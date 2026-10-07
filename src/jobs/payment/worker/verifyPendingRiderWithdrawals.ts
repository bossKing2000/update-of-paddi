import prisma from "../../../lib/prisma";
import { fetchTransferByReference } from "../../../services/payoutService";
import {
  settleRiderWithdrawalFailed,
  settleRiderWithdrawalPaid,
} from "../../../services/riderWithdrawalSettlement.service";
import { logger } from "../../../lib/logger";

/**
 * Stage O-C (N-03): reconcile rider withdrawals whose Paystack transfer
 * outcome we never learned.
 *
 * Since O-B, `processRiderWithdrawal` only marks a withdrawal FAILED when
 * Paystack definitively refused the transfer. A timeout, connection reset or
 * 5xx leaves the row PROCESSING — deliberately, because that transfer may
 * exist at Paystack. But "deliberately unresolved" must not mean "forever":
 * this job discovers what actually happened.
 *
 * It ONLY asks Paystack what happened to the transfer that already exists:
 *
 *   RiderWithdrawal.reference -> GET /transfer/verify/:reference
 *
 * It NEVER initiates, resends or finalises a transfer, never creates a
 * RiderWithdrawal and never mints a new reference. The original transfer is
 * the only thing that may settle a withdrawal, which is what makes
 * re-running this job safe.
 *
 * Mapping (Paystack statuses as documented on their API reference, Transfer
 * API — the values observed there are `success`, `pending`, `otp` and
 * `received`; `failed` is what this integration's own `transfer.failed`
 * webhook reports):
 *
 *   success                 -> PROCESSING -> PAID  (+ atomic wallet debit)
 *   failed                  -> PROCESSING -> FAILED (no wallet movement)
 *   pending / otp / received-> stays PROCESSING, retried on a later pass
 *   anything unrecognised   -> stays PROCESSING + error log for a human
 *   404 not found           -> stays PROCESSING (see below)
 *   timeout / 5xx / network -> stays PROCESSING, retried on a later pass
 *
 * A 404 is deliberately NOT converted to FAILED. Paystack's documentation
 * does not state whether a transfer created moments earlier is immediately
 * retrievable, so absence is not proof that the transfer was never created.
 * Failing closed (money stays reserved) is the only safe reading; resolving
 * those rows needs an explicit policy decision, not a guess.
 */
export async function verifyPendingRiderWithdrawals(
  batchSize = 20,
  graceMs = 60_000,
) {
  logger.info("Checking for PROCESSING rider withdrawals to reconcile");

  // Bounded, indexed scan. `status` is indexed and the reference must exist —
  // a row without one cannot be looked up by any key.
  const candidates = await prisma.riderWithdrawal.findMany({
    where: {
      status: "PROCESSING",
      reference: { not: null },
      // Grace period so a transfer that is still being written at Paystack
      // isn't looked up (and reported) the instant it was claimed.
      updatedAt: { lte: new Date(Date.now() - graceMs) },
    },
    orderBy: { requestedAt: "asc" },
    take: batchSize,
  });

  let checked = 0;
  let settledPaid = 0;
  let settledFailed = 0;
  let stillPending = 0;
  let unresolved = 0;
  let amountMismatch = 0;
  let notFound = 0;

  for (const withdrawal of candidates) {
    checked++;
    const reference = withdrawal.reference as string;
    try {
      const lookup = await fetchTransferByReference(reference);
      const logCtx = {
        withdrawalId: withdrawal.id,
        reference,
        localStatus: withdrawal.status,
      };

      if (lookup.outcome === "UNKNOWN") {
        // We could not ask Paystack. Leave the withdrawal exactly as it is.
        logger.warn(
          { ...logCtx, reason: lookup.reason },
          "verifyPendingRiderWithdrawals: transfer lookup inconclusive — leaving PROCESSING",
        );
        unresolved++;
        continue;
      }

      if (lookup.outcome === "NOT_FOUND") {
        // Not proof that no transfer exists (see header). Never auto-FAILED.
        logger.warn(
          logCtx,
          "verifyPendingRiderWithdrawals: Paystack has no transfer for this reference — leaving PROCESSING for review",
        );
        notFound++;
        continue;
      }

      // Paystack answered authoritatively about this transfer.
      if (lookup.reference && lookup.reference !== reference) {
        // Defence in depth: our own reference must be what Paystack echoes
        // back, otherwise we could settle someone else's transfer.
        logger.error(
          { ...logCtx, paystackReference: lookup.reference },
          "verifyPendingRiderWithdrawals: Paystack returned a different reference — leaving PROCESSING",
        );
        unresolved++;
        continue;
      }

      switch (lookup.status) {
        case "success": {
          // The transfer really exists and succeeded. Verify Paystack's
          // authoritative amount before we move any money locally.
          const expectedKobo = Math.round(withdrawal.amount * 100);
          if (lookup.amountKobo !== expectedKobo) {
            logger.error(
              {
                ...logCtx,
                paystackStatus: lookup.status,
                paystackAmountKobo: lookup.amountKobo,
                expectedAmountKobo: expectedKobo,
              },
              "verifyPendingRiderWithdrawals: Paystack transfer amount does not match the withdrawal — leaving PROCESSING for manual review",
            );
            amountMismatch++;
            continue;
          }
          const settlement = await settleRiderWithdrawalPaid(withdrawal.id);
          if (settlement.outcome === "SETTLED") {
            logger.info(
              { ...logCtx, paystackStatus: lookup.status },
              "verifyPendingRiderWithdrawals: reconciled as PAID",
            );
            settledPaid++;
          } else {
            // A webhook or another worker won the race. No double debit.
            logger.info(
              { ...logCtx, settlement },
              "verifyPendingRiderWithdrawals: already settled by another path",
            );
          }
          break;
        }

        case "failed": {
          const settlement = await settleRiderWithdrawalFailed(
            withdrawal.id,
            "Reconciled: Paystack reports the transfer failed",
          );
          if (settlement.outcome === "SETTLED") {
            logger.info(
              { ...logCtx, paystackStatus: lookup.status, failures: lookup.failures },
              "verifyPendingRiderWithdrawals: reconciled as FAILED",
            );
            settledFailed++;
          } else {
            logger.info(
              { ...logCtx, settlement },
              "verifyPendingRiderWithdrawals: already terminal",
            );
          }
          break;
        }

        case "pending":
        case "otp":
        case "received":
          // Still genuinely in flight at Paystack. Nothing to settle; the
          // next pass (or the webhook) will pick it up.
          logger.info(
            { ...logCtx, paystackStatus: lookup.status },
            "verifyPendingRiderWithdrawals: transfer still in flight at Paystack",
          );
          stillPending++;
          break;

        default:
          // Never guess. An unrecognised status must not settle money and
          // must not release funds — it goes to a human.
          logger.error(
            { ...logCtx, paystackStatus: lookup.status },
            "verifyPendingRiderWithdrawals: unrecognized Paystack transfer status — leaving PROCESSING for manual review",
          );
          unresolved++;
      }
    } catch (err) {
      // A reconciliation bug or unexpected failure must never transition
      // the withdrawal. Safe default: leave it PROCESSING.
      logger.error(
        { err, withdrawalId: withdrawal.id, reference },
        "verifyPendingRiderWithdrawals: error reconciling withdrawal",
      );
      unresolved++;
    }
  }

  logger.info(
    {
      checked,
      settledPaid,
      settledFailed,
      stillPending,
      unresolved,
      amountMismatch,
      notFound,
    },
    "verifyPendingRiderWithdrawals completed",
  );
  return {
    checked,
    settledPaid,
    settledFailed,
    stillPending,
    unresolved,
    amountMismatch,
    notFound,
  };
}

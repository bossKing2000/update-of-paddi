import prisma from "../../../lib/prisma";
import { fetchTransferByReference } from "../../../services/payoutService";
import {
  settleVendorPayoutFailed,
  settleVendorPayoutPaid,
} from "../../../services/vendorPayoutSettlement.service";
import { logger } from "../../../lib/logger";
import { PayoutStatus } from "@prisma/client";

/**
 * Stage N-06: reconcile vendor payouts whose Paystack transfer outcome we
 * never learned.
 *
 * `initiateVendorPayoutTransfer` deliberately leaves a payout PROCESSING when
 * Paystack's answer is unknown (timeout / connection reset / 5xx), because the
 * transfer may well exist. That is correct for double-payment safety, but it
 * left no way to ever learn the truth: a webhook that never arrives (or is
 * lost to the endpoint's catch-all 200) stranded the payout — and, before this
 * change, its claimed orders — forever.
 *
 * This worker closes that loop WITHOUT ever initiating a transfer. It only
 * asks Paystack what happened to the transfer that already exists, using the
 * reference already stored on the payout:
 *
 *     VendorPayout.reference -> GET /transfer/verify/:reference
 *
 * Mapping (documented Paystack transfer statuses):
 *
 *   success (amount matches) -> PROCESSING -> PAID    (claims RETAINED)
 *   success (amount differs) -> stays PROCESSING      (never settle a surprise
 *                                                    amount; needs a human)
 *   failed                  -> PROCESSING -> FAILED   + claims RELEASED
 *   pending/otp/received    -> stays PROCESSING
 *   unrecognised status     -> stays PROCESSING + error log
 *   404 not found           -> stays PROCESSING
 *   timeout / 5xx / network -> stays PROCESSING
 *
 * A 404 is deliberately NOT treated as failure: Paystack's documentation does
 * not state whether a just-created transfer is immediately retrievable, so
 * absence is not proof that no transfer exists. Failing closed (money stays
 * claimed) is the only safe reading.
 *
 * Deliberate differences from the rider reconciler (verifyPendingRiderWithdrawals):
 * there is no wallet to debit, and a verified failure must RELEASE the order
 * claims so the orders can be paid again in a future run.
 */
export async function verifyPendingVendorPayouts(
  batchSize = 20,
  graceMs = 60_000,
) {
  logger.info("Checking for PROCESSING vendor payouts to reconcile");

  // Bounded, indexed scan. Only payouts that actually reached Paystack
  // (non-null reference) can be verified — a PENDING payout with no reference
  // was never sent and is the admin `markPayoutPaid` path's business.
  const candidates = await prisma.vendorPayout.findMany({
    where: {
      status: PayoutStatus.PROCESSING,
      reference: { not: null },
      // Grace period so a transfer that is still being written at Paystack is
      // not looked up the instant it was claimed.
      updatedAt: { lte: new Date(Date.now() - graceMs) },
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let checked = 0;
  let settledPaid = 0;
  let settledFailed = 0;
  let releasedOrders = 0;
  let stillPending = 0;
  let unresolved = 0;
  let amountMismatch = 0;
  let notFound = 0;

  for (const payout of candidates) {
    checked++;
    const reference = payout.reference as string;
    const logCtx = {
      payoutId: payout.id,
      vendorId: payout.vendorId,
      reference,
      localStatus: payout.status,
      amountNaira: payout.amount,
    };

    try {
      const lookup = await fetchTransferByReference(reference);

      if (lookup.outcome === "UNKNOWN") {
        // Could not ask Paystack. Leave the payout and its claims exactly as
        // they are; a later pass retries the verification.
        logger.warn(
          { ...logCtx, reason: lookup.reason },
          "verifyPendingVendorPayouts: transfer lookup inconclusive — leaving PROCESSING",
        );
        unresolved++;
        continue;
      }

      if (lookup.outcome === "NOT_FOUND") {
        // Not proof that no transfer exists (see header). Never auto-FAILED,
        // never released.
        logger.warn(
          logCtx,
          "verifyPendingVendorPayouts: Paystack has no transfer for this reference — leaving PROCESSING for review",
        );
        notFound++;
        continue;
      }

      if (lookup.reference && lookup.reference !== reference) {
        // Defence in depth: our own reference must be what Paystack echoes.
        logger.error(
          { ...logCtx, paystackReference: lookup.reference },
          "verifyPendingVendorPayouts: Paystack returned a different reference — leaving PROCESSING",
        );
        unresolved++;
        continue;
      }

      switch (lookup.status) {
        case "success": {
          // Authoritative success — but verify the amount (integer kobo) before
          // settling. This is settlement only: no amount is ever recomputed.
          // payout.amount is already integer kobo (Phase 3A); lookup.amountKobo
          // is Paystack's integer kobo. Compare directly — no * 100.
          const expectedKobo = Number(payout.amount);
          if (lookup.amountKobo !== expectedKobo) {
            logger.error(
              {
                ...logCtx,
                paystackStatus: lookup.status,
                paystackAmountKobo: lookup.amountKobo,
                expectedAmountKobo: expectedKobo,
              },
              "verifyPendingVendorPayouts: Paystack transfer amount does not match the payout — leaving PROCESSING for manual review",
            );
            amountMismatch++;
            continue;
          }
          const settlement = await settleVendorPayoutPaid(payout.id);
          if (settlement.outcome === "SETTLED") {
            logger.info(
              { ...logCtx, paystackStatus: lookup.status },
              "verifyPendingVendorPayouts: reconciled as PAID (claims retained)",
            );
            settledPaid++;
          } else {
            logger.info(
              { ...logCtx, settlement },
              "verifyPendingVendorPayouts: already settled by another path",
            );
          }
          break;
        }

        case "failed": {
          // Definite failure: close the payout AND release the order claims
          // atomically, so those orders are payable again in a future run.
          const settlement = await settleVendorPayoutFailed(
            payout.id,
            "Reconciled: Paystack reports the transfer failed",
          );
          if (settlement.outcome === "SETTLED") {
            logger.info(
              {
                ...logCtx,
                paystackStatus: lookup.status,
                releasedOrders: settlement.releasedOrders,
                failures: lookup.failures,
              },
              "verifyPendingVendorPayouts: reconciled as FAILED (claims released)",
            );
            settledFailed++;
            releasedOrders += settlement.releasedOrders;
          } else {
            logger.info(
              { ...logCtx, settlement },
              "verifyPendingVendorPayouts: already terminal",
            );
          }
          break;
        }

        case "pending":
        case "otp":
        case "received":
          // Still genuinely in flight at Paystack.
          logger.info(
            { ...logCtx, paystackStatus: lookup.status },
            "verifyPendingVendorPayouts: transfer still in flight at Paystack",
          );
          stillPending++;
          break;

        default:
          // Never guess. An unrecognised status must neither settle money nor
          // release funds — it goes to a human.
          logger.error(
            { ...logCtx, paystackStatus: lookup.status },
            "verifyPendingVendorPayouts: unrecognized Paystack transfer status — leaving PROCESSING for manual review",
          );
          unresolved++;
      }
    } catch (err) {
      // A reconciliation bug must never transition the payout. Safe default:
      // leave it PROCESSING with its claims intact.
      logger.error(
        { err, payoutId: payout.id, reference },
        "verifyPendingVendorPayouts: error reconciling payout",
      );
      unresolved++;
    }
  }

  logger.info(
    {
      checked,
      settledPaid,
      settledFailed,
      releasedOrders,
      stillPending,
      unresolved,
      amountMismatch,
      notFound,
    },
    "verifyPendingVendorPayouts completed",
  );
  return {
    checked,
    settledPaid,
    settledFailed,
    releasedOrders,
    stillPending,
    unresolved,
    amountMismatch,
    notFound,
  };
}

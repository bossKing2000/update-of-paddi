import prisma from "../../../lib/prisma";
import { fetchRefundById, listRefundsForTransaction } from "../../../services/refundService";
import { completeRefund, failRefund } from "../../../services/refundFinalizer.service";
import { logger } from "../../../lib/logger";
import { RefundStatus } from "@prisma/client";

/**
 * Catch-up job for refunds whose final Paystack outcome we don't
 * definitively know yet:
 *
 *   - The common case: a refund was submitted and is still genuinely
 *     "processing"/"pending" on Paystack's side — nothing to do but wait,
 *     this just confirms that and logs nothing alarming.
 *   - The crash case: the process died between reserving the amount +
 *     writing the durable PROCESSING record (FIX 2 — this now always
 *     happens BEFORE the Paystack call) and recording Paystack's own
 *     refund id afterward. The PROCESSING row exists but
 *     `paystackRefundId` may still be null.
 *   - The lost-webhook case: Paystack sent refund.processed/refund.failed
 *     but our webhook endpoint never received it or errored before
 *     recording the outcome.
 *
 * This job NEVER calls POST /refund. It only reads Paystack's existing
 * records (Fetch Refund by id, or List Refunds for the transaction when
 * we don't have an id yet) and reconciles local state to match. An
 * outcome Paystack can't confirm one way or the other is left exactly as
 * it was — PROCESSING, reservation intact — for the next pass.
 */
export async function verifyPendingRefunds(batchSize = 50) {
  logger.info("Checking for PROCESSING refunds to reconcile");

  const candidates = await prisma.refundRequest.findMany({
    where: { status: RefundStatus.PROCESSING },
    orderBy: { resolvedAt: "asc" },
    take: batchSize,
  });

  let checked = 0;
  let completed = 0;
  let failed = 0;
  let stillPending = 0;
  let unresolved = 0;

  for (const refundRequest of candidates) {
    checked++;
    try {
      let paystackStatus: string | undefined;
      let paystackRefundId: string | undefined;

      if (refundRequest.paystackRefundId) {
        // Normal case: we know exactly which Paystack refund this is.
        const refund = await fetchRefundById(refundRequest.paystackRefundId);
        paystackStatus = refund.status;
        paystackRefundId = String(refund.id);
      } else {
        // Crash case — we reserved and recorded PROCESSING but never
        // got (or never persisted) Paystack's own refund id. List what
        // Paystack has on record for this transaction and try to find
        // the one that matches what we asked for.
        const refunds = await listRefundsForTransaction(refundRequest.paymentRef);
        const matches = refunds.filter((r) => r.amount === refundRequest.requestedAmountKobo);

        if (matches.length === 0) {
          // Paystack has no record of a refund at this amount for this
          // transaction. We genuinely don't know if our POST /refund
          // ever reached them — could still be in flight, could have
          // been dropped before they logged it. Do not assume either
          // way; do not resubmit.
          logger.warn(
            { refundRequestId: refundRequest.id, paymentRef: refundRequest.paymentRef, requestedAmountKobo: refundRequest.requestedAmountKobo },
            "verifyPendingRefunds: no matching Paystack refund found yet — leaving PROCESSING",
          );
          unresolved++;
          continue;
        }
        if (matches.length > 1) {
          // Ambiguous — more than one Paystack refund at this exact
          // amount for this transaction (e.g. two partial refunds that
          // happen to be the same size). Don't guess which is ours.
          logger.error(
            { refundRequestId: refundRequest.id, paymentRef: refundRequest.paymentRef, candidateIds: matches.map((m) => m.id) },
            "verifyPendingRefunds: multiple ambiguous Paystack refunds match — leaving PROCESSING for manual review",
          );
          unresolved++;
          continue;
        }

        paystackStatus = matches[0].status;
        paystackRefundId = String(matches[0].id);
      }

      switch (paystackStatus) {
        case "processed": {
          const result = await completeRefund(refundRequest.id, { paystackRefundId, source: "reconciliation" });
          logger.info({ refundRequestId: refundRequest.id, result }, "verifyPendingRefunds: reconciled as processed");
          completed++;
          break;
        }
        case "failed": {
          const result = await failRefund(refundRequest.id, { source: "reconciliation" });
          logger.info({ refundRequestId: refundRequest.id, result }, "verifyPendingRefunds: reconciled as failed");
          failed++;
          break;
        }
        case "pending":
        case "processing":
        case "needs-attention":
          // Still genuinely in flight on Paystack's side — nothing to
          // reconcile yet. If we found a refund id we didn't have
          // before (the crash case), persist it now so future passes
          // (and any late webhook) can match directly.
          if (paystackRefundId && !refundRequest.paystackRefundId) {
            await prisma.refundRequest.update({ where: { id: refundRequest.id }, data: { paystackRefundId } });
          }
          stillPending++;
          break;
        default:
          logger.error(
            { refundRequestId: refundRequest.id, paystackStatus },
            "verifyPendingRefunds: unrecognized Paystack refund status — leaving PROCESSING for manual review",
          );
          unresolved++;
      }
    } catch (err) {
      logger.error({ err, refundRequestId: refundRequest.id }, "verifyPendingRefunds: error reconciling refund");
      unresolved++;
    }
  }

  logger.info({ checked, completed, failed, stillPending, unresolved }, "verifyPendingRefunds completed");
  return { checked, completed, failed, stillPending, unresolved };
}

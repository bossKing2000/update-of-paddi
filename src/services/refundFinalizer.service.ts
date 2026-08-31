import prisma from "../lib/prisma";
import { PaymentStatus, OrderStatus, RefundStatus } from "@prisma/client";
import { logger } from "../lib/logger";
import { createAuditLog } from "../utils/auditLog.service";

type RefundOutcomeSource = "webhook" | "reconciliation" | "admin_sync";

/**
 * Marks a refund request COMPLETED once Paystack has confirmed the money
 * actually moved (refund.processed webhook, or a reconciliation fetch
 * that returns status "processed"). Shared by the webhook handler and
 * verifyPendingRefunds so both apply the identical rule for when a
 * Payment is actually fully refunded.
 *
 * Payment.refundedAmount is a RESERVATION ledger (used to stop concurrent
 * refunds from jointly over-committing the payment) — it is NOT proof
 * that money has moved. A payment only flips to REFUNDED, and its orders
 * only cancel, once the sum of COMPLETED refunds reaches the original
 * amount.
 */
export async function completeRefund(
  refundRequestId: string,
  opts: { paystackRefundId?: string | null; source: RefundOutcomeSource },
) {
  const result = await prisma.$transaction(async (tx) => {
    const refundRequest = await tx.refundRequest.findUnique({ where: { id: refundRequestId } });
    if (!refundRequest) return { outcome: "NOT_FOUND" as const };
    if (refundRequest.status === RefundStatus.COMPLETED) return { outcome: "ALREADY_COMPLETED" as const };
    if (refundRequest.status !== RefundStatus.PROCESSING) {
      logger.warn(
        { refundRequestId, status: refundRequest.status },
        "completeRefund: request not in PROCESSING state — skipping to avoid clobbering a different outcome",
      );
      return { outcome: "UNEXPECTED_STATE" as const, status: refundRequest.status };
    }

    await tx.refundRequest.update({
      where: { id: refundRequestId },
      data: {
        status: RefundStatus.COMPLETED,
        paystackRefundId: opts.paystackRefundId ?? refundRequest.paystackRefundId,
      },
    });

    const payment = await tx.payment.findUnique({ where: { reference: refundRequest.paymentRef } });
    if (!payment) {
      logger.warn({ refundRequestId, paymentRef: refundRequest.paymentRef }, "completeRefund: payment not found");
      return { outcome: "SUCCESS" as const, paymentFound: false };
    }

    // Option A from the audit: sum COMPLETED refunds directly rather than
    // trusting the reservation ledger to equal completed money.
    const completedAgg = await tx.refundRequest.aggregate({
      where: { paymentRef: payment.reference, status: RefundStatus.COMPLETED },
      _sum: { requestedAmountKobo: true },
    });
    const completedKobo = completedAgg._sum.requestedAmountKobo ?? 0;

    let fullyRefunded = false;
    if (completedKobo >= payment.amount && payment.status !== PaymentStatus.REFUNDED) {
      fullyRefunded = true;
      await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.REFUNDED } });
      const affectedOrders = payment.idempotencyKey
        ? await tx.order.findMany({ where: { idempotencyKey: payment.idempotencyKey } })
        : [{ id: payment.orderId }];
      await tx.order.updateMany({
        where: { id: { in: affectedOrders.map((o) => o.id) } },
        data: {
          paymentStatus: PaymentStatus.REFUNDED,
          status: OrderStatus.CANCELLED,
          cancellationReason: "REFUNDED",
          cancelledAt: new Date(),
        },
      });
    }

    return { outcome: "SUCCESS" as const, completedKobo, paymentAmount: payment.amount, fullyRefunded };
  });

  await createAuditLog({
    userId: null,
    action: "REFUND_PROCESSED",
    metadata: { refundRequestId, ...opts, result },
  }).catch((err) => logger.warn({ err, refundRequestId }, "completeRefund: failed to write audit log"));

  return result;
}

/**
 * Marks a refund request FAILED and releases its reservation. Only call
 * this for a DEFINITE failure — Paystack's own refund.failed webhook, or
 * a reconciliation fetch that returns status "failed". Never call this
 * for an unknown/ambiguous outcome (timeout, network error, no match
 * found) — that would incorrectly free up balance that may already be
 * moving.
 */
export async function failRefund(refundRequestId: string, opts: { source: RefundOutcomeSource }) {
  const result = await prisma.$transaction(async (tx) => {
    const refundRequest = await tx.refundRequest.findUnique({ where: { id: refundRequestId } });
    if (!refundRequest) return { outcome: "NOT_FOUND" as const };
    if (refundRequest.status === RefundStatus.FAILED) return { outcome: "ALREADY_FAILED" as const };
    if (refundRequest.status !== RefundStatus.PROCESSING) {
      logger.warn(
        { refundRequestId, status: refundRequest.status },
        "failRefund: request not in PROCESSING state — skipping to avoid clobbering a different outcome",
      );
      return { outcome: "UNEXPECTED_STATE" as const, status: refundRequest.status };
    }

    const releaseKobo = refundRequest.requestedAmountKobo ?? 0;
    await tx.payment.updateMany({
      where: { reference: refundRequest.paymentRef },
      data: { refundedAmount: { decrement: releaseKobo } },
    });
    await tx.refundRequest.update({ where: { id: refundRequestId }, data: { status: RefundStatus.FAILED } });

    return { outcome: "SUCCESS" as const, releasedKobo: releaseKobo };
  });

  await createAuditLog({
    userId: null,
    action: "REFUND_FAILED",
    metadata: { refundRequestId, ...opts, result },
  }).catch((err) => logger.warn({ err, refundRequestId }, "failRefund: failed to write audit log"));

  return result;
}

export type RefundMatchResult =
  | { kind: "matched"; request: NonNullable<Awaited<ReturnType<typeof prisma.refundRequest.findFirst>>> }
  | { kind: "amount_mismatch"; candidates: Array<{ id: string; requestedAmountKobo: number | null }> }
  | { kind: "ambiguous"; candidates: Array<{ id: string; requestedAmountKobo: number | null }> }
  | { kind: "not_found" };

/**
 * Finds the RefundRequest a refund.processed/refund.failed webhook (or a
 * reconciliation pass) is confirming.
 *
 * Preference order:
 *   1. Exact match on Paystack's own refund id, if we've recorded one —
 *      unambiguous regardless of current status (also makes duplicate
 *      webhook deliveries idempotent, since a resolved request still
 *      matches by id).
 *   2. Fall back to an unresolved PROCESSING request for this payment
 *      with no recorded refund id yet, narrowed by amount. Two or more
 *      same-amount candidates is genuinely ambiguous — refuse to guess.
 *      A candidate exists but with a different amount is a mismatch —
 *      also refuse, loudly (see FIX 5 in webhook.ts).
 */
export async function matchRefundRequest(params: {
  transactionReference: string;
  refundReference?: string | null;
  amountKobo?: number;
}): Promise<RefundMatchResult> {
  const { transactionReference, refundReference, amountKobo } = params;

  if (refundReference) {
    const byId = await prisma.refundRequest.findFirst({
      where: { paymentRef: transactionReference, paystackRefundId: refundReference },
    });
    if (byId) return { kind: "matched", request: byId };
  }

  const candidates = await prisma.refundRequest.findMany({
    where: { paymentRef: transactionReference, status: RefundStatus.PROCESSING, paystackRefundId: null },
    orderBy: { resolvedAt: "asc" },
  });

  if (candidates.length === 0) return { kind: "not_found" };

  const amountMatches = amountKobo != null ? candidates.filter((c) => c.requestedAmountKobo === amountKobo) : candidates;

  if (amountKobo != null && amountMatches.length === 0) {
    return { kind: "amount_mismatch", candidates: candidates.map((c) => ({ id: c.id, requestedAmountKobo: c.requestedAmountKobo })) };
  }

  if (amountMatches.length > 1) {
    return { kind: "ambiguous", candidates: amountMatches.map((c) => ({ id: c.id, requestedAmountKobo: c.requestedAmountKobo })) };
  }

  return { kind: "matched", request: amountMatches[0] };
}

import prisma from "../lib/prisma";
import { PaymentStatus, OrderStatus, RefundStatus } from "@prisma/client";
import { logger } from "../lib/logger";
import { createAuditLog } from "../utils/auditLog.service";
import { clearProductCache } from "./clearCaches";
import {
  findTerminalOrderIds,
  reconcileActiveDeliveryAssignments,
} from "./deliveryAssignmentReconciliation";

type RefundOutcomeSource = "webhook" | "reconciliation" | "admin_sync";

/**
 * N-02: the order statuses a refund is allowed to cancel.
 *
 * This is NOT a new rule — it is the project's own existing state machine,
 * copied from the CANCELLED transition in
 * `updateOrderStatus` (src/controllers/orderController.ts, `transitions`).
 * Anything outside this list is terminal or already-settled for cancellation
 * purposes (COMPLETED, CANCELLED, FAILED_DELIVERY, PAYMENT_EXPIRED,
 * CANCELLED_UNPAID, and the not-yet-confirmed PENDING /
 * WAITING_VENDOR_CONFIRMATION / WAITING_CUSTOMER_APPROVAL states, which
 * never appear as a transition source). Using the transition table keeps the
 * refund path from inventing state transitions the order machine does not
 * support — a refund must never flip a COMPLETED (possibly already
 * paid-out) order to CANCELLED. `tests/unit/batchRefund.test.ts` asserts
 * this list stays in sync with the transition table.
 */
const REFUND_CANCELLABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PAYMENT_CONFIRMED,
  OrderStatus.COOKING,
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.OUT_FOR_DELIVERY,
];

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

    // Phase 3.2.19 (FIN-08): claim the terminal transition BEFORE any other
    // write. The read above is not a lock, so a concurrent `failRefund` (or a
    // duplicate delivery) could pass the same PROCESSING check and then apply
    // its own terminal write plus ledger work. `updateMany` with the status in
    // the WHERE clause is the claim: under PostgreSQL's READ COMMITTED the
    // predicate is re-evaluated after the row lock is taken, so exactly one
    // execution can move this row out of PROCESSING and exactly one may
    // continue into the ledger/payment/order work below.
    const claim = await tx.refundRequest.updateMany({
      where: { id: refundRequestId, status: RefundStatus.PROCESSING },
      data: {
        status: RefundStatus.COMPLETED,
        paystackRefundId: opts.paystackRefundId ?? refundRequest.paystackRefundId,
      },
    });
    if (claim.count === 0) {
      // Lost the race. Report the outcome the pre-checks above would have
      // reported, so callers see exactly the vocabulary they always have.
      const current = await tx.refundRequest.findUnique({
        where: { id: refundRequestId },
        select: { status: true },
      });
      if (!current) return { outcome: "NOT_FOUND" as const };
      if (current.status === RefundStatus.COMPLETED) return { outcome: "ALREADY_COMPLETED" as const };
      logger.warn(
        { refundRequestId, status: current.status },
        "completeRefund: lost the transition race — another execution settled this refund",
      );
      return { outcome: "UNEXPECTED_STATE" as const, status: current.status };
    }

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
      // N-02: scope the cancellation to what was actually refunded.
      //
      // An order-scoped RefundRequest (orderId set — e.g. the paid-cancel
      // path) must cancel ONLY that order. Previously every order sharing the
      // payment's idempotencyKey was cancelled, so refunding one vendor's
      // order in a multi-vendor batch also cancelled the other vendors'
      // orders. A request with orderId === null is a whole-payment refund, so
      // the original fan-out over the batch is preserved there.
      //
      // Either way the update is restricted to statuses the order state
      // machine can legitimately move to CANCELLED, so a COMPLETED (possibly
      // already paid out) or otherwise terminal order is never rewritten and
      // never causes an error.
      const affectedOrders = refundRequest.orderId
        ? await tx.order.findMany({ where: { id: refundRequest.orderId } })
        : payment.idempotencyKey
          ? await tx.order.findMany({
              where: { idempotencyKey: payment.idempotencyKey },
            })
          : [{ id: payment.orderId }];
      await tx.order.updateMany({
        where: {
          id: { in: affectedOrders.map((o) => o.id) },
          status: { in: REFUND_CANCELLABLE_ORDER_STATUSES },
        },
        data: {
          paymentStatus: PaymentStatus.REFUNDED,
          status: OrderStatus.CANCELLED,
          cancellationReason: "REFUNDED",
          cancelledAt: new Date(),
        },
      });

      // F4-1 / INV-1: `OUT_FOR_DELIVERY` is deliberately refund-cancellable,
      // so a refund can land while a rider is mid-delivery. That combination
      // used to leave `CANCELLED`/`REFUNDED` with an active EN_ROUTE
      // assignment — the customer had their money back and the rider still held
      // a live delivery for a dead order, with nothing reconciling it.
      //
      // The reconciliation is applied inside this same transaction, and only to
      // orders that are ACTUALLY terminal now. `updateMany` reports just a
      // count, so the terminal ids are re-read rather than assumed: an order
      // the bulk write skipped (already COMPLETED, for instance) must not have
      // its delivery history rewritten.
      const becameTerminal = await findTerminalOrderIds(
        tx,
        affectedOrders.map((o) => o.id),
      );
      for (const terminalOrderId of becameTerminal) {
        await reconcileActiveDeliveryAssignments(tx, terminalOrderId);
      }
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

    // Phase 3.2.19 (FIN-08): the reservation release is a MONEY write, so it
    // must be gated on winning the terminal transition rather than on a
    // non-locking read. Claiming first means two concurrent definitive
    // failures (webhook + reconciliation, or two webhook deliveries) cannot
    // both decrement `Payment.refundedAmount`: the loser's conditional claim
    // matches zero rows and it returns without touching the ledger.
    const claim = await tx.refundRequest.updateMany({
      where: { id: refundRequestId, status: RefundStatus.PROCESSING },
      data: { status: RefundStatus.FAILED },
    });
    if (claim.count === 0) {
      // Lost the race — report the outcome the pre-checks above would have
      // reported, preserving the caller-visible vocabulary exactly.
      const current = await tx.refundRequest.findUnique({
        where: { id: refundRequestId },
        select: { status: true },
      });
      if (!current) return { outcome: "NOT_FOUND" as const };
      if (current.status === RefundStatus.FAILED) return { outcome: "ALREADY_FAILED" as const };
      logger.warn(
        { refundRequestId, status: current.status },
        "failRefund: lost the transition race — another execution settled this refund",
      );
      return { outcome: "UNEXPECTED_STATE" as const, status: current.status };
    }

    const releaseKobo = refundRequest.requestedAmountKobo ?? 0;
    await tx.payment.updateMany({
      where: { reference: refundRequest.paymentRef },
      data: { refundedAmount: { decrement: releaseKobo } },
    });

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

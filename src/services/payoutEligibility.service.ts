import { PaymentStatus, Prisma, RefundStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

/**
 * F8 — vendor payout eligibility when a customer's refund has touched the
 * value of an order.
 *
 * THE DEFECT THIS EXISTS TO CLOSE
 *
 * Every payout selector in the app keys off three Order fields only:
 *
 *     status = COMPLETED  AND  paymentStatus = SUCCESS  AND  payoutId IS NULL
 *
 * That predicate is correct for an order that was never refunded. It is NOT
 * correct for one that was, because the refund machinery only rewrites the
 * order when the order sits in `REFUND_CANCELLABLE_ORDER_STATUSES`
 * (`refundFinalizer.service.ts`). A COMPLETED order is deliberately excluded
 * from that list — a refund must never flip a possibly-paid-out order to
 * CANCELLED — so for a COMPLETED order the refund is effectively invisible to
 * the order row:
 *
 *   - a FULL refund sets `Payment.status = REFUNDED`, but leaves the order at
 *     COMPLETED + SUCCESS, because the cancellable-status filter matched no row;
 *   - a PARTIAL refund is worse, because `Payment.status` stays SUCCESS by
 *     design (`completedKobo >= payment.amount` is false), so nothing about the
 *     order or even the payment changes.
 *
 * Meanwhile `Order.vendorPayoutKobo` is a frozen checkout-time snapshot
 * (`orderSnapshot.service.ts` — explicitly "VALIDATION, never RECOMPUTATION")
 * and nothing adjusts it for money already returned to the customer. The result
 * is that a refunded order keeps its full, unrestricted vendor payout.
 *
 * WHY THIS FAILS CLOSED INSTEAD OF COMPUTING AN ADJUSTMENT
 *
 * Reducing a payout after a partial refund requires knowing how much of the
 * refund the vendor absorbs versus the platform, whether the delivery fee is
 * refundable, and whether commission is clawed back. **This repository defines
 * none of that.** `orderSnapshot.service.ts` validates a stored snapshot and
 * never re-derives money; `promoService.calculateDiscountAllocation` splits
 * *discounts* at checkout and is unrelated to refunds; and no refund path
 * anywhere computes a vendor-facing amount. Inventing such a split here would
 * be fabricating financial policy, and getting it wrong overpays a vendor or
 * silently steals a rider's fee.
 *
 * So the only safe rule that needs no policy is: **do not pay out an order
 * whose money is in an unresolved or completed refund state, and do not
 * attempt to net anything off.** The order keeps `payoutId = null` and returns
 * to the eligible pool automatically once its refund is rejected/failed or an
 * allocation policy is added. Nothing is lost, and no amount is invented.
 *
 * WHAT BLOCKS PAYOUT
 *
 *  - any `RefundRequest` for this order, or filed against the payment that
 *    paid it, in any status except REJECTED / FAILED (i.e. PENDING, APPROVED,
 *    PROCESSING, COMPLETED). PENDING matters: a refund request that an admin
 *    has not yet resolved must not be paid out underneath the admin, or the
 *    refund and the payout both win.
 *  - a payment with `refundedAmount > 0`. This is the money-level truth and
 *    catches partial refunds, which leave `Payment.status = SUCCESS` and are
 *    therefore invisible to a status check.
 *  - a payment with `status = REFUNDED`.
 *
 * HOW ORDER AND PAYMENT ARE MATCHED
 *
 * `Order.idempotencyKey` / `Payment.idempotencyKey` is the canonical link —
 * `paymentFinalizer.getOrdersForPayment` and `resolveRefundOrderId` both use it,
 * because one Paystack transaction pays for one order per vendor. The direct
 * `Payment.orderId` relation only points at the batch's PRIMARY order, so it is
 * unusable for sibling orders; `RefundRequest.orderId` is nullable and null for
 * every batch-level request. Both fallbacks are handled below.
 */

export type PayoutEligibilityDb = Prisma.TransactionClient | PrismaClient;

/**
 * Refund states that make an order unsafe to pay out. Everything except the two
 * terminal "money did not move" states.
 */
export const PAYOUT_BLOCKING_REFUND_STATUSES: RefundStatus[] = [
  RefundStatus.PENDING,
  RefundStatus.APPROVED,
  RefundStatus.PROCESSING,
  RefundStatus.COMPLETED,
];

export interface PayoutCandidateOrder {
  id: string;
  idempotencyKey: string | null;
}

/**
 * Row-locks the `Payment` rows that paid these orders, so a refund cannot be
 * approved (or completed) concurrently with a payout claim that is deciding
 * whether the order is safe to pay.
 *
 * This is deliberately the same lock the refund paths already take on Payment
 * (`admin.controller.updateRefundStatus` does
 * `SELECT id FROM "Payment" WHERE id = ... FOR UPDATE`), so the two paths
 * contend on one row lock and produce a deterministic winner instead of both
 * reading a safe state and both committing. The refund side needs no change:
 * it already locks before writing.
 *
 * Only orders with an `idempotencyKey` can be matched this way; an order
 * without one can only be guarded through its own attributed RefundRequest.
 */
export async function lockPaymentsCoveringOrders(
  db: PayoutEligibilityDb,
  idempotencyKeys: string[],
): Promise<void> {
  if (idempotencyKeys.length === 0) return;
  await db.$queryRaw`
    SELECT id FROM "Payment"
    WHERE "idempotencyKey" IN (${Prisma.join(idempotencyKeys)})
    FOR UPDATE
  `;
}

/**
 * Splits candidate payout orders into those safe to pay and those withheld
 * because a refund has consumed some or all of the order's value.
 *
 * Call this AFTER `lockPaymentsCoveringOrders` inside the payout transaction:
 * the lock is what makes the result authoritative rather than a stale read.
 */
export async function partitionPayoutBlockedOrders<T extends PayoutCandidateOrder>(
  db: PayoutEligibilityDb,
  orders: T[],
): Promise<{ eligible: T[]; blocked: T[] }> {
  if (orders.length === 0) return { eligible: [], blocked: [] };

  const orderIds = orders.map((o) => o.id);
  const keys = [
    ...new Set(orders.map((o) => o.idempotencyKey).filter((k): k is string => !!k)),
  ];

  const payments = keys.length
    ? await db.payment.findMany({
        where: { idempotencyKey: { in: keys } },
        select: {
          idempotencyKey: true,
          reference: true,
          refundedAmount: true,
          status: true,
        },
      })
    : [];

  const references = payments.map((p) => p.reference);
  const blockingRefunds = await db.refundRequest.findMany({
    where: {
      status: { in: PAYOUT_BLOCKING_REFUND_STATUSES },
      OR: [
        { orderId: { in: orderIds } },
        ...(references.length ? [{ paymentRef: { in: references } }] : []),
      ],
    },
    select: { orderId: true, paymentRef: true },
  });

  const refundBlockedOrders = new Set(
    blockingRefunds.map((r) => r.orderId).filter((id): id is string => !!id),
  );
  const refundBlockedPayments = new Set(blockingRefunds.map((r) => r.paymentRef));

  // A refund can be filed against a payment that is NOT the order's own primary
  // payment (batch), so a tainted payment blocks every order sharing its key.
  const blockedKeys = new Set<string>();
  for (const payment of payments) {
    if (
      payment.refundedAmount > 0 ||
      payment.status === PaymentStatus.REFUNDED ||
      refundBlockedPayments.has(payment.reference)
    ) {
      if (payment.idempotencyKey) blockedKeys.add(payment.idempotencyKey);
    }
  }

  const eligible: T[] = [];
  const blocked: T[] = [];
  for (const order of orders) {
    const withheld =
      refundBlockedOrders.has(order.id) ||
      (!!order.idempotencyKey && blockedKeys.has(order.idempotencyKey));
    (withheld ? blocked : eligible).push(order);
  }

  return { eligible, blocked };
}
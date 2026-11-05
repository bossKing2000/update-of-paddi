/**
 * Vendor order visibility — the single source of truth for "may this store
 * see this order AS A VENDOR ORDER?".
 *
 * THE INVARIANT
 * -------------
 * Checkout creates `Order` rows in `AWAITING_PAYMENT` before the customer has
 * paid anything (src/controllers/cartController.ts). Those rows are real,
 * intentional and must keep existing — the payment finalizer, the expiry
 * workers and the stock-restoration paths all depend on them. But until
 * `finalizePaymentSuccess` wins its compare-and-set and moves the order to
 * `PAYMENT_CONFIRMED` (src/services/paymentFinalizer.service.ts), the order
 * is not the vendor's work and must not appear in any vendor-facing surface.
 *
 * So visibility is expressed on AUTHORITATIVE DATABASE STATE ONLY:
 *   * `Order.status`         — the order's own workflow state
 *   * `Order.paymentStatus`  — set by the finalizer's conditional claims
 *
 * A client-supplied status, query parameter or socket payload is never
 * consulted. This mirrors the existing `DISPATCHABLE_ORDER_STATUSES` gate
 * (src/services/deliveryAssignmentReconciliation.ts), which already refuses to
 * hand an unpaid order to a rider for the same reason.
 *
 * WHY BOTH COLUMNS ARE NEEDED
 * ---------------------------
 * Neither column alone expresses the rule:
 *
 *   * `status` alone — `CANCELLED` is reachable both from `AWAITING_PAYMENT`
 *     (never paid; `cancellationReason: "USER_CANCELLED"` /
 *     `"VENDOR_REJECTED"`, orderController.ts `transitions`) and from
 *     `PAYMENT_CONFIRMED`/`COOKING`/`READY_FOR_PICKUP`/`OUT_FOR_DELIVERY`
 *     (paid). Status alone cannot tell those apart.
 *   * `paymentStatus` alone — a full refund rewrites the order to
 *     `CANCELLED` with `paymentStatus: REFUNDED`
 *     (src/services/refundFinalizer.service.ts). That order WAS paid, and a
 *     vendor must keep seeing it for their own records and payout disputes.
 *
 * So: exclude every status that cannot be reached after a settled payment,
 * and additionally require the payment marker itself to be settled.
 *
 * FAIL-CLOSED ON AN UNREADABLE PAYMENT MARKER
 * -------------------------------------------
 * `Order.paymentStatus` is nullable (prisma/schema.prisma: `PaymentStatus?
 * @default(PENDING)`). A NULL is not evidence that money was taken, so it is
 * NOT treated as settled — the same "unknown must not read as permitted"
 * convention already used by `isVendorStatusEstablishable`
 * (src/services/vendorStatus.service.ts). The baseline migration created the
 * column with `DEFAULT 'PENDING'` and no backfill step, and no code path
 * writes NULL, so this only ever bites a hand-edited row.
 */
import { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";

/**
 * Order statuses that cannot be reached once a payment has been authoritatively
 * confirmed — i.e. an order in one of these was never, and will never become,
 * payable work for the vendor.
 *
 *   PENDING                     — "customer placed order" (schema comment).
 *                                 Never written by the current checkout path,
 *                                 but it is a pre-payment state by definition.
 *   WAITING_VENDOR_CONFIRMATION — pre-payment confirmation states from the
 *   WAITING_CUSTOMER_APPROVAL     original state machine. Not written by any
 *                                 current code path; listed so a future writer
 *                                 cannot silently reintroduce the leak.
 *   AWAITING_PAYMENT            — written by cart checkout and by
 *                                 acceptSpecialOffer.
 *   PAYMENT_EXPIRED             — expiry worker outcome, `paymentStatus`
 *                                 EXPIRED.
 *   CANCELLED_UNPAID            — expiry/late-payment/customer-cancel outcome
 *                                 for an order that was never paid.
 */
export const PRE_PAYMENT_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.WAITING_VENDOR_CONFIRMATION,
  OrderStatus.WAITING_CUSTOMER_APPROVAL,
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PAYMENT_EXPIRED,
  OrderStatus.CANCELLED_UNPAID,
];

/**
 * Payment markers that mean "this order's money was actually settled": taken
 * by the customer (`SUCCESS`, written by the finalizer's conditional claim) or
 * returned to them afterwards (`REFUNDED`, written by the refund finalizer).
 *
 * Deliberately NOT included: PENDING, INITIATED, FAILED, EXPIRED,
 * LATE_PAYMENT, AMOUNT_MISMATCH — none of which represent captured money.
 */
export const SETTLED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.SUCCESS,
  PaymentStatus.REFUNDED,
];

export interface VendorVisibilityRow {
  status: OrderStatus;
  paymentStatus: PaymentStatus | null;
}

/**
 * True when `order` may be surfaced to the vendor as a vendor order.
 * Pure and independently testable — see tests/unit/vendorOrderVisibility.test.ts.
 */
export function isVendorVisibleOrder(order: VendorVisibilityRow): boolean {
  if (PRE_PAYMENT_ORDER_STATUSES.includes(order.status)) return false;
  return (
    order.paymentStatus !== null &&
    SETTLED_PAYMENT_STATUSES.includes(order.paymentStatus)
  );
}

/**
 * The same rule as a Prisma `where` fragment, so a query cannot drift from
 * `isVendorVisibleOrder`. Used by every vendor-facing order query.
 */
export const VENDOR_VISIBLE_ORDER_WHERE: Prisma.OrderWhereInput = {
  status: { notIn: [...PRE_PAYMENT_ORDER_STATUSES] },
  paymentStatus: { in: [...SETTLED_PAYMENT_STATUSES] },
};

/**
 * Compose the visibility rule with a caller-supplied filter.
 *
 * Kept as a helper (rather than spreading the fragment inline at each call
 * site) so a future status or payment marker is added in exactly one place and
 * every vendor-facing surface moves together.
 */
export function vendorVisibleOrderWhere(
  base: Prisma.OrderWhereInput = {},
): Prisma.OrderWhereInput {
  return { AND: [base, VENDOR_VISIBLE_ORDER_WHERE] };
}

/**
 * Cache key for the vendor dashboard summary.
 *
 * The `:v2` suffix is a deliberate, one-shot invalidation of any summary entry
 * written by the previous code, which could have been built from the unfiltered
 * order list. Without it a deploy would keep serving an unpaid order from
 * `getDashboardSummary`'s 5-minute Redis cache until that TTL elapsed.
 *
 * `clearCaches.ts` deletes this exact key via `vendorDashboardCacheKey`, so the
 * two cannot drift.
 */
export function vendorDashboardCacheKey(vendorId: string): string {
  return `vendor:${vendorId}:dashboardSummary:v2`;
}
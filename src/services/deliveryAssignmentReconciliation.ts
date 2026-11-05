/**
 * F4-1 — INV-1: terminal-order / delivery-assignment lifecycle consistency.
 *
 * INV-1:
 *   If an order reaches a terminal state (COMPLETED / CANCELLED /
 *   FAILED_DELIVERY / CANCELLED_UNPAID / REFUNDED), it must not retain any
 *   active DeliveryAssignment (ASSIGNED / ACCEPTED / PICKED_UP / EN_ROUTE).
 *
 * This module is deliberately tiny and side-effect free. It contains no policy:
 *
 *   - It never creates a DeliveryEarning.
 *   - It never touches walletBalance or any rider compensation.
 *   - It never deletes an assignment — history is preserved, rows are moved to
 *     a terminal status only.
 *   - It never widens the delivery state machine.
 *
 * WHY `CANCELLED` IS THE RECONCILIATION TARGET (derived, not chosen)
 * ---------------------------------------------------------------
 * `DeliveryAssignmentService.DELIVERY_TRANSITIONS` is the existing state
 * machine. Intersecting the terminal statuses reachable from each ACTIVE
 * status:
 *
 *   ASSIGNED   -> { CANCELLED }
 *   ACCEPTED   -> { CANCELLED }
 *   PICKED_UP  -> { DELIVERED, FAILED, CANCELLED }
 *   EN_ROUTE   -> { DELIVERED, FAILED, CANCELLED }
 *
 *   intersection = { CANCELLED }
 *
 * So CANCELLED is the ONLY terminal status the existing state machine permits
 * from all four active statuses. It is the forced answer, not a policy
 * decision. DELIVERED / FAILED / RETURNED are unreachable from ASSIGNED or
 * ACCEPTED and marking an assignment DELIVERED would manufacture rider
 * compensation for a delivery nobody confirmed — explicitly out of scope for
 * F4-1 and deferred to F4-2.
 *
 * LOCK ORDERING (global, must not diverge)
 * ----------------------------------------
 *   [DeliveryPerson] -> Order -> DeliveryAssignment
 *
 * The DeliveryPerson lock is taken ONLY by the dispatch/capacity paths
 * (F5-B: `assignOrder` manual, `acceptBroadcast`). This module never locks a
 * DeliveryPerson, so it cannot introduce an inverse edge. Every caller reaches
 * an assignment only after it has locked (or CAS-updated) its Order row, which
 * is the same relative order F3's `claimOrderRow` uses. See the lock-order
 * notes on `DeliveryAssignmentService.updateStatus`.
 */
import { Prisma, DeliveryStatus, OrderStatus } from "@prisma/client";

/**
 * Assignment statuses that own an order's delivery. Mirrors the set
 * `deliveryAssignment.assertNoActiveAssignment` has always used (N-05B), and
 * is the exact predicate of F3's `DeliveryAssignment_one_active_per_order`
 * partial unique index. Moved here (not copied) so there is one definition.
 */
export const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.ACCEPTED,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.EN_ROUTE,
];

/**
 * Order statuses after which no delivery work may legitimately continue.
 *
 * `REFUNDED` is a *payment* status, not an order status, so it is absent here
 * by design: the refund path pairs `paymentStatus = REFUNDED` with
 * `status = CANCELLED`, and CANCELLED is already terminal. Callers that hold a
 * freshly-written order should test the order status, not the payment status.
 */
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.FAILED_DELIVERY,
  OrderStatus.CANCELLED_UNPAID,
];

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

/**
 * Order statuses from which a delivery may still be dispatched.
 *
 * F4-4: this is the authoritative "can this order be given to a rider?" set, and
 * it lives here (moved, values unchanged, from `deliveryAssignment.ts`) so the
 * dispatch claim, the admin override guard and the preflight screen can never
 * drift apart. Only an order in one of these states can pass
 * `claimOrderRow`, so only a transition INTO one of these can reopen an order.
 */
export const DISPATCHABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.OUT_FOR_DELIVERY,
];

export function isDispatchableOrderStatus(status: OrderStatus): boolean {
  return DISPATCHABLE_ORDER_STATUSES.includes(status);
}

/**
 * Moves every active delivery assignment for `orderId` to `CANCELLED`, inside
 * the caller's transaction.
 *
 * Atomicity: a single conditional UPDATE, so it is safe under concurrency —
 * two callers reconciling the same order cannot interleave into a partial
 * state, and a row already moved to a terminal status by someone else simply
 * matches no row.
 *
 * It does NOT assume at most one active row. F3's partial unique index normally
 * guarantees that, but legacy data predating the index (or a manual DBA fix)
 * could hold more than one; `updateMany` terminalizes all of them rather than
 * leaving an orphan behind.
 *
 * @param tx the caller's transaction — this helper never opens its own, so the
 *           reconciliation is atomic with the terminal order transition that
 *           the caller is writing.
 * @returns the number of assignments moved out of an active status.
 */
export async function reconcileActiveDeliveryAssignments(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const reconciled = await tx.deliveryAssignment.updateMany({
    where: { orderId, status: { in: ACTIVE_DELIVERY_STATUSES } },
    data: { status: DeliveryStatus.CANCELLED },
  });
  return reconciled.count;
}

/**
 * Loads the ids of the given orders that are currently terminal.
 *
 * Used after a bulk terminal transition (the refund path writes several orders
 * with one `updateMany`, which reports only a count) so reconciliation is
 * applied to exactly the orders that actually became terminal — never to one
 * that the bulk write skipped because it was already in another state.
 */
export async function findTerminalOrderIds(
  tx: Prisma.TransactionClient,
  orderIds: string[],
): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.order.findMany({
    where: { id: { in: orderIds }, status: { in: TERMINAL_ORDER_STATUSES } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

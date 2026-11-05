/**
 * F4-2 — the single authoritative rider compensation for a completed order.
 *
 * BEFORE F4-2 there was exactly one writer of `DeliveryEarning`: the driver
 * path, `DeliveryAssignmentService.updateStatus(DELIVERED)`. An order that
 * reached `Order.status = COMPLETED` through the canonical customer/order path
 * therefore produced NO earning and NO wallet credit at all — the rider
 * physically delivered the order and was never paid.
 *
 * This module is the ONE implementation of that payout. Both completion routes
 * call it:
 *
 *   1. `DeliveryAssignmentService.updateStatus(DELIVERED)` — driver confirmed.
 *   2. `updateOrderStatus(COMPLETED)` — customer/order confirmed.
 *
 * The amount is UNCHANGED from the pre-existing driver `DELIVERED` behaviour:
 * the order's own `deliveryFee`, split into a base and a distance component.
 * No new fee formula is introduced here — see `DELIVERY_BASE_FEE` handling in
 * `creditDeliveryEarning`.
 *
 * IDEMPOTENCY — why the DeliveryEarning row is the idempotency record
 * ------------------------------------------------------------------
 * `DeliveryPerson.walletBalance` is a bare `Float` with no ledger behind it, so
 * "have I already paid for this order?" cannot be answered from the wallet
 * itself. It CAN be answered from the earning row, because this function
 * writes the earning and the wallet credit in the SAME transaction:
 *
 *     earning exists  <=>  wallet was credited
 *
 * There is no window in which one commits without the other. So the correct
 * exactly-once test is a read of `DeliveryEarning` by `orderId`, and it is safe
 * because BOTH completion routes hold the `Order` row for the whole
 * transaction before reaching here:
 *
 *   - the customer path CASes the Order (`tx.order.update`), which locks it;
 *   - the driver path takes it explicitly (`SELECT ... FOR UPDATE`).
 *
 * Two concurrent completions of the same order are therefore serialised on that
 * row, and the second one observes the first one's committed earning and
 * becomes a no-op. `DeliveryEarning @@unique([orderId])` (F9) remains the
 * database-level backstop underneath.
 *
 * We deliberately do NOT credit the wallet and then catch the unique violation:
 * that ordering yields one earning plus TWO wallet credits.
 */
import { Prisma, DeliveryStatus, OrderStatus, PaymentStatus } from "@prisma/client";
import { logger } from "../lib/logger";
import { ConflictError } from "../errors/AppError";

export type DeliveryEarningOutcome =
  /** A rider was identified and paid in this call. */
  | "credited"
  /** An earning already existed for this order — nothing to do. */
  | "already-credited"
  /** The order is not a paid, completed delivery. */
  | "ineligible"
  /** No rider ever held this order, so there is nobody to pay. */
  | "no-rider";

/**
 * Identifies the rider entitled to the earning for `orderId`.
 *
 * Mechanical, not a policy choice: the rider who most recently HELD the order.
 * A `DECLINED` assignment is excluded because that rider never took it — that
 * row exists only because `handleDecline` records the refusal before
 * re-dispatching. A `DELIVERED` row is preferred when one exists, because that
 * is the rider who actually completed the leg.
 *
 * This works both before and after F4-1's reconciliation, which moves a
 * stranded active assignment to `CANCELLED`: a `CANCELLED` row still identifies
 * its rider, it is simply not preferred over an explicit `DELIVERED`.
 */
async function resolveRider(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ holderId: string | null; holderIds: Set<string> }> {
  const assignments = await tx.deliveryAssignment.findMany({
    where: { orderId, status: { not: DeliveryStatus.DECLINED } },
    orderBy: { createdAt: "desc" },
    select: { deliveryPersonId: true, status: true },
  });
  const holderIds = new Set(assignments.map((a) => a.deliveryPersonId));
  if (assignments.length === 0) return { holderId: null, holderIds };
  const delivered = assignments.find((a) => a.status === DeliveryStatus.DELIVERED);
  return { holderId: (delivered ?? assignments[0]).deliveryPersonId, holderIds };
}

/**
 * F4-4 — the committed `DeliveryEarning` is the definitive financial barrier
 * against redispatching a settled order.
 *
 * Called INSIDE the dispatch transaction, immediately after `claimOrderRow`
 * has locked the Order row, so the check is authoritative rather than a
 * preflight read that could go stale between the read and the insert.
 *
 * Why this is needed on top of the order-status check: `claimOrderRow` already
 * refuses a `COMPLETED` order, so on its own it blocks the normal path. But an
 * admin override can move a settled order back into a dispatchable state, and
 * F3's per-order guard only counts ACTIVE assignments — a `DELIVERED`
 * assignment does not block a new one. Money already paid for an order must
 * keep it from being handed to a second rider regardless of how the order row
 * got rewound.
 *
 * Lock ordering is unchanged: the Order row is already locked by the caller
 * before this runs, and this adds only a plain (non-locking) read, so no new
 * lock edge and no chance of a deadlock with the dispatch or completion paths.
 */
export async function assertOrderNotSettled(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  // The committed earning is the definitive financial barrier.
  const earning = await tx.deliveryEarning.findUnique({
    where: { orderId },
    select: { id: true },
  });
  if (earning) {
    throw new ConflictError(
      "This order has already been paid out to a rider and cannot be dispatched again",
    );
  }

  // Supporting state evidence: a `DELIVERED` assignment means the delivery leg
  // already finished. F3's per-order guard counts only ACTIVE statuses, so on
  // its own it would let a second rider be handed an order someone already
  // completed. This is deliberately a narrow addition — it recognises
  // DELIVERED as evidence and changes no other transition semantics.
  //
  // Note the asymmetry that is intentional: if an order has a DELIVERED
  // assignment but NO earning (legacy or partially-repaired data), dispatching
  // it again is refused here. If such an order is ever genuinely re-delivered
  // by a new rider, that rider completes normally and is paid, because the
  // earning barrier is the only thing that suppresses a payout.
  const delivered = await tx.deliveryAssignment.findFirst({
    where: { orderId, status: DeliveryStatus.DELIVERED },
    select: { id: true },
  });
  if (delivered) {
    throw new ConflictError(
      "This order already has a completed delivery and cannot be dispatched again",
    );
  }
}

/**
 * Credits the rider for `orderId` — exactly once — inside the caller's
 * transaction.
 *
 * The caller MUST already hold the `Order` row lock (see the idempotency note
 * above). Callers must also invoke this only from inside the transaction that
 * performs the completion, so a failure rolls the order transition, the
 * assignment reconciliation and the payout back together.
 */
export async function creditDeliveryEarning(
  tx: Prisma.TransactionClient,
  orderId: string,
  opts: { riderId?: string } = {},
): Promise<DeliveryEarningOutcome> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, paymentStatus: true, deliveryFee: true },
  });
  if (!order) return "ineligible";

  // Both completion routes already require a paid order to reach COMPLETED (the
  // canonical state machine's payment gate, and the driver's mirror predicate).
  // Re-asserted here so this helper is safe for any future caller.
  if (order.status !== OrderStatus.COMPLETED) return "ineligible";
  if (order.paymentStatus !== PaymentStatus.SUCCESS) return "ineligible";

  // Resolve the rider FIRST so an existing earning can be attributed. When the
  // caller names a rider (the driver path), that id is validated against the
  // order's actual assignment holders — a caller-supplied id is never trusted on
  // its own.
  const { holderId, holderIds } = await resolveRider(tx, orderId);

  let riderId: string;
  if (opts.riderId) {
    if (!holderIds.has(opts.riderId)) {
      logger.error(
        { orderId, attemptedRiderId: opts.riderId },
        "F4-4: completion presented by a rider who never held this order",
      );
      throw new ConflictError("You are not the rider for this delivery");
    }
    riderId = opts.riderId;
  } else if (holderId) {
    riderId = holderId;
  } else {
    riderId = "";
  }

  // The exactly-once gate. Safe because the caller holds the Order row lock.
  //
  // F4-4: an earning that already exists is only an acceptable no-op when it
  // belongs to THIS rider. One that belongs to a different rider means a second
  // rider completed a delivery on a settled order — previously that returned
  // `already-credited`, so the caller reported success while the rider was
  // silently never paid. It now fails loudly and rolls the whole completion
  // transaction back, so the second delivery cannot commit in a half-finished
  // state. The wallet is NOT incremented on this path: the duplicate is detected
  // before any financial write.
  const existing = await tx.deliveryEarning.findUnique({
    where: { orderId },
    select: { id: true, deliveryPersonId: true },
  });
  if (existing) {
    if (existing.deliveryPersonId === riderId) return "already-credited";
    logger.error(
      {
        orderId,
        earningId: existing.id,
        existingRiderId: existing.deliveryPersonId,
        attemptedRiderId: riderId,
      },
      "F4-4: delivery completed by a second rider on an already-paid order — completion refused",
    );
    throw new ConflictError(
      "This order has already been completed and paid to another rider",
    );
  }

  if (!riderId) {
    logger.warn({ orderId }, "F4-2: order completed with no rider on any assignment — no earning created");
    return "no-rider";
  }

  // ── Existing amount, unchanged from the driver DELIVERED path ──────────────
  // Phase 3A: order.deliveryFee is integer kobo, so totalEarned is kobo.
  // DELIVERY_BASE_FEE env default is integer kobo (see deliveryFee.service.ts).
  const baseFee = Number(process.env.DELIVERY_BASE_FEE) || 30000;
  const totalEarned = order.deliveryFee;
  const distanceFee = Math.max(totalEarned - baseFee, 0);
  const earningData = {
    baseFee: Math.min(baseFee, totalEarned),
    distanceFee,
    totalEarned,
  };

  await tx.deliveryPerson.update({
    where: { id: riderId },
    data: { totalDeliveries: { increment: 1 }, walletBalance: { increment: totalEarned } },
  });

  // `upsert` rather than `create`: a retry after a rolled-back attempt, or a
  // concurrent caller that slipped past the read above, must not surface F9's
  // unique violation as normal control flow.
  await tx.deliveryEarning.upsert({
    where: { orderId },
    create: { deliveryPersonId: riderId, orderId, ...earningData },
    update: earningData,
  });

  return "credited";
}

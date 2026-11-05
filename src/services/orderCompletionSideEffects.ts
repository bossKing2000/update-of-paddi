import { creditReferralRewardIfEligible } from "../controllers/referralController";
import {
  creditPotPointsForCompletedOrder,
  logPotPointsFailure,
} from "./potPoints.service";
import { logger } from "../lib/logger";

/**
 * N-05C (F1): the completion side effects an order earns by reaching
 * `OrderStatus.COMPLETED`, shared by every path that can complete one.
 *
 * There are exactly two production paths that set COMPLETED today:
 *
 *   1. the canonical one — `orderController.updateOrderStatus`, which the
 *      transition table allows from OUT_FOR_DELIVERY (customer role), and
 *   2. the driver one — `DeliveryAssignmentService.updateStatus(DELIVERED)`,
 *      whose N-05A conditional mirror can also land the order on COMPLETED.
 *
 * Before this helper only path 1 ran these effects, so a delivery completed by
 * the driver — the normal end state of a delivered order — silently forfeited
 * the customer's Pot Points and the referrer's first-order reward. Same
 * terminal status, different business outcome, purely because of which writer
 * won.
 *
 * This is deliberately only the *invocation* block lifted out of
 * `updateOrderStatus`. The referral and Pot Points implementations are not
 * touched, moved, re-implemented or wrapped in a transaction:
 *
 *   - Both remain fire-and-forget. The canonical path has always let completion
 *     succeed even if loyalty crediting fails, and a completion that fails
 *     because a points insert did would be strictly worse.
 *   - Both keep their existing warn-level logging on failure.
 *   - Both keep their existing idempotency guarantees, which are what make it
 *     safe to call this from two paths: `PotPointTransaction.orderId` is
 *     `@unique` (exactly-once per order) and `ReferralReward` is
 *     `@unique([referrerId, referredId])` (at-most-once per referral
 *     relationship; a racing duplicate surfaces as a caught unique violation).
 *   - Neither is made transactionally coupled to the order status write, since
 *     that would change existing failure semantics for path 1.
 *
 * Callers must invoke this only once they know the order actually reached
 * COMPLETED — i.e. after their own CAS succeeded. Calling it speculatively
 * would credit loyalty for orders that were never completed.
 */
export function runOrderCompletionSideEffects(orderId: string, customerId: string): void {
  // Referrals: check (and credit, if eligible) once an order actually
  // completes — the referred customer's *first* completed order is what
  // triggers a reward for whoever referred them.
  creditReferralRewardIfEligible(customerId, orderId).catch((err) =>
    logger.warn(
      { err, orderId, customerId },
      "Failed to check/credit referral reward",
    ),
  );
  // Pot Points: +50 per completed order, idempotent per orderId.
  // Fire-and-forget like referrals — completion must never fail here.
  creditPotPointsForCompletedOrder(orderId, customerId).catch((err) =>
    logPotPointsFailure(err, { orderId, customerId }),
  );
}
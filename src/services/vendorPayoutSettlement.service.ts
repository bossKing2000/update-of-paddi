import prisma from "../lib/prisma";
import { PayoutStatus } from "@prisma/client";

/**
 * Stage N-06: the ONE place a vendor payout's terminal state is applied.
 *
 * Every settlement path (Paystack webhook, transfer-initiation failure, and
 * the reconciliation worker) funnels through here, so the safety property
 * cannot drift between them.
 *
 * The rule that matters:
 *
 *   Only the writer that wins the `PROCESSING` status CAS may apply the
 *   financial side effect.
 *
 * A payout is "claimed" by its ORDERS carrying `payoutId = <payout.id>`, not
 * by the payout row itself. So:
 *
 *   success  -> PROCESSING -> PAID   : orders KEEP their claim (the money is
 *                                      now genuinely owed-and-paid)
 *   failure  -> PROCESSING -> FAILED : orders RELEASE their claim
 *                                      (payoutId -> null), returning the
 *                                      orders to the eligible pool
 *
 * Releasing on failure is only safe because a FAILED payout can never
 * settle afterwards: the webhook's status guard + CAS, this CAS, the
 * reconciler (PROCESSING only) and `markPayoutPaid` (PENDING && no
 * reference) all refuse a FAILED payout, and `processPayout({payoutId})`
 * additionally refuses a payout that no longer owns any orders. So a
 * released order can only ever be re-claimed by a brand-new payout — never
 * double-paid through the old one.
 */

export type VendorPayoutSettlementOutcome =
  | { outcome: "SETTLED" }
  | { outcome: "ALREADY_TERMINAL"; status: string };

/**
 * Settles a PROCESSING payout as PAID. Order claims are intentionally left
 * untouched — the orders belong to a paid-out payout.
 */
export async function settleVendorPayoutPaid(
  payoutId: string,
): Promise<VendorPayoutSettlementOutcome> {
  const claimed = await prisma.vendorPayout.updateMany({
    where: { id: payoutId, status: PayoutStatus.PROCESSING },
    data: {
      status: PayoutStatus.PAID,
      paidAt: new Date(),
      failureReason: null,
    },
  });
  if (claimed.count === 1) return { outcome: "SETTLED" };
  const current = await prisma.vendorPayout.findUnique({
    where: { id: payoutId },
    select: { status: true },
  });
  return {
    outcome: "ALREADY_TERMINAL",
    status: current?.status ?? "UNKNOWN",
  };
}

/**
 * Settles a PROCESSING payout as FAILED **and releases every order it still
 * holds**, atomically.
 *
 * The payout status transition and the claim release share one transaction,
 * so there is no instant at which a payout is FAILED while its orders are
 * still bound (or vice versa). The release is scoped by
 * `payoutId = <this payout>`, so orders belonging to any other payout are
 * never touched.
 *
 * If the CAS matches no row, another path already settled this payout and
 * owns the outcome — in particular a concurrent `transfer.success` webhook,
 * which would have moved it to PAID. In that case NOTHING is released.
 */
export async function settleVendorPayoutFailed(
  payoutId: string,
  failureReason: string,
): Promise<
  VendorPayoutSettlementOutcome & { releasedOrders: number }
> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.vendorPayout.updateMany({
      where: { id: payoutId, status: PayoutStatus.PROCESSING },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: String(failureReason || "Transfer failed").slice(0, 500),
      },
    });
    if (claimed.count !== 1) {
      const current = await tx.vendorPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      return {
        outcome: "ALREADY_TERMINAL" as const,
        status: current?.status ?? "UNKNOWN",
        releasedOrders: 0,
      };
    }

    // Only the CAS winner releases the claims.
    const released = await tx.order.updateMany({
      where: { payoutId },
      data: { payoutId: null },
    });
    return {
      outcome: "SETTLED" as const,
      status: PayoutStatus.FAILED,
      releasedOrders: released.count,
    };
  });
}

import prisma from "../lib/prisma";

/**
 * Stage O-C (N-03): the ONE place a rider withdrawal's money movement is
 * applied locally.
 *
 * Both the Paystack `transfer.*` webhook and the reconciliation worker call
 * these two functions, so the safety property cannot drift between paths:
 *
 *   > A RiderWithdrawal can debit its rider's wallet AT MOST ONCE,
 *     regardless of how many webhooks, reconcilers or admins race.
 *
 * Both are compare-and-set on `status: "PROCESSING"`. The row only moves out
 * of PROCESSING once, so:
 *   - the transaction that wins the CAS is the only one allowed to debit,
 *   - a duplicate/late webhook against an already-terminal row is a no-op,
 *   - `transfer.failed` can never reverse a withdrawal already PAID,
 *   - a failure never touches the wallet (the wallet is only ever debited
 *     on success, and it was never debited before that).
 */

export type RiderWithdrawalSettlementOutcome =
  | { outcome: "SETTLED" }
  | { outcome: "ALREADY_TERMINAL"; status: string }
  | { outcome: "NOT_FOUND" };

/**
 * Settles a withdrawal as PAID and debits the rider's wallet atomically.
 *
 * The wallet debit happens inside the same transaction as the status
 * transition and only when that transition actually changed a row, so a
 * lost/duplicated/replayed settlement can never double-debit.
 */
export async function settleRiderWithdrawalPaid(
  withdrawalId: string,
): Promise<RiderWithdrawalSettlementOutcome> {
  return prisma.$transaction(async (tx) => {
    const withdrawal = await tx.riderWithdrawal.findUnique({
      where: { id: withdrawalId },
    });
    if (!withdrawal) return { outcome: "NOT_FOUND" as const };

    const claimed = await tx.riderWithdrawal.updateMany({
      where: { id: withdrawalId, status: "PROCESSING" },
      data: {
        status: "PAID",
        processedAt: new Date(),
        failureReason: null,
      },
    });
    if (claimed.count !== 1) {
      return {
        outcome: "ALREADY_TERMINAL" as const,
        status: withdrawal.status,
      };
    }

    await tx.deliveryPerson.update({
      where: { id: withdrawal.deliveryPersonId },
      data: { walletBalance: { decrement: withdrawal.amount } },
    });
    return { outcome: "SETTLED" as const };
  });
}

/**
 * Settles a withdrawal as FAILED, releasing its funds reservation by
 * definition (FAILED is excluded from the reserved-balance aggregate).
 * The wallet is never touched here: it was only ever debited on success.
 */
export async function settleRiderWithdrawalFailed(
  withdrawalId: string,
  failureReason: string,
): Promise<RiderWithdrawalSettlementOutcome> {
  const claimed = await prisma.riderWithdrawal.updateMany({
    where: { id: withdrawalId, status: "PROCESSING" },
    data: {
      status: "FAILED",
      failureReason: String(failureReason || "Transfer failed").slice(0, 500),
      processedAt: new Date(),
    },
  });
  if (claimed.count === 1) return { outcome: "SETTLED" as const };
  const current = await prisma.riderWithdrawal.findUnique({
    where: { id: withdrawalId },
    select: { status: true },
  });
  if (!current) return { outcome: "NOT_FOUND" as const };
  return { outcome: "ALREADY_TERMINAL" as const, status: current.status };
}

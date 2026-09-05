import prisma from "../lib/prisma";
import { logger } from "../lib/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Pot Points — minimal Bottom Pot loyalty (Phase 1: earn-only).
//
// PRODUCT DECISION (reported, deterministic, explainable):
//   +50 points per COMPLETED order ("Get 50 points on every order").
//   Fixed per order (not per naira) to match the intended Home messaging,
//   keep the first version trivially auditable, and avoid fractional math.
//   Only paid orders can reach COMPLETED (orderController enforces
//   paymentStatus === SUCCESS), so points always represent real purchases.
//
// SAFETY:
//   - Server-side only. No endpoint accepts client-submitted point values.
//   - Idempotent per order: PotPointTransaction.orderId is UNIQUE, so a
//     double-processed completion credits exactly once.
//   - Balance column mirrors SUM(ledger); only creditPotPoints writes it,
//     inside the same transaction as the ledger insert.
//   - Redemption is out of scope: REDEEM rows/history shape already exist,
//     but no spend endpoint is exposed yet.
// ─────────────────────────────────────────────────────────────────────────────

export const POT_POINTS_PER_ORDER = 50;

export interface PotPointHistoryItem {
  id: string;
  points: number;
  type: "EARN" | "REDEEM" | "ADJUST";
  reason: string;
  orderId: string | null;
  createdAt: Date;
}

/**
 * Credits Pot Points for a completed order. Safe to call more than once
 * for the same order (unique orderId guard) and safe to fire-and-forget
 * (throws are the caller's choice — order completion must never fail
 * because loyalty crediting did).
 */
export async function creditPotPointsForCompletedOrder(
  orderId: string,
  customerId: string,
): Promise<{ credited: boolean; balance: number }> {
  const existing = await prisma.potPointTransaction.findFirst({
    where: { orderId },
    select: { id: true },
  });
  if (existing) {
    const user = await prisma.user.findUnique({
      where: { id: customerId },
      select: { potPointsBalance: true },
    });
    return { credited: false, balance: user?.potPointsBalance ?? 0 };
  }

  const reason = "Order completed — Pot Points earned";
  const [, user] = await prisma.$transaction([
    prisma.potPointTransaction.create({
      data: {
        userId: customerId,
        points: POT_POINTS_PER_ORDER,
        type: "EARN",
        reason,
        orderId,
      },
    }),
    prisma.user.update({
      where: { id: customerId },
      data: { potPointsBalance: { increment: POT_POINTS_PER_ORDER } },
      select: { potPointsBalance: true },
    }),
  ]);
  return { credited: true, balance: user.potPointsBalance };
}

export async function getPotPointsBalance(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { potPointsBalance: true },
  });
  return user?.potPointsBalance ?? 0;
}

export async function getPotPointsHistory(
  userId: string,
  take = 20,
): Promise<PotPointHistoryItem[]> {
  const rows = await prisma.potPointTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(take, 1), 50),
    select: {
      id: true,
      points: true,
      type: true,
      reason: true,
      orderId: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    points: r.points,
    type: r.type as PotPointHistoryItem["type"],
    reason: r.reason,
    orderId: r.orderId,
    createdAt: r.createdAt,
  }));
}

export function logPotPointsFailure(
  err: unknown,
  context: Record<string, unknown>,
): void {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err), ...context },
    "Failed to credit Pot Points",
  );
}

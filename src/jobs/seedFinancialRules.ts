/**
 * Shared financial rules for seeders.
 *
 * WHY THIS EXISTS SEPARATELY FROM `src/services/deliveryEarning.ts`
 * -------------------------------------------------------------------------
 * The production rider payout is written by `creditDeliveryEarning`
 * (`src/services/deliveryEarning.ts`), which splits the order's delivery fee
 * into a base and a distance component and credits the wallet:
 *
 *     totalEarned = order.deliveryFee
 *     baseFee     = min(DELIVERY_BASE_FEE || 30000, totalEarned)
 *     distanceFee = max(totalEarned - baseFee, 0)
 *     walletBalance += totalEarned
 *     totalDeliveries += 1
 *
 * The deterministic financial fixtures must reproduce that arithmetic exactly,
 * otherwise a fixture would assert a payout the application would never make.
 * The production function performs its arithmetic inline inside a transaction
 * and is not a pure export, so seeders cannot call it without opening a
 * transaction and (in the fixtures' existence-guarded helpers) potentially
 * writing records.
 *
 * This module mirrors that arithmetic as a pure function. It is deliberately a
 * *seeder-local* copy rather than a refactor of the production service, because
 * changing `src/services/deliveryEarning.ts` is outside the seeder-reliability
 * scope of this task.
 *
 * The drift risk of duplicating the rule is managed by
 * `tests/unit/seederSafety.test.ts`, which pins this file's formula against the
 * literal arithmetic in the production source. If the production split ever
 * changes, that test fails and this copy must be updated in the same change.
 */

/** Mirrors `Number(process.env.DELIVERY_BASE_FEE) || 30000` in production. */
export function deliveryBaseFee(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.DELIVERY_BASE_FEE) || 30000;
}

export interface DeliveryEarningAmounts {
  baseFee: number;
  distanceFee: number;
  totalEarned: number;
}

/**
 * Derives the per-rider earning split from an order's delivery fee, matching
 * `creditDeliveryEarning` exactly.
 */
export function deriveDeliveryEarningAmounts(
  totalEarned: number,
  env: NodeJS.ProcessEnv = process.env,
): DeliveryEarningAmounts {
  const baseFee = deliveryBaseFee(env);
  return {
    baseFee: Math.min(baseFee, totalEarned),
    distanceFee: Math.max(totalEarned - baseFee, 0),
    totalEarned,
  };
}

/**
 * Financial starting position for a bulk demo rider.
 *
 * The bulk demo seeder creates `DELIVERED` assignments against `COMPLETED`
 * orders but deliberately creates NO `DeliveryEarning` rows — the deterministic
 * financial fixtures (F1-F9 in `seedFinancialFixtures.ts`) are the single
 * reference for rider compensation, and keeping the two datasets distinguishable
 * matters for the reconciliation tests that read this database.
 *
 * Because the application's rule is that a wallet balance only ever moves when
 * an earning is recorded (or a withdrawal settles), a rider with no earnings
 * must start at zero. Random balances would be fabricated money that reconciles
 * to nothing, and would make any wallet-versus-earnings reconciliation return a
 * meaningless difference.
 *
 * `totalDeliveries` follows the same rule: production increments it in the same
 * statement as the wallet credit, so it tracks earned deliveries and must be 0
 * for a rider with no earnings.
 */
export const DEMO_RIDER_FINANCIALS = {
  walletBalance: 0,
  totalDeliveries: 0,
} as const;
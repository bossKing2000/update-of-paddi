import type { Prisma, PrismaClient } from "@prisma/client";
import { ValidationError } from "../errors/AppError";

/**
 * Phase 3.2b going-forward financial snapshots.
 *
 * Pure calculation module (no DB, no Paystack): given the already-finalized
 * integer-kobo order values and the vendor commission rate actually applied,
 * it produces the integer-kobo snapshots stored on Order. Historical rows
 * stay NULL — this module never backfills, it only snapshots new orders.
 *
 * Rounding policy: identical to the existing payout semantics in
 * `calculatePayoutAmounts` (vendorDashboard.service.ts) — commission is
 * computed directly in the integer-kobo domain as `basePriceKobo * rate`,
 * so `Math.round(basePriceKobo * rate)` rounds to the nearest kobo. No new
 * rounding policy is introduced here; all inputs and outputs are integer
 * kobo (Phase 3A).
 */

/** Business-rule fallback, mirroring the schema default and the admin payout fallback. */
export const DEFAULT_COMMISSION_RATE = 0.15;

export interface OrderMoneySnapshotInput {
  /** Order base in integer kobo (Phase 3A) — net of discount, delivery fee excluded from the commission base. */
  basePriceKobo: number;
  /** Discount actually applied to this vendor order in integer kobo (0 when none). */
  discountKobo: number;
  /** The exact vendor commission rate applied to this order (0–1). */
  commissionRate: number;
}

export interface OrderMoneySnapshot {
  /** The exact rate the commission below was computed from. */
  commissionRateSnapshot: number;
  /** Platform commission for this order, kobo. */
  commissionKobo: bigint;
  /** Net vendor share for this order, kobo (gross minus commission, integer domain). */
  vendorPayoutKobo: bigint;
  /** Discount granted on this order, kobo. */
  discountKobo: bigint;
}

function assertFiniteMoney(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`Invalid snapshot value for ${field}`, {
      field,
      value,
    });
  }
}

/**
 * Resolve the effective commission rate, preserving the existing
 * `?? 0.15` business-rule fallback. User.commissionRate is NOT NULL so the
 * fallback only triggers for missing/undefined reads — it is recorded here
 * (not scattered across writers) so the snapshotted rate is always the
 * rate actually used.
 */
export function resolveCommissionRate(
  rate: number | null | undefined,
): number {
  const resolved = rate ?? DEFAULT_COMMISSION_RATE;
  assertFiniteMoney(resolved, "commissionRate");
  return resolved;
}

/**
 * Phase 3.2b refund order attribution — the single shared rule for every
 * RefundRequest creation path.
 *
 * Returns the exact Order.id when the payment maps to precisely one of the
 * customer's orders, otherwise null. A payment whose idempotencyKey spans
 * multiple vendor orders stays unattributed (never guess). For legacy
 * null-key payments, the FK-linked primary order is used only after
 * verifying it actually belongs to the requesting customer.
 *
 * Accepts either the global client or a transaction client so callers
 * inside a creation transaction resolve attribution atomically.
 */
export async function resolveRefundOrderId(
  db: Prisma.TransactionClient | PrismaClient,
  payment: { orderId: string; idempotencyKey: string | null },
  customerId: string,
): Promise<string | null> {
  if (payment.idempotencyKey) {
    const matches = await db.order.findMany({
      where: { idempotencyKey: payment.idempotencyKey, customerId },
      select: { id: true },
    });
    return matches.length === 1 ? matches[0].id : null;
  }
  const linked = await db.order.findUnique({
    where: { id: payment.orderId },
    select: { id: true, customerId: true },
  });
  return linked && linked.customerId === customerId ? linked.id : null;
}

export function buildOrderMoneySnapshot(
  input: OrderMoneySnapshotInput,
): OrderMoneySnapshot {
  assertFiniteMoney(input.basePriceKobo, "basePriceKobo");
  assertFiniteMoney(input.discountKobo, "discountKobo");
  assertFiniteMoney(input.commissionRate, "commissionRate");

  // Same expression as calculatePayoutAmounts, per-order grain. All inputs
  // are integer kobo (Phase 3A), so commission is computed directly in kobo
  // (base * rate) and gross/discount pass through unchanged — no * 100 and
  // no toFixed() naira round-trip.
  const commissionKoboRounded = Math.round(input.basePriceKobo * input.commissionRate);
  const grossKoboRounded = input.basePriceKobo;
  const discountKoboRounded = input.discountKobo;
  assertFiniteMoney(commissionKoboRounded, "commissionKobo");
  assertFiniteMoney(grossKoboRounded, "grossKobo");
  assertFiniteMoney(discountKoboRounded, "discountKobo");

  return {
    commissionRateSnapshot: input.commissionRate,
    commissionKobo: BigInt(commissionKoboRounded),
    vendorPayoutKobo: BigInt(grossKoboRounded) - BigInt(commissionKoboRounded),
    discountKobo: BigInt(discountKoboRounded),
  };
}

/**
 * Stage J (E-04): snapshot-authoritative payout aggregation.
 *
 * Sums persisted per-order snapshots with exact integer/BigInt arithmetic.
 * No Float multiplication, no commission rate, no toFixed(), no
 * Math.round() — the kobo values pass through untouched, so commission is
 * effectively rounded once at the per-order level (in
 * `buildOrderMoneySnapshot`) and never recomputed at batch level.
 *
 * Only orders with BOTH `commissionKobo` and `vendorPayoutKobo` present are
 * summed. Orders with NULL snapshots (pre-3.2b legacy rows — NULL means
 * "unknown history", never zero) are NOT included; the caller must handle
 * them via the documented legacy fallback. Grains are never mixed within
 * a single order.
 */
export interface SnapshotBackedOrder {
  commissionKobo: bigint | null;
  vendorPayoutKobo: bigint | null;
}

export interface SnapshotSumKobo {
  /** Number of snapshot-backed orders included in the sums. */
  snapshotOrderCount: number;
  /** Exact integer-kobo totals (commission + vendor payout = gross). */
  grossKobo: bigint;
  commissionKobo: bigint;
  vendorPayoutKobo: bigint;
}

export function sumSnapshotKoboTotals(
  orders: SnapshotBackedOrder[],
): SnapshotSumKobo {
  let grossKobo = 0n;
  let commissionKobo = 0n;
  let vendorPayoutKobo = 0n;
  let snapshotOrderCount = 0;
  for (const order of orders) {
    if (order.commissionKobo === null || order.vendorPayoutKobo === null) {
      continue;
    }
    commissionKobo += order.commissionKobo;
    vendorPayoutKobo += order.vendorPayoutKobo;
    grossKobo += order.commissionKobo + order.vendorPayoutKobo;
    snapshotOrderCount += 1;
  }
  return { snapshotOrderCount, grossKobo, commissionKobo, vendorPayoutKobo };
}

/**
 * Stage M (E-07): payout-time integrity classification for a persisted order
 * money snapshot.
 *
 * This is VALIDATION, never RECOMPUTATION. It asks "are these persisted
 * values internally coherent?" — it never re-derives settlement amounts from
 * a rate (neither the live vendor rate nor `commissionRateSnapshot`), and it
 * never rewrites stored kobo values. The kobo identity checked here is the
 * one `buildOrderMoneySnapshot` itself establishes:
 *
 *   commissionKobo + vendorPayoutKobo === Math.round(basePrice * 100)
 *
 * `LEGACY_NULL` (all snapshot fields absent) is NOT a defect: pre-3.2b rows
 * legitimately carry no history and keep the documented payout fallback.
 * A PARTIALLY populated snapshot is a defect — it can never be safely
 * half-trusted or silently coerced to zero.
 */
export interface OrderMoneySnapshotRow {
  id: string;
  basePrice: number;
  commissionKobo: bigint | null;
  vendorPayoutKobo: bigint | null;
  commissionRateSnapshot: number | null;
}

export type SnapshotDefectReason =
  /** One kobo field present, the other absent — torn/partial write. */
  | "PARTIAL_SNAPSHOT"
  | "NEGATIVE_COMMISSION"
  | "NEGATIVE_VENDOR_PAYOUT"
  /** Present but outside the project's documented [0, 1] rate domain. */
  | "INVALID_COMMISSION_RATE"
  /** basePrice cannot be expressed as integer kobo (non-finite). */
  | "INVALID_BASE_PRICE"
  /** commissionKobo + vendorPayoutKobo contradicts the stored gross. */
  | "INCOHERENT_GROSS";

export interface SnapshotDefect {
  orderId: string;
  reason: SnapshotDefectReason;
}

/**
 * Minimum commission-rate domain enforced by the existing code:
 * `setVendorCommissionRate` rejects anything outside 0–1, so the same domain
 * — plus an explicit finite check — is what a frozen snapshot rate must
 * satisfy when it is present.
 */
export const MIN_COMMISSION_RATE = 0;
export const MAX_COMMISSION_RATE = 1;

/**
 * Returns the defect for a snapshot-backed order, or null when the order is
 * internally coherent. Legacy orders (no monetary snapshot at all) return
 * null — absence of history is not a defect. Pure and deterministic: no
 * database, and settlement amounts are never re-derived from a rate.
 */
export function findOrderMoneySnapshotDefect(
  order: OrderMoneySnapshotRow,
): SnapshotDefect | null {
  const defect = (reason: SnapshotDefectReason): SnapshotDefect => ({
    orderId: order.id,
    reason,
  });

  const hasCommission = order.commissionKobo !== null;
  const hasVendorPayout = order.vendorPayoutKobo !== null;

  // Legacy: no monetary snapshot at all. Not a defect — the payout keeps
  // its documented fallback for this order.
  if (!hasCommission && !hasVendorPayout) return null;

  // Torn write: exactly one monetary field present. Never half-trusted and
  // never coerced to zero.
  if (hasCommission !== hasVendorPayout) return defect("PARTIAL_SNAPSHOT");

  if (order.commissionKobo! < 0n) return defect("NEGATIVE_COMMISSION");
  if (order.vendorPayoutKobo! < 0n) return defect("NEGATIVE_VENDOR_PAYOUT");

  // The frozen rate is audit evidence, not a settlement input: it is
  // validated when present but is never absent-checked, so this guard can
  // never block settlement on metadata alone.
  const rate = order.commissionRateSnapshot;
  if (
    rate !== null &&
    (!Number.isFinite(rate) ||
      rate < MIN_COMMISSION_RATE ||
      rate > MAX_COMMISSION_RATE)
  )
    return defect("INVALID_COMMISSION_RATE");

  if (!Number.isFinite(order.basePrice))
    return defect("INVALID_BASE_PRICE");

  // The builder's own identity — gross is never redefined here.
  // basePrice is already integer kobo (Phase 3A), so gross kobo is basePrice
  // itself — no * 100 and no naira round-trip.
  const expectedGrossKobo = BigInt(order.basePrice);
  if (order.commissionKobo! + order.vendorPayoutKobo! !== expectedGrossKobo)
    return defect("INCOHERENT_GROSS");

  return null;
}

/**
 * Payout-blocking integrity gate: returns every defect across the candidate
 * payout batch so the caller can refuse settlement deterministically instead
 * of silently dropping a corrupt row out of the aggregation.
 */
export function findPayoutSnapshotDefects(
  orders: OrderMoneySnapshotRow[],
): SnapshotDefect[] {
  const defects: SnapshotDefect[] = [];
  for (const order of orders) {
    const defect = findOrderMoneySnapshotDefect(order);
    if (defect) defects.push(defect);
  }
  return defects;
}

/**
 * True when an order carries no monetary snapshot history (pre-3.2b row), so
 * the documented payout fallback applies. A partial snapshot is NOT legacy —
 * `findPayoutSnapshotDefects` rejects it first.
 */
export function isLegacyNullSnapshotOrder(
  order: Pick<OrderMoneySnapshotRow, "commissionKobo" | "vendorPayoutKobo">,
): boolean {
  return order.commissionKobo === null && order.vendorPayoutKobo === null;
}

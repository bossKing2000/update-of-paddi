/**
 * Batch G — read-only financial reconciliation detectors.
 *
 * These functions never write, never call providers, and never mutate
 * historical records. They compare independently-maintained figures that
 * must agree by construction (reservation ledger vs completed refunds,
 * payout rows vs order snapshots, earnings vs order state) and return
 * every discrepancy for human review. A clean result is evidence, not
 * proof — and a finding is an investigation lead, not an auto-correction.
 *
 * Deliberately NOT scheduled by any cron in this batch: wiring continuous
 * scanning is a separate operational decision (cadence, alerting, scale).
 * Each detector accepts a Prisma client so tests inject doubles.
 */

export interface RefundLedgerDiscrepancy {
  paymentRef: string;
  paymentAmountKobo: number;
  reservedKobo: number;
  completedKobo: number;
  issue:
    | "RESERVED_EXCEEDS_CAPTURED"
    | "COMPLETED_EXCEEDS_CAPTURED"
    | "COMPLETED_EXCEEDS_RESERVED";
}

export interface PayoutSettlementDiscrepancy {
  payoutId: string;
  expectedNetKobo: number;
  recordedNetKobo: number;
  issue: "SETTLEMENT_MISMATCH";
}

export interface DeliveryEarningDiscrepancy {
  earningId: string;
  orderId: string;
  orderStatus: string;
  orderPaymentStatus: string | null;
  issue: "EARNING_ON_INELIGIBLE_ORDER";
}

type PrismaLike = {
  payment: { findMany: (args: unknown) => Promise<any[]> };
  refundRequest: { findMany: (args: unknown) => Promise<any[]> };
  vendorPayout: { findMany: (args: unknown) => Promise<any[]> };
  deliveryEarning: { findMany: (args: unknown) => Promise<any[]> };
};

/**
 * Reservation ledger vs completed refunds, per payment reference.
 * Invariants: reserved (refundedAmount) <= captured (amount); completed
 * (SUM COMPLETED) <= captured; completed <= reserved (completion consumes
 * reservation, never exceeds it).
 */
export async function auditRefundLedger(
  prisma: PrismaLike,
): Promise<RefundLedgerDiscrepancy[]> {
  const out: RefundLedgerDiscrepancy[] = [];
  const payments = await prisma.payment.findMany({
    select: { reference: true, amount: true, refundedAmount: true },
  });
  const completed = await prisma.refundRequest.findMany({
    where: { status: "COMPLETED" },
    select: { paymentRef: true, requestedAmountKobo: true },
  });
  const completedByRef = new Map<string, number>();
  for (const r of completed) {
    if (typeof r.requestedAmountKobo === "number") {
      completedByRef.set(r.paymentRef, (completedByRef.get(r.paymentRef) ?? 0) + r.requestedAmountKobo);
    }
  }
  for (const p of payments) {
    const completedKobo = completedByRef.get(p.reference) ?? 0;
    if (p.refundedAmount > p.amount) {
      out.push({
        paymentRef: p.reference,
        paymentAmountKobo: p.amount,
        reservedKobo: p.refundedAmount,
        completedKobo,
        issue: "RESERVED_EXCEEDS_CAPTURED",
      });
    }
    if (completedKobo > p.amount) {
      out.push({
        paymentRef: p.reference,
        paymentAmountKobo: p.amount,
        reservedKobo: p.refundedAmount,
        completedKobo,
        issue: "COMPLETED_EXCEEDS_CAPTURED",
      });
    } else if (completedKobo > p.refundedAmount) {
      out.push({
        paymentRef: p.reference,
        paymentAmountKobo: p.amount,
        reservedKobo: p.refundedAmount,
        completedKobo,
        issue: "COMPLETED_EXCEEDS_RESERVED",
      });
    }
  }
  return out;
}

/**
 * Payout rows vs bound order snapshots. Only payouts whose orders are ALL
 * snapshot-backed are verifiable (legacy all-NULL rows use the documented
 * Float fallback, which this detector cannot re-derive exactly and
 * therefore skips). Expected net is the exact kobo sum, mirroring the
 * settlement equation; the recorded Float amount is converted at the same
 * kobo boundary settlement uses.
 */
export async function auditPayoutSettlement(
  prisma: PrismaLike,
): Promise<PayoutSettlementDiscrepancy[]> {
  const out: PayoutSettlementDiscrepancy[] = [];
  const payouts = await prisma.vendorPayout.findMany({
    select: {
      id: true,
      amount: true,
      orders: {
        select: { vendorPayoutKobo: true },
      },
    },
  });
  for (const payout of payouts) {
    const snapshots = (payout.orders ?? []) as { vendorPayoutKobo: bigint | number | null }[];
    if (snapshots.length === 0) continue;
    if (snapshots.some((o) => o.vendorPayoutKobo == null)) continue; // legacy-mixed: not exactly verifiable
    const expectedNetKobo = snapshots.reduce(
      (sum, o) => sum + Number(o.vendorPayoutKobo),
      0,
    );
    const recordedNetKobo = Number(payout.amount);
    if (expectedNetKobo !== recordedNetKobo) {
      out.push({ payoutId: payout.id, expectedNetKobo, recordedNetKobo, issue: "SETTLEMENT_MISMATCH" });
    }
  }
  return out;
}

/**
 * Delivery earnings require a COMPLETED + SUCCESS order (the only states
 * `creditDeliveryEarning` accepts). Anything else indicates an admin
 * override or a historical anomaly worth reviewing — never auto-reversed.
 */
export async function auditDeliveryEarnings(
  prisma: PrismaLike,
): Promise<DeliveryEarningDiscrepancy[]> {
  const out: DeliveryEarningDiscrepancy[] = [];
  const earnings = await prisma.deliveryEarning.findMany({
    select: {
      id: true,
      orderId: true,
      order: { select: { status: true, paymentStatus: true } },
    },
  });
  for (const e of earnings) {
    const status = e.order?.status;
    const paymentStatus = e.order?.paymentStatus ?? null;
    if (status !== "COMPLETED" || paymentStatus !== "SUCCESS") {
      out.push({
        earningId: e.id,
        orderId: e.orderId,
        orderStatus: String(status),
        orderPaymentStatus: paymentStatus,
        issue: "EARNING_ON_INELIGIBLE_ORDER",
      });
    }
  }
  return out;
}

/**
 * F8 — a vendor payout must never knowingly include an order whose customer
 * refund has consumed part or all of the order's value.
 *
 * The dangerous state, before this fix:
 *
 *   COMPLETED + SUCCESS + payoutId = NULL
 *        + a refund on the payment that paid it (PENDING/APPROVED/PROCESSING/COMPLETED,
 *          or any payment with refundedAmount > 0, or Payment.status = REFUNDED)
 *        → selected as payout-eligible, paid the full frozen vendorPayoutKobo
 *
 * A partial refund makes this invisible: `Payment.status` deliberately stays
 * SUCCESS, and `refundFinalizer.completeRefund` only rewrites the ORDER when it
 * sits in REFUND_CANCELLABLE_ORDER_STATUSES, which excludes COMPLETED.
 *
 * The fix fails CLOSED (withhold the order) rather than netting off a refund,
 * because this repository defines no vendor/platform allocation for refunds —
 * see the rationale at the top of src/services/payoutEligibility.service.ts.
 */
import prisma from "../../src/lib/prisma";
import {
  partitionPayoutBlockedOrders,
  lockPaymentsCoveringOrders,
  PAYOUT_BLOCKING_REFUND_STATUSES,
  type PayoutEligibilityDb,
} from "../../src/services/payoutEligibility.service";
import { getPendingPayouts, processPayout } from "../../src/controllers/admin.controller";
import { VendorDashboardService } from "../../src/controllers/vendorDashboard.service";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findMany: jest.fn(), updateMany: jest.fn() },
    payment: { findMany: jest.fn() },
    refundRequest: { findMany: jest.fn() },
    vendorPayout: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), aggregate: jest.fn(), updateMany: jest.fn() },
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/services/payoutService", () => ({
  __esModule: true,
  createTransferRecipient: jest.fn(async () => ({ recipient_code: "rc-1" })),
  initiateTransfer: jest.fn(async () => ({ status: "success", reference: "tr-1" })),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => {}),
}));

jest.mock("../../src/lib/session", () => ({ deleteAllUserSessions: jest.fn(async () => {}) }));

jest.mock("../../src/utils/encrypt", () => ({
  __esModule: true,
  encrypt: jest.fn((v: string) => v),
  decrypt: jest.fn((v: string) => v),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

const db = prisma as unknown as {
  order: { findMany: jest.Mock; updateMany: jest.Mock };
  payment: { findMany: jest.Mock };
  refundRequest: { findMany: jest.Mock };
  vendorPayout: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    aggregate: jest.Mock;
    updateMany: jest.Mock;
  };
  user: { findMany: jest.Mock; findUnique: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};
/** The mocked Prisma client, typed as whatever the service accepts. */
const eligibilityDb = db as unknown as PayoutEligibilityDb;

const KEY = "idem-1";
const REF = "pay_ref_1";

/** Candidate orders as the payout selectors hand them over (extra columns vary per caller). */
type CandidateOrder = { id: string; idempotencyKey: string | null } & Record<string, unknown>;
let candidates: CandidateOrder[];
/** Payments covering those orders (matched by idempotencyKey). */
let payments: Array<{
  idempotencyKey: string | null;
  reference: string;
  refundedAmount: number;
  status: string;
}>;
/** Refund requests in whatever states the test needs. */
let refunds: Array<{ orderId: string | null; paymentRef: string; status: string }>;

const order = (id: string, key: string | null = KEY): CandidateOrder => ({ id, idempotencyKey: key });
const cleanPayment = { idempotencyKey: KEY, reference: REF, refundedAmount: 0, status: "SUCCESS" };

function install() {
  db.order.findMany.mockImplementation(async () => candidates);
  db.payment.findMany.mockImplementation(async () => payments);
  db.refundRequest.findMany.mockImplementation(async (args: any) => {
    // Mirror the real filter so the test exercises the query the service built.
    const statuses: string[] = args?.where?.status?.in ?? [];
    const or = args?.where?.OR ?? [];
    const orderIds: string[] = or.find((c: any) => c.orderId)?.orderId?.in ?? [];
    const refs: string[] = or.find((c: any) => c.paymentRef)?.paymentRef?.in ?? [];
    return refunds.filter(
      (r) =>
        statuses.includes(r.status) &&
        (orderIds.includes(r.orderId as string) || refs.includes(r.paymentRef)),
    );
  });
}

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

beforeEach(() => {
  jest.clearAllMocks();
  candidates = [order("o-1")];
  payments = [{ ...cleanPayment }];
  refunds = [];
  install();
});

// ---------------------------------------------------------------------------
describe("F8 — refund states that must block payout", () => {
  it("1. an order with no refund at all stays payout-eligible", async () => {
    const { eligible, blocked } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(blocked).toHaveLength(0);
    expect(eligible.map((o) => o.id)).toEqual(["o-1"]);
  });

  it.each(["PENDING", "APPROVED", "PROCESSING", "COMPLETED"])(
    "2. a refund in %s withholds the order",
    async (status) => {
      refunds = [{ orderId: "o-1", paymentRef: REF, status }];
      const { eligible, blocked } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
      expect(blocked.map((o) => o.id)).toEqual(["o-1"]);
      expect(eligible).toHaveLength(0);
    },
  );

  it("3. a batch-level refund (orderId NULL) against the covering payment still withholds", async () => {
    refunds = [{ orderId: null, paymentRef: REF, status: "COMPLETED" }];
    const { eligible, blocked } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(blocked).toHaveLength(1);
    expect(eligible).toHaveLength(0);
  });

  it.each(["REJECTED", "FAILED"])(
    "4. a refund in %s did not move money and does not withhold",
    async (status) => {
      refunds = [{ orderId: "o-1", paymentRef: REF, status }];
      const { eligible, blocked } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
      expect(blocked).toHaveLength(0);
      expect(eligible).toHaveLength(1);
    },
  );

  it("5. a PARTIAL refund withholds the order even though Payment.status stays SUCCESS", async () => {
    // Money left the platform, but the payment still reads SUCCESS — the exact
    // case a status-only check misses.
    payments = [{ ...cleanPayment, refundedAmount: 150_000 }];
    refunds = [{ orderId: "o-1", paymentRef: REF, status: "COMPLETED" }];

    const { eligible, blocked } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(blocked).toHaveLength(1);
    expect(eligible).toHaveLength(0);
  });

  it("5b. refundedAmount > 0 alone withholds even with no live refund request", async () => {
    payments = [{ ...cleanPayment, refundedAmount: 1 }];
    const { eligible } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(eligible).toHaveLength(0);
  });

  it("6. a FULL refund (Payment.status = REFUNDED) withholds the order", async () => {
    payments = [{ ...cleanPayment, refundedAmount: 550_000, status: "REFUNDED" }];
    const { eligible, blocked } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(blocked).toHaveLength(1);
    expect(eligible).toHaveLength(0);
  });

  it("6b. repeated refunds: one failed refund after a successful one does not unblock", async () => {
    payments = [{ ...cleanPayment, refundedAmount: 550_000, status: "REFUNDED" }];
    refunds = [
      { orderId: "o-1", paymentRef: REF, status: "COMPLETED" },
      { orderId: "o-1", paymentRef: REF, status: "FAILED" },
    ];
    const { eligible } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(eligible).toHaveLength(0);
  });

  it("6c. every non-terminal refund status is classified as blocking", () => {
    expect(PAYOUT_BLOCKING_REFUND_STATUSES).toEqual([
      "PENDING",
      "APPROVED",
      "PROCESSING",
      "COMPLETED",
    ]);
    expect(PAYOUT_BLOCKING_REFUND_STATUSES).not.toContain("REJECTED");
    expect(PAYOUT_BLOCKING_REFUND_STATUSES).not.toContain("FAILED");
  });
});

// ---------------------------------------------------------------------------
describe("F8 — batch scope and mapping", () => {
  it("7. a refund on one batch payment withholds every order sharing that key", async () => {
    candidates = [order("o-1"), order("o-2"), order("o-3")];
    refunds = [{ orderId: null, paymentRef: REF, status: "COMPLETED" }];

    const { eligible, blocked } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(eligible).toHaveLength(0);
    expect(blocked).toHaveLength(3);
  });

  it("7b. a clean order is unaffected by another order's refund", async () => {
    candidates = [order("o-1"), order("o-2", "idem-2")];
    payments = [{ ...cleanPayment }, { idempotencyKey: "idem-2", reference: "ref2", refundedAmount: 0, status: "SUCCESS" }];
    refunds = [{ orderId: "o-1", paymentRef: REF, status: "COMPLETED" }];

    const { eligible, blocked } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(blocked.map((o) => o.id)).toEqual(["o-1"]);
    expect(eligible.map((o) => o.id)).toEqual(["o-2"]);
  });

  it("7c. an order with no idempotencyKey is still guarded by its own attributed refund", async () => {
    candidates = [order("o-1", null)];
    payments = [];
    refunds = [{ orderId: "o-1", paymentRef: "anything", status: "PROCESSING" }];

    const { eligible } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(eligible).toHaveLength(0);
  });

  it("7d. no candidates means no queries", async () => {
    const { eligible, blocked } = await partitionPayoutBlockedOrders(eligibilityDb, []);
    expect(eligible).toHaveLength(0);
    expect(blocked).toHaveLength(0);
    expect(db.payment.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("F8 — advisory selectors agree with the claim", () => {
  it("8. admin pending-payouts omits a refunded order from its totals", async () => {
    // Distinct payments: only o-2's payment is tainted, so only o-2 is withheld.
    candidates = [
      { id: "o-1", vendorId: "v-1", totalPrice: 100000, deliveryFee: 0, idempotencyKey: "idem-a" },
      { id: "o-2", vendorId: "v-1", totalPrice: 200000, deliveryFee: 0, idempotencyKey: "idem-b" },
    ];
    payments = [
      { idempotencyKey: "idem-a", reference: "ref-a", refundedAmount: 0, status: "SUCCESS" },
      { idempotencyKey: "idem-b", reference: "ref-b", refundedAmount: 200_000, status: "SUCCESS" },
    ];
    refunds = [{ orderId: "o-2", paymentRef: "ref-b", status: "COMPLETED" }];
    db.user.findMany.mockResolvedValue([
      { id: "v-1", name: "V", brandName: "V", commissionRate: 0.15, bankName: "b", bankCode: "1", bankAccountNumber: "2", paystackRecipientCode: "r", vendorStatus: "ACTIVE" },
    ]);

    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.json = jest.fn().mockReturnValue(r);
    await getPendingPayouts({} as any, r);

    const payload = r.json.mock.calls[0][0];
    expect(payload.data.pending).toHaveLength(1);
    // Only the clean order (1000) is counted — the refunded 2000 is withheld.
    expect(payload.data.pending[0].orderCount).toBe(1);
    expect(payload.data.pending[0].grossRevenue).toBe(1000);
  });

  it("9. the vendor payout summary omits a refunded order from its available balance", async () => {
    candidates = [
      { id: "o-1", totalPrice: 5000, deliveryFee: 500, idempotencyKey: KEY },
    ];
    payments = [{ ...cleanPayment, refundedAmount: 100 }];
    db.user.findUnique.mockResolvedValue({ commissionRate: 0.15, bankName: "b", bankAccountNumber: "2", bankAccountName: "n" });
    db.vendorPayout.findMany.mockResolvedValue([]);
    db.vendorPayout.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    const summary = await new VendorDashboardService("v-1").getPayoutSummary();
    expect(summary.available.orderCount).toBe(0);
    expect(summary.available.grossRevenue).toBe(0);
  });

  it("10. a payout-claimed order is never re-selected", async () => {
    // payoutId is excluded by the selector itself, before this guard runs.
    candidates = [];
    const { eligible } = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(eligible).toHaveLength(0);
    expect(db.refundRequest.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("F8 — refund vs payout coordination", () => {
  it("11. the payout transaction takes the same Payment row lock the refund path takes", async () => {
    // admin.controller.updateRefundStatus locks with:
    //   SELECT id FROM "Payment" WHERE id = $1 FOR UPDATE
    // so the payout claim must lock the same rows or the two paths can both
    // read "safe" and both commit.
    await lockPaymentsCoveringOrders(eligibilityDb, [KEY]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings] = db.$queryRaw.mock.calls[0];
    expect(strings.join(" ")).toContain('SELECT id FROM "Payment"');
    expect(strings.join(" ")).toContain("FOR UPDATE");
  });

  it("11b. no lock is issued when there is nothing to lock", async () => {
    await lockPaymentsCoveringOrders(eligibilityDb, []);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("11c. Race A/B: the refund state is re-read AFTER the lock, so a refund that commits first is seen", async () => {
    // Simulates refund approval committing between the candidate SELECT and the
    // guard. Because the guard runs inside the locked transaction, it observes
    // the committed refund and withholds — the payout can never win the race.
    candidates = [order("o-1")];
    db.payment.findMany.mockResolvedValueOnce([
      { ...cleanPayment, refundedAmount: 0, status: "SUCCESS" },
    ]);
    db.refundRequest.findMany.mockResolvedValueOnce([]);
    const first = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(first.eligible).toHaveLength(1);

    // Refund now approved/reserved before the payout re-reads.
    payments = [{ ...cleanPayment, refundedAmount: 250_000 }];
    refunds = [{ orderId: null, paymentRef: REF, status: "PROCESSING" }];
    install();

    const second = await partitionPayoutBlockedOrders(eligibilityDb, candidates);
    expect(second.eligible).toHaveLength(0);
    expect(second.blocked).toHaveLength(1);
  });
});
// ---------------------------------------------------------------------------
describe("F8 — the payout claim itself", () => {
  const VENDOR = {
    id: "v-1",
    name: "V",
    roles: ["VENDOR"],
    commissionRate: 0.15,
    vendorStatus: "ACTIVE",
    bankName: "Bank",
    bankCode: "001",
    bankAccountNumber: "0123",
    paystackRecipientCode: "rc-1",
  };

  /** Snapshot-backed candidate: commission 15% of 1000n = 15000 kobo, vendor 85000 kobo. */
  const claimable = (id: string, key: string, basePriceKobo: number) => ({
    id,
    vendorId: "v-1",
    status: "COMPLETED",
    paymentStatus: "SUCCESS",
    payoutId: null,
    // Phase 3A: basePrice is integer kobo.
    basePrice: basePriceKobo,
    totalPrice: basePriceKobo,
    deliveryFee: 0,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    commissionKobo: BigInt(Math.round(basePriceKobo * 0.15)),
    vendorPayoutKobo: BigInt(basePriceKobo) - BigInt(Math.round(basePriceKobo * 0.15)),
    commissionRateSnapshot: 0.15,
    idempotencyKey: key,
  });

  function runClaim() {
    db.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === "function" ? arg(db) : arg,
    );
    db.user.findUnique.mockResolvedValue(VENDOR);
    db.order.findMany.mockImplementation(async () => candidates);
    db.payment.findMany.mockImplementation(async () => payments);
    db.refundRequest.findMany.mockImplementation(async (args: any) => {
      const statuses: string[] = args?.where?.status?.in ?? [];
      const or = args?.where?.OR ?? [];
      const orderIds: string[] = or.find((c: any) => c.orderId)?.orderId?.in ?? [];
      const refs: string[] = or.find((c: any) => c.paymentRef)?.paymentRef?.in ?? [];
      return refunds.filter(
        (r) => statuses.includes(r.status) && (orderIds.includes(r.orderId as string) || refs.includes(r.paymentRef)),
      );
    });
    db.vendorPayout.create.mockImplementation(async (args: any) => ({
      id: "vp-1",
      reference: null,
      amount: args.data.amount,
      status: "PENDING",
      ...args.data,
    }));
    // Mirror the real CAS: it must claim every eligible order.
    db.order.updateMany.mockImplementation(async (args: any) => ({
      count: args?.where?.id?.in?.length ?? 0,
    }));
    db.vendorPayout.updateMany.mockResolvedValue({ count: 1 });
    db.vendorPayout.findUnique.mockResolvedValue({ id: "vp-1", status: "PROCESSING", reference: "tr-1" });

    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.json = jest.fn().mockReturnValue(r);
    return processPayout({ body: { vendorId: "v-1" }, user: { id: "admin-1" } } as any, r);
  }

  it("12. a clean order is claimed and paid its full snapshot", async () => {
    candidates = [claimable("o-1", "idem-a", 100000)] as unknown as CandidateOrder[];
    payments = [{ idempotencyKey: "idem-a", reference: "ref-a", refundedAmount: 0, status: "SUCCESS" }];

    await runClaim();

    expect(db.vendorPayout.create).toHaveBeenCalledTimes(1);
    const data = db.vendorPayout.create.mock.calls[0][0].data;
    expect(data.orderCount).toBe(1);
    // VendorPayout.amount is integer kobo (Phase 3A): ₦850.00 = 85000 kobo.
    expect(data.amount).toBe(85000n);
    expect(db.order.updateMany.mock.calls[0][0].where.id).toEqual({ in: ["o-1"] });
  });

  it("13. a PARTIALLY refunded order is withheld from the payout entirely", async () => {
    // Two clean orders + one whose payment has refundedAmount > 0.
    candidates = [
      claimable("o-1", "idem-a", 100000),
      claimable("o-2", "idem-b", 100000),
      claimable("o-3", "idem-c", 500000),
    ] as unknown as CandidateOrder[];
    payments = [
      { idempotencyKey: "idem-a", reference: "ref-a", refundedAmount: 0, status: "SUCCESS" },
      { idempotencyKey: "idem-b", reference: "ref-b", refundedAmount: 0, status: "SUCCESS" },
      { idempotencyKey: "idem-c", reference: "ref-c", refundedAmount: 200_000, status: "SUCCESS" },
    ];
    refunds = [{ orderId: null, paymentRef: "ref-c", status: "COMPLETED" }];

    await runClaim();

    // o-3 is NOT in the claim...
    expect(db.order.updateMany.mock.calls[0][0].where.id).toEqual({ in: ["o-1", "o-2"] });
    // ...and the payout totals only the two clean snapshots.
    const data = db.vendorPayout.create.mock.calls[0][0].data;
    expect(data.orderCount).toBe(2);
    // 2 x ₦850.00 = ₦1,700.00 = 170000 kobo. Never ₦4,250 (o-3) and never any reduced/netted figure.
    expect(data.amount).toBe(170000n);
  });

  it("14. a payout already claimed by another process is not re-claimed", async () => {
    candidates = [claimable("o-1", "idem-a", 1000)] as unknown as CandidateOrder[];
    payments = [{ idempotencyKey: "idem-a", reference: "ref-a", refundedAmount: 0, status: "SUCCESS" }];
    db.order.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(runClaim()).rejects.toThrow(/claimed one or more orders/);
  });

  it("15. when every candidate is withheld the payout is refused, not zero-paid", async () => {
    candidates = [claimable("o-1", "idem-a", 1000)] as unknown as CandidateOrder[];
    payments = [{ idempotencyKey: "idem-a", reference: "ref-a", refundedAmount: 200_000, status: "SUCCESS" }];
    refunds = [{ orderId: "o-1", paymentRef: "ref-a", status: "COMPLETED" }];

    await expect(runClaim()).rejects.toThrow(/No payout-eligible orders/);
    expect(db.vendorPayout.create).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it("16. the claim takes the Payment row lock INSIDE its own transaction", async () => {
    candidates = [claimable("o-1", "idem-a", 1000)] as unknown as CandidateOrder[];
    payments = [{ idempotencyKey: "idem-a", reference: "ref-a", refundedAmount: 0, status: "SUCCESS" }];

    await runClaim();

    const lockCall = db.$queryRaw.mock.calls.find((c) =>
      String(c[0]).includes("FOR UPDATE"),
    );
    expect(lockCall).toBeDefined();
    expect(String(lockCall![0])).toContain('SELECT id FROM "Payment"');
  });
});

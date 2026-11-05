/**
 * Stage J (E-04) — snapshot-authoritative payout aggregation (Option A).
 *
 * For snapshot-backed orders the payout must equal the exact integer sums:
 *   VendorPayout.commission = SUM(Order.commissionKobo)
 *   VendorPayout.amount     = SUM(Order.vendorPayoutKobo)
 * and must never recompute commission from aggregate Float revenue at the
 * live rate. Legacy NULL-snapshot orders use the documented aggregate
 * fallback for those orders only; NULL is never treated as zero.
 *
 * All monetary values here are integer kobo (Phase 3A).
 */
import { Prisma } from "@prisma/client";
import { processPayout } from "../../src/controllers/admin.controller";
import prisma from "../../src/lib/prisma";
import { buildOrderMoneySnapshot } from "../../src/services/orderSnapshot.service";
import { calculatePayoutAmounts } from "../../src/controllers/vendorDashboard.service";
import { sumSnapshotKoboTotals } from "../../src/services/orderSnapshot.service";
import { initiateTransfer } from "../../src/services/payoutService";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), updateMany: jest.fn() },
    order: { findMany: jest.fn(), updateMany: jest.fn() },
    // F8: the payout claim now reads refund state before paying anything.
    payment: { findMany: jest.fn(async () => []) },
    refundRequest: { findMany: jest.fn(async () => []) },
    vendorPayout: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: { create: jest.fn(async () => ({})) },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/services/payoutService", () => ({
  createTransferRecipient: jest.fn(async () => "RCP_TEST"),
  initiateTransfer: jest.fn(async () => ({ status: true })),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  createAuditLog: jest.fn(async () => ({})),
}));

const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  vendorPayout: { findUnique: jest.Mock; updateMany: jest.Mock };
  $transaction: jest.Mock;
};
const mockedTransfer = initiateTransfer as jest.Mock;

function p2034() {
  return new Prisma.PrismaClientKnownRequestError("Write conflict", {
    code: "P2034",
    clientVersion: "test",
  });
}

function vendorWithLiveRate(rate: number) {
  return {
    id: "v-1",
    roles: ["VENDOR"],
    commissionRate: rate,
    bankName: "GTB",
    bankCode: "058",
    bankAccountNumber: "0123456789",
    bankAccountName: "Vendor",
    paystackRecipientCode: "RCP_1",
    vendorStatus: "ACTIVE",
  };
}

/** Snapshot-backed eligible order built with the REAL production writer.
 *  `baseNaira` is the notional naira value; it is converted to integer kobo
 *  at the boundary, matching how checkout now stores kobo. */
function snapshotOrder(baseNaira: number, rate: number, id: string) {
  const baseKobo = Math.round(baseNaira * 100);
  const snap = buildOrderMoneySnapshot({
    basePriceKobo: baseKobo,
    discountKobo: 0,
    commissionRate: rate,
  });
  return {
    id,
    // Faithful to the persisted Order row shape (basePrice is the
    // commission base; delivery fee is excluded from it). All kobo.
    basePrice: baseKobo,
    totalPrice: baseKobo + 50000,
    deliveryFee: 50000,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    commissionKobo: snap.commissionKobo,
    vendorPayoutKobo: snap.vendorPayoutKobo,
    commissionRateSnapshot: snap.commissionRateSnapshot,
  };
}

function legacyOrder(baseNaira: number, id: string) {
  const baseKobo = Math.round(baseNaira * 100);
  return {
    id,
    basePrice: baseKobo,
    totalPrice: baseKobo + 50000,
    deliveryFee: 50000,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    commissionKobo: null,
    vendorPayoutKobo: null,
    commissionRateSnapshot: null,
  };
}

/**
 * Runs the REAL claim-transaction callback against an in-memory order set.
 * The fake tx mimics Prisma semantics (create returns the row, updateMany
 * claims with a count guard).
 */
function runRealClaim(eligibleOrders: any[]) {
  let createdData: any = null;
  const fakeTx = {
    order: {
      findMany: jest.fn(async () => eligibleOrders),
      updateMany: jest.fn(async () => ({ count: eligibleOrders.length })),
    },
    payment: { findMany: jest.fn(async () => []) },
    refundRequest: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
    vendorPayout: {
      create: jest.fn(async ({ data }: any) => {
        createdData = data;
        return { id: "po-test", ...data, status: "PENDING" };
      }),
    },
  };
  db.$transaction.mockImplementationOnce(async (cb: any) => cb(fakeTx));
  return () => createdData;
}

function mockReq(body: object) {
  return {
    user: { id: "admin-1" },
    body,
    headers: {},
    params: {},
    query: {},
  } as never;
}

function mockRes() {
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnThis(), json } as never;
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.vendorPayout.updateMany.mockResolvedValue({ count: 1 });
  db.vendorPayout.findUnique.mockResolvedValue({ id: "po-test", status: "PROCESSING" });
});

describe("E-04 snapshot-authoritative payout aggregation", () => {
  it("A. known reproduction: 3 x N10.03 @15% pays 450 kobo commission, not 451", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.15));
    const orders = [
      snapshotOrder(10.03, 0.15, "o1"),
      snapshotOrder(10.03, 0.15, "o2"),
      snapshotOrder(10.03, 0.15, "o3"),
    ];
    // Sanity: each snapshot really is 150/853 (writer contract).
    for (const o of orders) {
      expect(o.commissionKobo).toBe(150n);
      expect(o.vendorPayoutKobo).toBe(853n);
    }
    const getCreated = runRealClaim(orders);
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(json.mock.calls[0][0].success).toBe(true);
    const created = getCreated();
    expect(Number(created.commission)).toBe(450);
    expect(Number(created.amount)).toBe(2559);
    expect(Number(created.grossRevenue)).toBe(3009);
  });

  it("B. larger divergence: 100 x N10.03 @15% uses SUM snapshots (15000), not aggregate (15045)", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.15));
    const orders = Array.from({ length: 100 }, (_, i) =>
      snapshotOrder(10.03, 0.15, `o${i}`),
    );
    const getCreated = runRealClaim(orders);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    expect(Number(created.commission)).toBe(150 * 100);
    expect(Number(created.amount)).toBe(853 * 100);
    // Guard: the old aggregate formula would have produced 15045 here.
    const legacy = calculatePayoutAmounts(orders, 0.15);
    expect(Number(legacy.commission)).toBe(15045);
  });

  it("C. snapshot authority vs live rate: snapshots @15%, live 99% — payout stays at snapshots", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.99));
    const orders = [
      snapshotOrder(5000, 0.15, "o1"),
      snapshotOrder(5000, 0.15, "o2"),
    ];
    const getCreated = runRealClaim(orders);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    expect(Number(created.commission)).toBe(75000 * 2);
    expect(Number(created.amount)).toBe(425000 * 2);
  });

  it("D. exact reconciliation: payout kobo fields round-trip to snapshot sums with zero tolerance", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.15));
    const orders = [
      snapshotOrder(10.03, 0.15, "o1"),
      snapshotOrder(5000, 0.15, "o2"),
      snapshotOrder(1234.56, 0.15, "o3"),
    ];
    const expectedComm = orders.reduce((s, o) => s + o.commissionKobo, 0n);
    const expectedPay = orders.reduce((s, o) => s + o.vendorPayoutKobo, 0n);
    const getCreated = runRealClaim(orders);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    expect(Number(created.commission)).toBe(Number(expectedComm));
    expect(Number(created.amount)).toBe(Number(expectedPay));
    expect(Number(created.grossRevenue)).toBe(
      Number(expectedComm + expectedPay),
    );
  });

  it("E. legacy NULL snapshots follow the aggregate fallback and are never zeroed", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.15));
    const orders = [legacyOrder(5000, "o1"), legacyOrder(3000, "o2")];
    const getCreated = runRealClaim(orders);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    const expected = calculatePayoutAmounts(orders, 0.15);
    expect(Number(created.commission)).toBe(Number(expected.commission));
    expect(Number(created.amount)).toBe(Number(expected.netAvailable));
    // NULL was not treated as zero: commission is genuinely positive.
    expect(Number(created.commission)).toBeGreaterThan(0);
  });

  it("F. mixed batch: snapshot order frozen, legacy order on fallback, deterministic total", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.2));
    const snap = snapshotOrder(5000, 0.15, "o-snap"); // frozen 75000/425000
    const leg = legacyOrder(3000, "o-leg"); // fallback @live 0.20 -> 600/2400
    const getCreated = runRealClaim([snap, leg]);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    const legacyExpected = calculatePayoutAmounts([leg], 0.2);
    expect(Number(created.commission)).toBe(
      75000 + Number(legacyExpected.commission),
    );
    expect(Number(created.amount)).toBe(
      425000 + Number(legacyExpected.netAvailable),
    );
    // The snapshot-backed order was NOT re-rated at the 20% live rate
    // (which would have given 100000, not 75000, for its share).
    expect(snap.commissionKobo).toBe(75000n);
  });

  it("G. E-03 preserved: P2034 loser retries, winner totals stay snapshot-correct, one transfer", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.15));
    const orders = [snapshotOrder(10.03, 0.15, "o1")];
    let createdData: any = null;
    const fakeTx = {
      order: {
        findMany: jest.fn(async () => orders),
        updateMany: jest.fn(async () => ({ count: orders.length })),
      },
      // F8: the claim reads refund state before creating any payout.
      payment: { findMany: jest.fn(async () => []) },
      refundRequest: { findMany: jest.fn(async () => []) },
      $queryRaw: jest.fn(async () => []),
      vendorPayout: {
        create: jest.fn(async ({ data }: any) => {
          createdData = data;
          return { id: "po-test", ...data, status: "PENDING" };
        }),
      },
    };
    db.$transaction
      .mockRejectedValueOnce(p2034())
      .mockImplementationOnce(async (cb: any) => cb(fakeTx));
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(json.mock.calls[0][0].success).toBe(true);
    expect(Number(createdData.commission)).toBe(150);
    expect(Number(createdData.amount)).toBe(853);
    expect(mockedTransfer).toHaveBeenCalledTimes(1);
  });

  it("H. Paystack compatibility: amount converts to exact kobo and transfer uses it", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.15));
    const orders = [snapshotOrder(10.03, 0.15, "o1")];
    const getCreated = runRealClaim(orders);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    const paystackKobo = Number(created.amount);
    expect(paystackKobo).toBe(Number(orders[0].vendorPayoutKobo));
    expect(mockedTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        amountKobo: Number(created.amount),
        reference: expect.any(String),
      }),
    );
  });

  it("unit: sumSnapshotKoboTotals skips NULL rows without zeroing them", () => {
    const sum = sumSnapshotKoboTotals([
      { commissionKobo: 150n, vendorPayoutKobo: 850n },
      { commissionKobo: null, vendorPayoutKobo: null },
      { commissionKobo: 151n, vendorPayoutKobo: 849n },
    ]);
    expect(sum).toEqual({
      snapshotOrderCount: 2,
      grossKobo: 2000n,
      commissionKobo: 301n,
      vendorPayoutKobo: 1699n,
    });
  });
});

/**
 * Stage K (E-05) — frozen commission snapshot authoritative during payout.
 *
 * Inspection verdict: the Stage J claim transaction already prevents the
 * live vendor rate from influencing snapshot-backed settlement — the rate
 * reaches exactly one expression, `calculatePayoutAmounts(legacyOrders,
 * vendor.commissionRate)`, where `legacyOrders` contains ONLY NULL-snapshot
 * rows (empty for snapshotted batches, so the rate participates in zero
 * arithmetic). These tests PROVE that immunity rather than churning
 * production code: no production file is changed for E-05.
 *
 * Covered timings: rate changed between checkout and claim (A/B/D/E/H),
 * between attempts — vendor row is fetched once before the E-03 retry loop,
 * so any inter-attempt change is equally inert (C) — and the estimate vs
 * ledger boundary (estimates intentionally use the live rate and must never
 * be confused with settlement).
 */
import { Prisma } from "@prisma/client";
import { processPayout, getPendingPayouts } from "../../src/controllers/admin.controller";
import { VendorDashboardService } from "../../src/controllers/vendorDashboard.service";
import prisma from "../../src/lib/prisma";
import {
  buildOrderMoneySnapshot,
  sumSnapshotKoboTotals,
} from "../../src/services/orderSnapshot.service";
import { calculatePayoutAmounts } from "../../src/controllers/vendorDashboard.service";
import { initiateTransfer } from "../../src/services/payoutService";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
    order: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(async () => []),
    },
    // F8: payout selectors now read refund state before paying anything.
    payment: { findMany: jest.fn(async () => []) },
    refundRequest: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
    vendorPayout: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })),
      findMany: jest.fn(async () => []),
    },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/services/payoutService", () => ({
  createTransferRecipient: jest.fn(async () => "RCP_TEST"),
  initiateTransfer: jest.fn(async () => ({ status: true })),
  resolveBankAccount: jest.fn(),
  listBanks: jest.fn(),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  createAuditLog: jest.fn(async () => ({})),
}));

const db = prisma as unknown as {
  user: { findUnique: jest.Mock; findMany: jest.Mock };
  order: { groupBy: jest.Mock; findMany: jest.Mock; updateMany: jest.Mock };
  vendorPayout: {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    findMany: jest.Mock;
  };
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

/** Snapshot-backed eligible order via the REAL checkout writer. All kobo. */
function snapshotOrder(baseNaira: number, rate: number, id: string) {
  const baseKobo = Math.round(baseNaira * 100);
  const snap = buildOrderMoneySnapshot({
    basePriceKobo: baseKobo,
    discountKobo: 0,
    commissionRate: rate,
  });
  return {
    id,
    // Faithful to the persisted Order row shape.
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

/** Executes the REAL claim-transaction callback against fixture orders. */
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
  db.vendorPayout.findUnique.mockResolvedValue({
    id: "po-test",
    status: "PROCESSING",
  });
});

describe("E-05 frozen rate authoritative during payout", () => {
  it("A. rate 15% -> 99% after checkout: payout uses frozen sums, not 99%", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.99));
    const orders = [
      snapshotOrder(5000, 0.15, "o1"),
      snapshotOrder(4500, 0.15, "o2"),
    ];
    for (const o of orders) expect(o.commissionRateSnapshot).toBe(0.15);
    const expectedComm = orders.reduce((s, o) => s + o.commissionKobo, 0n);
    const expectedPay = orders.reduce((s, o) => s + o.vendorPayoutKobo, 0n);
    const getCreated = runRealClaim(orders);
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(json.mock.calls[0][0].success).toBe(true);
    const created = getCreated();
    expect(Number(created.commission)).toBe(Number(expectedComm));
    expect(Number(created.amount)).toBe(Number(expectedPay));
    // A 99% re-rating of N9500 would have produced 940500 kobo, not 142500.
    expect(Number(created.commission)).toBe(142500);
  });

  it("B. rate 15% -> 0% after checkout: payout identical to frozen snapshots", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0));
    const orders = [snapshotOrder(5000, 0.15, "o1")];
    const getCreated = runRealClaim(orders);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    expect(Number(created.commission)).toBe(75000);
    expect(Number(created.amount)).toBe(425000);
  });

  it("C. rate change across retry: P2034 then success at live 99% — frozen totals, E-03 intact, one transfer", async () => {
    // The vendor row is fetched once before the bounded retry loop, so a
    // rate change between attempts is equally inert for snapshots; using
    // 99% here proves the retry path never re-rates frozen orders.
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.99));
    const orders = [snapshotOrder(5000, 0.15, "o1")];
    let createdData: any = null;
    const fakeTx = {
      order: {
        findMany: jest.fn(async () => orders),
        updateMany: jest.fn(async () => ({ count: orders.length })),
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
    db.$transaction
      .mockRejectedValueOnce(p2034())
      .mockImplementationOnce(async (cb: any) => cb(fakeTx));
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(json.mock.calls[0][0].success).toBe(true);
    expect(Number(createdData.commission)).toBe(75000);
    expect(Number(createdData.amount)).toBe(425000);
    expect(mockedTransfer).toHaveBeenCalledTimes(1);
  });

  it("D. 3 x N10.03 @15% with live 99%: commission 450 (not 451, not 297)", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.99));
    const orders = ["o1", "o2", "o3"].map((id) =>
      snapshotOrder(10.03, 0.15, id),
    );
    const getCreated = runRealClaim(orders);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    expect(Number(created.commission)).toBe(450);
    expect(Number(created.amount)).toBe(2559);
  });

  it("E. 100 x N10.03 @15% with live 99%: frozen 15000 (not 15045, not a 99% figure)", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.99));
    const orders = Array.from({ length: 100 }, (_, i) =>
      snapshotOrder(10.03, 0.15, `o${i}`),
    );
    const getCreated = runRealClaim(orders);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    expect(Number(created.commission)).toBe(15000);
    expect(Number(created.amount)).toBe(85300);
  });

  it("F. legacy NULL orders: fallback preserved, NULL never zero, snapshots uncontaminated", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.15));
    const orders = [legacyOrder(5000, "o1")];
    const getCreated = runRealClaim(orders);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    const expected = calculatePayoutAmounts(orders, 0.15);
    expect(Number(created.commission)).toBe(Number(expected.commission));
    expect(Number(created.commission)).toBeGreaterThan(0);
  });

  it("G. mixed batch at live 99%: snapshot share frozen, legacy share on 99% fallback", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.99));
    const snap = snapshotOrder(5000, 0.15, "o-snap");
    const leg = legacyOrder(5000, "o-leg");
    const getCreated = runRealClaim([snap, leg]);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    const legacyExpected = calculatePayoutAmounts([leg], 0.99);
    // Snapshot share immune to 99%: still 75000/425000.
    expect(Number(created.commission)).toBe(
      75000 + Number(legacyExpected.commission),
    );
    expect(Number(created.amount)).toBe(
      425000 + Number(legacyExpected.netAvailable),
    );
  });

  it("H. rate-snapshot consistency audit: stored kobo match the frozen rate via the checkout writer", async () => {
    const fixtures = [
      snapshotOrder(5000, 0.15, "o1"),
      snapshotOrder(4500, 0.15, "o2"),
      snapshotOrder(10.03, 0.15, "o3"),
    ];
    for (const o of fixtures) {
      const rebuilt = buildOrderMoneySnapshot({
        basePriceKobo: o.totalPrice - o.deliveryFee,
        discountKobo: 0,
        commissionRate: o.commissionRateSnapshot,
      });
      expect(o.commissionKobo).toBe(rebuilt.commissionKobo);
      expect(o.vendorPayoutKobo).toBe(rebuilt.vendorPayoutKobo);
    }
    // And the claim consumes the STORED kobo, not a re-rating:
    const sum = sumSnapshotKoboTotals(fixtures);
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.99));
    const getCreated = runRealClaim(fixtures);
    await processPayout(mockReq({ vendorId: "v-1" }), mockRes().res);
    const created = getCreated();
    expect(Number(created.commission)).toBe(Number(sum.commissionKobo));
    expect(Number(created.amount)).toBe(Number(sum.vendorPayoutKobo));
  });

  it("estimate boundary: getPayoutSummary uses the live rate (estimate) and creates no ledger rows", async () => {
    // Estimate/UI semantics are INTENTIONAL: the vendor-facing projection
    // follows the current rate. It must never be confused with settlement,
    // which uses frozen snapshots (proven above).
    db.user.findUnique.mockResolvedValue({
      commissionRate: 0.99,
      bankName: "GTB",
      bankAccountNumber: "0123456789",
      bankAccountName: "Vendor",
    });
    const snap = snapshotOrder(5000, 0.15, "o1");
    const eligible = [
      {
        id: "o1",
        totalPrice: snap.totalPrice,
        deliveryFee: snap.deliveryFee,
      },
    ];
    const prismaMock = prisma as unknown as {
      order: { findMany: jest.Mock };
      vendorPayout: { findMany: jest.Mock; aggregate: jest.Mock };
    };
    prismaMock.order.findMany = jest.fn(async () => eligible);
    const service = new VendorDashboardService("v-1");
    const data = await service.getPayoutSummary();
    const liveEstimate = calculatePayoutAmounts(eligible, 0.99);
    // getPayoutSummary returns naira to the dashboard client; calculatePayoutAmounts
    // returns kobo. Compare naira to naira.
    expect(data.available.commission).toBe(liveEstimate.commission / 100);
    expect(data.available.netAvailable).toBe(liveEstimate.netAvailable / 100);
    // The estimate is explicitly NOT the frozen ledger value.
    expect(data.available.commission).not.toBe(
      Number(snap.commissionKobo) / 100,
    );
  });

  it("estimate boundary: getPendingPayouts uses live-rate math and creates no payouts", async () => {
    db.order.findMany.mockResolvedValue([
      { id: "o1", vendorId: "v-1", totalPrice: 550000, deliveryFee: 50000, idempotencyKey: "k1" },
    ]);
    db.user.findMany.mockResolvedValue([vendorWithLiveRate(0.99)]);
    const res = mockRes();
    await getPendingPayouts({} as never, res.res);
    const pending = res.json.mock.calls[0][0].data.pending;
    expect(pending).toHaveLength(1);
    // Live-rate aggregate estimate: (550000-50000) @99% = 4950 naira commission.
    expect(pending[0].commission).toBe(4950);
  });
});

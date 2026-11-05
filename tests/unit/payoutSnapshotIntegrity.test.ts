/**
 * Stage M (E-07) — payout commission validation / snapshot integrity.
 *
 * The payout claim path must refuse settlement when a candidate order's
 * persisted money snapshot is impossible or internally contradictory:
 * partial (torn) snapshots, negative kobo, out-of-domain frozen rate, and
 * `commissionKobo + vendorPayoutKobo !== round(basePrice * 100)`.
 *
 * Rejection contract asserted everywhere below: no VendorPayout created, no
 * order claimed, zero Paystack calls, deterministic ConflictError
 * (code PAYOUT_SNAPSHOT_INVALID), and no E-03 retry (the error is not P2034).
 *
 * Legacy all-NULL snapshots are explicitly NOT defects — they keep the
 * documented Stage J fallback. This is validation, never recomputation.
 */
import { Prisma } from "@prisma/client";
import { processPayout } from "../../src/controllers/admin.controller";
import prisma from "../../src/lib/prisma";
import {
  buildOrderMoneySnapshot,
  findOrderMoneySnapshotDefect,
  findPayoutSnapshotDefects,
  isLegacyNullSnapshotOrder,
  MAX_COMMISSION_RATE,
  MIN_COMMISSION_RATE,
} from "../../src/services/orderSnapshot.service";
import {
  createTransferRecipient,
  initiateTransfer,
} from "../../src/services/payoutService";

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
  vendorPayout: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
};
const mockedCreateRecipient = createTransferRecipient as jest.Mock;
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

/** Coherent snapshot row produced by the REAL checkout writer. All kobo. */
function validOrder(baseNaira = 5000, rate = 0.15, id = "o1") {
  const baseKobo = Math.round(baseNaira * 100);
  const snap = buildOrderMoneySnapshot({
    basePriceKobo: baseKobo,
    discountKobo: 0,
    commissionRate: rate,
  });
  return {
    id,
    basePrice: baseKobo,
    totalPrice: baseKobo + 50000,
    deliveryFee: 50000,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    commissionKobo: snap.commissionKobo,
    vendorPayoutKobo: snap.vendorPayoutKobo,
    commissionRateSnapshot: snap.commissionRateSnapshot,
  };
}

function legacyOrder(baseNaira = 5000, id = "o-leg") {
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

/** Runs the REAL claim-transaction callback over the given order rows. */
function runRealClaim(eligibleOrders: any[]) {
  const payoutsCreated: any[] = [];
  const claims: any[] = [];
  const fakeTx = {
    order: {
      findMany: jest.fn(async () => eligibleOrders),
      updateMany: jest.fn(async (args: any) => {
        claims.push(args);
        return { count: eligibleOrders.length };
      }),
    },
    payment: { findMany: jest.fn(async () => []) },
    refundRequest: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
    vendorPayout: {
      create: jest.fn(async ({ data }: any) => {
        payoutsCreated.push(data);
        return { id: "po-test", ...data, status: "PENDING" };
      }),
    },
  };
  db.$transaction.mockImplementationOnce(async (cb: any) => cb(fakeTx));
  return { payoutsCreated, claims };
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

/**
 * Asserts the full invalid-state contract: throws, no payout, no claim,
 * zero Paystack side effects, and NOT retried by the E-03 loop.
 */
async function expectPayoutBlocked(orders: any[], reason: string) {
  const { payoutsCreated, claims } = runRealClaim(orders);
  const err = await processPayout(
    mockReq({ vendorId: "v-1" }),
    mockRes().res,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).not.toBeNull();
  expect((err as { code?: string }).code).toBe("PAYOUT_SNAPSHOT_INVALID");
  expect((err as { statusCode?: number }).statusCode).toBe(409);
  expect((err as Error).message).toContain(reason);
  expect(payoutsCreated).toHaveLength(0);
  expect(claims).toHaveLength(0);
  expect(mockedTransfer).not.toHaveBeenCalled();
  expect(mockedCreateRecipient).not.toHaveBeenCalled();
  // Invalid state is not a serialization conflict -> no retry.
  expect(db.$transaction).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset also drops any unconsumed queued implementations, so a test
  // that stops early (e.g. a single-attempt failure) cannot leak its queue
  // into the next test.
  db.$transaction.mockReset();
  db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.15));
  db.vendorPayout.updateMany.mockResolvedValue({ count: 1 });
  db.vendorPayout.findUnique.mockResolvedValue({
    id: "po-test",
    status: "PROCESSING",
  });
});

describe("E-07 payout snapshot integrity guard", () => {
  it("A. partial snapshot: commissionKobo NULL, vendorPayoutKobo set -> blocked", async () => {
    await expectPayoutBlocked(
      [{ ...validOrder(), commissionKobo: null }],
      "PARTIAL_SNAPSHOT",
    );
  });

  it("B. partial snapshot: vendorPayoutKobo NULL, commissionKobo set -> blocked", async () => {
    await expectPayoutBlocked(
      [{ ...validOrder(), vendorPayoutKobo: null }],
      "PARTIAL_SNAPSHOT",
    );
  });

  it("C. negative commissionKobo -> blocked", async () => {
    const base = validOrder();
    await expectPayoutBlocked(
      [
        {
          ...base,
          commissionKobo: -1n,
          vendorPayoutKobo: base.vendorPayoutKobo + 1n,
        },
      ],
      "NEGATIVE_COMMISSION",
    );
  });

  it("D. negative vendorPayoutKobo -> blocked", async () => {
    const base = validOrder();
    await expectPayoutBlocked(
      [
        {
          ...base,
          commissionKobo: base.commissionKobo + 1n,
          vendorPayoutKobo: -1n,
        },
      ],
      "NEGATIVE_VENDOR_PAYOUT",
    );
  });

  it.each([
    ["negative", -0.01],
    ["above maximum", MAX_COMMISSION_RATE + 0.01],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("E. invalid frozen commission rate (%s) -> blocked", async (_label, rate) => {
    await expectPayoutBlocked(
      [{ ...validOrder(), commissionRateSnapshot: rate }],
      "INVALID_COMMISSION_RATE",
    );
  });

  it("F. incoherent monetary snapshot (sum != stored gross) -> blocked", async () => {
    const base = validOrder();
    await expectPayoutBlocked(
      [
        {
          ...base,
          // commission + payout no longer reconstruct basePrice*100.
          vendorPayoutKobo: base.vendorPayoutKobo + 7n,
        },
      ],
      "INCOHERENT_GROSS",
    );
  });

  it("F2. incoherent gross caused by tampered basePrice -> blocked", async () => {
    // basePrice (kobo) no longer matches commissionKobo + vendorPayoutKobo.
    await expectPayoutBlocked(
      [{ ...validOrder(), basePrice: 600000 }],
      "INCOHERENT_GROSS",
    );
  });

  it("G. valid snapshot settles normally (75000/425000)", async () => {
    const { payoutsCreated, claims } = runRealClaim([validOrder()]);
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(json.mock.calls[0][0].success).toBe(true);
    expect(payoutsCreated).toHaveLength(1);
    expect(Number(payoutsCreated[0].commission)).toBe(75000);
    expect(Number(payoutsCreated[0].amount)).toBe(425000);
    expect(claims).toHaveLength(1);
    expect(mockedTransfer).toHaveBeenCalledTimes(1);
  });

  it("H. legacy all-NULL order is NOT rejected — fallback preserved", async () => {
    const { payoutsCreated } = runRealClaim([legacyOrder(5000)]);
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(json.mock.calls[0][0].success).toBe(true);
    expect(payoutsCreated).toHaveLength(1);
    // Fallback = aggregate/live-rate math on gross (5000) @0.15.
    expect(Number(payoutsCreated[0].commission)).toBe(75000);
    expect(Number(payoutsCreated[0].amount)).toBe(425000);
  });

  it("I. mixed batch: valid snapshot settles + legacy falls back, both deterministic", async () => {
    const { payoutsCreated } = runRealClaim([
      validOrder(5000, 0.15, "o-snap"),
      legacyOrder(3000, "o-leg"),
    ]);
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(json.mock.calls[0][0].success).toBe(true);
    // Snapshot share 425000 + legacy share (gross 3000 @15%) 255000.
    expect(Number(payoutsCreated[0].commission)).toBe(120000);
    expect(Number(payoutsCreated[0].amount)).toBe(680000);
  });

  it("I2. mixed batch with one corrupt snapshot blocks the WHOLE payout (never silently excluded)", async () => {
    await expectPayoutBlocked(
      [validOrder(5000, 0.15, "o-snap"), legacyOrder(3000, "o-leg"), { ...validOrder(1000, 0.15, "o-bad"), commissionKobo: null }],
      "PARTIAL_SNAPSHOT",
    );
  });

  it("J. hostile live rate 99% does not affect validation or settlement", async () => {
    db.user.findUnique.mockResolvedValue(vendorWithLiveRate(0.99));
    const { payoutsCreated } = runRealClaim([validOrder()]);
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(json.mock.calls[0][0].success).toBe(true);
    expect(Number(payoutsCreated[0].commission)).toBe(75000);
    expect(Number(payoutsCreated[0].amount)).toBe(425000);
  });

  it("K. E-03 retry: validation stays active across attempts; valid retry settles once", async () => {
    const payoutsCreated: any[] = [];
    // Attempt 1 loses with a serialization failure; attempt 2 re-runs the
    // REAL claim callback, so validation runs again on the retry.
    db.$transaction
      .mockRejectedValueOnce(p2034())
      .mockImplementationOnce(async (cb: any) =>
        cb({
          order: {
            findMany: jest.fn(async () => [validOrder()]),
            updateMany: jest.fn(async () => ({ count: 1 })),
          },
          // F8: the claim reads refund state before creating any payout.
          payment: { findMany: jest.fn(async () => []) },
          refundRequest: { findMany: jest.fn(async () => []) },
          $queryRaw: jest.fn(async () => []),
          vendorPayout: {
            create: jest.fn(async ({ data }: any) => {
              payoutsCreated.push(data);
              return { id: "po-test", ...data, status: "PENDING" };
            }),
          },
        }),
      );
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(json.mock.calls[0][0].success).toBe(true);
    expect(payoutsCreated).toHaveLength(1);
    expect(mockedTransfer).toHaveBeenCalledTimes(1);
  });

  it("K2. invalid snapshot never becomes payable on retry (no retry, still blocked)", async () => {
    db.$transaction.mockRejectedValueOnce(p2034());
    runRealClaim([{ ...validOrder(), vendorPayoutKobo: null }]);
    const err = await processPayout(
      mockReq({ vendorId: "v-1" }),
      mockRes().res,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("PAYOUT_SNAPSHOT_INVALID");
    expect(mockedTransfer).not.toHaveBeenCalled();
    // 1 serialization attempt + 1 validation attempt, no third.
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it("unit: valid snapshot yields no defect; legacy all-NULL is not legacy-flagged for defects", () => {
    expect(findOrderMoneySnapshotDefect(validOrder())).toBeNull();
    expect(findOrderMoneySnapshotDefect(legacyOrder())).toBeNull();
    expect(isLegacyNullSnapshotOrder(legacyOrder())).toBe(true);
    expect(isLegacyNullSnapshotOrder(validOrder())).toBe(false);
  });

  it("unit: defects are reported per order with stable reasons", () => {
    const defects = findPayoutSnapshotDefects([
      validOrder(5000, 0.15, "ok"),
      { ...validOrder(5000, 0.15, "bad1"), commissionKobo: null },
      { ...validOrder(5000, 0.15, "bad2"), commissionRateSnapshot: 2 },
      legacyOrder(1000, "leg"),
    ]);
    expect(defects).toEqual([
      { orderId: "bad1", reason: "PARTIAL_SNAPSHOT" },
      { orderId: "bad2", reason: "INVALID_COMMISSION_RATE" },
    ]);
  });

  it("unit: the rate domain is the one the project already documents", () => {
    expect(MIN_COMMISSION_RATE).toBe(0);
    expect(MAX_COMMISSION_RATE).toBe(1);
  });

  it("unit: the frozen rate is audit evidence, not a settlement gate", () => {
    // Absent rate + present kobo: still coherent (settles from kobo).
    expect(
      findOrderMoneySnapshotDefect({
        ...validOrder(),
        commissionRateSnapshot: null,
      }),
    ).toBeNull();
    // Present rate with no monetary snapshot: legacy-shaped, not a defect.
    const rateOnly = { ...legacyOrder(), commissionRateSnapshot: 0.15 };
    expect(findOrderMoneySnapshotDefect(rateOnly)).toBeNull();
    expect(isLegacyNullSnapshotOrder(rateOnly)).toBe(true);
    // But an invalid rate VALUE on a snapshot-backed order is rejected.
    expect(
      findOrderMoneySnapshotDefect({
        ...validOrder(),
        commissionRateSnapshot: 1.5,
      })?.reason,
    ).toBe("INVALID_COMMISSION_RATE");
  });
});

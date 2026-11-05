/**
 * Batch G — reconciliation alignment + refund retry recovery.
 *
 * 1. Customer refund re-request is allowed after terminal FAILED/REJECTED
 *    (which hold no reservation) but still blocked after COMPLETED
 *    (money moved) or while a request is live.
 * 2. Payout previews use the same snapshot-first equation as settlement.
 * 3. Reconciliation detectors flag ledger/settlement/earning drift without
 *    writing anything.
 *
 * Real controllers/helpers (mocked Prisma only). Detector tests inject
 * plain doubles. No live infrastructure.
 */
import { requestRefund } from "../../src/controllers/paymentController";
import {
  previewVendorPayoutAmounts,
} from "../../src/controllers/vendorDashboard.service";
import {
  auditRefundLedger,
  auditPayoutSettlement,
  auditDeliveryEarnings,
} from "../../src/services/financialReconciliation.service";
import prisma from "../../src/lib/prisma";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: jest.fn() },
    refundRequest: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    order: { findUnique: jest.fn() },
    vendorPayout: { findMany: jest.fn() },
    deliveryEarning: { findMany: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
  },
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => ({})),
}));

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

const successPayment = () => ({
  id: "pay-1",
  reference: "PSK-1",
  userId: "cust-1",
  orderId: "order-1",
  status: "SUCCESS",
  amount: 1000000,
  refundedAmount: 0,
});

function refundReq(body: any) {
  return {
    user: { id: "cust-1", role: "CUSTOMER", sessionId: "s" },
    body,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.payment.findUnique.mockResolvedValue(successPayment());
  db.order.findUnique.mockResolvedValue({ vendorId: "vend-1" });
  db.refundRequest.create.mockImplementation(async (args: any) => ({ id: "rr-new", ...args.data }));
});

describe("Batch G — customer refund retry recovery", () => {
  // The mocked findFirst honors the status predicate like the database:
  // only rows in a blocking state are returned.
  let priorRequest: any = null;
  beforeEach(() => {
    db.refundRequest.findFirst.mockImplementation(async (args: any) => {
      if (!priorRequest) return null;
      const allowed = args?.where?.status?.in;
      if (Array.isArray(allowed)) return allowed.includes(priorRequest.status) ? priorRequest : null;
      return priorRequest;
    });
  });

  it("1. re-request allowed after FAILED (no reservation held)", async () => {
    priorRequest = { id: "rr-old", status: "FAILED" };

    await requestRefund(refundReq({ reference: "PSK-1", reason: "retry" }), res());

    expect(db.refundRequest.create).toHaveBeenCalledTimes(1);
  });

  it("2. re-request allowed after REJECTED (never reserved)", async () => {
    priorRequest = { id: "rr-old", status: "REJECTED" };

    await requestRefund(refundReq({ reference: "PSK-1", reason: "retry" }), res());

    expect(db.refundRequest.create).toHaveBeenCalledTimes(1);
  });

  it("3. still blocked while a request is live or completed", async () => {
    for (const status of ["PENDING", "APPROVED", "PROCESSING", "COMPLETED"]) {
      priorRequest = { id: "rr-old", status };

      await expect(
        requestRefund(refundReq({ reference: "PSK-1", reason: "again" }), res()),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(db.refundRequest.create).not.toHaveBeenCalled();
  });
});

describe("Batch G — snapshot-first payout previews", () => {
  const snapOrder = (over: Record<string, unknown> = {}) => ({
    id: "o-1",
    // Phase 3A: monetary fields are integer kobo.
    basePrice: 500000,
    totalPrice: 550000,
    deliveryFee: 50000,
    commissionKobo: 75000n,
    vendorPayoutKobo: 425000n,
    commissionRateSnapshot: 0.15,
    ...over,
  });

  it("4. snapshot-backed orders preview exact kobo (matches settlement)", async () => {
    const preview = previewVendorPayoutAmounts([snapOrder(), snapOrder({ id: "o-2" })], 0.2);

    // Live rate (0.2) is ignored: frozen snapshots rule.
    expect(preview).toMatchObject({
      grossRevenue: 10000,
      commission: 1500,
      netAvailable: 8500,
      blocked: false,
    });
    expect(preview.snapshotOrderCount).toBe(2);
  });

  it("5. legacy all-NULL orders use the documented fallback only", async () => {
    const legacy = {
      id: "o-old",
      // Phase 3A: monetary fields are integer kobo.
      basePrice: 500000,
      totalPrice: 550000,
      deliveryFee: 50000,
      commissionKobo: null,
      vendorPayoutKobo: null,
      commissionRateSnapshot: null,
    };
    const preview = previewVendorPayoutAmounts([snapOrder(), legacy], 0.15);

    expect(preview.blocked).toBe(false);
    expect(preview.legacyOrderCount).toBe(1);
    // snapshot 425000 + legacy (5000 × 0.85 × 100) = 850000 kobo.
    expect(preview.netAvailable).toBe(8500);
  });

  it("6. torn snapshots block the preview instead of showing a wrong number", async () => {
    const torn = snapOrder({ vendorPayoutKobo: null });
    const preview = previewVendorPayoutAmounts([torn], 0.15);

    expect(preview.blocked).toBe(true);
    expect(preview.blockReason).toMatch(/PAYOUT_SNAPSHOT_INVALID/);
    expect(preview.netAvailable).toBe(0);
  });
});

describe("Batch G — reconciliation detectors (read-only)", () => {
  it("7. clean books produce no findings", async () => {
    const fake = {
      payment: { findMany: jest.fn(async () => [{ reference: "P1", amount: 100000, refundedAmount: 40000 }]) },
      refundRequest: {
        findMany: jest.fn(async () => [{ paymentRef: "P1", requestedAmountKobo: 40000 }]),
      },
      vendorPayout: {
        findMany: jest.fn(async () => [{ id: "po-1", amount: 850000n, orders: [{ vendorPayoutKobo: 425000 }, { vendorPayoutKobo: 425000 }] }]),
      },
      deliveryEarning: {
        findMany: jest.fn(async () => [{ id: "e-1", orderId: "o-1", order: { status: "COMPLETED", paymentStatus: "SUCCESS" } }]),
      },
    };

    await expect(auditRefundLedger(fake)).resolves.toEqual([]);
    await expect(auditPayoutSettlement(fake)).resolves.toEqual([]);
    await expect(auditDeliveryEarnings(fake)).resolves.toEqual([]);
  });

  it("8. over-reserved, over-completed, mismatched payout, and stray earning are flagged", async () => {
    const fake = {
      payment: {
        findMany: jest.fn(async () => [
          { reference: "P-over", amount: 100000, refundedAmount: 120000 },
          { reference: "P-done", amount: 100000, refundedAmount: 100000 },
          { reference: "P-part", amount: 100000, refundedAmount: 40000 },
        ]),
      },
      refundRequest: {
        findMany: jest.fn(async () => [
          { paymentRef: "P-done", requestedAmountKobo: 100000 },
          { paymentRef: "P-done", requestedAmountKobo: 1000 },
          { paymentRef: "P-part", requestedAmountKobo: 50000 },
        ]),
      },
      vendorPayout: {
        findMany: jest.fn(async () => [{ id: "po-9", amount: 80000, orders: [{ vendorPayoutKobo: 425000 }] }]),
      },
      deliveryEarning: {
        findMany: jest.fn(async () => [{ id: "e-9", orderId: "o-9", order: { status: "CANCELLED", paymentStatus: "SUCCESS" } }]),
      },
    };

    const ledger = await auditRefundLedger(fake);
    expect(ledger.map((d) => d.issue).sort()).toEqual([
      "COMPLETED_EXCEEDS_CAPTURED",
      "COMPLETED_EXCEEDS_RESERVED",
      "RESERVED_EXCEEDS_CAPTURED",
    ]);
    await expect(auditPayoutSettlement(fake)).resolves.toEqual([
      { payoutId: "po-9", expectedNetKobo: 425000, recordedNetKobo: 80000, issue: "SETTLEMENT_MISMATCH" },
    ]);
    await expect(auditDeliveryEarnings(fake)).resolves.toEqual([
      expect.objectContaining({ earningId: "e-9", issue: "EARNING_ON_INELIGIBLE_ORDER" }),
    ]);
  });

  it("9. detectors never write (no mutating client methods touched)", async () => {
    const calls: string[] = [];
    const fake: any = new Proxy(
      {},
      {
        get: (_t, model: string) => new Proxy(
          {},
          { get: (_t2, method: string) => (..._a: unknown[]) => { calls.push(`${model}.${method}`); return Promise.resolve([]); } },
        ),
      },
    );

    await auditRefundLedger(fake);
    await auditPayoutSettlement(fake);
    await auditDeliveryEarnings(fake);

    expect(calls.every((c) => c.endsWith(".findMany"))).toBe(true);
  });
});

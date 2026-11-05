/**
 * Stage N-06: vendor payout failure recovery + reconciliation.
 *
 * Root problem fixed: vendor orders stayed permanently bound to a non-PAID
 * VendorPayout. A definite failure released only the payout state (not the
 * order claims), and an ambiguous PROCESSING payout had no reconciliation at
 * all — so a lost webhook stranded the payout AND its orders forever.
 *
 * Invariants under test:
 *   1. An ambiguous Paystack outcome NEVER releases a claim.
 *   2. A definite failure releases the claims atomically with the state change.
 *   3. Only the winner of the PROCESSING CAS may apply the side effect.
 *   4. A released order can never be paid twice through the old payout.
 *   5. Reconciliation only verifies — it never initiates a transfer.
 */
import {
  verifyPendingVendorPayouts,
} from "../../src/jobs/payment/worker/verifyPendingVendorPayouts";
import { paystackWebhookHandler } from "../../src/controllers/webhook";
import { fetchTransferByReference } from "../../src/services/payoutService";
import prisma from "../../src/lib/prisma";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    vendorPayout: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    order: { findMany: jest.fn(), updateMany: jest.fn() },
    product: { updateMany: jest.fn() },
    payment: { findUnique: jest.fn() },
    refundRequest: { findFirst: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/lib/axiosClient", () => ({
  __esModule: true,
  paystack: { post: jest.fn(), get: jest.fn() },
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/paystack", () => ({
  __esModule: true,
  validatePaystackSignature: jest.fn(() => true),
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisPayments: {
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    incr: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    ttl: jest.fn(async () => 60),
  },
}));

// Phase 3.2.8: the handler drives the inflight/done replay claim. These
// suites exercise the financial settlement paths, not the claim state
// machine (covered in webhookReplayClaim.test.ts), so the claim is stubbed
// to always acquire and complete — preserving each suite's original
// duplicate/replay semantics via the real settlement CAS.
jest.mock("../../src/services/webhookReplayClaim.service", () => ({
  __esModule: true,
  newClaimToken: jest.fn(() => "mock-owner-token"),
  acquireWebhookClaim: jest.fn(async () => "ACQUIRED"),
  completeWebhookClaim: jest.fn(async () => true),
  releaseWebhookClaim: jest.fn(async () => true),
  WEBHOOK_INFLIGHT_TTL_SECONDS: 300,
  WEBHOOK_DONE_TTL_SECONDS: 259200,
}));


jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
  clearProductsCache: jest.fn(async () => {}),
}));

const db = prisma as unknown as {
  vendorPayout: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
  order: { updateMany: jest.Mock };
  $transaction: jest.Mock;
};
const paystackGet = (require("../../src/lib/axiosClient").paystack as { get: jest.Mock }).get;
const paystackPost = (require("../../src/lib/axiosClient").paystack as { post: jest.Mock }).post;

const PID = "po-1";
const AMOUNT = 8075;
const KOBO = AMOUNT * 100;
const REF = "vendor_payout_po-1";

function processingPayout(over: Record<string, unknown> = {}) {
  return {
    id: PID,
    vendorId: "v-1",
    // Phase 3A: VendorPayout.amount is integer kobo (BigInt).
    amount: KOBO,
    status: "PROCESSING",
    reference: REF,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

function paystackTransfer(over: Record<string, unknown> = {}) {
  return {
    data: {
      status: true,
      message: "Transfer retrieved",
      data: { status: "success", amount: KOBO, reference: REF, transfer_code: "TRF_x", failures: null, ...over },
    },
  };
}
function httpError(status: number) {
  const e: any = new Error(`status ${status}`);
  e.response = { status, data: { message: "gateway" } };
  return e;
}
function transportError(code = "ECONNRESET") {
  const e: any = new Error("socket hang up");
  e.code = code;
  return e;
}

function runReconciler() {
  return verifyPendingVendorPayouts(20, 0);
}

/** The single payout-status CAS issued. */
function payoutCas() {
  return db.vendorPayout.updateMany.mock.calls[0][0];
}
/**
 * The order claim-release write, if any. `mock.calls` holds argument ARRAYS,
 * so the found element must be unwrapped with [0] to get the args object.
 */
function claimRelease() {
  const call = db.order.updateMany.mock.calls.find(
    (c) => c[0].data?.payoutId === null,
  );
  return call?.[0];
}

async function deliverWebhook(event: string, over: Record<string, unknown> = {}) {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  await paystackWebhookHandler(
    {
      user: { id: "u1" },
      params: {},
      query: {},
      ip: "127.0.0.1",
      headers: { "x-paystack-signature": "sig" },
      body: Buffer.from(
        JSON.stringify({ event, data: { reference: REF, amount: KOBO, ...over } }),
      ),
    } as never,
    r,
  );
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );
  db.vendorPayout.findMany.mockResolvedValue([processingPayout()]);
  db.vendorPayout.findFirst.mockResolvedValue(processingPayout());
  db.vendorPayout.findUnique.mockResolvedValue(processingPayout({ status: "PAID" }));
  db.vendorPayout.updateMany.mockResolvedValue({ count: 1 });
  db.order.updateMany.mockResolvedValue({ count: 2 });
  paystackGet.mockResolvedValue(paystackTransfer());
});

// ---------------------------------------------------------------------------
describe("N-06 — reconciliation status mapping", () => {
  it("1-3. verified failure: payout FAILED and ALL its orders released", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ status: "failed" }));
    const r = await runReconciler();
    expect(r.settledFailed).toBe(1);
    expect(r.releasedOrders).toBe(2);
    expect(payoutCas().where).toEqual({ id: PID, status: "PROCESSING" });
    expect(payoutCas().data.status).toBe("FAILED");
    // Scoped strictly to this payout's orders.
    expect(claimRelease()?.where).toEqual({ payoutId: PID });
    expect(claimRelease()?.data).toEqual({ payoutId: null });
  });

  it("2. unrelated payout orders are never released", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ status: "failed" }));
    await runReconciler();
    for (const call of db.order.updateMany.mock.calls) {
      expect(call[0].where).toEqual({ payoutId: PID });
    }
  });

  it.each([
    ["timeout", () => transportError("ECONNABORTED")],
    ["5xx", () => httpError(500)],
    ["connection reset", () => transportError("ECONNRESET")],
    ["404 not found", () => httpError(404)],
  ])("4-7. %s: payout stays PROCESSING and claims are retained", async (_label, mk) => {
    paystackGet.mockRejectedValueOnce(mk());
    await runReconciler();
    expect(db.vendorPayout.updateMany).not.toHaveBeenCalled();
    expect(claimRelease()).toBeUndefined();
  });

  it("8. verified success: PAID, amount checked, claims RETAINED", async () => {
    const r = await runReconciler();
    expect(r.settledPaid).toBe(1);
    expect(payoutCas().data.status).toBe("PAID");
    // Success keeps the claims — the money is genuinely paid out.
    expect(claimRelease()).toBeUndefined();
  });

  it("9. amount mismatch: stays PROCESSING, no release, no PAID", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ amount: KOBO + 100 }));
    const r = await runReconciler();
    expect(r.amountMismatch).toBe(1);
    expect(r.settledPaid).toBe(0);
    expect(db.vendorPayout.updateMany).not.toHaveBeenCalled();
    expect(claimRelease()).toBeUndefined();
  });

  it.each(["pending", "otp", "received"])(
    "10. Paystack '%s': stays PROCESSING",
    async (status) => {
      paystackGet.mockResolvedValueOnce(paystackTransfer({ status }));
      const r = await runReconciler();
      expect(r.stillPending).toBe(1);
      expect(db.vendorPayout.updateMany).not.toHaveBeenCalled();
    },
  );

  it("unrecognised status stays PROCESSING for human review", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ status: "wibble" }));
    const r = await runReconciler();
    expect(r.unresolved).toBe(1);
    expect(db.vendorPayout.updateMany).not.toHaveBeenCalled();
  });

  it("reconciler only considers PROCESSING payouts that reached Paystack", async () => {
    db.vendorPayout.findMany.mockResolvedValue([]);
    await runReconciler();
    expect(db.vendorPayout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "PROCESSING",
          reference: { not: null },
        }),
        take: 20,
      }),
    );
    expect(paystackGet).not.toHaveBeenCalled();
  });

  it("21. ambiguous payout never triggers a second Paystack transfer", async () => {
    paystackGet.mockRejectedValueOnce(transportError());
    const r = await runReconciler();
    expect(r.unresolved).toBe(1);
    expect(paystackPost).not.toHaveBeenCalled();
    expect(db.vendorPayout.updateMany).not.toHaveBeenCalled();
  });

  it("22. PENDING payout with no reference is left to admin mark-paid", async () => {
    db.vendorPayout.findMany.mockResolvedValue([]);
    const r = await runReconciler();
    expect(r.checked).toBe(0);
    expect(paystackGet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("N-06 — webhook interaction", () => {
  it("11. transfer.failed: FAILED and claims released", async () => {
    const r = await deliverWebhook("transfer.failed");
    expect(payoutCas().data.status).toBe("FAILED");
    expect(claimRelease()?.where).toEqual({ payoutId: PID });
    expect(r.send).toHaveBeenCalledWith("Vendor payout webhook processed");
  });

  it("12. transfer.success: PAID and claims retained", async () => {
    await deliverWebhook("transfer.success");
    expect(payoutCas().data.status).toBe("PAID");
    expect(claimRelease()).toBeUndefined();
  });

  it("13. duplicate success webhook has no duplicate effect", async () => {
    db.vendorPayout.findFirst.mockResolvedValue(processingPayout({ status: "PAID" }));
    const r = await deliverWebhook("transfer.success");
    expect(r.send).toHaveBeenCalledWith("Vendor payout already settled");
    expect(db.vendorPayout.updateMany).not.toHaveBeenCalled();
    expect(claimRelease()).toBeUndefined();
  });

  it("14. late success after FAILED cannot resurrect it; claims stay released", async () => {
    db.vendorPayout.findFirst.mockResolvedValue(processingPayout({ status: "FAILED" }));
    const r = await deliverWebhook("transfer.success");
    expect(r.send).toHaveBeenCalledWith("Vendor payout already settled");
    expect(db.vendorPayout.updateMany).not.toHaveBeenCalled();
  });

  it("webhook amount mismatch is ignored before any settlement", async () => {
    const r = await deliverWebhook("transfer.success", { amount: KOBO + 500 });
    expect(r.send).toHaveBeenCalledWith("Vendor payout webhook ignored");
    expect(db.vendorPayout.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("N-06 — concurrency", () => {
  /** Drives both the reconciler and a webhook concurrently against one CAS. */
  async function race(webhookEvent: string, gatewayStatus: string) {
    paystackGet.mockResolvedValue(paystackTransfer({ status: gatewayStatus }));
    await Promise.all([runReconciler(), deliverWebhook(webhookEvent)]);
  }

  it("15/16/17. only the PROCESSING CAS winner applies the side effect", async () => {
    let settled = false;
    db.vendorPayout.updateMany.mockImplementation(async () => {
      if (settled) return { count: 0 };
      settled = true;
      return { count: 1 };
    });
    await race("transfer.success", "success");
    // Exactly one terminal transition, and success retains the claims.
    expect(payoutCas().data.status).toBe("PAID");
    expect(claimRelease()).toBeUndefined();
    expect(
      db.order.updateMany.mock.calls.filter((c) => c[0].data?.payoutId === null),
    ).toHaveLength(0);
  });

  it("16b. reconciler failure vs failed webhook: claims released exactly once", async () => {
    let settled = false;
    db.vendorPayout.updateMany.mockImplementation(async () => {
      if (settled) return { count: 0 };
      settled = true;
      return { count: 1 };
    });
    await race("transfer.failed", "failed");
    expect(
      db.order.updateMany.mock.calls.filter((c) => c[0].data?.payoutId === null),
    ).toHaveLength(1);
  });

  it("18/19. CAS loser performs no destructive side effect", async () => {
    db.vendorPayout.updateMany.mockResolvedValue({ count: 0 });
    const r = await runReconciler();
    expect(r.settledPaid).toBe(0);
    expect(r.settledFailed).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it("20. released order is re-claimable only via a NEW payout; old one cannot settle", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ status: "failed" }));
    await runReconciler();
    // Claims released...
    expect(claimRelease()?.data).toEqual({ payoutId: null });
    // ...and a subsequent success webhook for the SAME reference is inert,
    // because the payout is FAILED and can never be CAS'd back to PAID.
    db.vendorPayout.findFirst.mockResolvedValue(processingPayout({ status: "FAILED" }));
    const r = await deliverWebhook("transfer.success");
    expect(r.send).toHaveBeenCalledWith("Vendor payout already settled");
  });

  it("19b. verification uses the persisted reference only (no new transfer)", async () => {
    await runReconciler();
    expect(paystackGet).toHaveBeenCalledWith(`/transfer/verify/${encodeURIComponent(REF)}`);
    expect(paystackPost).not.toHaveBeenCalled();
  });

  it("lookup helper classifies 404 as NOT_FOUND, never as a failure verdict", async () => {
    paystackGet.mockRejectedValueOnce(httpError(404));
    await expect(fetchTransferByReference(REF)).resolves.toEqual({ outcome: "NOT_FOUND" });
    paystackGet.mockRejectedValueOnce(httpError(500));
    await expect(fetchTransferByReference(REF)).resolves.toMatchObject({ outcome: "UNKNOWN" });
  });
});

/**
 * Stage O-C (N-03): reconciliation of rider withdrawals whose Paystack
 * transfer outcome was never learned.
 *
 * The reconciler answers exactly one question — "what happened to the
 * transfer that already exists?" — using the withdrawal's own persisted
 * reference (GET /transfer/verify/:reference). It must NEVER initiate a
 * transfer, create a withdrawal, mint a reference, or debit a wallet twice.
 */
import {
  verifyPendingRiderWithdrawals,
} from "../../src/jobs/payment/worker/verifyPendingRiderWithdrawals";
import { fetchTransferByReference } from "../../src/services/payoutService";
import { paystackWebhookHandler } from "../../src/controllers/webhook";
import prisma from "../../src/lib/prisma";
import { paystack } from "../../src/lib/axiosClient";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    riderWithdrawal: { findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
    deliveryPerson: { update: jest.fn() },
    vendorPayout: { findFirst: jest.fn(async () => null) },
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
  createAuditLog: jest.fn(async () => ({})),
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

jest.mock("../../src/services/paymentFinalizer.service", () => ({
  finalizePaymentSuccess: jest.fn(async () => ({ outcome: "SUCCESS" })),
}));

const db = prisma as unknown as {
  riderWithdrawal: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  deliveryPerson: { update: jest.Mock };
  $transaction: jest.Mock;
};
const paystackGet = (paystack as unknown as { get: jest.Mock }).get;
const paystackPost = (paystack as unknown as { post: jest.Mock }).post;

const WITHDRAWAL_ID = "11111111-1111-1111-1111-111111111111";
const REFERENCE = `rider_withdrawal_${WITHDRAWAL_ID}`;
const AMOUNT = 5000;
const KOBO = AMOUNT * 100;

function processingWithdrawal(overrides: Record<string, unknown> = {}) {
  return {
    id: WITHDRAWAL_ID,
    deliveryPersonId: "dp-1",
    amount: AMOUNT,
    status: "PROCESSING",
    reference: REFERENCE,
    requestedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Paystack 200 with an authoritative transfer body. */
function paystackTransfer(over: Record<string, unknown> = {}) {
  return {
    data: {
      status: true,
      message: "Transfer retrieved",
      data: {
        status: "success",
        amount: KOBO,
        reference: REFERENCE,
        transfer_code: "TRF_abc",
        failures: null,
        ...over,
      },
    },
  };
}
function httpError(status: number, message = "gateway error") {
  const e: any = new Error(`status ${status}`);
  e.response = { status, data: { message } };
  return e;
}
function transportError(code = "ECONNRESET") {
  const e: any = new Error("socket hang up");
  e.code = code;
  return e;
}

/** Rows that would be too fresh to reconcile are filtered by this. */
function runReconciler() {
  return verifyPendingRiderWithdrawals(20, 0);
}

function terminalStatuses() {
  return db.riderWithdrawal.updateMany.mock.calls
    .map((c) => c[0].data?.status)
    .filter((s): s is string => Boolean(s));
}

beforeEach(() => {
  jest.clearAllMocks();
  db.riderWithdrawal.findMany.mockResolvedValue([processingWithdrawal()]);
  db.riderWithdrawal.findUnique.mockResolvedValue(processingWithdrawal());
  db.riderWithdrawal.updateMany.mockResolvedValue({ count: 1 });
  db.deliveryPerson.update.mockImplementation(async (a: any) => ({ id: a.where.id }));
  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );
});

// ---------------------------------------------------------------------------
describe("Paystack lookup (1-9)", () => {
  it("1. successful transfer lookup", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer());
    await expect(fetchTransferByReference(REFERENCE)).resolves.toMatchObject({
      outcome: "FOUND",
      status: "success",
      amountKobo: KOBO,
      reference: REFERENCE,
    });
    // Read-only, and only ever the verify endpoint.
    expect(paystackGet).toHaveBeenCalledWith(
      `/transfer/verify/${encodeURIComponent(REFERENCE)}`,
    );
  });

  it("2. failed transfer lookup", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ status: "failed" }));
    await expect(fetchTransferByReference(REFERENCE)).resolves.toMatchObject({
      outcome: "FOUND",
      status: "failed",
    });
  });

  it("3. pending transfer lookup", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ status: "pending" }));
    await expect(fetchTransferByReference(REFERENCE)).resolves.toMatchObject({
      outcome: "FOUND",
      status: "pending",
    });
  });

  it("4. malformed/unexpected response is UNKNOWN, never FOUND", async () => {
    paystackGet.mockResolvedValueOnce({ data: { status: true, data: null } });
    await expect(fetchTransferByReference(REFERENCE)).resolves.toMatchObject({
      outcome: "UNKNOWN",
    });
    paystackGet.mockResolvedValueOnce({ data: { data: { amount: 10 } } });
    await expect(fetchTransferByReference(REFERENCE)).resolves.toMatchObject({
      outcome: "UNKNOWN",
    });
  });

  it("5. timeout is UNKNOWN", async () => {
    paystackGet.mockRejectedValueOnce(transportError("ECONNABORTED"));
    await expect(fetchTransferByReference(REFERENCE)).resolves.toMatchObject({
      outcome: "UNKNOWN",
    });
  });

  it("6. network failure is UNKNOWN", async () => {
    paystackGet.mockRejectedValueOnce(transportError());
    await expect(fetchTransferByReference(REFERENCE)).resolves.toMatchObject({
      outcome: "UNKNOWN",
    });
  });

  it("7. HTTP 5xx is UNKNOWN (never a failure verdict)", async () => {
    paystackGet.mockRejectedValueOnce(httpError(500));
    await expect(fetchTransferByReference(REFERENCE)).resolves.toMatchObject({
      outcome: "UNKNOWN",
    });
  });

  it("7b. HTTP 401 (bad key) is UNKNOWN, not NOT_FOUND", async () => {
    paystackGet.mockRejectedValueOnce(httpError(401, "Invalid key"));
    await expect(fetchTransferByReference(REFERENCE)).resolves.toMatchObject({
      outcome: "UNKNOWN",
    });
  });

  it("8. authoritative 404 maps to NOT_FOUND only", async () => {
    paystackGet.mockRejectedValueOnce(httpError(404));
    await expect(fetchTransferByReference(REFERENCE)).resolves.toEqual({
      outcome: "NOT_FOUND",
    });
  });
});

// ---------------------------------------------------------------------------
describe("Settlement (10-14)", () => {
  it("10. successful reconciliation: PROCESSING -> PAID, wallet debited once", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer());
    const r = await runReconciler();
    expect(r.settledPaid).toBe(1);
    expect(db.riderWithdrawal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WITHDRAWAL_ID, status: "PROCESSING" },
        data: expect.objectContaining({ status: "PAID" }),
      }),
    );
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
    expect(db.deliveryPerson.update).toHaveBeenCalledWith({
      where: { id: "dp-1" },
      data: { walletBalance: { decrement: AMOUNT } },
    });
  });

  it("11. failed reconciliation: PROCESSING -> FAILED, wallet untouched", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ status: "failed" }));
    const r = await runReconciler();
    expect(r.settledFailed).toBe(1);
    expect(terminalStatuses()).toEqual(["FAILED"]);
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it.each(["pending", "otp", "received"])(
    "12. Paystack status '%s' leaves the withdrawal PROCESSING",
    async (status) => {
      paystackGet.mockResolvedValueOnce(paystackTransfer({ status }));
      const r = await runReconciler();
      expect(r.stillPending).toBe(1);
      expect(terminalStatuses()).toHaveLength(0);
      expect(db.deliveryPerson.update).not.toHaveBeenCalled();
    },
  );

  it("12b. unrecognised Paystack status leaves PROCESSING for review", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ status: "wibble" }));
    const r = await runReconciler();
    expect(r.unresolved).toBe(1);
    expect(terminalStatuses()).toHaveLength(0);
  });

  it("13. ambiguous lookup leaves PROCESSING (unknown, not-found, timeout, 5xx)", async () => {
    paystackGet.mockRejectedValueOnce(transportError());
    const a = await runReconciler();
    paystackGet.mockRejectedValueOnce(httpError(500));
    const b = await runReconciler();
    paystackGet.mockRejectedValueOnce(httpError(404));
    const c = await runReconciler();
    expect([a.unresolved, b.unresolved]).toEqual([1, 1]);
    expect(c.notFound).toBe(1);
    expect(terminalStatuses()).toHaveLength(0);
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("14. amount mismatch: no PAID, no wallet debit, stays PROCESSING", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ amount: KOBO + 100 }));
    const r = await runReconciler();
    expect(r.amountMismatch).toBe(1);
    expect(r.settledPaid).toBe(0);
    expect(terminalStatuses()).toHaveLength(0);
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("14b. Paystack echoing a different reference cannot settle this withdrawal", async () => {
    paystackGet.mockResolvedValueOnce(
      paystackTransfer({ reference: "rider_withdrawal_someone-else" }),
    );
    const r = await runReconciler();
    expect(r.unresolved).toBe(1);
    expect(terminalStatuses()).toHaveLength(0);
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("Concurrency (15-18)", () => {
  it("15. two workers reconciling the same successful withdrawal debit once", async () => {
    paystackGet.mockResolvedValue(paystackTransfer());
    let settled = false;
    db.riderWithdrawal.updateMany.mockImplementation(async () => {
      if (settled) return { count: 0 };
      settled = true;
      return { count: 1 };
    });
    db.riderWithdrawal.findUnique.mockImplementation(async () =>
      processingWithdrawal({ status: settled ? "PAID" : "PROCESSING" }),
    );
    await Promise.all([runReconciler(), runReconciler()]);
    // Both workers may attempt the CAS; only the winner debits. The second
    // observes count === 0 and performs no financial mutation at all.
    expect(db.riderWithdrawal.updateMany.mock.calls.length).toBeGreaterThan(0);
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
    expect(db.deliveryPerson.update).toHaveBeenCalledWith({
      where: { id: "dp-1" },
      data: { walletBalance: { decrement: AMOUNT } },
    });
  });

  it("16. webhook success races reconciliation success: one wallet debit", async () => {
    paystackGet.mockResolvedValue(paystackTransfer());
    let settled = false;
    db.riderWithdrawal.updateMany.mockImplementation(async () => {
      if (settled) return { count: 0 };
      settled = true;
      return { count: 1 };
    });
    db.riderWithdrawal.findUnique.mockImplementation(async () =>
      processingWithdrawal({ status: settled ? "PAID" : "PROCESSING" }),
    );
    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.send = jest.fn().mockReturnValue(r);
    await Promise.all([
      runReconciler(),
      paystackWebhookHandler(
        {
          user: { id: "u1" },
          params: {},
          query: {},
          ip: "127.0.0.1",
          headers: { "x-paystack-signature": "sig" },
          body: Buffer.from(
            JSON.stringify({
              event: "transfer.success",
              data: { reference: REFERENCE, amount: KOBO },
            }),
          ),
        } as never,
        r,
      ),
    ]);
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
  });

  it("17. webhook failure races reconciliation success: one terminal transition", async () => {
    paystackGet.mockResolvedValue(paystackTransfer());
    let terminal: string | null = null;
    db.riderWithdrawal.updateMany.mockImplementation(async (args: any) => {
      if (terminal !== null) return { count: 0 };
      terminal = args.data.status;
      return { count: 1 };
    });
    db.riderWithdrawal.findUnique.mockImplementation(async () =>
      processingWithdrawal({ status: terminal ?? "PROCESSING" }),
    );
    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.send = jest.fn().mockReturnValue(r);
    await Promise.all([
      runReconciler(),
      paystackWebhookHandler(
        {
          user: { id: "u1" },
          params: {},
          query: {},
          ip: "127.0.0.1",
          headers: { "x-paystack-signature": "sig" },
          body: Buffer.from(
            JSON.stringify({
              event: "transfer.failed",
              data: { reference: REFERENCE, amount: KOBO },
            }),
          ),
        } as never,
        r,
      ),
    ]);
    expect(["PAID", "FAILED"]).toContain(terminal);
    const debits = db.deliveryPerson.update.mock.calls.filter(
      (c) => c[0].data?.walletBalance?.decrement === AMOUNT,
    );
    expect(debits.length).toBe(terminal === "PAID" ? 1 : 0);
  });

  it("18. duplicate reconciliation after PAID performs no further mutation", async () => {
    db.riderWithdrawal.findUnique.mockResolvedValue(
      processingWithdrawal({ status: "PAID" }),
    );
    db.riderWithdrawal.updateMany.mockResolvedValue({ count: 0 });
    paystackGet.mockResolvedValue(paystackTransfer());
    const r = await runReconciler();
    expect(r.settledPaid).toBe(0);
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("Transfer safety (19-24)", () => {
  it("19. reconciliation never initiates a transfer", async () => {
    paystackGet.mockResolvedValue(paystackTransfer());
    await runReconciler();
    expect(paystackPost).not.toHaveBeenCalled();
  });

  it("20. reconciliation never creates a RiderWithdrawal", async () => {
    paystackGet.mockResolvedValue(paystackTransfer());
    await runReconciler();
    expect(
      (db.riderWithdrawal as unknown as Record<string, jest.Mock>).create,
    ).toBeUndefined();
  });

  it("21. reconciliation always uses the persisted reference", async () => {
    paystackGet.mockResolvedValue(paystackTransfer());
    await runReconciler();
    expect(paystackGet).toHaveBeenCalledWith(
      `/transfer/verify/${encodeURIComponent(REFERENCE)}`,
    );
    expect(paystackGet).toHaveBeenCalledTimes(1);
  });

  it("22. an ambiguous lookup never triggers a second transfer attempt", async () => {
    paystackGet.mockRejectedValueOnce(transportError());
    const r = await runReconciler();
    expect(r.unresolved).toBe(1);
    expect(paystackPost).not.toHaveBeenCalled();
  });

  it("23/24. a temporary failure is retried on a later pass and still moves nothing", async () => {
    paystackGet.mockRejectedValueOnce(transportError());
    const first = await runReconciler();
    paystackGet.mockResolvedValueOnce(paystackTransfer());
    const second = await runReconciler();
    // Retried, and the retry is the one that settles — still a single
    // transfer lookup per pass and never a new transfer.
    expect(first.settledPaid).toBe(0);
    expect(second.settledPaid).toBe(1);
    expect(paystackGet).toHaveBeenCalledTimes(2);
    expect(paystackPost).not.toHaveBeenCalled();
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
  });

  it("rows without a reference are never selected", async () => {
    db.riderWithdrawal.findMany.mockResolvedValue([]);
    await runReconciler();
    expect(db.riderWithdrawal.findMany).toHaveBeenCalledWith(
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
});

// ---------------------------------------------------------------------------
describe("Wallet invariant (25-27)", () => {
  it("25. exact amount settles", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ amount: KOBO }));
    const r = await runReconciler();
    expect(r.settledPaid).toBe(1);
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
  });

  it("26. a mismatched amount cannot produce PAID", async () => {
    paystackGet.mockResolvedValueOnce(paystackTransfer({ amount: 1 }));
    const r = await runReconciler();
    expect(r.settledPaid).toBe(0);
    expect(r.amountMismatch).toBe(1);
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("27. repeated passes can never debit more than once for one withdrawal", async () => {
    paystackGet.mockResolvedValue(paystackTransfer());
    let settled = false;
    db.riderWithdrawal.updateMany.mockImplementation(async () => {
      if (settled) return { count: 0 };
      settled = true;
      return { count: 1 };
    });
    db.riderWithdrawal.findUnique.mockImplementation(async () =>
      processingWithdrawal({ status: settled ? "PAID" : "PROCESSING" }),
    );
    for (let i = 0; i < 4; i++) await runReconciler();
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
  });
});

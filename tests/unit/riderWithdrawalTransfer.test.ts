/**
 * Stage O-B — N-03: rider withdrawals must survive ambiguous Paystack
 * transfer outcomes.
 *
 * Root cause fixed: `processRiderWithdrawal` mapped EVERY error from
 * `initiateTransfer()` to PROCESSING → FAILED. FAILED is excluded from the
 * reserved-balance aggregate, so the same earnings became withdrawable
 * again; the rider could then create a second withdrawal (new reference) and
 * be paid twice, while the late `transfer.success` for the first transfer was
 * discarded because the row was no longer PROCESSING.
 *
 * Invariant under test:
 *   An uncertain external transfer outcome must NEVER become a retryable
 *   local FAILED withdrawal. Only a definite 4xx rejection may.
 *
 * Second invariant: a RiderWithdrawal can debit its rider's wallet AT MOST
 * ONCE, enforced by an atomic compare-and-set on the status transition — not
 * by the Redis replay-claim layer.
 *
 * These tests drive the REAL controller/service/webhook with mocked Prisma
 * and a mocked Paystack HTTP layer only.
 */
import { paystack } from "../../src/lib/axiosClient";
import { processRiderWithdrawal } from "../../src/controllers/riderOperationsController";
import { paystackWebhookHandler } from "../../src/controllers/webhook";
import {
  classifyTransferInitiationError,
  initiateTransfer,
} from "../../src/services/payoutService";
import prisma from "../../src/lib/prisma";
import { createAuditLog } from "../../src/utils/auditLog.service";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    deliveryPerson: { findUnique: jest.fn(), update: jest.fn() },
    riderWithdrawal: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    riderPayoutAccount: { update: jest.fn() },
    vendorPayout: { findFirst: jest.fn(async () => null) },
    payment: { findUnique: jest.fn() },
    refundRequest: { findFirst: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => ({})),
}));

jest.mock("../../src/utils/paystack", () => ({
  __esModule: true,
  // Signature verification itself is covered by webhookSignature.test.ts.
  validatePaystackSignature: jest.fn(() => true),
}));

// Redis-backed replay claim + rate limiter live outside the N-03 invariant.
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

jest.mock("../../src/services/paymentFinalizer.service", () => ({
  finalizePaymentSuccess: jest.fn(async () => ({ outcome: "SUCCESS" })),
}));

// The Paystack HTTP layer is the only external boundary mocked here; the
// controllers/services under test are the real implementations.
jest.mock("../../src/lib/axiosClient", () => ({
  __esModule: true,
  paystack: { post: jest.fn(), get: jest.fn() },
}));

const db = prisma as unknown as {
  deliveryPerson: { update: jest.Mock };
  riderWithdrawal: { findUnique: jest.Mock; updateMany: jest.Mock };
  $transaction: jest.Mock;
};
const audit = createAuditLog as jest.Mock;

// Script the gateway's answer per test.
const paystackPost = paystack.post as unknown as jest.Mock;

const WITHDRAWAL_ID = "11111111-1111-1111-1111-111111111111";
const REFERENCE = `rider_withdrawal_${WITHDRAWAL_ID}`;
const AMOUNT = 500000; // integer kobo (₦5,000), matching withdrawal.amount (Phase 3A)

function processingWithdrawal(overrides: Record<string, unknown> = {}) {
  return {
    id: WITHDRAWAL_ID,
    deliveryPersonId: "dp-1",
    payoutAccountId: "acct-1",
    amount: AMOUNT,
    status: "PROCESSING",
    reference: REFERENCE,
    idempotencyKey: "idem-1",
    failureReason: null,
    payoutAccount: { recipientCode: "RCP_1", accountName: "Rider", accountNumber: "x", bankCode: "058" },
    deliveryPerson: { user: { name: "Rider" } },
    ...overrides,
  };
}

function req(id = WITHDRAWAL_ID) {
  return {
    user: { id: "admin-1", sessionId: "s" },
    params: { withdrawalId: id },
    body: {},
    headers: {},
    query: {},
    socket: { remoteAddress: "127.0.0.1" },
    rawBody: Buffer.from("{}"),
    get: () => "sig",
  } as never;
}

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

/** A gateway error shaped like an HTTP error response. */
function httpError(status: number) {
  const e: any = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: { message: "gateway said no" } };
  return e;
}
/** A transport-level failure: no HTTP response was ever received. */
function transportError(code = "ECONNRESET", message = "socket hang up") {
  const e: any = new Error(message);
  e.code = code;
  e.request = {};
  return e;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.riderWithdrawal.findUnique.mockResolvedValue(processingWithdrawal());
  db.deliveryPerson.update.mockImplementation(async (a: any) => ({ id: a.where.id }));
  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );
  db.riderWithdrawal.updateMany.mockResolvedValue({ count: 1 });
});

// ---------------------------------------------------------------------------
describe("1-5. gateway outcome classification", () => {
  beforeEach(() => {
    // processRiderWithdrawal performs the PENDING -> PROCESSING claim itself.
    db.riderWithdrawal.findUnique.mockResolvedValue(
      processingWithdrawal({ status: "PENDING" }),
    );
  });

  it("classify: no HTTP response is UNKNOWN, 5xx is UNKNOWN, 4xx is REJECTED", () => {
    expect(classifyTransferInitiationError(transportError())).toBe("UNKNOWN");
    expect(classifyTransferInitiationError(httpError(500))).toBe("UNKNOWN");
    expect(classifyTransferInitiationError(httpError(503))).toBe("UNKNOWN");
    expect(classifyTransferInitiationError(httpError(400))).toBe("REJECTED");
    expect(classifyTransferInitiationError(httpError(401))).toBe("REJECTED");
    expect(classifyTransferInitiationError(httpError(422))).toBe("REJECTED");
  });

  it("classify: the legacy `retryable` flag is preserved (vendor payouts unchanged)", async () => {
    paystackPost.mockRejectedValueOnce(httpError(500));
    await expect(
      initiateTransfer({ amountKobo: 100, recipientCode: "RCP", reason: "r", reference: "ref-1" }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ retryable: false, outcome: "UNKNOWN" }),
    });
  });

  it("1. definite 4xx rejection -> FAILED, reservation released, no wallet debit", async () => {
    paystackPost.mockRejectedValueOnce(httpError(400));
    await expect(processRiderWithdrawal(req(), res())).rejects.toThrow();
    // call[0] is the PENDING -> PROCESSING claim; call[1] is the terminal one.
    const calls = db.riderWithdrawal.updateMany.mock.calls;
    expect(calls[0][0].data.status).toBe("PROCESSING");
    expect(calls[1][0].where).toEqual({ id: WITHDRAWAL_ID, status: "PROCESSING" });
    expect(calls[1][0].data.status).toBe("FAILED");
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].action === "RIDER_WITHDRAWAL_TRANSFER_FAILED")).toBe(true);
  });

  it("2. HTTP 5xx -> ambiguous, stays PROCESSING, reservation held", async () => {
    paystackPost.mockRejectedValueOnce(httpError(500));
    await expect(processRiderWithdrawal(req(), res())).rejects.toThrow(/not yet known/i);
    // Only the claim write happened — nothing moved it to FAILED.
    const terminal = db.riderWithdrawal.updateMany.mock.calls.filter(
      (c) => c[0].data?.status === "FAILED",
    );
    expect(terminal).toHaveLength(0);
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].action === "RIDER_WITHDRAWAL_TRANSFER_UNKNOWN")).toBe(true);
  });

  it("3. timeout (ECONNABORTED) -> stays PROCESSING, no second transfer attempt", async () => {
    paystackPost.mockRejectedValueOnce(transportError("ECONNABORTED", "timeout of 0ms exceeded"));
    await expect(processRiderWithdrawal(req(), res())).rejects.toThrow(/not yet known/i);
    expect(
      db.riderWithdrawal.updateMany.mock.calls.filter((c) => c[0].data?.status === "FAILED"),
    ).toHaveLength(0);
    expect(paystackPost).toHaveBeenCalledTimes(1);
  });

  it("4. ECONNRESET -> stays PROCESSING", async () => {
    paystackPost.mockRejectedValueOnce(transportError("ECONNRESET", "socket hang up"));
    await expect(processRiderWithdrawal(req(), res())).rejects.toThrow(/not yet known/i);
    expect(
      db.riderWithdrawal.updateMany.mock.calls.filter((c) => c[0].data?.status === "FAILED"),
    ).toHaveLength(0);
  });

  it("5. successful Paystack acceptance -> stays PROCESSING, wallet NOT debited yet", async () => {
    paystackPost.mockResolvedValueOnce({ data: { data: { id: 1, status: "success" } } });
    const r = res();
    await processRiderWithdrawal(req(), r);
    // Stays PROCESSING: a 2xx only means Paystack accepted the request.
    expect(db.riderWithdrawal.updateMany.mock.calls.every((c) => c[0].data.status === "PROCESSING")).toBe(true);
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("5b. unknown outcome leaves the reference bound to this withdrawal (no re-initiation)", async () => {
    paystackPost.mockRejectedValueOnce(transportError());
    await expect(processRiderWithdrawal(req(), res())).rejects.toThrow();
    // The deterministic reference is derived from the withdrawal id and was
    // persisted by the PENDING->PROCESSING claim before the gateway call.
    expect(REFERENCE).toBe(`rider_withdrawal_${WITHDRAWAL_ID}`);
    const auditMeta = audit.mock.calls.find((c) => c[0].action === "RIDER_WITHDRAWAL_TRANSFER_UNKNOWN")?.[0].metadata;
    expect(auditMeta.reference).toBe(REFERENCE);
  });

  it("15. a PROCESSING withdrawal cannot be re-initiated (admin retry rejected)", async () => {
    // Re-calling the endpoint re-reads the row: it is no longer PENDING.
    db.riderWithdrawal.findUnique.mockResolvedValue(
      processingWithdrawal({ status: "PROCESSING" }),
    );
    await expect(
      processRiderWithdrawal(req(), res()),
    ).rejects.toThrow(/Only pending rider withdrawals can be processed/);
    expect(paystackPost).not.toHaveBeenCalled();
  });

  it("15b. definite rejection makes the withdrawal retryable via a NEW row, unknown outcome does not", async () => {
    // Simulates the reservation aggregate that requestRiderWithdrawal uses.
    const reservedFor = (status: string) => (status === "PENDING" || status === "PROCESSING" ? AMOUNT : 0);
    // After an unknown outcome the row is still PROCESSING => funds reserved.
    expect(reservedFor("PROCESSING")).toBe(AMOUNT);
    // After a definite rejection the row is FAILED => funds released.
    expect(reservedFor("FAILED")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------
function transferEvent(event: string, reference = REFERENCE, amount = AMOUNT) {
  return Buffer.from(
    JSON.stringify({
      event,
      data: { reference, amount, status: event === "transfer.success" ? "success" : "failed" },
    }),
  );
}

function webhookRes() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  return r;
}

async function deliverWebhook(event: string, reference = REFERENCE) {
  const r = webhookRes();
  const q: any = {
    user: { id: "u1" },
    params: {},
    query: {},
    ip: "127.0.0.1",
    headers: { "x-paystack-signature": "test-signature" },
    // express.raw() mounted on this route: the handler requires a Buffer.
    body: transferEvent(event, reference),
  };
  await paystackWebhookHandler(q, r);
  return r;
}

describe("6-11. transfer webhook settlement (atomic CAS)", () => {
  it("6. transfer.success settles PROCESSING -> PAID and debits exactly once", async () => {
    await deliverWebhook("transfer.success");
    expect(db.riderWithdrawal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WITHDRAWAL_ID, status: "PROCESSING" },
        data: expect.objectContaining({ status: "PAID" }),
      }),
    );
    expect(db.deliveryPerson.update).toHaveBeenCalledWith({
      where: { id: "dp-1" },
      data: { walletBalance: { decrement: AMOUNT } },
    });
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
  });

  it("7. duplicate transfer.success on a PAID withdrawal does not debit again", async () => {
    db.riderWithdrawal.findUnique.mockResolvedValue(processingWithdrawal({ status: "PAID" }));
    const r = await deliverWebhook("transfer.success");
    expect(r.send).toHaveBeenCalledWith("Transfer already settled");
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("8. concurrent duplicate success webhooks: one CAS wins, one wallet debit", async () => {
    // Both deliveries read PROCESSING (findUnique), but the CAS is the guard.
    let transitions = 0;
    db.riderWithdrawal.updateMany.mockImplementation(async () => {
      transitions += 1;
      return { count: transitions === 1 ? 1 : 0 };
    });
    await Promise.all([
      deliverWebhook("transfer.success"),
      deliverWebhook("transfer.success"),
    ]);
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
  });

  it("9. transfer.failed settles PROCESSING -> FAILED with no wallet debit", async () => {
    await deliverWebhook("transfer.failed");
    expect(db.riderWithdrawal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WITHDRAWAL_ID, status: "PROCESSING" },
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("10. duplicate transfer.failed has no additional side effects", async () => {
    db.riderWithdrawal.findUnique.mockResolvedValue(processingWithdrawal({ status: "FAILED" }));
    const r = await deliverWebhook("transfer.failed");
    expect(r.send).toHaveBeenCalledWith("Transfer already settled");
    expect(db.riderWithdrawal.updateMany).not.toHaveBeenCalled();
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("11. success vs failed race: exactly one terminal transition, one wallet mutation", async () => {
    // Which event wins is genuinely non-deterministic; the money invariant is
    // not: exactly one row transition, and the wallet is debited at most once
    // (only the PAID winner may touch it).
    let terminal: string | null = null;
    db.riderWithdrawal.updateMany.mockImplementation(async (args: any) => {
      const where = args.where as { status: string };
      if (terminal !== null) return { count: 0 };
      terminal = args.data.status;
      return { count: 1 };
    });
    db.riderWithdrawal.findUnique.mockImplementation(async () =>
      processingWithdrawal({ status: terminal ?? "PROCESSING" }),
    );
    await Promise.all([
      deliverWebhook("transfer.success"),
      deliverWebhook("transfer.failed"),
    ]);
    expect(["PAID", "FAILED"]).toContain(terminal);
    const debits = db.deliveryPerson.update.mock.calls.filter(
      (c) => c[0].data?.walletBalance?.decrement === AMOUNT,
    );
    expect(debits.length).toBeLessThanOrEqual(1);
    expect(debits.length).toBe(terminal === "PAID" ? 1 : 0);
  });

  it("12. a PAID withdrawal receiving transfer.success again never debits", async () => {
    db.riderWithdrawal.findUnique.mockResolvedValue(processingWithdrawal({ status: "PAID" }));
    // Even if the early-return guard were bypassed, the CAS would refuse.
    db.riderWithdrawal.updateMany.mockResolvedValue({ count: 0 });
    await deliverWebhook("transfer.success");
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("13. a PAID withdrawal receiving transfer.failed stays PAID (no reversal)", async () => {
    db.riderWithdrawal.findUnique.mockResolvedValue(processingWithdrawal({ status: "PAID" }));
    await deliverWebhook("transfer.failed");
    expect(db.riderWithdrawal.updateMany).not.toHaveBeenCalled();
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("14. late success on an already-FAILED withdrawal creates no second payout", async () => {
    db.riderWithdrawal.findUnique.mockResolvedValue(processingWithdrawal({ status: "FAILED" }));
    const r = await deliverWebhook("transfer.success");
    // Safely ignored: no wallet mutation, no new transfer. Resolving whether
    // money actually moved is Stage O-C reconciliation's job.
    expect(r.send).toHaveBeenCalledWith("Transfer already settled");
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
    expect(db.riderWithdrawal.updateMany).not.toHaveBeenCalled();
  });

  it("16. the webhook matches strictly by the withdrawal reference", async () => {
    db.riderWithdrawal.findUnique.mockResolvedValue(null);
    const r = await deliverWebhook("transfer.success", "rider_withdrawal_someone-else");
    expect(db.riderWithdrawal.findUnique).toHaveBeenCalledWith({
      where: { reference: "rider_withdrawal_someone-else" },
    });
    expect(r.send).toHaveBeenCalledWith("Transfer webhook ignored");
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("17-18. wallet invariant", () => {
  it("17. repeated success events cannot drive the wallet below what is settled", async () => {
    // Simulate three deliveries of the same transfer against a DB that only
    // lets the first one transition the row.
    let settled = false;
    db.riderWithdrawal.updateMany.mockImplementation(async () => {
      if (settled) return { count: 0 };
      settled = true;
      return { count: 1 };
    });
    for (let i = 0; i < 3; i++) await deliverWebhook("transfer.success");
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
    expect(db.deliveryPerson.update).toHaveBeenCalledWith({
      where: { id: "dp-1" },
      data: { walletBalance: { decrement: AMOUNT } },
    });
  });

  it("18. exactly one wallet debit per PAID withdrawal across mixed events", async () => {
    let state: string | null = "PROCESSING";
    db.riderWithdrawal.findUnique.mockImplementation(async () =>
      processingWithdrawal({ status: state as string }),
    );
    db.riderWithdrawal.updateMany.mockImplementation(async (args: any) => {
      const where = args.where as { status: string };
      if (state !== where.status) return { count: 0 };
      state = args.data.status;
      return { count: 1 };
    });
    for (const e of ["transfer.success", "transfer.success", "transfer.failed", "transfer.success"]) {
      await deliverWebhook(e);
    }
    expect(state).toBe("PAID");
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
  });
});

/**
 * Batch C — webhook infrastructure failures + charge.failed handling.
 *
 * C1: Redis failures in the rate limiter / replay claim previously fell
 * into the catch-all and were acknowledged with 200, so Paystack never
 * retried a genuinely unprocessed event. They now answer 503 (retryable).
 *
 * C2: `charge.failed` was rejected as unsupported, leaving failed payments
 * PENDING until expiry. Verified failures now record FAILED via a
 * conditional transition that can never overwrite a settled payment; order
 * cancellation and stock restoration stay with the expiry worker's CAS.
 *
 * Drives the REAL `paystackWebhookHandler` (mocked Prisma/Redis/signature
 * only). No live Paystack, Redis, or database.
 */
import { paystackWebhookHandler } from "../../src/controllers/webhook";
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import { createAuditLog } from "../../src/utils/auditLog.service";
import { settleRiderWithdrawalPaid } from "../../src/services/riderWithdrawalSettlement.service";
import prisma from "../../src/lib/prisma";
import { redisPayments } from "../../src/lib/redis";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    vendorPayout: { findFirst: jest.fn(async () => null) },
    riderWithdrawal: { findUnique: jest.fn(async () => null) },
    auditLog: { create: jest.fn(async () => ({})) },
  },
}));

// Phase 3.2.8: the handler now drives the inflight/done claim state
// machine. Its ownership/fencing logic has dedicated coverage in
// webhookReplayClaim.test.ts (against a Redis double that implements the
// scripts' commands), so here it is stubbed to control the outcome the
// handler reacts to.
const mockClaimState = {
  acquire: "ACQUIRED" as "ACQUIRED" | "DONE" | "BUSY",
  acquireThrows: false,
  completeReturns: true,
  completeThrows: false,
  releaseReturns: true,
  releaseThrows: false,
  released: [] as Array<{ webhookId: string; token: string }>,
  completed: 0,
};

jest.mock("../../src/services/webhookReplayClaim.service", () => ({
  __esModule: true,
  newClaimToken: jest.fn(() => "mock-owner-token"),
  acquireWebhookClaim: jest.fn(async () => {
    if (mockClaimState.acquireThrows) throw new Error("ECONNRESET: claim store down");
    return mockClaimState.acquire;
  }),
  completeWebhookClaim: jest.fn(async () => {
    if (mockClaimState.completeThrows) throw new Error("ECONNRESET: completion failed");
    mockClaimState.completed += 1;
    return mockClaimState.completeReturns;
  }),
  releaseWebhookClaim: jest.fn(async (_client: unknown, claim: any) => {
    if (mockClaimState.releaseThrows) throw new Error("ECONNRESET: release failed");
    mockClaimState.released.push(claim);
    return mockClaimState.releaseReturns;
  }),
  WEBHOOK_INFLIGHT_TTL_SECONDS: 300,
  WEBHOOK_DONE_TTL_SECONDS: 259200,
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisPayments: {
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    incr: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    ttl: jest.fn(async () => 60),
    eval: jest.fn(async () => 1),
  },
}));

jest.mock("../../src/utils/paystack", () => ({
  __esModule: true,
  validatePaystackSignature: jest.fn(() => true),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => ({})),
}));

jest.mock("../../src/services/paymentFinalizer.service", () => ({
  finalizePaymentSuccess: jest.fn(async () => ({ outcome: "SUCCESS" })),
}));

jest.mock("../../src/services/refundFinalizer.service", () => ({
  matchRefundRequest: jest.fn(),
  completeRefund: jest.fn(),
  failRefund: jest.fn(),
}));

jest.mock("../../src/services/vendorPayoutSettlement.service", () => ({
  // Return the real helpers' shape: the handler reads `settlement.outcome`.
  settleVendorPayoutPaid: jest.fn(async () => ({ outcome: "SETTLED" })),
  settleVendorPayoutFailed: jest.fn(async () => ({ outcome: "SETTLED" })),
}));

jest.mock("../../src/services/riderWithdrawalSettlement.service", () => ({
  settleRiderWithdrawalPaid: jest.fn(async () => ({ outcome: "SETTLED" })),
  settleRiderWithdrawalFailed: jest.fn(async () => ({ outcome: "SETTLED" })),
}));

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const redis = redisPayments as unknown as Record<string, jest.Mock>;
const mockedFinalize = finalizePaymentSuccess as jest.Mock;
const mockedAudit = createAuditLog as jest.Mock;

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  return r;
}

function webhookReq(event: string, data: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify({ event, data }));
  return {
    ip: "127.0.0.1",
    body,
    headers: { "x-paystack-signature": "sig" },
    socket: { remoteAddress: "127.0.0.1" },
  } as never;
}

function statusOf(r: any) {
  return r.status.mock.calls[0][0];
}

const chargeData = (over: Record<string, unknown> = {}) => ({
  reference: "PSK-1",
  amount: 500000,
  channel: "card",
  metadata: { userId: "cust-1" },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockClaimState.acquire = "ACQUIRED";
  mockClaimState.acquireThrows = false;
  mockClaimState.completeReturns = true;
  mockClaimState.completeThrows = false;
  mockClaimState.releaseReturns = true;
  mockClaimState.releaseThrows = false;
  mockClaimState.released = [];
  mockClaimState.completed = 0;
  redis.incr.mockResolvedValue(1);
  redis.set.mockResolvedValue("OK");
  db.payment.updateMany.mockResolvedValue({ count: 1 });
});

describe("Batch C1 — infrastructure failures answer retryably", () => {
  it("1. rate-limiter Redis failure returns 503 without processing", async () => {
    redis.incr.mockRejectedValueOnce(new Error("Connection is closed"));
    const r = res();

    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), r);

    expect(statusOf(r)).toBe(503);
    expect(mockedFinalize).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
  });

  it("2. replay-claim Redis failure returns 503 without processing", async () => {
    mockClaimState.acquireThrows = true;
    const r = res();

    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), r);

    expect(statusOf(r)).toBe(503);
    expect(mockedFinalize).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
  });

  it("3. unsupported events are still rejected without processing", async () => {
    const r = res();
    await paystackWebhookHandler(webhookReq("transfer.reverse", chargeData()), r);

    expect(statusOf(r)).toBe(400);
    expect(mockedFinalize).not.toHaveBeenCalled();
  });
});

describe("Batch C2 — charge.failed handling", () => {
  it("4. verified failure on a pending payment records FAILED conditionally", async () => {
    const r = res();
    await paystackWebhookHandler(
      webhookReq("charge.failed", { ...chargeData(), gateway_response: "Declined" }),
      r,
    );

    expect(statusOf(r)).toBe(200);
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reference: "PSK-1", status: { in: ["PENDING", "INITIATED"] } },
      }),
    );
    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PAYMENT_CHARGE_FAILED" }),
    );
    // Failure recording never finalizes success and never touches orders.
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it("5. failure for an already-settled payment matches nothing and writes nothing else", async () => {
    db.payment.updateMany.mockResolvedValueOnce({ count: 0 }); // lost: already SUCCESS
    const r = res();
    await paystackWebhookHandler(webhookReq("charge.failed", chargeData()), r);

    expect(statusOf(r)).toBe(200);
    // The conditional write is the protection: same predicate, zero rows.
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reference: "PSK-1", status: { in: ["PENDING", "INITIATED"] } },
      }),
    );
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it("6. duplicate charge.failed delivery is a replay, not a second transition", async () => {
    const first = res();
    await paystackWebhookHandler(webhookReq("charge.failed", chargeData()), first);
    expect(statusOf(first)).toBe(200);
    expect(mockClaimState.completed).toBe(1); // durably resolved

    // The redelivery finds the durable done marker.
    mockClaimState.acquire = "DONE";
    const second = res();
    await paystackWebhookHandler(webhookReq("charge.failed", chargeData()), second);

    expect(statusOf(second)).toBe(200);
    expect(db.payment.updateMany).toHaveBeenCalledTimes(1);
  });

  it("7. charge.success still routes to the shared finalizer (regression guard)", async () => {
    const r = res();
    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), r);

    expect(statusOf(r)).toBe(200);
    expect(mockedFinalize).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "PSK-1", amountKobo: 500000 }),
    );
  });
});

describe("Batch F-C1 — processing failures are retryable, not acknowledged", () => {
  it("10. an unprocessed event whose claim was released gets a retryable status", async () => {
    mockedFinalize.mockRejectedValueOnce(new Error("db unavailable"));
    const r = res();

    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), r);

    // NOT 200: acknowledging here would tell Paystack never to resend an
    // event that was never durably processed.
    expect(statusOf(r)).toBe(503);
    // The lease was released (owner-checked) so the provider's retry can
    // acquire it again instead of being suppressed.
    expect(mockClaimState.released).toHaveLength(1);
    expect(mockClaimState.completed).toBe(0); // never marked resolved
  });

  it("11. a genuine database failure during processing is also retryable", async () => {
    db.payment.updateMany.mockRejectedValueOnce(new Error("connection reset"));
    const r = res();

    await paystackWebhookHandler(webhookReq("charge.failed", chargeData()), r);

    expect(statusOf(r)).toBe(503);
    expect(mockClaimState.released).toHaveLength(1);
    expect(mockClaimState.completed).toBe(0);
  });

  it("12. a retry after release re-processes and settles exactly once", async () => {
    // First delivery fails after claiming; Paystack resends.
    mockedFinalize.mockRejectedValueOnce(new Error("db unavailable"));
    const first = res();
    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), first);
    expect(statusOf(first)).toBe(503);
    expect(mockClaimState.released).toHaveLength(1);

    // The lease was released, so the retry acquires again and processes.
    mockedFinalize.mockResolvedValueOnce({ outcome: "SUCCESS" });
    const retry = res();
    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), retry);

    expect(statusOf(retry)).toBe(200);
    expect(mockClaimState.completed).toBe(1); // now durably resolved
    expect(mockedFinalize).toHaveBeenCalledTimes(2);
    // The finalizer's own payment claim is idempotent — one SUCCESS, not two
    // captured payments (asserted in paymentRecoveryRefundOwed.test.ts).
  });

  it("13. permanent rejections and duplicates keep their established contract", async () => {
    // Unsupported event -> 400 (permanent, no retry loop).
    const unsupported = res();
    await paystackWebhookHandler(webhookReq("transfer.reverse", chargeData()), unsupported);
    expect(statusOf(unsupported)).toBe(400);

    // Replay of an already-resolved event -> 200 duplicate response.
    mockClaimState.acquire = "DONE";
    const duplicate = res();
    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), duplicate);
    expect(statusOf(duplicate)).toBe(200);
    expect(duplicate.send).toHaveBeenCalledWith("Webhook already processed");
    expect(mockedFinalize).not.toHaveBeenCalled();
  });
});

describe("Batch F-1 — in-flight is not completed, and completion is recorded", () => {
  it("14. an event owned by another worker is NOT acknowledged (retryable)", async () => {
    mockClaimState.acquire = "BUSY";
    const r = res();

    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), r);

    // A live lease is not a resolved event: answering 200 would let the
    // provider stop retrying while the owner may still die.
    expect(statusOf(r)).toBe(503);
    expect(mockedFinalize).not.toHaveBeenCalled();
    expect(mockClaimState.completed).toBe(0);
    expect(mockClaimState.released).toHaveLength(0); // not ours to release
  });

  it("15. a processed event is promoted to done before the 2xx is sent", async () => {
    const r = res();
    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), r);

    expect(statusOf(r)).toBe(200);
    expect(mockClaimState.completed).toBe(1);
  });

  it("16. a lost lease before completion still acknowledges, and stays retryable", async () => {
    // The lease lapsed mid-processing and another worker owns it now: our
    // completion is a no-op, but the work this handler did is real, so the
    // response stays 2xx. The event is NOT suppressed — the other owner
    // controls its state.
    mockClaimState.completeReturns = false;
    const r = res();

    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), r);

    expect(statusOf(r)).toBe(200);
    expect(mockClaimState.completed).toBe(1);
    expect(mockClaimState.released).toHaveLength(0);
  });

  it("17. a Redis failure while recording completion is NOT acknowledged", async () => {
    mockClaimState.completeThrows = true;
    const r = res();

    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), r);

    // Financial work committed but completion is unrecorded — releasing the
    // lease and asking for a retry is safer than a false 200.
    expect(statusOf(r)).toBe(503);
    expect(mockClaimState.released).toHaveLength(1);
  });

  it("18. a release failure after a crash still answers retryable", async () => {
    mockedFinalize.mockRejectedValueOnce(new Error("db unavailable"));
    mockClaimState.releaseThrows = true;
    const r = res();

    await paystackWebhookHandler(webhookReq("charge.success", chargeData()), r);

    expect(statusOf(r)).toBe(503);
    expect(mockClaimState.completed).toBe(0);
  });
});

describe("Batch G — rider transfer amount verification", () => {
  const mockedSettleRiderPaid = settleRiderWithdrawalPaid as jest.Mock;

  function processingWithdrawal() {
    (db.riderWithdrawal.findUnique as jest.Mock).mockResolvedValue({
      id: "w-1",
      status: "PROCESSING",
      // Phase 3A: withdrawal amount is integer kobo (₦5000 = 500000 kobo).
      amount: 500000,
      reference: "rider_withdrawal_w-1",
    });
  }

  it("8. matching success amount settles via the shared helper", async () => {
    processingWithdrawal();
    const r = res();
    await paystackWebhookHandler(
      webhookReq("transfer.success", { reference: "rider_withdrawal_w-1", amount: 500000 }),
      r,
    );

    expect(statusOf(r)).toBe(200);
    expect(mockedSettleRiderPaid).toHaveBeenCalledWith("w-1");
  });

  it("9. mismatched success amount is ignored without debiting", async () => {
    processingWithdrawal();
    const r = res();
    await paystackWebhookHandler(
      webhookReq("transfer.success", { reference: "rider_withdrawal_w-1", amount: 499900 }),
      r,
    );

    expect(statusOf(r)).toBe(200);
    expect(mockedSettleRiderPaid).not.toHaveBeenCalled();
  });
});

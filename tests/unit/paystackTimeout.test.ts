/**
 * FIN-07-03a — bounded Paystack request timeout.
 *
 * WHAT THIS SUITE DOES *NOT* DO
 * -----------------------------
 * It does not connect to Paystack, PostgreSQL, Redis or any network service.
 * The Axios module itself is replaced with a controllable double, so the
 * timeout is exercised at the transport boundary while `paymentService` and
 * `verifyPendingPayments` run as real code.
 *
 * The point is the *error path*, not the number: a request that cannot hang
 * forever must still land in the worker's existing catch, must not be mistaken
 * for evidence that Paystack declined the payment, must not move any payment or
 * order state, and must leave the reference eligible for a later attempt.
 *
 * The "does not prevent overlapping cron runs" caveat is explicit in the
 * module doc: bounding one request does not bound a whole worker pass.
 */
const axiosGet = jest.fn();
const axiosPost = jest.fn();
const createInstance = {
  get: axiosGet,
  post: axiosPost,
  request: jest.fn(),
  defaults: {},
};

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => createInstance),
    defaults: {},
  },
  create: jest.fn(() => createInstance),
}));

jest.mock("../../src/config/config", () => ({
  __esModule: true,
  default: { paystackSecret: "test-secret-not-real" },
}));

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    order: { findMany: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(async (arg: any) => (typeof arg === "function" ? arg : arg)),
  },
}));

jest.mock("../../src/services/inventory.service", () => ({
  __esModule: true,
  restoreStockForOrders: jest.fn(async () => []),
  reserveStockForItems: jest.fn(async () => {}),
  assertQuantityAvailable: jest.fn(async () => {}),
}));

// The finalizer is not under test here; mocking it lets the assertions state
// precisely whether verification reached it, and stops its own database work
// from running against the mocked client.
jest.mock("../../src/services/paymentFinalizer.service", () => ({
  __esModule: true,
  finalizePaymentSuccess: jest.fn(async () => ({ outcome: "SUCCESS" })),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
  clearProductsCache: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/activityUtils/notify", () => ({
  __esModule: true,
  sendNotification: jest.fn(async () => ({})),
  sendNotificationToMany: jest.fn(async () => []),
  notifyRole: jest.fn(async () => []),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/generate Receipt/generateReceipt", () => ({
  __esModule: true,
  generateReceipt: jest.fn(async () => ({ pdfUrl: "http://test/r.pdf" })),
}));

import axios from "axios";
import { PAYSTACK_REQUEST_TIMEOUT_MS, paystack } from "../../src/lib/axiosClient";
import { verifyPayment } from "../../src/services/paymentService";
import { verifyPendingPayments } from "../../src/jobs/payment/worker/verifyPendingPayments";
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import prisma from "../../src/lib/prisma";

const mockedFinalizer = finalizePaymentSuccess as jest.Mock;
const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

/**
 * `axios.create` runs once when `axiosClient` is first imported. Captured here
 * because `jest.clearAllMocks()` in `beforeEach` clears the recorded call, and
 * the assertions are about how the client was CONFIGURED, not about how many
 * times it was created.
 */
const createCalls = (axios.create as unknown as jest.Mock).mock.calls;
const paystackCreateConfig = createCalls[createCalls.length - 1][0];

/** An Axios-shaped client timeout, which is what Axios actually throws. */
const timeoutError = () => {
  const e: any = new Error(`timeout of ${PAYSTACK_REQUEST_TIMEOUT_MS}ms exceeded`);
  e.code = "ECONNABORTED";
  e.config = { baseURL: "https://api.paystack.co", url: "/transaction/verify/PSK-T" };
  return e;
};

/** A payment still INSIDE its window — the only state that reaches Paystack. */
const liveCandidate = () => ({
  id: "pay-1",
  reference: "PSK-T",
  orderId: "order-A",
  idempotencyKey: "batch-1",
  status: "PENDING",
  expiresAt: new Date(Date.now() + 10 * 60_000),
  createdAt: new Date(),
});

/** One page of candidates, then an empty page so the cursor loop terminates. */
const queuePayments = (rows: any[]) => {
  db.payment.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]);
};

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );
  db.payment.updateMany.mockResolvedValue({ count: 1 });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  // The expiry branch reads its eligible-order list before the per-order CAS.
  db.order.findMany.mockResolvedValue([]);
  mockedFinalizer.mockResolvedValue({ outcome: "SUCCESS" });
});

describe("FIN-07-03a — the Paystack client is bounded", () => {
  it("1. is created with an explicit, finite, positive timeout", () => {
    const createArg = paystackCreateConfig;
    expect(createArg.timeout).toBeDefined();
    expect(Number.isFinite(createArg.timeout)).toBe(true);
    expect(createArg.timeout).toBeGreaterThan(0);
    expect(PAYSTACK_REQUEST_TIMEOUT_MS).toBe(createArg.timeout);
    // Guards the original defect specifically: Axios treats "absent" as infinite.
    expect(createArg.timeout).not.toBe(0);
    expect(paystack).toBe(createInstance);
  });

  it("2. leaves headers, auth and base URL untouched, and changes no global default", () => {
    const createArg = paystackCreateConfig;
    expect(createArg.baseURL).toBe("https://api.paystack.co");
    expect(createArg.headers.Authorization).toBe("Bearer test-secret-not-real");
    expect(createArg.headers["Content-Type"]).toBe("application/json");
    // No unrelated client is reconfigured: only this instance gained a timeout.
    expect((axios.defaults as Record<string, unknown>).timeout).toBeUndefined();
    expect(createInstance.defaults).toEqual({});
  });

  it("2b. adds no automatic retry interceptor", () => {
    // A retry of a money-moving Paystack call is unsafe to introduce blindly.
    // The instance exposes only the raw verbs, no interceptors.
    expect(Object.keys(createInstance).sort()).toEqual(["defaults", "get", "post", "request"]);
    expect((createInstance as Record<string, unknown>).interceptors).toBeUndefined();
  });
});

describe("FIN-07-03a — a timeout reaches the worker's existing error path", () => {
  it("3. propagates through verifyPayment and is caught by the worker", async () => {
    axiosGet.mockRejectedValue(timeoutError());
    queuePayments([liveCandidate()]);

    await expect(verifyPayment("PSK-T")).rejects.toMatchObject({ code: "ECONNABORTED" });

    await verifyPendingPayments(50);

    // The worker swallowed it through its pre-existing catch.
    expect(mockedFinalizer).not.toHaveBeenCalled();
  });

  it("4. a timeout moves no payment or order state", async () => {
    axiosGet.mockRejectedValue(timeoutError());
    queuePayments([liveCandidate()]);

    await verifyPendingPayments(50);

    // No status write at all — not EXPIRED, not FAILED, not AMOUNT_MISMATCH.
    const statusWrites = db.payment.updateMany.mock.calls.filter((c: any) => c[0]?.data?.status);
    expect(statusWrites).toHaveLength(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it("5. does not treat the timeout as a gateway decline", async () => {
    axiosGet.mockRejectedValue(timeoutError());
    queuePayments([liveCandidate()]);

    await verifyPendingPayments(50);

    // The decisive distinction: a timeout never reaches the finalizer, so it can
    // never become a mismatch/failure verdict over a payment that may have
    // actually succeeded.
    expect(mockedFinalizer).not.toHaveBeenCalled();
    // ...and it is not retried within the same pass.
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it("6. the reference is retried on the next pass and then succeeds", async () => {
    axiosGet
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({ data: { data: { status: "success", amount: 550_000, currency: "NGN" } } });
    queuePayments([liveCandidate()]);

    // First pass: transient failure, nothing settled.
    await verifyPendingPayments(50);
    expect(mockedFinalizer).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();

    // Second pass: the payment is still PENDING, so it is still a candidate.
    db.payment.findMany
      .mockResolvedValueOnce([liveCandidate()])
      .mockResolvedValue([]);
    await verifyPendingPayments(50);

    expect(mockedFinalizer).toHaveBeenCalledTimes(1);
    expect(mockedFinalizer.mock.calls[0][0]).toMatchObject({ reference: "PSK-T" });
  });
});

describe("FIN-07-03a — existing gateway outcomes are unchanged", () => {
  it("7. a gateway success still reaches the finalizer", async () => {
    axiosGet.mockResolvedValue({
      data: { data: { status: "success", amount: 550_000, currency: "NGN", channel: "card" } },
    });
    queuePayments([liveCandidate()]);

    await verifyPendingPayments(50);

    expect(mockedFinalizer).toHaveBeenCalledTimes(1);
    expect(mockedFinalizer.mock.calls[0][0]).toMatchObject({
      reference: "PSK-T",
      amountKobo: 550_000,
      currency: "NGN",
    });
  });

  it("8. a non-success gateway response still settles nothing", async () => {
    axiosGet.mockResolvedValue({ data: { data: { status: "failed" } } });
    queuePayments([liveCandidate()]);

    await verifyPendingPayments(50);

    expect(mockedFinalizer).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
  });

  it("9. an already-expired payment still takes the local expiry branch, with no gateway call", async () => {
    // Pre-existing behaviour the timeout must not disturb.
    queuePayments([
      { ...liveCandidate(), expiresAt: new Date(Date.now() - 60_000) },
    ]);

    await verifyPendingPayments(50);

    expect(axiosGet).not.toHaveBeenCalled();
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXPIRED" }),
      }),
    );
  });
});
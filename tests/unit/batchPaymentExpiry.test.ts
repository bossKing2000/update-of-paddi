/**
 * Stage N-04: batch payment expiry consistency.
 *
 * A single Paystack payment can cover several vendors' orders. The
 * authoritative batch key is `Order.idempotencyKey`; `Payment.orderId` points
 * only at the primary/first order. This worker used to expire just
 * `payment.orderId`, leaving sibling orders AWAITING_PAYMENT until the
 * separate order-expiry cron ran.
 *
 * These are runtime behaviour tests (real worker + mocked Prisma/Paystack),
 * not source-text assertions. Stock restoration is deliberately NOT asserted
 * here — that is a separate finding.
 */
import { verifyPendingPayments } from "../../src/jobs/payment/worker/verifyPendingPayments";
import { verifyPayment } from "../../src/services/paymentService";
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import prisma from "../../src/lib/prisma";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    order: { updateMany: jest.fn() },
    $transaction: jest.fn(async (arg: any) => arg),
  },
}));

jest.mock("../../src/services/paymentService", () => ({
  verifyPayment: jest.fn(),
}));

jest.mock("../../src/services/paymentFinalizer.service", () => ({
  finalizePaymentSuccess: jest.fn(async () => ({ outcome: "ALREADY_PROCESSED" })),
}));

const db = prisma as unknown as {
  payment: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  order: { updateMany: jest.Mock };
  $transaction: jest.Mock;
};
const mockedVerify = verifyPayment as jest.Mock;

/** An already-expired payment candidate. */
function expiredCandidate(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    reference: "PSK-REF-1",
    orderId: "order-A",
    idempotencyKey: "batch-123",
    status: "PENDING",
    expiresAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 20 * 60_000),
    ...over,
  };
}

/** First page returns the candidate; second page is empty so the loop ends. */
function queuePayments(payments: any[]) {
  db.payment.findMany
    .mockResolvedValueOnce(payments)
    .mockResolvedValue([]);
}

/** The single `updateMany` this worker issues for order expiry. */
function orderExpiryCall() {
  return db.order.updateMany.mock.calls[0][0];
}

function whereStatuses() {
  return orderExpiryCall().where.status.in;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (arg: any) => arg);
  db.payment.update.mockResolvedValue({});
  db.order.updateMany.mockResolvedValue({ count: 3 });
  mockedVerify.mockResolvedValue({ status: "failed" });
});

describe("N-04 — batch payment expiry", () => {
  it("1. single-order payment expiry still expires the payment and its order", async () => {
    queuePayments([expiredCandidate({ idempotencyKey: null })]);
    await verifyPendingPayments(10);

    expect(db.payment.update).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { status: "EXPIRED" },
    });
    // No batch key -> the pre-existing primary-order fallback is preserved.
    expect(orderExpiryCall().where).toEqual({
      id: "order-A",
      status: { in: ["AWAITING_PAYMENT", "PENDING"] },
    });
    expect(orderExpiryCall().data).toMatchObject({
      status: "CANCELLED_UNPAID",
      paymentStatus: "EXPIRED",
      cancellationReason: "PAYMENT_EXPIRED",
    });
  });

  it("2. multi-vendor batch expiry cancels ALL eligible siblings (N-04 regression)", async () => {
    queuePayments([
      expiredCandidate(), // orderId = order-A, idempotencyKey = batch-123
    ]);
    await verifyPendingPayments(10);

    // The primary regression: sibling discovery is by the batch key, not by
    // payment.orderId, so orders B and C are covered too.
    expect(orderExpiryCall().where).toEqual({
      idempotencyKey: "batch-123",
      status: { in: ["AWAITING_PAYMENT", "PENDING"] },
    });
    expect(orderExpiryCall().where.id).toBeUndefined();
    expect(db.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "EXPIRED" } }),
    );
  });

  it("3. mixed-state batch: terminal/in-flight siblings are never touched", async () => {
    // A = AWAITING_PAYMENT, B = PAYMENT_CONFIRMED, C = CANCELLED.
    // Eligibility is enforced by the status predicate in the UPDATE itself,
    // so B and C cannot be transitioned regardless of their state.
    queuePayments([expiredCandidate()]);
    db.order.updateMany.mockResolvedValue({ count: 1 }); // only A matched

    await verifyPendingPayments(10);

    const statuses = whereStatuses();
    expect(statuses).toEqual(["AWAITING_PAYMENT", "PENDING"]);
    for (const terminal of [
      "PAYMENT_CONFIRMED",
      "COMPLETED",
      "CANCELLED",
      "CANCELLED_UNPAID",
      "PAYMENT_EXPIRED",
    ]) {
      expect(statuses).not.toContain(terminal);
    }
  });

  it("4. a payment with no idempotencyKey falls back to payment.orderId", async () => {
    queuePayments([expiredCandidate({ idempotencyKey: null })]);
    await expect(verifyPendingPayments(10)).resolves.not.toThrow();
    expect(orderExpiryCall().where.id).toBe("order-A");
    expect(orderExpiryCall().where.idempotencyKey).toBeUndefined();
  });

  it("5. idempotent rerun: the status predicate makes a second pass a no-op", async () => {
    queuePayments([expiredCandidate()]);
    db.order.updateMany.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 0 });
    await verifyPendingPayments(10);
    const first = orderExpiryCall();

    queuePayments([expiredCandidate()]);
    await verifyPendingPayments(10);
    const second = db.order.updateMany.mock.calls[1][0];

    // Same guarded statement both times — no unconditional rewrite, so a
    // repeat run cannot transition anything twice.
    expect(second.where).toEqual(first.where);
    expect(second.data.status).toBe("CANCELLED_UNPAID");
  });

  it("6. only the payment's own batch is affected (other keys untouched)", async () => {
    queuePayments([expiredCandidate({ idempotencyKey: "batch-123" })]);
    await verifyPendingPayments(10);
    const { where } = orderExpiryCall();
    // Scoped to exactly this key — an unrelated batch-999 is not selectable.
    expect(where.idempotencyKey).toBe("batch-123");
    expect(where.idempotencyKey).not.toBe("batch-999");
  });

  it("7. payment + sibling expiry happen in ONE transaction", async () => {
    queuePayments([expiredCandidate()]);
    await verifyPendingPayments(10);

    // Batch form: a single $transaction call carrying both writes, so it is
    // all-or-nothing rather than payment-then-orders.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const arg = db.$transaction.mock.calls[0][0];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg).toHaveLength(2);
    expect(db.payment.update).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it("8. a not-yet-expired payment is verified, not expired (no behaviour change)", async () => {
    queuePayments([
      expiredCandidate({ expiresAt: new Date(Date.now() + 10 * 60_000) }),
    ]);
    await verifyPendingPayments(10);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(mockedVerify).toHaveBeenCalledWith("PSK-REF-1");
  });
});

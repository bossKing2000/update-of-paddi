/**
 * Stage N — N-01: the auto-filed paid-cancel refund must be bounded by the
 * cancelled order's own paid value, not by the batch payment total.
 *
 * One Paystack payment can cover several vendors' orders (Payment.orderId is
 * only the *primary* order). Before this fix the paid-cancel path created the
 * RefundRequest with `requestedAmountKobo: null`, which the admin submit path
 * resolves as `requestedAmountKobo ?? remaining` — i.e. the ENTIRE remaining
 * payment. Cancelling one vendor's order in a two-vendor batch therefore
 * queued a refund of the whole payment.
 *
 * These tests drive the REAL controllers (mocked Prisma/Paystack only):
 *   1. single-vendor paid cancel   -> order amount in kobo
 *   2. two-vendor batch, one cancel-> that order's kobo, never the payment total
 *   3. customer-initiated refund   -> still null (unchanged, by design)
 *   4. admin approval              -> reserves exactly the order amount
 */

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    refundRequest: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      aggregate: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    vendorPayout: { findUnique: jest.fn(), updateMany: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === "function" ? arg(require("../../src/lib/prisma").default) : arg,
    ),
  },
}));

jest.mock("../../src/services/inventory.service", () => ({
  __esModule: true,
  restoreStockForOrders: jest.fn(async () => {}),
  assertQuantityAvailable: jest.fn(),
  reserveStockForItems: jest.fn(async () => {}),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

jest.mock("../../src/services/refundService", () => ({
  refundPaymentViaPaystack: jest.fn(async () => ({ id: 9001, status: "queued" })),
  classifyRefundSubmitError: jest.fn(() => "unknown"),
  fetchRefundById: jest.fn(),
  listRefundsForTransaction: jest.fn(async () => []),
}));

jest.mock("../../src/services/payoutService", () => ({
  createTransferRecipient: jest.fn(async () => "RCP"),
  initiateTransfer: jest.fn(async () => ({ status: true })),
}));

import fs from "fs";
import prisma from "../../src/lib/prisma";
import { updateOrderStatus } from "../../src/controllers/orderController";
import { completeRefund } from "../../src/services/refundFinalizer.service";
import { requestRefund } from "../../src/controllers/paymentController";
import { updateRefundStatus } from "../../src/controllers/admin.controller";
import { refundPaymentViaPaystack } from "../../src/services/refundService";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedRefundViaPaystack = refundPaymentViaPaystack as jest.Mock;

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

const K = "batch-key-1";
/** Vendor A: N5,500 charged (base 5000 + 500 delivery). */
const vendorAOrder = () => ({
  id: "o-A",
  vendorId: "v-A",
  customerId: "c-1",
  status: "PAYMENT_CONFIRMED",
  paymentStatus: "SUCCESS",
  idempotencyKey: K,
  basePrice: 5000,
  deliveryFee: 500,
  totalPrice: 5500,
});
/** Vendor B: N4,500 charged. Untouched sibling in the same payment. */
const vendorBOrder = () => ({
  id: "o-B",
  vendorId: "v-B",
  customerId: "c-1",
  status: "COOKING",
  paymentStatus: "SUCCESS",
  idempotencyKey: K,
  basePrice: 4000,
  deliveryFee: 500,
  totalPrice: 4500,
});

const batchPayment = () => ({
  id: "p-1",
  userId: "c-1",
  // Primary order only — the sibling order is reachable by idempotencyKey.
  orderId: "o-A",
  idempotencyKey: K,
  reference: "PSK-BATCH-1",
  amount: 1000000,
  refundedAmount: 0,
  status: "SUCCESS",
});

beforeEach(() => {
  jest.clearAllMocks();
  db.order.update.mockImplementation(async (a: any) => ({ ...vendorAOrder(), ...a.data }));
  db.refundRequest.create.mockImplementation(async (a: any) => ({ id: "r-1", ...a.data }));
  db.refundRequest.update.mockImplementation(async (a: any) => ({ id: a.where.id, ...a.data }));
  db.payment.updateMany.mockResolvedValue({ count: 1 });
});

describe("N-01 — paid-cancel refund is scoped to the cancelled order", () => {
  it("1. single-vendor paid cancel files a refund for exactly that order's total in kobo", async () => {
    db.order.findUnique.mockResolvedValue(vendorAOrder());
    db.payment.findFirst.mockResolvedValue({
      id: "p-1",
      reference: "PSK-SINGLE",
      idempotencyKey: "k-single",
    });
    db.refundRequest.findFirst.mockResolvedValue(null);

    await updateOrderStatus(
      {
        user: { id: "v-A", role: "VENDOR", sessionId: "s" },
        params: { orderId: "o-A" },
        body: { status: "CANCELLED" },
      } as never,
      res(),
    );

    expect(db.refundRequest.create).toHaveBeenCalledTimes(1);
    const data = db.refundRequest.create.mock.calls[0][0].data;
    expect(data.orderId).toBe("o-A");
    expect(data.requestedAmountKobo).toBe(550000);
  });

  it("2. two-vendor batch: cancelling vendor A's order never uses the payment total", async () => {
    db.order.findUnique.mockResolvedValue(vendorAOrder());
    db.payment.findFirst.mockResolvedValue(batchPayment());
    db.refundRequest.findFirst.mockResolvedValue(null);

    await updateOrderStatus(
      {
        user: { id: "v-A", role: "VENDOR", sessionId: "s" },
        params: { orderId: "o-A" },
        body: { status: "CANCELLED" },
      } as never,
      res(),
    );

    const data = db.refundRequest.create.mock.calls[0][0].data;
    expect(data.orderId).toBe("o-A");
    // Scoped to the cancelled order, not the N10,000 batch payment.
    expect(data.requestedAmountKobo).toBe(550000);
    expect(data.requestedAmountKobo).not.toBe(1000000);
    expect(data.requestedAmountKobo).not.toBeNull();
    expect(data.paymentRef).toBe("PSK-BATCH-1");
  });

  it("2b. cancelling vendor B's order in the same batch is scoped to B", async () => {
    // B must still be in a cancellable state (the state machine rightly
    // forbids cancelling from COOKING).
    const bPayable = { ...vendorBOrder(), status: "PAYMENT_CONFIRMED" };
    db.order.findUnique.mockResolvedValue(bPayable);
    db.order.update.mockImplementation(async (a: any) => ({ ...bPayable, ...a.data }));
    db.payment.findFirst.mockResolvedValue(batchPayment());
    db.refundRequest.findFirst.mockResolvedValue(null);

    await updateOrderStatus(
      {
        user: { id: "v-B", role: "VENDOR", sessionId: "s" },
        params: { orderId: "o-B" },
        body: { status: "CANCELLED" },
      } as never,
      res(),
    );

    const data = db.refundRequest.create.mock.calls[0][0].data;
    expect(data.orderId).toBe("o-B");
    expect(data.requestedAmountKobo).toBe(450000);
    expect(data.requestedAmountKobo).not.toBe(1000000);
  });

  it("3. customer-initiated refund path is unchanged and stays amountless (null)", async () => {
    db.payment.findFirst.mockResolvedValue(batchPayment());
    db.payment.findUnique.mockResolvedValue(batchPayment());
    db.refundRequest.findFirst.mockResolvedValue(null);
    db.order.findMany.mockResolvedValue([vendorAOrder(), vendorBOrder()]);
    db.order.findUnique.mockResolvedValue(vendorAOrder());
    db.user.findUnique.mockResolvedValue({ id: "c-1", email: "c@x.test" });

    await requestRefund(
      {
        user: { id: "c-1", sessionId: "s" },
        body: { reference: "PSK-BATCH-1", reason: "changed my mind" },
        params: {},
        query: {},
        headers: {},
        socket: { remoteAddress: "127.0.0.1" },
      } as never,
      res(),
    );

    const data = db.refundRequest.create.mock.calls[0][0].data;
    expect(data.paymentRef).toBe("PSK-BATCH-1");
    // Deliberately unchanged: the admin `?? remaining` fallback must stay
    // available for the self-service path.
    expect(data.requestedAmountKobo).toBeUndefined();
    expect("requestedAmountKobo" in data).toBe(false);
  });

  it("4. admin approval reserves exactly the cancelled order's amount, not the payment total", async () => {
    db.refundRequest.findUnique.mockResolvedValue({
      id: "r-1",
      paymentRef: "PSK-BATCH-1",
      status: "APPROVED",
      // What the paid-cancel path now files.
      requestedAmountKobo: 550000,
    });
    db.payment.findUnique.mockResolvedValue(batchPayment());
    db.payment.findUniqueOrThrow = jest.fn(async () => batchPayment());
    db.$transaction.mockImplementationOnce(async (cb: any) => cb(db));

    await updateRefundStatus(
      {
        user: { id: "admin-1", sessionId: "s" },
        params: { id: "r-1" },
        body: { status: "COMPLETED" },
      } as never,
      res(),
    );

    // Reservation is the stored order-scoped amount …
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { refundedAmount: { increment: 550000 } },
      }),
    );
    // … and the persisted PROCESSING record carries the same figure.
    expect(db.refundRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestedAmountKobo: 550000 }),
      }),
    );
    // The whole N10,000 payment is NOT reserved.
    expect(db.payment.updateMany.mock.calls[0][0].data.refundedAmount.increment).toBe(550000);
    expect(db.payment.updateMany.mock.calls[0][0].data.refundedAmount.increment).not.toBe(1000000);
    expect(mockedRefundViaPaystack).toHaveBeenCalledTimes(1);
  });

  it("4b. an amountless request still falls back to the remaining balance (customer path preserved)", async () => {
    db.refundRequest.findUnique.mockResolvedValue({
      id: "r-2",
      paymentRef: "PSK-BATCH-1",
      status: "APPROVED",
      requestedAmountKobo: null,
    });
    db.payment.findUnique.mockResolvedValue(batchPayment());
    db.payment.findUniqueOrThrow = jest.fn(async () => batchPayment());
    db.$transaction.mockImplementationOnce(async (cb: any) => cb(db));

    await updateRefundStatus(
      {
        user: { id: "admin-1", sessionId: "s" },
        params: { id: "r-2" },
        body: { status: "COMPLETED" },
      } as never,
      res(),
    );

    // Unchanged legacy semantics: null => refund everything remaining.
    expect(db.payment.updateMany.mock.calls[0][0].data.refundedAmount.increment).toBe(1000000);
  });
});

// ---------------------------------------------------------------------------
// N-02 — completing an order-scoped refund must not touch sibling orders
// ---------------------------------------------------------------------------

describe("N-02 — completeRefund cancels only the refunded order", () => {
  const complete = () => completeRefund("r-1", { source: "webhook" });

  beforeEach(() => {
    jest.clearAllMocks();
    db.refundRequest.update.mockImplementation(async (a: any) => ({ id: a.where.id, ...a.data }));
    db.order.updateMany.mockResolvedValue({ count: 1 });
    db.payment.update.mockImplementation(async (a: any) => ({ ...batchPayment(), ...a.data }));
  });

  it("5. order-scoped refund cancels only that order; the sibling is untouched", async () => {
    db.refundRequest.findUnique.mockResolvedValue({
      id: "r-1",
      paymentRef: "PSK-BATCH-1",
      orderId: "o-A",
      status: "PROCESSING",
      requestedAmountKobo: 550000,
    });
    db.payment.findUnique.mockResolvedValue(batchPayment());
    // A's order-scoped refund (550k) plus B's (450k) have both completed, so
    // the payment as a whole is fully refunded — the only situation in which
    // completeRefund cancels any order at all.
    db.refundRequest.aggregate.mockResolvedValue({ _sum: { requestedAmountKobo: 1000000 } });
    db.order.findMany.mockResolvedValue([vendorAOrder()]);

    const res = await complete();
    expect(res.outcome).toBe("SUCCESS");

    // Sibling fan-out is gone: the lookup is scoped to the refunded order id,
    // never to the payment's idempotencyKey.
    expect(db.order.findMany).toHaveBeenCalledWith({ where: { id: "o-A" } });
    const where = db.order.updateMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ in: ["o-A"] });
    expect(where.idempotencyKey).toBeUndefined();
    expect(db.order.updateMany.mock.calls[0][0].data.status).toBe("CANCELLED");
  });

  it("6. whole-payment refund (orderId null) keeps the batch fan-out", async () => {
    db.refundRequest.findUnique.mockResolvedValue({
      id: "r-1",
      paymentRef: "PSK-BATCH-1",
      orderId: null,
      status: "PROCESSING",
      requestedAmountKobo: 1000000,
    });
    db.payment.findUnique.mockResolvedValue(batchPayment());
    db.refundRequest.aggregate.mockResolvedValue({ _sum: { requestedAmountKobo: 1000000 } });
    db.order.findMany.mockResolvedValue([vendorAOrder(), vendorBOrder()]);

    const res = await complete();
    expect(res.outcome).toBe("SUCCESS");
    expect(db.order.findMany).toHaveBeenCalledWith({
      where: { idempotencyKey: K },
    });
    expect(db.order.updateMany.mock.calls[0][0].where.id).toEqual({
      in: ["o-A", "o-B"],
    });
  });

  it("7. an already-COMPLETED order is never rewritten and causes no error", async () => {
    db.refundRequest.findUnique.mockResolvedValue({
      id: "r-1",
      paymentRef: "PSK-BATCH-1",
      orderId: "o-C",
      status: "PROCESSING",
      requestedAmountKobo: 550000,
    });
    db.payment.findUnique.mockResolvedValue(batchPayment());
    db.refundRequest.aggregate.mockResolvedValue({ _sum: { requestedAmountKobo: 1000000 } });
    db.order.findMany.mockResolvedValue([{ id: "o-C", status: "COMPLETED" }]);

    // Must not throw merely because the order is terminal…
    const res = await complete();
    expect(res.outcome).toBe("SUCCESS");
    expect(res.fullyRefunded).toBe(true);
    // …and the order write must exclude terminal statuses.
    const where = db.order.updateMany.mock.calls[0][0].where;
    expect(where.status.in).not.toContain("COMPLETED");
    expect(where.status.in).not.toContain("CANCELLED");
    expect(where.status.in).not.toContain("FAILED_DELIVERY");
    expect(where.status.in).toContain("COOKING");
    expect(where.status.in).toContain("PAYMENT_CONFIRMED");
  });

  it("8. two-vendor batch: vendor A is cancelled while vendor B stays COOKING", async () => {
    db.refundRequest.findUnique.mockResolvedValue({
      id: "r-1",
      paymentRef: "PSK-BATCH-1",
      orderId: "o-A",
      status: "PROCESSING",
      requestedAmountKobo: 550000,
    });
    db.payment.findUnique.mockResolvedValue(batchPayment());
    // A's order-scoped refund (550k) plus B's (450k) have both completed, so
    // the payment as a whole is fully refunded — the only situation in which
    // completeRefund cancels any order at all.
    db.refundRequest.aggregate.mockResolvedValue({ _sum: { requestedAmountKobo: 1000000 } });
    db.order.findMany.mockResolvedValue([vendorAOrder()]);

    await complete();

    const where = db.order.updateMany.mock.calls[0][0].where;
    // Only A is ever a write target — B (COOKING) is neither loaded nor
    // written, so it keeps its status untouched.
    expect(where.id).toEqual({ in: ["o-A"] });
    expect(db.order.findMany).not.toHaveBeenCalledWith({
      where: { idempotencyKey: K },
    });
    // B is a cancellable status, so if it HAD been targeted it would have
    // been rewritten — proving the scoping, not the status filter, is what
    // protects it here.
    expect(where.status.in).toContain("COOKING");
  });

  it("drift guard: the refund cancellable set matches the order transition table", () => {
    const src = fs.readFileSync("src/controllers/orderController.ts", "utf8");
    const rule = src.slice(
      src.indexOf("CANCELLED: {"),
      src.indexOf("FAILED_DELIVERY: {"),
    );
    const from = rule
      .slice(rule.indexOf("from: ["))
      .slice(0, rule.indexOf("]", rule.indexOf("from: [")))
      .match(/OrderStatus\.([A-Z_]+)/g)!
      .map((m) => m.replace("OrderStatus.", ""));

    expect(from).toEqual([
      "AWAITING_PAYMENT",
      "PAYMENT_CONFIRMED",
      "COOKING",
      "READY_FOR_PICKUP",
      "OUT_FOR_DELIVERY",
    ]);

    // The same list must be what refundFinalizer actually filters on.
    const finalizer = fs.readFileSync("src/services/refundFinalizer.service.ts", "utf8");
    const set = finalizer.slice(
      finalizer.indexOf("const REFUND_CANCELLABLE_ORDER_STATUSES"),
      finalizer.indexOf("];", finalizer.indexOf("const REFUND_CANCELLABLE_ORDER_STATUSES")),
    );
    const mirrored = set
      .match(/OrderStatus\.([A-Z_]+)/g)!
      .map((m) => m.replace("OrderStatus.", ""));
    expect(mirrored).toEqual(from);
  });
});

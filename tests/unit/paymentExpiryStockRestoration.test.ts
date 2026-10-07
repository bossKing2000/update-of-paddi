/**
 * Stage N-04A: stock restoration on payment expiry.
 *
 * The payment-expiry worker used to cancel expired orders (AWAITING_PAYMENT /
 * PENDING -> CANCELLED_UNPAID) WITHOUT releasing the checkout-time stock
 * reservation. Because the order is no longer AWAITING_PAYMENT, every other
 * restoration path is structurally blind to it, so the reserved portions were
 * stranded permanently.
 *
 * `restoreStockForOrders` is NOT internally idempotent (stock += qty, no
 * marker), so the per-order CAS is the idempotency boundary:
 *
 *     restoreStockForOrders  <=>  this execution moved the order out of
 *                                 [AWAITING_PAYMENT, PENDING]
 */
import { verifyPendingPayments } from "../../src/jobs/payment/worker/verifyPendingPayments";
import { updateOrderStatus } from "../../src/controllers/orderController";
import { verifyPayment } from "../../src/services/paymentService";
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import prisma from "../../src/lib/prisma";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    order: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    product: { updateMany: jest.fn() },
    userPaymentMethod: { upsert: jest.fn() },
    refundRequest: { findFirst: jest.fn(), create: jest.fn() },
    user: { findUnique: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/services/paymentService", () => ({
  verifyPayment: jest.fn(),
}));

jest.mock("../../src/services/paymentFinalizer.service", () => ({
  finalizePaymentSuccess: jest.fn(async () => ({ outcome: "ALREADY_PROCESSED" })),
}));

// Keep the real restoreStockForOrders so stock arithmetic is exercised; stub
// only the cache layer it transitively imports (avoids requiring Redis).
jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
  clearProductsCache: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

const db = prisma as unknown as {
  payment: { findMany: jest.Mock; update: jest.Mock; findFirst: jest.Mock };
  order: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
    findUnique: jest.Mock;
  };
  product: { updateMany: jest.Mock };
  refundRequest: { findFirst: jest.Mock; create: jest.Mock };
  $transaction: jest.Mock;
};
const mockedVerify = verifyPayment as jest.Mock;
const mockedFinalize = finalizePaymentSuccess as jest.Mock;

const KOBO_QTY = 3;

function candidate(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    reference: "PSK-1",
    orderId: "order-A",
    idempotencyKey: "batch-123",
    status: "PENDING",
    expiresAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 20 * 60_000),
    ...over,
  };
}

/** Register the orders that exist, so id-filtered reads behave realistically. */
let ORDER_ROWS: any[] = [];
function setOrders(rows: any[]) {
  ORDER_ROWS = rows;
}

/** One eligible order holding a TRACKED product with 3 portions. */
function trackedOrder(id: string, productId: string) {
  return {
    id,
    productId,
    idempotencyKey: "batch-123",
    items: [{ productId, quantity: KOBO_QTY }],
  };
}

function queuePayments(payments: any[]) {
  db.payment.findMany.mockResolvedValueOnce(payments).mockResolvedValue([]);
}

/** Total stock increment issued via Product.updateMany, summed. */
function totalRestored() {
  return db.product.updateMany.mock.calls.reduce((sum, c) => sum + (c[0].data?.stock?.increment ?? 0), 0);
}
function restoredProducts() {
  return db.product.updateMany.mock.calls.map((c) => c[0].where.id);
}

beforeEach(() => {
  jest.clearAllMocks();
  // `verifyPendingPayments` reads candidates by batch scope; `restoreStockForOrders`
  // re-reads by explicit ids. Both must behave like a real filtered query.
  db.order.findMany.mockImplementation(async (args: any) => {
    const inIds = args?.where?.id?.in;
    if (Array.isArray(inIds)) return ORDER_ROWS.filter((r) => inIds.includes(r.id));
    return ORDER_ROWS.filter((r) => args?.where?.idempotencyKey === undefined
      || args.where.idempotencyKey === r.idempotencyKey);
  });
  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );
  db.payment.update.mockResolvedValue({});
  db.order.updateMany.mockResolvedValue({ count: 1 });
  setOrders([trackedOrder("order-A", "prod-1")]);
  db.product.updateMany.mockResolvedValue({ count: 1 });
  mockedVerify.mockResolvedValue({ status: "failed" });
  mockedFinalize.mockResolvedValue({ outcome: "ALREADY_PROCESSED" });
});

// ---------------------------------------------------------------------------
describe("N-04A — restoration on payment expiry", () => {
  it("1. single tracked-product order: stock restored exactly +3, order cancelled", async () => {
    queuePayments([candidate()]);
    await verifyPendingPayments(10);

    expect(db.payment.update).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { status: "EXPIRED" },
    });
    const cas = db.order.updateMany.mock.calls[0][0];
    expect(cas.where).toEqual({ id: "order-A", status: { in: ["AWAITING_PAYMENT", "PENDING"] } });
    expect(cas.data).toMatchObject({
      status: "CANCELLED_UNPAID",
      paymentStatus: "EXPIRED",
      cancellationReason: "PAYMENT_EXPIRED",
    });
    // Reservation released exactly once, into the tracked product.
    expect(restoredProducts()).toEqual(["prod-1"]);
    expect(totalRestored()).toBe(KOBO_QTY);
  });

  it("2. multi-vendor batch: every eligible sibling's stock is restored once", async () => {
    queuePayments([candidate()]);
    setOrders([
      trackedOrder("order-A", "prod-1"),
      trackedOrder("order-B", "prod-2"),
      trackedOrder("order-C", "prod-3"),
    ]);
    await verifyPendingPayments(10);

    expect(db.order.updateMany).toHaveBeenCalledTimes(3);
    expect(db.order.updateMany.mock.calls.map((c) => c[0].where.id)).toEqual([
      "order-A",
      "order-B",
      "order-C",
    ]);
    expect(restoredProducts()).toEqual(["prod-1", "prod-2", "prod-3"]);
    expect(totalRestored()).toBe(KOBO_QTY * 3);
  });

  it("3. mixed-state batch: only the CAS winners are touched or restored", async () => {
    // Candidates are already filtered to eligible statuses, so B (confirmed)
    // and C (cancelled) never reach the CAS at all; D (PENDING) does.
    queuePayments([candidate()]);
    setOrders([
      trackedOrder("order-A", "prod-1"),
      trackedOrder("order-D", "prod-4"),
    ]);
    await verifyPendingPayments(10);

    expect(db.order.updateMany.mock.calls.map((c) => c[0].where.id)).toEqual([
      "order-A",
      "order-D",
    ]);
    expect(restoredProducts()).toEqual(["prod-1", "prod-4"]);
  });

  it("4. untracked product: the order still dies, but its stock cannot be touched", async () => {
    // `reserveStockForItems` skips untracked products entirely, so there is no
    // reservation to release. `restoreStockForOrders` still issues the
    // increment, but its predicate is `trackInventory: true`, so the database
    // matches zero rows and the stock value is provably unchanged.
    queuePayments([candidate()]);
    setOrders([{ id: "order-A", idempotencyKey: "batch-123", items: [{ productId: "prod-x", quantity: 3 }] }]);
    db.product.updateMany.mockResolvedValue({ count: 0 }); // no tracked match

    await verifyPendingPayments(10);

    // The order is still expired correctly.
    expect(db.order.updateMany.mock.calls[0][0].data.status).toBe("CANCELLED_UNPAID");
    // The restore is gated on trackInventory, so an untracked product cannot
    // be modified by this path.
    expect(db.product.updateMany).toHaveBeenCalledWith({
      where: { id: "prod-x", trackInventory: true },
      data: { stock: { increment: 3 } },
    });
  });

  it("5. second expiry execution restores nothing extra (idempotent)", async () => {
    queuePayments([candidate()]);
    db.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
    await verifyPendingPayments(10);
    const afterFirst = totalRestored();
    expect(afterFirst).toBe(KOBO_QTY);

    // Rerun: the CAS now matches nothing, so this run owns nothing.
    queuePayments([candidate()]);
    await verifyPendingPayments(10);
    expect(totalRestored()).toBe(afterFirst);
  });

  it("8. CAS loser (count === 0) never restores stock", async () => {
    queuePayments([candidate()]);
    db.order.updateMany.mockResolvedValue({ count: 0 }); // lost to a race
    await verifyPendingPayments(10);

    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("9. a failure mid-batch rolls the whole transaction back", async () => {
    queuePayments([candidate()]);
    setOrders([
      trackedOrder("order-A", "prod-1"),
      trackedOrder("order-B", "prod-2"),
    ]);
    db.product.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("db exploded"));

    // The transaction rejects, so the worker must not silently continue as if
    // the batch had expired cleanly.
    db.$transaction.mockImplementationOnce(async (arg: any) => arg(db));
    await verifyPendingPayments(10);

    // 1st restore attempted, 2nd failed => nothing may be committed.
    expect(db.product.updateMany.mock.calls.length).toBe(2);
    expect(db.payment.update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Customer-cancel CAS hardening
// ---------------------------------------------------------------------------
function cancelReq(status = "CANCELLED") {
  return {
    user: { id: "u-1", role: "CUSTOMER", sessionId: "s" },
    params: { orderId: "order-A" },
    body: { status },
    headers: {},
    query: {},
  } as never;
}
function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

function unpaidOrder() {
  return {
    id: "order-A",
    vendorId: "v-1",
    customerId: "u-1",
    status: "AWAITING_PAYMENT",
    paymentStatus: "PENDING",
    idempotencyKey: "batch-123",
    totalPrice: 5000,
    items: [{ productId: "prod-1", quantity: KOBO_QTY }],
  };
}

describe("N-04A — customer cancel CAS", () => {
  beforeEach(() => {
    db.order.findUnique.mockResolvedValue(unpaidOrder());
    db.order.update.mockImplementation(async () => ({ ...unpaidOrder(), status: "CANCELLED" }));
    db.payment.findFirst.mockResolvedValue(null);
    db.refundRequest.findFirst.mockResolvedValue(null);
  });

  it("10. CAS loses to a concurrent payment expiry: order is not overwritten, no restore", async () => {
    db.order.update.mockRejectedValueOnce(
      Object.assign(new Error("Record to update not found"), { code: "P2025" }),
    );
    // Order contents as restoreStockForOrders would read them.
    setOrders([{ id: "order-A", idempotencyKey: "batch-123", items: [{ productId: "prod-1", quantity: KOBO_QTY }] }]);

    await expect(updateOrderStatus(cancelReq(), res())).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("11. CAS wins: cancel applies and the reservation is released exactly once", async () => {
    setOrders([{ id: "order-A", idempotencyKey: "batch-123", items: [{ productId: "prod-1", quantity: KOBO_QTY }] }]);
    await updateOrderStatus(cancelReq(), res());
    expect(db.order.update.mock.calls[0][0].where).toEqual({
      id: "order-A",
      status: "AWAITING_PAYMENT",
    });
    expect(totalRestored()).toBe(KOBO_QTY);
  });
});

/**
 * Stage E.2 — FIN-07-02: real-PostgreSQL verification of a verified capture
 * arriving for a payment this system had already expired locally.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * FIN-07-02 taught the finalizer to file a durable refund obligation when a
 * capture is verified for a payment in `EXPIRED` state, without rewriting that
 * terminal payment, reopening the order, restoring inventory, or calling
 * Paystack. `tests/unit/paymentRecoveryRefundOwed.test.ts` proves that with a
 * mocked client, which cannot establish transaction atomicity, real concurrent
 * deduplication, or the expiry worker's own invariant.
 *
 * The gap this closes:
 *   * the obligation is a real, persisted row (not a mock call);
 *   * the payment and order terminal states survive in the database;
 *   * the existing `isProcessing` lock serialises two concurrent finalizations
 *     so only one obligation is written — proven with `Promise.all`, not
 *     sequential calls;
 *   * a failure inside the obligation transaction rolls everything back, and a
 *     later retry still lands exactly one obligation;
 *   * the expiry worker really does move a payment to EXPIRED and cancel its
 *     orders in one transaction, and an order cannot silently be left
 *     AWAITING_PAYMENT behind an EXPIRED payment by that worker.
 *
 * CONVENTIONS
 * -----------
 * Modelled on tests/integration/latePaymentRefundOwedDb.test.ts (FIN-07-01):
 * the shared Prisma singleton — required here because the rollback case must
 * intercept the very transaction client the finalizer uses — run-unique tags,
 * tracked ids and child-first `afterAll` teardown.
 *
 * NO EXTERNAL SERVICE
 * -------------------
 * `src/lib/redis` is mocked so the Redis client is never constructed (the
 * worker imports it transitively and it throws at import time without
 * REDIS_URL). `verifyPayment` is replaced with a throwing stub so any attempt
 * to reach Paystack fails loudly rather than silently contacting a provider —
 * and a test asserts it is never called.
 */
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import { verifyPendingPayments } from "../../src/jobs/payment/worker/verifyPendingPayments";
import prisma from "../../src/lib/prisma";
import { verifyPayment } from "../../src/services/paymentService";

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisNotifications: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), isOpen: true, scan: jest.fn(async () => ({ cursor: "0", keys: [] })) },
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn(), scan: jest.fn(async () => ({ cursor: "0", keys: [] })) },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn(), scan: jest.fn(async () => ({ cursor: "0", keys: [] })) },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), scan: jest.fn(async () => ({ cursor: "0", keys: [] })) },
  redisUsersSessions: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), scan: jest.fn(async () => ({ cursor: "0", keys: [] })) },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn(), scan: jest.fn(async () => ({ cursor: "0", keys: [] })) },
  redisPayments: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), scan: jest.fn(async () => ({ cursor: "0", keys: [] })) },
  connectRedis: jest.fn(async () => undefined),
  ensureRedisReady: jest.fn(async () => undefined),
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(async () => []),
}));

jest.mock("../../src/services/paymentService", () => ({
  __esModule: true,
  verifyPayment: jest.fn(async () => {
    throw new Error("verifyPayment must never be called in this suite");
  }),
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

jest.setTimeout(120000);

const tag = `fin07-02-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const userIds: string[] = [];
const orderIds: string[] = [];
const orderItemIds: string[] = [];
const paymentIds: string[] = [];
const productIds: string[] = [];
const dishTypeIds: string[] = [];
const categoryIds: string[] = [];

/** `Product.dishTypeId` / `categoryId` are real foreign keys. */
let categoryId = "";
let dishTypeId = "";

const TOTAL = 5500;
const QTY = 3;
const INITIAL_STOCK = 10;
const PAST = () => new Date(Date.now() - 60_000);
const FUTURE = () => new Date(Date.now() + 10 * 60_000);

type OrderSpec = { id: string; status?: string; paymentStatus?: string };

async function makeScenario(options: {
  suffix: string;
  paymentStatus?: string;
  orderSpecs?: OrderSpec[];
}) {
  const suffix = options.suffix;
  const vendor = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}-v@x.test`,
      name: "Expired Vendor",
      role: "VENDOR",
      roles: ["VENDOR"],
      commissionRate: 0.15,
    },
  });
  const customer = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}-c@x.test`,
      name: "Expired Customer",
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    },
  });
  userIds.push(vendor.id, customer.id);

  const product = await prisma.product.create({
    data: {
      name: `Expired Product ${suffix}`,
      description: `Fixture product for ${suffix}`,
      dishTypeId,
      categoryId,
      price: TOTAL,
      vendorId: vendor.id,
      archived: false,
      trackInventory: true,
      stock: INITIAL_STOCK,
    },
  });
  productIds.push(product.id);

  const key = `${tag}-key-${suffix}`;
  const specs = options.orderSpecs ?? [
    { id: "A", status: "CANCELLED_UNPAID", paymentStatus: "EXPIRED" },
  ];
  const created: Array<{ id: string; status: string }> = [];

  for (const spec of specs) {
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        vendorId: vendor.id,
        basePrice: TOTAL,
        totalPrice: TOTAL,
        status: (spec.status ?? "CANCELLED_UNPAID") as never,
        paymentStatus: (spec.paymentStatus ?? "EXPIRED") as never,
        idempotencyKey: key,
        protectedUntil: PAST(),
        cancelledAt: PAST(),
        cancellationReason: "PAYMENT_EXPIRED",
      },
    });
    orderIds.push(order.id);
    created.push({ id: order.id, status: order.status });
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        quantity: QTY,
        unitPrice: TOTAL,
        subtotal: TOTAL * QTY,
      },
    });
    orderItemIds.push(item.id);
  }

  const payment = await prisma.payment.create({
    data: {
      reference: `${tag}-${suffix}`,
      idempotencyKey: key,
      orderId: created[0].id,
      userId: customer.id,
      amount: TOTAL * specs.length * 100,
      status: (options.paymentStatus ?? "EXPIRED") as never,
      expiresAt: PAST(),
      channel: "card",
    },
  });
  paymentIds.push(payment.id);

  return { vendor, customer, product, orders: created, payment };
}

const finalize = (payment: { reference: string }, amountKobo = TOTAL) =>
    finalizePaymentSuccess({
      reference: payment.reference,
      amountKobo,
      currency: "NGN",
    });

const refundsFor = (orderId: string) => prisma.refundRequest.findMany({ where: { orderId } });
const stockOf = (productId: string) =>
  prisma.product.findUnique({ where: { id: productId }, select: { stock: true } });
const paymentByRef = (reference: string) => prisma.payment.findUnique({ where: { reference } });
const orderById = (id: string) => prisma.order.findUnique({ where: { id } });

beforeAll(async () => {
  categoryId = `${tag}-cat`;
  dishTypeId = `${tag}-dish`;
  const category = await prisma.category.create({
    data: { id: categoryId, name: `Cat ${tag}`, slug: `cat-${tag}` },
  });
  categoryIds.push(category.id);
  const dishType = await prisma.dishType.create({
    data: { id: dishTypeId, name: `Dish ${tag}`, categoryId: category.id },
  });
  dishTypeIds.push(dishType.id);
});

afterAll(async () => {
  // Child-first. RefundRequest.order, Receipt.paymentId, DishType.category and
  // OrderItem.product are all Restrict.
  if (orderIds.length)
    await prisma.refundRequest.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
  if (orderItemIds.length)
    await prisma.orderItem.deleteMany({ where: { id: { in: orderItemIds } } }).catch(() => {});
  if (paymentIds.length)
    await prisma.receipt.deleteMany({ where: { paymentId: { in: paymentIds } } }).catch(() => {});
  if (paymentIds.length)
    await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }).catch(() => {});
  if (orderIds.length)
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
  if (productIds.length)
    await prisma.product.deleteMany({ where: { id: { in: productIds } } }).catch(() => {});
  if (dishTypeIds.length)
    await prisma.dishType.deleteMany({ where: { id: { in: dishTypeIds } } }).catch(() => {});
  if (categoryIds.length)
    await prisma.category.deleteMany({ where: { id: { in: categoryIds } } }).catch(() => {});
  if (userIds.length)
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.$disconnect();
});

describe("FIN-07-02 — verified capture against an already-EXPIRED payment", () => {
  it("1. files one persisted obligation and preserves both terminal states", async () => {
    const { product, orders, payment } = await makeScenario({ suffix: "basic" });
    const orderId = orders[0].id;

    const result = await finalize(payment);
    expect(result.outcome).toBe("LATE_CAPTURE_REFUND_FILED");
    expect(result.refundPendingOrderIds).toEqual([orderId]);

    // The terminal payment record is preserved, never rewritten to SUCCESS.
    expect((await paymentByRef(payment.reference))?.status).toBe("EXPIRED");

    // The cancelled order is not reopened.
    const order = await orderById(orderId);
    expect(order?.status).toBe("CANCELLED_UNPAID");
    expect(order?.paymentStatus).toBe("EXPIRED");

    const refunds = await refundsFor(orderId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      userId: order!.customerId,
      paymentRef: payment.reference,
      orderId,
      status: "PENDING",
      requestedAmountKobo: TOTAL,
    });
    expect(refunds[0].reason).toContain("LATE_PAYMENT");

    // No inventory restoration: this branch does not own stock.
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK);
  });

  it("2. repeated finalization files exactly one obligation and changes nothing", async () => {
    const { product, orders, payment } = await makeScenario({ suffix: "repeat" });
    const orderId = orders[0].id;

    await finalize(payment);
    await finalize(payment);
    await finalize(payment);

    expect(await refundsFor(orderId)).toHaveLength(1);
    expect((await paymentByRef(payment.reference))?.status).toBe("EXPIRED");
    expect((await orderById(orderId))?.status).toBe("CANCELLED_UNPAID");
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK);
  });

  it("3. two CONCURRENT finalizations produce one obligation, not two", async () => {
    const { product, orders, payment } = await makeScenario({ suffix: "race" });
    const orderId = orders[0].id;

    // Genuinely concurrent: the per-payment `isProcessing` lock must serialise
    // them, and the helper's dedupe must catch the loser.
    await Promise.all([finalize(payment), finalize(payment)]);

    expect(await refundsFor(orderId)).toHaveLength(1);
    expect((await paymentByRef(payment.reference))?.status).toBe("EXPIRED");
    expect((await orderById(orderId))?.status).toBe("CANCELLED_UNPAID");
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK);
  });

  it("4. a failed obligation transaction rolls back and a later retry lands exactly one", async () => {
    const { product, orders, payment } = await makeScenario({ suffix: "rollback" });
    const orderId = orders[0].id;

    // Narrow fault at the obligation boundary on the REAL transaction client.
    // fileRefundOwed (refundObligation.service.ts) now inserts the obligation
    // with a tagged raw SQL `INSERT INTO "RefundRequest" ... ON CONFLICT ...
    // DO NOTHING RETURNING`, not through `tx.refundRequest.create`. Transaction
    // clients route their `$queryRaw` calls through the shared client, so a
    // single spy on `prisma.$queryRaw` intercepts exactly that statement. The
    // match is narrowed to the obligation insert's SQL text so unrelated raw
    // queries delegate unchanged, preserving tagged-template bindings, argument
    // order, transaction context and `this`.
    let fired = false;
    let faultArmed = true;
    const realQueryRaw = (prisma as any).$queryRaw.bind(prisma);
    const querySpy = jest
      .spyOn(prisma, "$queryRaw")
      .mockImplementation((function (...args: any[]) {
        const strings = args[0];
        const literals = Array.isArray(strings) ? strings.join("") : "";
        const isObligationInsert =
          literals.includes('INSERT INTO "RefundRequest"') && literals.includes("ON CONFLICT");
        if (isObligationInsert && faultArmed) {
          fired = true;
          faultArmed = false;
          throw new Error("injected refund-obligation fault");
        }
        return realQueryRaw(...args);
      }) as any);

    let settled: any = "still-running";
    let running: Promise<unknown> = Promise.resolve();
    try {
      // async-retry will retry, so start it and inspect the database while the
      // first attempt has just rolled back.
      running = finalize(payment).then(
        (r) => {
          settled = r;
          return r;
        },
        (e) => {
          settled = e;
          return undefined;
        },
      );
      const deadline = Date.now() + 20_000;
      while (!fired && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(fired).toBe(true);

      // Nothing partially applied.
      expect(await refundsFor(orderId)).toHaveLength(0);
      expect((await paymentByRef(payment.reference))?.status).toBe("EXPIRED");
      expect((await orderById(orderId))?.status).toBe("CANCELLED_UNPAID");
      expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK);
    } finally {
      // faultArmed is now false, so the in-flight retry delegates to the real
      // $queryRaw and completes normally. Restore after awaiting the retry so
      // no other suite sees a wrapped $queryRaw.
    }
    await running;
    querySpy.mockRestore();

    expect(settled?.outcome).toBe("LATE_CAPTURE_REFUND_FILED");
    expect(await refundsFor(orderId)).toHaveLength(1);
    expect((await paymentByRef(payment.reference))?.status).toBe("EXPIRED");
  });
});

describe("FIN-07-02 — expiry-worker invariant", () => {
  it("5a. the worker moves a payment to EXPIRED and cancels its order atomically", async () => {
    // The real worker, not a simulation. The order starts payable-pending.
    const { product, orders, payment } = await makeScenario({
      suffix: "worker",
      paymentStatus: "PENDING",
      orderSpecs: [{ id: "A", status: "AWAITING_PAYMENT", paymentStatus: "PENDING" }],
    });
    const orderId = orders[0].id;

    await verifyPendingPayments(50);

    expect((await paymentByRef(payment.reference))?.status).toBe("EXPIRED");
    const order = await orderById(orderId);
    expect(order?.status).toBe("CANCELLED_UNPAID");
    expect(order?.paymentStatus).toBe("EXPIRED");
    expect(order?.cancellationReason).toBe("PAYMENT_EXPIRED");
    // The worker owns stock restoration; the initial reservation is released.
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK + QTY);
    // No Paystack call: an expired reference is settled locally, not queried.
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  it("5b. after the worker runs, a late capture on that reference files the obligation", async () => {
    // The realistic production sequence: expiry first, capture later.
    const { product, orders, payment } = await makeScenario({
      suffix: "worker-then-capture",
      paymentStatus: "PENDING",
      orderSpecs: [{ id: "A", status: "AWAITING_PAYMENT", paymentStatus: "PENDING" }],
    });
    const orderId = orders[0].id;

    await verifyPendingPayments(50);
    expect((await paymentByRef(payment.reference))?.status).toBe("EXPIRED");

    const result = await finalize(payment);
    expect(result.outcome).toBe("LATE_CAPTURE_REFUND_FILED");
    expect(await refundsFor(orderId)).toHaveLength(1);
    expect((await paymentByRef(payment.reference))?.status).toBe("EXPIRED");
    expect((await orderById(orderId))?.status).toBe("CANCELLED_UNPAID");
    // Restored once by the worker; the capture branch restores nothing.
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK + QTY);
  });

  it("5c. an AWAITING_PAYMENT order can exist beside an EXPIRED payment, and files nothing", async () => {
    // The worker cannot produce this pair (both writes share one transaction —
    // 5a proves it). But nothing at the schema level forbids it, so the branch's
    // behaviour on it is worth pinning: it must not cancel the order, and it
    // must not file an obligation for an order that is not yet unfulfillable.
    const { orders, payment } = await makeScenario({
      suffix: "coexist",
      orderSpecs: [{ id: "A", status: "AWAITING_PAYMENT", paymentStatus: "PENDING" }],
    });
    const orderId = orders[0].id;

    const result = await finalize(payment);

    expect(result.outcome).toBe("LATE_CAPTURE_REFUND_FILED");
    expect(result.refundPendingOrderIds).toEqual([]);
    expect(await refundsFor(orderId)).toHaveLength(0);
    // The branch does not cancel it; that stays with the expiry path.
    expect((await orderById(orderId))?.status).toBe("AWAITING_PAYMENT");
    expect((await paymentByRef(payment.reference))?.status).toBe("EXPIRED");
  });
});

describe("FIN-07-02 — other terminal states and valid processing", () => {
  it("6a. other protected terminal states are left completely untouched", async () => {
    for (const status of ["LATE_PAYMENT", "FAILED", "REFUNDED", "AMOUNT_MISMATCH"]) {
      const { orders, payment } = await makeScenario({
        suffix: `terminal-${status}`,
        paymentStatus: status,
        orderSpecs: [{ id: "A", status: "CANCELLED_UNPAID", paymentStatus: status }],
      });
      const orderId = orders[0].id;

      const result = await finalize(payment);

      expect(result.outcome).toBe("ALREADY_PROCESSED");
      expect(await refundsFor(orderId)).toHaveLength(0);
      expect((await paymentByRef(payment.reference))?.status).toBe(status);
      expect((await orderById(orderId))?.status).toBe("CANCELLED_UNPAID");
    }
  });

  it("6b. an ordinary in-window capture confirms the order and files nothing", async () => {
    const { product, orders, payment } = await makeScenario({
      suffix: "in-window",
      paymentStatus: "PENDING",
      orderSpecs: [{ id: "A", status: "AWAITING_PAYMENT", paymentStatus: "PENDING" }],
    });
    const orderId = orders[0].id;
    // Push the window forward so the payment is genuinely in-window.
    await prisma.payment.update({
      where: { id: payment.id },
      data: { expiresAt: FUTURE() },
    });
    await prisma.order.update({
      where: { id: orderId },
      data: { protectedUntil: FUTURE(), cancelledAt: null, cancellationReason: null },
    });

    const result = await finalize(payment);

    expect(result.outcome).toBe("SUCCESS");
    const order = await orderById(orderId);
    expect(order?.status).toBe("PAYMENT_CONFIRMED");
    expect(order?.paymentStatus).toBe("SUCCESS");
    expect(await refundsFor(orderId)).toHaveLength(0);
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK);
  });
});
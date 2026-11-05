/**
 * Stage E.1 — FIN-07-01: real-PostgreSQL verification of the late-payment
 * refund obligation.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * FIN-07-01 made the finalizer's LATE_PAYMENT branch file a refund obligation
 * for every order it cancels. That change is proven only by mocked unit tests
 * (`tests/unit/paymentRecoveryRefundOwed.test.ts`), which cannot establish
 * whether the row is actually persisted, whether it is written inside the same
 * transaction as the cancellation, whether deduplication holds under real
 * concurrent finalization, or whether a failure rolls everything back.
 *
 * No pre-existing integration suite could verify it: `protectedUntil` is never
 * set by any suite under tests/integration, and every `Payment.expiresAt` is in
 * the future, so the branch's guard
 *
 *     if (!isWithinProtection && !isBeforeExpiry)
 *
 * (paymentFinalizer.service.ts:436) is never satisfied. This suite therefore
 * models the real post-expiry shape — a payment whose `expiresAt` has passed and
 * an order whose `protectedUntil` has passed.
 *
 * CONVENTIONS
 * -----------
 * Modelled on tests/integration/paymentReSyncMarkerGuard.test.ts: a real
 * PrismaClient resolved through the pinned DATABASE_URL, run-unique tags,
 * tracked ids and child-first `afterAll` teardown. No Redis, no Paystack, no
 * remote service: gateway values are passed as finalizer input exactly as the
 * webhook and verify paths do after dividing kobo by 100.
 *
 * THE REAL FINALIZER RUNS
 * -----------------------
 * `finalizePaymentSuccess` is imported unmocked, so the conditional payment
 * claim, the per-order cancellation CAS, the stock restoration and the refund
 * obligation are all executed by the database, not simulated. The only
 * interception is the rollback case, which spies on this suite's own Prisma
 * client at the RefundRequest boundary and restores it in a `finally`.
 */
import fs from "fs";
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import { getReceiptFilePath } from "../../src/utils/receiptsPath";
// The shared singleton, NOT a fresh `new PrismaClient()`. Both resolve the same
// pinned DATABASE_URL and therefore the same disposable database, but only the
// singleton is the exact object the finalizer imports — which is what lets the
// rollback case intercept the transaction client. A private client instance
// would query the same rows yet remain invisible to jest.spyOn.
import prisma from "../../src/lib/prisma";

jest.setTimeout(120000);
const tag = `late07-01-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const userIds: string[] = [];
const orderIds: string[] = [];
const orderItemIds: string[] = [];
const paymentIds: string[] = [];
const productIds: string[] = [];
const dishTypeIds: string[] = [];
const categoryIds: string[] = [];

/**
 * `Product.dishTypeId` and `Product.categoryId` are real foreign keys, so each
 * suite needs its own Category -> DishType -> Product chain. Created once and
 * reused by every fixture in this file, since the rows are inert reference data
 * and the rows under assertion are the orders.
 */
let categoryId = "";
let dishTypeId = "";

const TOTAL = 5500;
const QTY = 3;
const INITIAL_STOCK = 10;
const PAST = () => new Date(Date.now() - 60_000);
const FUTURE = () => new Date(Date.now() + 10 * 60_000);

/**
 * One vendor + customer + product, then one order/item/payment per entry.
 *
 * `late: true` is what makes the late branch reachable: both the payment's
 * `expiresAt` and the order's `protectedUntil` sit in the past, which is the
 * state a real checkout lands in once its 15-minute window has closed.
 */
async function makePayment(options: {
  suffix: string;
  late?: boolean;
  orders?: Array<{ id: string; status?: string }>;
}) {
  const suffix = options.suffix;
  const vendor = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}-v@x.test`,
      name: "Late Vendor",
      role: "VENDOR",
      roles: ["VENDOR"],
      commissionRate: 0.15,
    },
  });
  const customer = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}-c@x.test`,
      name: "Late Customer",
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    },
  });
  userIds.push(vendor.id, customer.id);

  const product = await prisma.product.create({
    data: {
      name: `Late Product ${suffix}`,
      description: `Fixture product for ${suffix}`,
      dishTypeId: dishTypeId,
      categoryId: categoryId,
      price: TOTAL,
      vendorId: vendor.id,
      archived: false,
      trackInventory: true,
      stock: INITIAL_STOCK,
    },
  });
  productIds.push(product.id);

  const key = `${tag}-key-${suffix}`;
  const specs = options.orders ?? [{ id: "A" }];
  const created: Array<{ id: string; status: string }> = [];

  for (const spec of specs) {
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        vendorId: vendor.id,
        basePrice: TOTAL,
        totalPrice: TOTAL,
        status: (spec.status ?? "AWAITING_PAYMENT") as never,
        paymentStatus: "PENDING" as never,
        idempotencyKey: key,
        protectedUntil: options.late ? PAST() : FUTURE(),
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

  const first = created[0];
  const payment = await prisma.payment.create({
    data: {
      reference: `${tag}-${suffix}`,
      idempotencyKey: key,
      orderId: first.id,
      userId: customer.id,
      amount: TOTAL * specs.length * 100,
      status: "PENDING" as never,
      expiresAt: options.late ? PAST() : FUTURE(),
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

const refundsFor = (orderId: string) =>
  prisma.refundRequest.findMany({ where: { orderId } });
const stockOf = (productId: string) =>
  prisma.product.findUnique({ where: { id: productId }, select: { stock: true } });

/**
 * Removes the receipt PDFs this suite generated, and reports any that survive.
 *
 * `finalizePaymentSuccess` calls `generateReceipt`, which streams a PDF named
 * `receipt_<payment.reference>.pdf` into the receipts directory. The `Receipt`
 * ROW is deleted below, but the FILE was not — so every run left PDFs behind
 * in the repository (the `receipt_late07-*.pdf` files).
 *
 * OWNERSHIP IS ESTABLISHED FROM THE DATABASE, not from a filename prefix: the
 * references are read from the Payment rows this suite created, immediately
 * before those rows are deleted. The file name is then derived with the same
 * helper `generateReceipt` uses, so the two cannot drift. Files belonging to
 * any other suite are never matched.
 */
async function removeOwnedReceiptPdfs(): Promise<string[]> {
  const failures: string[] = [];
  if (!paymentIds.length) return failures;

  const owned = await prisma.payment.findMany({
    where: { id: { in: paymentIds } },
    select: { reference: true },
  });
  const references = owned.map((p) => p.reference);

  // Each file is attempted independently, so one failure cannot prevent the
  // remaining owned files from being removed.
  for (const reference of references) {
    const file = getReceiptFilePath(reference);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      failures.push(
        `receipt-pdf.unlink ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const leftover = references.filter((reference) => fs.existsSync(getReceiptFilePath(reference)));
  if (leftover.length) {
    failures.push(`owned receipt PDFs still present after cleanup: ${JSON.stringify(leftover)}`);
  }
  return failures;
}

afterAll(async () => {
  // Capture the receipt references BEFORE the Payment rows are deleted, then
  // remove the PDFs. A failure here is reported rather than swallowed: an
  // owned PDF left on disk must fail the run, not be reported as a successful
  // cleanup.
  const pdfFailures = await removeOwnedReceiptPdfs();

  try {
    // Child-first, strictly limited to ids this suite created.
    // RefundRequest.order and DishType.category are onDelete:Restrict and
    // OrderItem.product is onDelete:Restrict, so children go before parents.
    if (orderIds.length)
      await prisma.refundRequest.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    if (orderItemIds.length)
      await prisma.orderItem.deleteMany({ where: { id: { in: orderItemIds } } }).catch(() => {});
    // Receipt.paymentId is Restrict, so receipts must go before their payments.
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
  } finally {
    // The shared client is always disconnected, including when the cleanup
    // below reports a failure.
    await prisma.$disconnect();
  }

  if (pdfFailures.length) {
    throw new Error(
      `latePaymentRefundOwedDb cleanup failed:\n  - ${pdfFailures.join("\n  - ")}`,
    );
  }
});

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

describe("FIN-07-01 — late capture persists a refund obligation", () => {
  it("1. a captured payment past the window cancels the order and persists one PENDING obligation", async () => {
    const { product, orders, payment } = await makePayment({ suffix: "late-basic", late: true });
    const orderId = orders[0].id;

    const result = await finalize(payment);

    expect(result.outcome).toBe("LATE_PAYMENT");
    expect(result.refundPendingOrderIds).toEqual([orderId]);

    // The order stays terminal — it is cancelled, never resurrected.
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe("CANCELLED_UNPAID");
    expect(order?.cancellationReason).toBe("LATE_PAYMENT");
    expect(order?.paymentStatus).toBe("LATE_PAYMENT");
    expect(order?.status).not.toBe("AWAITING_PAYMENT");

    const settled = await prisma.payment.findUnique({ where: { reference: payment.reference } });
    expect(settled?.status).toBe("LATE_PAYMENT");

    // The obligation is a real row, with the right order, reference, kobo
    // amount and a reason that names the late-payment scenario.
    const refunds = await refundsFor(orderId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      userId: order?.customerId,
      paymentRef: payment.reference,
      orderId,
      status: "PENDING",
      requestedAmountKobo: TOTAL,
    });
    expect(refunds[0].reason).toContain("LATE_PAYMENT");

    // Real inventory restoration ran for the cancelled order.
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK + QTY);
  });

  it("2. only the order whose cancellation CAS wins receives an obligation", async () => {
    // Two orders on one batch payment. Order B is already CANCELLED before the
    // finalizer runs, so its cancellation CAS legitimately matches nothing —
    // real database state, not a mocked count.
    const { product, orders, payment } = await makePayment({
      suffix: "late-cas",
      late: true,
      orders: [{ id: "A" }, { id: "B", status: "CANCELLED" }],
    });
    const [a, b] = orders;

    const result = await finalize(payment, TOTAL * 2);

    expect(result.outcome).toBe("LATE_PAYMENT");
    expect(result.refundPendingOrderIds).toEqual([a.id]);

    expect(await refundsFor(a.id)).toHaveLength(1);
    expect(await refundsFor(b.id)).toHaveLength(0);

    // The CAS loser is left exactly as the database already had it.
    const loser = await prisma.order.findUnique({ where: { id: b.id } });
    expect(loser?.status).toBe("CANCELLED");
    expect(loser?.paymentStatus).toBe("PENDING");

    // Only the winner's order items were restored.
    const winner = await prisma.order.findUnique({ where: { id: a.id } });
    expect(winner?.status).toBe("CANCELLED_UNPAID");
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK + QTY);
  });
});

describe("FIN-07-01 — concurrency, dedupe and inventory", () => {
  it("3. two concurrent finalizations produce one obligation and restore stock exactly once", async () => {
    const { product, orders, payment } = await makePayment({ suffix: "late-race", late: true });
    const orderId = orders[0].id;

    await Promise.all([finalize(payment), finalize(payment)]);

    const refunds = await refundsFor(orderId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe("PENDING");

    // Exactly one restoration: not double, not missing.
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK + QTY);

    const settled = await prisma.payment.findUnique({ where: { reference: payment.reference } });
    expect(settled?.status).toBe("LATE_PAYMENT");
  });

  it("4. repeated finalization after the first never duplicates the obligation", async () => {
    const { product, orders, payment } = await makePayment({ suffix: "late-repeat", late: true });
    const orderId = orders[0].id;

    await finalize(payment);
    await finalize(payment); // duplicate delivery
    await finalize(payment); // retry after the terminal guard returns

    expect(await refundsFor(orderId)).toHaveLength(1);
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK + QTY);
  });
});

describe("FIN-07-01 — transaction rollback", () => {
  it("5. a failure to create the obligation rolls back payment, cancellation and stock", async () => {
    const { product, orders, payment } = await makePayment({ suffix: "late-rollback", late: true });
    const orderId = orders[0].id;

    // Narrowly scoped fault at the obligation boundary only.
    //
    // fileRefundOwed (refundObligation.service.ts) now inserts the obligation
    // with a tagged raw SQL `INSERT INTO "RefundRequest" ... ON CONFLICT ...
    // DO NOTHING RETURNING`, not through `tx.refundRequest.create`. Transaction
    // clients route their `$queryRaw` calls through the shared client, so a
    // single spy on `prisma.$queryRaw` intercepts exactly that statement. The
    // match is narrowed to the obligation insert's SQL text so unrelated raw
    // queries (e.g. the socket FOR SHARE locks) delegate unchanged, and
    // tagged-template bindings, argument order, transaction context and `this`
    // are all preserved because we forward to the real `$queryRaw`.
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
      // The finalizer wraps its work in async-retry, so a throw is retried.
      // Do not await it here: assert the database state immediately after the
      // first failed attempt, which is where the rollback property lives.
      running = finalize(payment).then(
        (r) => { settled = r; return r; },
        (e) => { settled = e; return undefined; },
      );

      const deadline = Date.now() + 20_000;
      while (!fired && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fired).toBe(true);

      // The transaction rolled back completely: nothing partially applied.
      const afterRollback = await prisma.order.findUnique({ where: { id: orderId } });
      expect(afterRollback?.status).toBe("AWAITING_PAYMENT");
      expect(afterRollback?.paymentStatus).toBe("PENDING");
      expect(afterRollback?.cancelledAt).toBeNull();

      const paymentAfter = await prisma.payment.findUnique({ where: { reference: payment.reference } });
      expect(paymentAfter?.status).toBe("PENDING");

      expect(await refundsFor(orderId)).toHaveLength(0);

      // Inventory was restored inside the same transaction, so it rolled back.
      expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK);
    } finally {
      // faultArmed is now false, so the in-flight retry delegates to the real
      // $queryRaw and completes normally. The spy is left installed; the flag
      // guarantees it cannot fault again. It is restored after awaiting the
      // retry so no later test in this file (or the sibling suite) sees a
      // wrapped $queryRaw.
    }

    // Let the in-flight finalizer finish: the retry delegates to the real
    // $queryRaw now that the fault is disarmed, and still holds the payment's
    // isProcessing lock, so a second finalize() call would return LOCKED.
    await running;
    querySpy.mockRestore();

    expect(settled?.outcome).toBe("LATE_PAYMENT");
    expect(await refundsFor(orderId)).toHaveLength(1);
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK + QTY);
  });
});

describe("FIN-07-01 — no regression on the in-window path", () => {
  it("6. a normal in-window capture confirms the order and files no obligation", async () => {
    const { product, orders, payment } = await makePayment({ suffix: "in-window" });
    const orderId = orders[0].id;

    const result = await finalize(payment);

    expect(result.outcome).toBe("SUCCESS");
    expect(result.refundPendingOrderIds).toEqual([]);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe("PAYMENT_CONFIRMED");
    expect(order?.paymentStatus).toBe("SUCCESS");

    expect(await refundsFor(orderId)).toHaveLength(0);
    // No cancellation happened, so no restoration either.
    expect((await stockOf(product.id))?.stock).toBe(INITIAL_STOCK);
  });
});
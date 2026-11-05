/**
 * C-2 — the DATABASE guarantee, proven against a real PostgreSQL instance.
 *
 * The mocked suite in tests/unit/refundObligationConcurrency.test.ts can only
 * prove the application's branch decisions. It cannot prove that the partial
 * unique index actually prevents two concurrent transactions from writing two
 * open obligations for the same order. That is what this file establishes.
 *
 * It drives the REAL `fileRefundOwed` helper, so the exact production SQL —
 * including the `ON CONFLICT ("paymentRef","orderId") WHERE ...` inference
 * target and its enum casts — is what gets exercised.
 *
 * ── NOT RUN AS PART OF THE C-2 IMPLEMENTATION TASK ─────────────────────────
 * This file was authored but deliberately NOT executed. It has never run, so
 * every assertion below is UNVERIFIED. Running it requires, in this order:
 *   1. A SEPARATE DISPOSABLE test database — never the development or
 *      application database (see AGENTS.md §7).
 *   2. The duplicate-open-obligation preflight query returning no rows:
 *        SELECT "paymentRef","orderId",count(*) FROM "RefundRequest"
 *        WHERE "orderId" IS NOT NULL
 *          AND status IN ('PENDING','APPROVED','PROCESSING')
 *        GROUP BY 1,2 HAVING count(*)>1;
 *      If it returns anything, STOP and report the groups for manual review.
 *      Do not delete rows and do not choose a survivor.
 *   3. The C-2 migration applied FIRST. This is not optional: the production
 *      INSERT uses an explicit `ON CONFLICT (...) WHERE ...` inference target,
 *      and without the partial unique index PostgreSQL raises SQLSTATE 42P10
 *      and every obligation path fails.
 *
 * Run with the integration config only, e.g.
 *   npx jest --config jest.integration.config.js --runInBand \
 *     tests/integration/refundObligationConcurrency.test.ts
 *
 * Self-cleaning: every row it creates is removed in afterAll.
 */
import { PrismaClient, Prisma, RefundStatus } from "@prisma/client";
import { fileRefundOwed } from "../../src/services/refundObligation.service";

jest.setTimeout(120_000);

const prisma = new PrismaClient();

const tag = `c2pg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const suffix = tag.slice(0, 18);

let customerId = "";
let vendorId = "";
let orderA = "";
let orderB = "";
let createdOrderIds: string[] = [];

/**
 * A vendor is a `User` in this schema — there is no `Vendor` model and no
 * `prisma.vendor` delegate. `Order.vendorId` references `User.id` through the
 * "VendorOrders" relation, so the fixture creates a second User to act as the
 * vendor.
 *
 * Required `User` columns are `name` and `email` (unique). Everything else the
 * schema lists is nullable or defaulted.
 */
async function createUser(role: string) {
  return prisma.user.create({
    data: {
      name: `C2 ${role}`,
      email: `${suffix}-${role}@example.test`,
    },
  });
}

/** Required `Order` columns: customerId, vendorId, basePrice, totalPrice. */
async function makeOrder(naira: number) {
  const order = await prisma.order.create({
    data: {
      customerId,
      vendorId,
      basePrice: naira,
      totalPrice: naira,
      status: "PAYMENT_CONFIRMED",
      paymentStatus: "SUCCESS",
    },
  });
  createdOrderIds.push(order.id);
  return order.id;
}

beforeAll(async () => {
  const customer = await createUser("customer");
  customerId = customer.id;

  const vendor = await createUser("vendor");
  vendorId = vendor.id;

  orderA = await makeOrder(5000);
  orderB = await makeOrder(4500);
});

afterAll(async () => {
  // `RefundRequest.orderId` is ON DELETE RESTRICT, so the refund rows MUST go
  // before the orders they reference, or the order delete is rejected.
  if (createdOrderIds.length) {
    await prisma.refundRequest.deleteMany({
      where: { orderId: { in: createdOrderIds } },
    });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (vendorId) await prisma.user.deleteMany({ where: { id: vendorId } });
  if (customerId) await prisma.user.deleteMany({ where: { id: customerId } });
  await prisma.$disconnect();
});

/** Runs `fn` in its own real interactive transaction (its own connection). */
const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(fn);

const obligation = (orderId: string, paymentRef: string) => ({
  userId: customerId,
  paymentRef,
  reason: "C-2 concurrency test",
  orderId,
  requestedAmountKobo: 500_000,
});

const openRowsFor = (orderId: string, paymentRef: string) =>
  prisma.refundRequest.findMany({
    where: {
      orderId,
      paymentRef,
      status: {
        in: [
          RefundStatus.PENDING,
          RefundStatus.APPROVED,
          RefundStatus.PROCESSING,
        ],
      },
    },
  });

/** A distinct paymentRef per test, so cases cannot interfere. */
const uniqueRef = (part: string) => `${tag}-${part}`.toUpperCase().slice(0, 40);

describe("C-2 — one open obligation per (paymentRef, orderId)", () => {
  it("two concurrent inserts of the same obligation leave exactly one open row", async () => {
    const paymentRef = uniqueRef("same");

    // Two genuinely independent transactions racing the same obligation.
    const results = await Promise.all([
      inTx((tx) => fileRefundOwed(tx, obligation(orderA, paymentRef))),
      inTx((tx) => fileRefundOwed(tx, obligation(orderA, paymentRef))),
    ]);

    // Exactly one writer created the row; the other reused it. Neither threw,
    // and the winner is whichever transaction PostgreSQL serialises first —
    // that is non-deterministic, so assert the invariant, not the winner.
    const createdFlags = results.map((r) => r.created);
    expect(createdFlags.filter(Boolean).length).toBe(1);

    // Both callers observe the SAME obligation — the loser re-reads the winner
    // rather than inventing an id or reporting a false success.
    expect(results[0].obligation.id).toBe(results[1].obligation.id);

    // And the table holds exactly one open row, not two.
    const rows = await openRowsFor(orderA, paymentRef);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(results[0].obligation.id);

    await prisma.refundRequest.deleteMany({ where: { paymentRef } });
  });

  it("concurrent inserts for two different orders on one payment both succeed", async () => {
    const paymentRef = uniqueRef("sib");

    const results = await Promise.all([
      inTx((tx) => fileRefundOwed(tx, obligation(orderA, paymentRef))),
      inTx((tx) => fileRefundOwed(tx, obligation(orderB, paymentRef))),
    ]);

    // The invariant is per order, not per payment: no false conflict.
    expect(results.every((r) => r.created)).toBe(true);
    expect(results[0].obligation.id).not.toBe(results[1].obligation.id);
    expect(await openRowsFor(orderA, paymentRef)).toHaveLength(1);
    expect(await openRowsFor(orderB, paymentRef)).toHaveLength(1);

    await prisma.refundRequest.deleteMany({ where: { paymentRef } });
  });

  it.each([RefundStatus.COMPLETED, RefundStatus.FAILED, RefundStatus.REJECTED])(
    "a %s obligation does not block a later one",
    async (terminal) => {
      const paymentRef = uniqueRef("term");

      await prisma.refundRequest.create({
        data: {
          userId: customerId,
          paymentRef,
          reason: "prior terminal obligation",
          status: terminal,
          orderId: orderA,
        },
      });

      const { created } = await inTx((tx) =>
        fileRefundOwed(tx, obligation(orderA, paymentRef)),
      );

      // The terminal row is outside the partial index, so it must not block.
      expect(created).toBe(true);
      expect(await openRowsFor(orderA, paymentRef)).toHaveLength(1);

      await prisma.refundRequest.deleteMany({ where: { paymentRef } });
    },
  );
});

describe("C-2 — NULL orderId stays outside the index", () => {
  it("multiple NULL-orderId refund requests coexist", async () => {
    const paymentRef = uniqueRef("null");

    // The customer-facing payment-wide guard writes NULL attribution for
    // multi-order payments. Those rows must not collide with each other.
    const rows = await Promise.all([
      prisma.refundRequest.create({
        data: {
          userId: customerId,
          paymentRef,
          reason: "null order 1",
          orderId: null,
        },
      }),
      prisma.refundRequest.create({
        data: {
          userId: customerId,
          paymentRef,
          reason: "null order 2",
          orderId: null,
        },
      }),
    ]);

    expect(rows).toHaveLength(2);

    await prisma.refundRequest.deleteMany({ where: { paymentRef } });
  });

  it("a NULL-orderId row does not conflict with an order-scoped row", async () => {
    const paymentRef = uniqueRef("mix");

    await prisma.refundRequest.create({
      data: {
        userId: customerId,
        paymentRef,
        reason: "null attribution",
        orderId: null,
      },
    });
    const { created } = await inTx((tx) =>
      fileRefundOwed(tx, obligation(orderA, paymentRef)),
    );

    expect(created).toBe(true);
    expect(await openRowsFor(orderA, paymentRef)).toHaveLength(1);

    await prisma.refundRequest.deleteMany({ where: { paymentRef } });
  });
});

describe("C-2 — the index itself", () => {
  it("exists as a partial unique index on (paymentRef, orderId)", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ indexdef: string; indexname: string }>
    >`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'RefundRequest'
        AND indexname = 'RefundRequest_open_obligation_per_order'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/CREATE UNIQUE INDEX/i);
    expect(rows[0].indexdef).toMatch(/\("paymentRef",\s*"orderId"\)/i);
    expect(rows[0].indexdef).toMatch(/WHERE/i);
  });
});

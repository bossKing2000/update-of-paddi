/**
 * Daily-cap reservation / release idempotency — real PostgreSQL.
 *
 * These tests exercise `reserveDailyCap` / `releaseOrderDailyCaps` against a
 * live database (no mocked Prisma), proving that capacity is reserved and
 * released exactly once per order even under concurrent releases.
 *
 * Requires the disposable integration database (see tests/README.md). Run
 * with:
 *   npx jest --config jest.integration.config.js --runInBand \
 *     tests/integration/dailyCapConcurrency.test.ts
 */
import { PrismaClient, OrderStatus } from "@prisma/client";
import { DateTime } from "luxon";
import {
  reserveDailyCap,
  releaseOrderDailyCaps,
} from "../../src/services/scheduling.service";

jest.setTimeout(120_000);

const prisma = new PrismaClient();

const LAGOS = "Africa/Lagos";
const DAY_START = DateTime.fromISO("2026-11-02T00:00:00", { zone: LAGOS }).toJSDate();

let vendorId = "";
let customerId = "";
let productId = "";
let orderId = "";
const createdIds: string[] = [];

async function createVendor() {
  const u = await prisma.user.create({
    data: { id: `cap-vend-${Date.now()}`, name: "Cap Vendor", email: `cap-vendor-${Date.now()}@example.test`, role: "VENDOR", isLive: true, vendorStatus: "ACTIVE", kycStatus: "VERIFIED" },
  });
  vendorId = u.id;
  createdIds.push(u.id);
}

async function createCustomer() {
  const u = await prisma.user.create({
    data: { id: `cap-cust-${Date.now()}`, name: "Cap Customer", email: `cap-cust-${Date.now()}@example.test`, role: "CUSTOMER" },
  });
  customerId = u.id;
  createdIds.push(u.id);
}

async function createCategoryAndDishType() {
  const category = await prisma.category.create({
    data: { id: `cap-cat-${Date.now()}`, name: `Cap Category ${Date.now()}`, slug: `cap-cat-${Date.now()}`, sortOrder: 1, isActive: true },
  });
  createdIds.push(category.id);
  const dishType = await prisma.dishType.create({
    data: { id: `cap-dt-${Date.now()}`, name: `Cap Dish ${Date.now()}`, sortOrder: 1, isActive: true, categoryId: category.id },
  });
  createdIds.push(dishType.id);
  return { categoryId: category.id, dishTypeId: dishType.id };
}

async function createProduct({ dailyCap }: { dailyCap: number | null }) {
  const { categoryId, dishTypeId } = await createCategoryAndDishType();
  const p = await prisma.product.create({
    data: {
      id: `cap-prod-${Date.now()}`,
      name: "Cap Product",
      description: "daily cap product",
      price: 1000,
      archived: false,
      dishTypeId,
      categoryId,
      trackInventory: false,
      stock: null,
      vendorId,
      dailyCap,
    },
  });
  productId = p.id;
  createdIds.push(p.id);
}

async function createOrder() {
  const o = await prisma.order.create({
    data: {
      id: `cap-order-${Date.now()}`,
      customerId,
      vendorId,
      basePrice: 1000,
      extraCharge: 0,
      deliveryFee: 0,
      totalPrice: 1000,
      status: OrderStatus.AWAITING_PAYMENT,
      idempotencyKey: `cap-idem-${Date.now()}`,
      paymentStatus: "PENDING",
    },
  });
  orderId = o.id;
  createdIds.push(o.id);
}

beforeAll(async () => {
  await createVendor();
  await createCustomer();
});

afterAll(async () => {
  if (createdIds.length) {
    await prisma.dailyCapReservation.deleteMany({ where: { orderId: { in: createdIds.filter((id) => id.startsWith("cap-order") || id.startsWith("cap-comp")) } } });
    await prisma.order.deleteMany({ where: { id: { in: createdIds.filter((id) => id.startsWith("cap-order") || id.startsWith("cap-comp")) } } });
    await prisma.product.deleteMany({ where: { id: { in: createdIds.filter((id) => id.startsWith("cap-prod")) } } });
    await prisma.dishType.deleteMany({ where: { id: { in: createdIds.filter((id) => id.startsWith("cap-dt")) } } });
    await prisma.category.deleteMany({ where: { id: { in: createdIds.filter((id) => id.startsWith("cap-cat")) } } });
    await prisma.user.deleteMany({ where: { id: { in: createdIds.filter((id) => id.startsWith("cap-vend") || id.startsWith("cap-cust")) } } });
  }
  await prisma.$disconnect();
});

describe("daily-cap reservation / release (real PostgreSQL)", () => {
  it("1. reserves capacity for an order (counter 0 -> 1)", async () => {
    await createProduct({ dailyCap: 5 });
    await createOrder();

    let counter: number | null = null;
    await prisma.$transaction(async (tx) => {
      await reserveDailyCap(tx, productId, DAY_START, 5, orderId);
      const row = await tx.productDailyCounter.findUnique({
        where: { productId_date: { productId, date: DAY_START } },
        select: { count: true },
      });
      counter = row?.count ?? null;
    });

    expect(counter).toBe(1);
  });

  it("2. releasing restores capacity once (counter 1 -> 0)", async () => {
    await createProduct({ dailyCap: 5 });
    await createOrder();
    await prisma.$transaction(async (tx) => {
      await reserveDailyCap(tx, productId, DAY_START, 5, orderId);
    });

    let counter: number | null = null;
    await prisma.$transaction(async (tx) => {
      await releaseOrderDailyCaps(tx, { id: orderId });
      const row = await tx.productDailyCounter.findUnique({
        where: { productId_date: { productId, date: DAY_START } },
        select: { count: true },
      });
      counter = row?.count ?? null;
    });

    expect(counter).toBe(0);
  });

  it("3. releasing the same reservation twice restores capacity only once", async () => {
    await createProduct({ dailyCap: 5 });
    await createOrder();
    await prisma.$transaction(async (tx) => {
      await reserveDailyCap(tx, productId, DAY_START, 5, orderId);
    });

    // First release.
    await prisma.$transaction(async (tx) => {
      await releaseOrderDailyCaps(tx, { id: orderId });
    });
    // Second release of the same reservation must be a no-op.
    await prisma.$transaction(async (tx) => {
      await releaseOrderDailyCaps(tx, { id: orderId });
    });

    const row = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId, date: DAY_START } },
      select: { count: true },
    });
    expect(row?.count).toBe(0);
  });

  it("4. two concurrent releases for the same order restore capacity once", async () => {
    await createProduct({ dailyCap: 5 });
    await createOrder();
    await prisma.$transaction(async (tx) => {
      await reserveDailyCap(tx, productId, DAY_START, 5, orderId);
    });

    // Two concurrent releases of the same reservation.
    await Promise.all([
      prisma.$transaction(async (tx) => {
        await releaseOrderDailyCaps(tx, { id: orderId });
      }),
      prisma.$transaction(async (tx) => {
        await releaseOrderDailyCaps(tx, { id: orderId });
      }),
    ]);

    const row = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId, date: DAY_START } },
      select: { count: true },
    });
    expect(row?.count).toBe(0);
  });

  it("5. releasing order A cannot decrement capacity reserved by order B", async () => {
    await createProduct({ dailyCap: 5 });
    await createOrder();
    const orderBId = `cap-order-b-${Date.now()}`;
    await prisma.order.create({
      data: {
        id: orderBId,
        customerId,
        vendorId,
        basePrice: 1000,
        extraCharge: 0,
        deliveryFee: 0,
        totalPrice: 1000,
        status: OrderStatus.AWAITING_PAYMENT,
        idempotencyKey: `cap-idem-b-${Date.now()}`,
        paymentStatus: "PENDING",
      },
    });
    createdIds.push(orderBId);

    // Reserve 1 unit for order A and 1 unit for order B (counter -> 2).
    await prisma.$transaction(async (tx) => {
      await reserveDailyCap(tx, productId, DAY_START, 5, orderId);
      await reserveDailyCap(tx, productId, DAY_START, 5, orderBId);
    });

    // Release only order B's reservation.
    await prisma.$transaction(async (tx) => {
      await releaseOrderDailyCaps(tx, { id: orderBId });
    });

    // Order A's capacity must still be reserved (counter stays at 1).
    const row = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId, date: DAY_START } },
      select: { count: true },
    });
    expect(row?.count).toBe(1);

    // Clean up order B's leftover reservation (order A released in afterAll via orderId filter;
    // order B is not in that filter, so remove it explicitly).
    await prisma.dailyCapReservation.deleteMany({ where: { orderId: orderBId } });
    await prisma.order.delete({ where: { id: orderBId } });
  });

  it("6. repeated release after checkout + cancellation does not double-release", async () => {
    await createProduct({ dailyCap: 5 });
    await createOrder();

    // Reserve + cancel the order (simulating a cancellation path).
    await prisma.$transaction(async (tx) => {
      await reserveDailyCap(tx, productId, DAY_START, 5, orderId);
      await releaseOrderDailyCaps(tx, { id: orderId });
    });
    // Simulate a second expiry/cancellation sweep on the same order.
    await prisma.$transaction(async (tx) => {
      await releaseOrderDailyCaps(tx, { id: orderId });
    });

    const row = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId, date: DAY_START } },
      select: { count: true },
    });
    expect(row?.count).toBe(0);
  });

  it("8. competing reservations against a daily cap: cap cannot be exceeded", async () => {
    await createProduct({ dailyCap: 2 });

    // Three orders compete for 2 units of capacity on the same product+day.
    const orderIds = [`cap-comp-a-${Date.now()}`, `cap-comp-b-${Date.now()}`, `cap-comp-c-${Date.now()}`];
    for (const oid of orderIds) {
      await prisma.order.create({
        data: {
          id: oid,
          customerId,
          vendorId,
          basePrice: 1000,
          extraCharge: 0,
          deliveryFee: 0,
          totalPrice: 1000,
          status: OrderStatus.AWAITING_PAYMENT,
          idempotencyKey: `cap-comp-idem-${oid}`,
          paymentStatus: "PENDING",
        },
      });
      createdIds.push(oid);
    }

    const results = await Promise.allSettled(
      orderIds.map((oid) =>
        prisma.$transaction(async (tx) => {
          await reserveDailyCap(tx, productId, DAY_START, 2, oid);
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    // Exactly 2 reservations succeed (cap=2), 1 is rejected.
    expect(succeeded).toBe(2);
    expect(failed).toBe(1);

    // Counter must equal the cap, never exceed it.
    const row = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId, date: DAY_START } },
      select: { count: true },
    });
    expect(row?.count).toBe(2);
  });

  it("9. rollback: failed reservation transaction leaves counter unchanged", async () => {
    await createProduct({ dailyCap: 5 });
    await createOrder();

    const counterBefore = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId, date: DAY_START } },
      select: { count: true },
    });
    expect(counterBefore ? counterBefore.count : 0).toBe(0);

    // A transaction that reserves capacity then deliberately fails must roll
    // back both the counter increment and the reservation row.
    await expect(
      prisma.$transaction(async (tx) => {
        await reserveDailyCap(tx, productId, DAY_START, 5, orderId);
        throw new Error("simulated failure after reservation");
      }),
    ).rejects.toThrow("simulated failure after reservation");

    const counterAfter = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId, date: DAY_START } },
      select: { count: true },
    });
    expect(counterAfter ? counterAfter.count : 0).toBe(0);

    const reservation = await prisma.dailyCapReservation.findUnique({
      where: { orderId_productId_day: { orderId, productId, day: DAY_START } },
    });
    expect(reservation).toBeNull();
  });

  it("7. different products and fulfilment days are isolated", async () => {
    // Product A with dailyCap on day 1.
    await createProduct({ dailyCap: 5 });
    const productAId = productId;
    await createOrder();
    const orderAId = orderId;

    // Product B (different product) with dailyCap on day 2.
    await createProduct({ dailyCap: 5 });
    const productBId = productId;
    await createOrder();
    const orderBId = orderId;

    const day2 = DateTime.fromISO("2026-11-03T00:00:00", { zone: LAGOS }).toJSDate();

    await prisma.$transaction(async (tx) => {
      await reserveDailyCap(tx, productAId, DAY_START, 5, orderAId);
      await reserveDailyCap(tx, productBId, day2, 5, orderBId);
    });

    const rowA = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId: productAId, date: DAY_START } },
      select: { count: true },
    });
    const rowB = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId: productBId, date: day2 } },
      select: { count: true },
    });
    expect(rowA?.count).toBe(1);
    expect(rowB?.count).toBe(1);

    // Release order A only; product B's reservation untouched.
    await prisma.$transaction(async (tx) => {
      await releaseOrderDailyCaps(tx, { id: orderAId });
    });
    const rowAAfter = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId: productAId, date: DAY_START } },
      select: { count: true },
    });
    const rowBAfter = await prisma.productDailyCounter.findUnique({
      where: { productId_date: { productId: productBId, date: day2 } },
      select: { count: true },
    });
    expect(rowAAfter?.count).toBe(0);
    expect(rowBAfter?.count).toBe(1);
  });
});

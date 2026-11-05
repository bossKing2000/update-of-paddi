/**
 * F9 — one DeliveryEarning per Order.
 *
 * Enforced at the database level by "DeliveryEarning_orderId_key"
 * (CREATE UNIQUE INDEX ... ON "DeliveryEarning" ("orderId")), which is the
 * database-level backstop underneath the N-05A completion flow (conditional
 * Order CAS + the `orderTransitioned` earnings gate).
 *
 * Self-contained: every fixture row is created here and deleted afterwards, so
 * this does not depend on seeded data. Requires a database reachable through
 * DATABASE_URL that already has the migrations applied.
 */
import { PrismaClient } from "@prisma/client";

jest.setTimeout(60000);

const prisma = new PrismaClient();
const tag = `f9backstop-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = {
  users: [] as string[],
  orders: [] as string[],
  persons: [] as string[],
  earnings: [] as string[],
};

async function makeUser(suffix: string, role: "VENDOR" | "CUSTOMER") {
  const u = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}@x.test`,
      name: `F9 ${suffix}`,
      role,
      roles: [role],
    },
  });
  created.users.push(u.id);
  return u;
}

async function makeOrder(vendorId: string, customerId: string, suffix: string) {
  const o = await prisma.order.create({
    data: {
      customerId,
      vendorId,
      basePrice: 5000,
      totalPrice: 5500,
      deliveryFee: 500,
      status: "COMPLETED",
      paymentStatus: "SUCCESS",
      idempotencyKey: `${tag}-${suffix}`,
    },
  });
  created.orders.push(o.id);
  return o;
}

async function makeDriver(suffix: string) {
  const u = await makeUser(`driver-${suffix}`, "CUSTOMER");
  const p = await prisma.deliveryPerson.create({
    data: { userId: u.id, status: "ACTIVE", walletBalance: 0 },
  });
  created.persons.push(p.id);
  return p;
}

async function makeEarning(orderId: string, deliveryPersonId: string, total = 500) {
  const e = await prisma.deliveryEarning.create({
    data: {
      orderId,
      deliveryPersonId,
      baseFee: 300,
      distanceFee: Math.max(total - 300, 0),
      totalEarned: total,
    },
  });
  created.earnings.push(e.id);
  return e;
}

async function cleanup() {
  // Delete by ORDER, not by recorded earning id: a failing assertion (for
  // example during mutation testing) can leave earnings that were never pushed
  // to `created.earnings`, and leaking those would break the next run by
  // colliding with the unique index. Orders are tagged, so this is precisely
  // scoped to this test run's fixtures.
  if (created.orders.length)
    await prisma.deliveryEarning.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => {});
  if (created.earnings.length)
    await prisma.deliveryEarning.deleteMany({ where: { id: { in: created.earnings } } }).catch(() => {});
  if (created.persons.length)
    await prisma.deliveryPerson.deleteMany({ where: { id: { in: created.persons } } }).catch(() => {});
  if (created.orders.length)
    await prisma.order.deleteMany({ where: { id: { in: created.orders } } }).catch(() => {});
  if (created.users.length)
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  created.users.length = 0;
  created.orders.length = 0;
  created.persons.length = 0;
  created.earnings.length = 0;
}

afterEach(cleanup);
afterAll(async () => {
  await prisma.$disconnect();
});

const isP2002 = (err: unknown) => (err as { code?: string })?.code === "P2002";

describe("F9 one-earning-per-order constraint", () => {
  it("guard: the unique index exists on orderId alone", async () => {
    const rows = (await prisma.$queryRaw`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'DeliveryEarning_orderId_key'
    `) as { indexdef: string }[];

    expect(rows).toHaveLength(1);
    const def = rows[0].indexdef;
    expect(def).toContain("UNIQUE");
    expect(def).toContain('"orderId"');
    // The key must be orderId ALONE — a composite (deliveryPersonId, orderId)
    // index would still permit two riders earning against one order.
    expect(def).not.toContain("deliveryPersonId");
  });

  it("allowed: an order with zero earnings is fine", async () => {
    const vendor = await makeUser("zero-v", "VENDOR");
    const customer = await makeUser("zero-c", "CUSTOMER");
    const order = await makeOrder(vendor.id, customer.id, "zero");
    expect(await prisma.deliveryEarning.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("allowed: exactly one earning per order succeeds", async () => {
    const vendor = await makeUser("one-v", "VENDOR");
    const customer = await makeUser("one-c", "CUSTOMER");
    const order = await makeOrder(vendor.id, customer.id, "one");
    const driver = await makeDriver("one");

    await expect(makeEarning(order.id, driver.id)).resolves.toBeDefined();
    expect(await prisma.deliveryEarning.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("allowed: different orders each hold their own earning", async () => {
    const vendor = await makeUser("multi-v", "VENDOR");
    const customer = await makeUser("multi-c", "CUSTOMER");
    const orderA = await makeOrder(vendor.id, customer.id, "multi-a");
    const orderB = await makeOrder(vendor.id, customer.id, "multi-b");
    const d1 = await makeDriver("multi-a");
    const d2 = await makeDriver("multi-b");

    await expect(makeEarning(orderA.id, d1.id)).resolves.toBeDefined();
    await expect(makeEarning(orderB.id, d2.id)).resolves.toBeDefined();
    expect(await prisma.deliveryEarning.count({ where: { orderId: { in: [orderA.id, orderB.id] } } })).toBe(2);
  });

  it("forbidden: a second earning for the SAME order is rejected", async () => {
    const vendor = await makeUser("dup-v", "VENDOR");
    const customer = await makeUser("dup-c", "CUSTOMER");
    const order = await makeOrder(vendor.id, customer.id, "dup");
    const driver = await makeDriver("dup");

    await makeEarning(order.id, driver.id);
    await expect(makeEarning(order.id, driver.id)).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.deliveryEarning.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("forbidden: a SECOND RIDER earning against the same order is rejected", async () => {
    // This is exactly what a (deliveryPersonId, orderId) key would have let
    // through, and the reason the key is orderId alone.
    const vendor = await makeUser("two-v", "VENDOR");
    const customer = await makeUser("two-c", "CUSTOMER");
    const order = await makeOrder(vendor.id, customer.id, "two");
    const rider1 = await makeDriver("two-a");
    const rider2 = await makeDriver("two-b");

    await makeEarning(order.id, rider1.id);
    await expect(makeEarning(order.id, rider2.id)).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.deliveryEarning.count({ where: { orderId: order.id } })).toBe(1);
    // Only the first rider is recorded as earning it.
    const rows = await prisma.deliveryEarning.findMany({ where: { orderId: order.id } });
    expect(rows[0].deliveryPersonId).toBe(rider1.id);
  });

  it("concurrency: two concurrent transactions for one order converge to a single row", async () => {
    const vendor = await makeUser("race-v", "VENDOR");
    const customer = await makeUser("race-c", "CUSTOMER");
    const order = await makeOrder(vendor.id, customer.id, "race");
    const rider1 = await makeDriver("race-a");
    const rider2 = await makeDriver("race-b");

    // Two real, separate transactions racing the same unique key.
    const attempt = (driverId: string) =>
      prisma.$transaction(async (tx) =>
        tx.deliveryEarning.create({
          data: {
            orderId: order.id,
            deliveryPersonId: driverId,
            baseFee: 300,
            distanceFee: 200,
            totalEarned: 500,
          },
        }),
      );

    const results = await Promise.allSettled([attempt(rider1.id), attempt(rider2.id)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isP2002((rejected[0] as PromiseRejectedResult).reason)).toBe(true);

    const rows = await prisma.deliveryEarning.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
    created.earnings.push(rows[0].id);
  });

  it("the sole writer's shape is unchanged: one row per completion", async () => {
    // Mirrors DeliveryAssignmentService.updateStatus: a single
    // deliveryEarning.create inside the completion transaction.
    const vendor = await makeUser("writer-v", "VENDOR");
    const customer = await makeUser("writer-c", "CUSTOMER");
    const order = await makeOrder(vendor.id, customer.id, "writer");
    const driver = await makeDriver("writer");

    const [wallet, earning] = await prisma.$transaction([
      prisma.deliveryPerson.update({
        where: { id: driver.id },
        data: { walletBalance: { increment: 500 }, totalDeliveries: { increment: 1 } },
      }),
      prisma.deliveryEarning.create({
        data: {
          orderId: order.id,
          deliveryPersonId: driver.id,
          baseFee: 300,
          distanceFee: 200,
          totalEarned: 500,
        },
      }),
    ]);

    expect(wallet.walletBalance).toBe(500);
    expect(earning.orderId).toBe(order.id);
    created.earnings.push(earning.id);
    expect(await prisma.deliveryEarning.count({ where: { orderId: order.id } })).toBe(1);
  });
});
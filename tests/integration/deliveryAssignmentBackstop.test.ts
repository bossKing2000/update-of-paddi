/**
 * F3 Stage 2 — partial unique backstop:
 * "DeliveryAssignment_one_active_per_order" ON ("orderId")
 * WHERE status IN ('ASSIGNED','ACCEPTED','PICKED_UP','EN_ROUTE').
 *
 * At most one row per order may be in an ACTIVE delivery status. Terminal rows
 * (DECLINED / DELIVERED / FAILED / RETURNED / CANCELLED) are outside the
 * predicate and are never constrained, so the reassignment history an order
 * legitimately accumulates keeps working.
 *
 * Self-contained: every fixture row is created here and deleted afterwards, so
 * this does not depend on seeded data. Requires a database reachable through
 * DATABASE_URL that already has the migrations applied.
 */
import { PrismaClient } from "@prisma/client";

jest.setTimeout(60000);

const prisma = new PrismaClient();
const tag = `f3backstop-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = {
  users: [] as string[],
  orders: [] as string[],
  persons: [] as string[],
  assignments: [] as string[],
};

async function makeVendorUser(suffix: string) {
  const u = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}@x.test`,
      name: `Backstop ${suffix}`,
      role: "VENDOR",
      roles: ["VENDOR"],
    },
  });
  created.users.push(u.id);
  return u;
}

async function makeCustomer(suffix: string) {
  const u = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}@x.test`,
      name: `Backstop ${suffix}`,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
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
      status: "READY_FOR_PICKUP",
      paymentStatus: "SUCCESS",
      idempotencyKey: `${tag}-${suffix}`,
    },
  });
  created.orders.push(o.id);
  return o;
}

async function makeDriver(suffix: string) {
  const u = await makeCustomer(`driver-${suffix}`);
  const p = await prisma.deliveryPerson.create({
    data: { userId: u.id, status: "ACTIVE", walletBalance: 0 },
  });
  created.persons.push(p.id);
  return p;
}

type ActiveStatus = "ASSIGNED" | "ACCEPTED" | "PICKED_UP" | "EN_ROUTE";
type AnyStatus = ActiveStatus | "DECLINED" | "DELIVERED" | "FAILED" | "RETURNED" | "CANCELLED";

async function makeAssignment(orderId: string, deliveryPersonId: string, status: AnyStatus) {
  const a = await prisma.deliveryAssignment.create({
    data: { orderId, deliveryPersonId, status },
  });
  created.assignments.push(a.id);
  return a;
}

async function cleanup() {
  if (created.assignments.length)
    await prisma.deliveryAssignment
      .deleteMany({ where: { id: { in: created.assignments } } })
      .catch(() => {});
  if (created.persons.length)
    await prisma.deliveryPerson
      .deleteMany({ where: { id: { in: created.persons } } })
      .catch(() => {});
  if (created.orders.length)
    await prisma.order.deleteMany({ where: { id: { in: created.orders } } }).catch(() => {});
  if (created.users.length)
    await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  created.users.length = 0;
  created.orders.length = 0;
  created.persons.length = 0;
  created.assignments.length = 0;
}

afterEach(cleanup);
afterAll(async () => {
  await prisma.$disconnect();
});

const isP2002 = (err: unknown) => (err as { code?: string })?.code === "P2002";

describe("F3 Stage 2 partial unique backstop", () => {
  it("guard: the partial unique index exists with the intended predicate", async () => {
    const rows = (await prisma.$queryRaw`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'DeliveryAssignment_one_active_per_order'
    `) as { indexdef: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("UNIQUE");
    expect(rows[0].indexdef).toContain('"orderId"');
    for (const status of ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"]) {
      expect(rows[0].indexdef).toContain(status);
    }
    // Terminal statuses must NOT be in the predicate, otherwise legitimate
    // reassignment history would be rejected.
    for (const status of ["DECLINED", "DELIVERED", "FAILED", "RETURNED", "CANCELLED"]) {
      expect(rows[0].indexdef).not.toContain(status);
    }
  });

  it("Test 1: a second ACTIVE assignment for the same order is rejected", async () => {
    const vendor = await makeVendorUser("t1-v");
    const customer = await makeCustomer("t1-c");
    const order = await makeOrder(vendor.id, customer.id, "t1");
    const d1 = await makeDriver("t1-a");
    const d2 = await makeDriver("t1-b");

    await makeAssignment(order.id, d1.id, "ASSIGNED");

    await expect(makeAssignment(order.id, d2.id, "ACCEPTED")).rejects.toMatchObject({
      code: "P2002",
    });
    // Still exactly one active row.
    expect(
      await prisma.deliveryAssignment.count({
        where: {
          orderId: order.id,
          status: { in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] },
        },
      }),
    ).toBe(1);
  });

  it("Test 2: an ACTIVE assignment alongside a TERMINAL assignment is allowed", async () => {
    const vendor = await makeVendorUser("t2-v");
    const customer = await makeCustomer("t2-c");
    const order = await makeOrder(vendor.id, customer.id, "t2");
    const driver = await makeDriver("t2");

    await makeAssignment(order.id, driver.id, "DECLINED");
    await expect(makeAssignment(order.id, driver.id, "ASSIGNED")).resolves.toBeDefined();
  });

  it("Test 3: multiple TERMINAL assignments for the same order are allowed", async () => {
    const vendor = await makeVendorUser("t3-v");
    const customer = await makeCustomer("t3-c");
    const order = await makeOrder(vendor.id, customer.id, "t3");
    const driver = await makeDriver("t3");

    await makeAssignment(order.id, driver.id, "DECLINED");
    await makeAssignment(order.id, driver.id, "DELIVERED");
    await expect(makeAssignment(order.id, driver.id, "CANCELLED")).resolves.toBeDefined();
    await expect(makeAssignment(order.id, driver.id, "FAILED")).resolves.toBeDefined();
    expect(
      await prisma.deliveryAssignment.count({ where: { orderId: order.id } }),
    ).toBe(4);
  });

  it("Test 4: after the only active assignment is terminalized, a new active one is allowed", async () => {
    const vendor = await makeVendorUser("t4-v");
    const customer = await makeCustomer("t4-c");
    const order = await makeOrder(vendor.id, customer.id, "t4");
    const driver = await makeDriver("t4");

    const first = await makeAssignment(order.id, driver.id, "ASSIGNED");
    // Same row changing status is never constrained by a per-row index.
    await prisma.deliveryAssignment.update({
      where: { id: first.id },
      data: { status: "DELIVERED" },
    });

    await expect(makeAssignment(order.id, driver.id, "ASSIGNED")).resolves.toBeDefined();
  });

  it("Test 4b: every legitimate status transition in place is allowed", async () => {
    const vendor = await makeVendorUser("t4b-v");
    const customer = await makeCustomer("t4b-c");
    const order = await makeOrder(vendor.id, customer.id, "t4b");
    const driver = await makeDriver("t4b");

    const a = await makeAssignment(order.id, driver.id, "ASSIGNED");
    // ASSIGNED -> ACCEPTED -> PICKED_UP -> EN_ROUTE -> DELIVERED
    for (const status of ["ACCEPTED", "PICKED_UP", "EN_ROUTE", "DELIVERED"] as const) {
      await expect(
        prisma.deliveryAssignment.update({ where: { id: a.id }, data: { status } }),
      ).resolves.toBeDefined();
    }
  });

  it("Test 5: two different orders can each hold an active assignment", async () => {
    const vendor = await makeVendorUser("t5-v");
    const customer = await makeCustomer("t5-c");
    const orderA = await makeOrder(vendor.id, customer.id, "t5-a");
    const orderB = await makeOrder(vendor.id, customer.id, "t5-b");
    const d1 = await makeDriver("t5-a");
    const d2 = await makeDriver("t5-b");

    await expect(makeAssignment(orderA.id, d1.id, "ASSIGNED")).resolves.toBeDefined();
    await expect(makeAssignment(orderB.id, d2.id, "ACCEPTED")).resolves.toBeDefined();
  });

  it("Test 6: concurrent creates for one order converge to a single active row", async () => {
    const vendor = await makeVendorUser("t6-v");
    const customer = await makeCustomer("t6-c");
    const order = await makeOrder(vendor.id, customer.id, "t6");
    const d1 = await makeDriver("t6-a");
    const d2 = await makeDriver("t6-b");

    const results = await Promise.allSettled([
      makeAssignment(order.id, d1.id, "ASSIGNED"),
      makeAssignment(order.id, d2.id, "ACCEPTED"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isP2002((rejected[0] as PromiseRejectedResult).reason)).toBe(true);
    expect(
      await prisma.deliveryAssignment.count({
        where: {
          orderId: order.id,
          status: { in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] },
        },
      }),
    ).toBe(1);
  });
});
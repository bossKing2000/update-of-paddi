/**
 * F5 regression tests — EN_ROUTE capacity semantics.
 *
 * These tests verify that EN_ROUTE is correctly included in the driver
 * capacity count, per the F5 fix.
 *
 * The tests use a real database to exercise the exact capacity-checking
 * paths (assignOrder, acceptBroadcast, getActiveAssignmentsForDriver)
 * against the updated DRIVER_STACK_STATUSES which now includes EN_ROUTE.
 */
import { PrismaClient, DeliveryStatus } from "@prisma/client";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";

jest.setTimeout(60000);

const prisma = new PrismaClient();
const tag = `f5cap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = {
  users: [] as string[],
  orders: [] as string[],
  persons: [] as string[],
  assignments: [] as string[],
  addresses: [] as string[],
};

async function makeUser(suffix: string, role: "VENDOR" | "CUSTOMER") {
  const u = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}@x.test`,
      name: `F5 ${suffix}`,
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
      status: "READY_FOR_PICKUP",
      paymentStatus: "SUCCESS",
      idempotencyKey: `${tag}-${suffix}`,
    },
  });
  created.orders.push(o.id);
  return o;
}

async function makeDriver(suffix: string) {
  const u = await prisma.user.create({
    data: {
      email: `${tag}-${suffix}@x.test`,
      name: `F5 Driver ${suffix}`,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    },
  });
  created.users.push(u.id);
  const p = await prisma.deliveryPerson.create({
    data: { userId: u.id, status: "ACTIVE", walletBalance: 0, isOnline: true },
  });
  created.persons.push(p.id);
  return p;
}

async function makeAssignment(orderId: string, deliveryPersonId: string, status: DeliveryStatus) {
  const a = await prisma.deliveryAssignment.create({
    data: { orderId, deliveryPersonId, status },
  });
  created.assignments.push(a.id);
  return a;
}

// NOTE: per-test rows (orders/assignments) are torn down after EACH test, but
// the shared vendor/customer/driver users and the DeliveryPerson row are
// suite-scoped fixtures and must survive until the suite's afterAll. An earlier
// version tore down everything after each test, which deleted the shared users
// out from under the remaining tests and failed them with Order_customerId_fkey.
describe("F5 — EN_ROUTE capacity regression tests", () => {
  let vendorId: string;
  let customerId: string;
  let deliveryPersonId: string;
  // Service APIs that take a "driverId" expect the USER id, not the DeliveryPerson id.
  let driverUserId: string;

  beforeAll(async () => {
    const vendor = await prisma.user.create({
      data: { email: `${tag}-vendor@x.test`, name: "F5 Vendor", role: "VENDOR", roles: ["VENDOR"] },
    });
    vendorId = vendor.id;
    created.users.push(vendor.id);

    // The automatic (broadcast) path scans for drivers relative to the vendor's
    // default address, so the vendor fixture needs one with coordinates.
    const vendorAddress = await prisma.address.create({
      data: {
        userId: vendor.id,
        label: "Shop",
        street: "1 Test Road",
        city: "Lagos",
        country: "NG",
        latitude: 6.5244,
        longitude: 3.3792,
        isDefault: true,
      },
    });
    created.addresses.push(vendorAddress.id);

    const customer = await prisma.user.create({
      data: { email: `${tag}-customer@x.test`, name: "F5 Customer", role: "CUSTOMER", roles: ["CUSTOMER"] },
    });
    customerId = customer.id;
    created.users.push(customer.id);

    const driverUser = await prisma.user.create({
      data: {
        email: `${tag}-driver@x.test`,
        name: "F5 Driver",
        role: "CUSTOMER",
        roles: ["CUSTOMER"],
        // The driver scan requires a verified, online, ACTIVE driver.
        isEmailVerified: true,
      },
    });
    created.users.push(driverUser.id);
    driverUserId = driverUser.id;
    const driverPerson = await prisma.deliveryPerson.create({
      data: { userId: driverUser.id, status: "ACTIVE", walletBalance: 0, isOnline: true },
    });
    deliveryPersonId = driverPerson.id;
    created.persons.push(driverPerson.id);
  });

  beforeEach(() => {
    // Fresh per-test fixtures
  });

  afterEach(async () => {
    if (created.assignments.length)
      await prisma.deliveryAssignment.deleteMany({ where: { id: { in: created.assignments } } }).catch(() => {});
    if (created.orders.length)
      await prisma.order.deleteMany({ where: { id: { in: created.orders } } }).catch(() => {});
    created.orders.length = 0;
    created.assignments.length = 0;
  });

  afterAll(async () => {
    if (created.assignments.length)
      await prisma.deliveryAssignment.deleteMany({ where: { id: { in: created.assignments } } }).catch(() => {});
    if (created.orders.length)
      await prisma.order.deleteMany({ where: { id: { in: created.orders } } }).catch(() => {});
    if (created.persons.length)
      await prisma.deliveryPerson.deleteMany({ where: { id: { in: created.persons } } }).catch(() => {});
    if (created.addresses.length)
      await prisma.address.deleteMany({ where: { id: { in: created.addresses } } }).catch(() => {});
    if (created.users.length)
      await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function makeOrder(suffix: string) {
    const o = await prisma.order.create({
      data: {
        customerId,
        vendorId,
        basePrice: 5000,
        totalPrice: 5500,
        deliveryFee: 500,
        status: "READY_FOR_PICKUP",
        paymentStatus: "SUCCESS",
        idempotencyKey: `${tag}-${suffix}`,
      },
    });
    created.orders.push(o.id);
    return o;
  }

  async function makeAssignment(orderId: string, status: DeliveryStatus) {
    const a = await prisma.deliveryAssignment.create({
      data: { orderId, deliveryPersonId, status },
    });
    created.assignments.push(a.id);
    return a;
  }

  async function countActiveAssignments(orderId?: string) {
    // Batch F5-isolation: the no-argument branch is scoped to the test
    // driver's own DeliveryPerson row. Counting database-wide let seeded demo
    // assignments inflate the total (3 test rows + 4 seed rows = 7), while the
    // rule under test is per-driver capacity. The orderId branch is unchanged.
    const where = orderId ? { orderId, status: { in: [DeliveryStatus.ASSIGNED, DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE] } } : { deliveryPersonId, status: { in: [DeliveryStatus.ASSIGNED, DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE] } };
    return prisma.deliveryAssignment.count({ where });
  }

  describe("Test 1 — EN_ROUTE counts toward capacity", () => {
    it("rejects 4th assignment when driver has 3 EN_ROUTE orders", async () => {
      const orderA = await makeOrder("t1-a");
      const orderB = await makeOrder("t1-b");
      const orderC = await makeOrder("t1-c");
      const orderD = await makeOrder("t1-d");

      await makeAssignment(orderA.id, "EN_ROUTE");
      await makeAssignment(orderB.id, "EN_ROUTE");
      await makeAssignment(orderC.id, "EN_ROUTE");

      // 4th assignment should be rejected due to capacity (MAX_STACK = 3)
      await expect(DeliveryAssignmentService.assignOrder(orderD.id, driverUserId)).rejects.toMatchObject({
        message: /exceeds stacking limit|No available drivers|No drivers available within stacking limit/,
      });

      expect(await countActiveAssignments()).toBe(3);
    });
  });

  describe("Test 2 — PICKED_UP → EN_ROUTE does not free capacity", () => {
    it("rejects 4th assignment when driver has PICKED_UP + 2 ACCEPTED, then PICKED_UP → EN_ROUTE", async () => {
      const orderA = await makeOrder("t2-a");
      const orderB = await makeOrder("t2-b");
      const orderC = await makeOrder("t2-c");
      const orderD = await makeOrder("t2-d");

      // Driver at capacity: 1 PICKED_UP + 2 ACCEPTED = 3 active
      await makeAssignment(orderA.id, "PICKED_UP");
      await makeAssignment(orderB.id, "ACCEPTED");
      await makeAssignment(orderC.id, "ACCEPTED");
      expect(await countActiveAssignments()).toBe(3);

      // Transition PICKED_UP -> EN_ROUTE
      await prisma.deliveryAssignment.update({
        where: { id: (await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: orderA.id } })).id },
        data: { status: "EN_ROUTE" },
      });

      // 4th assignment should still be rejected (capacity still 3)
      await expect(DeliveryAssignmentService.assignOrder(orderD.id, driverUserId)).rejects.toMatchObject({
        message: /exceeds stacking limit|No available drivers|No drivers available within stacking limit/,
      });

      expect(await countActiveAssignments()).toBe(3);
    });
  });

  describe("Test 3 — mixed active statuses all count toward capacity", () => {
    it("ASSIGNED + ACCEPTED + PICKED_UP = full capacity", async () => {
      const orderA = await makeOrder("t3-a");
      const orderB = await makeOrder("t3-b");
      const orderC = await makeOrder("t3-c");
      const orderD = await makeOrder("t3-d");

      await makeAssignment(orderA.id, "ASSIGNED");
      await makeAssignment(orderB.id, "ACCEPTED");
      await makeAssignment(orderC.id, "PICKED_UP");

      await expect(DeliveryAssignmentService.assignOrder(orderD.id, driverUserId)).rejects.toMatchObject({
        message: /exceeds stacking limit|No available drivers|No drivers available within stacking limit/,
      });
    });

    it("EN_ROUTE + ACCEPTED + PICKED_UP = full capacity", async () => {
      const orderA = await makeOrder("t3b-a");
      const orderB = await makeOrder("t3b-b");
      const orderC = await makeOrder("t3b-c");
      const orderD = await makeOrder("t3b-d");

      await makeAssignment(orderA.id, "EN_ROUTE");
      await makeAssignment(orderB.id, "ACCEPTED");
      await makeAssignment(orderC.id, "PICKED_UP");

      await expect(DeliveryAssignmentService.assignOrder(orderD.id, driverUserId)).rejects.toMatchObject({
        message: /exceeds stacking limit|No available drivers|No drivers available within stacking limit/,
      });
    });

    it("EN_ROUTE + ASSIGNED + ACCEPTED = full capacity", async () => {
      const orderA = await makeOrder("t3c-a");
      const orderB = await makeOrder("t3c-b");
      const orderC = await makeOrder("t3c-c");
      const orderD = await makeOrder("t3c-d");

      await makeAssignment(orderA.id, "EN_ROUTE");
      await makeAssignment(orderB.id, "ASSIGNED");
      await makeAssignment(orderC.id, "ACCEPTED");

      await expect(DeliveryAssignmentService.assignOrder(orderD.id, driverUserId)).rejects.toMatchObject({
        message: /exceeds stacking limit|No available drivers|No drivers available within stacking limit/,
      });
    });
  });

  describe("Test 4 — terminal status releases capacity", () => {
    it("EN_ROUTE → DELIVERED releases capacity slot", async () => {
      const orderA = await makeOrder("t4-a");
      const orderB = await makeOrder("t4-b");
      const orderC = await makeOrder("t4-c");
      const orderD = await makeOrder("t4-d");

      // Fill capacity with 3 active
      await makeAssignment(orderA.id, "EN_ROUTE");
      await makeAssignment(orderB.id, "ACCEPTED");
      await makeAssignment(orderC.id, "PICKED_UP");

      // Complete orderA
      await prisma.deliveryAssignment.update({
        where: { id: (await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: orderA.id } })).id },
        data: { status: "DELIVERED" },
      });

      // Now capacity should be freed
      await expect(DeliveryAssignmentService.assignOrder(orderD.id, driverUserId)).resolves.toBeTruthy();

      expect(await countActiveAssignments()).toBe(3);
    });

    it("EN_ROUTE → FAILED releases capacity slot", async () => {
      const orderA = await makeOrder("t4b-a");
      const orderB = await makeOrder("t4b-b");
      const orderC = await makeOrder("t4b-c");
      const orderD = await makeOrder("t4b-d");

      await makeAssignment(orderA.id, "EN_ROUTE");
      await makeAssignment(orderB.id, "ACCEPTED");
      await makeAssignment(orderC.id, "PICKED_UP");

      await prisma.deliveryAssignment.update({
        where: { id: (await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: orderA.id } })).id },
        data: { status: "FAILED" },
      });

      await expect(DeliveryAssignmentService.assignOrder(orderD.id, driverUserId)).resolves.toBeTruthy();
      expect(await countActiveAssignments()).toBe(3);
    });

    it("EN_ROUTE → CANCELLED releases capacity slot", async () => {
      const orderA = await makeOrder("t4c-a");
      const orderB = await makeOrder("t4b-b");
      const orderC = await makeOrder("t4b-c");
      const orderD = await makeOrder("t4b-d");

      await makeAssignment(orderA.id, "EN_ROUTE");
      await makeAssignment(orderB.id, "ACCEPTED");
      await makeAssignment(orderC.id, "PICKED_UP");

      await prisma.deliveryAssignment.update({
        where: { id: (await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: orderA.id } })).id },
        data: { status: "CANCELLED" },
      });

      await expect(DeliveryAssignmentService.assignOrder(orderD.id, driverUserId)).resolves.toBeTruthy();
      expect(await countActiveAssignments()).toBe(3);
    });
  });

  describe("Test 5 — driver active list agrees with capacity", () => {
    it("getActiveAssignmentsForDriver includes EN_ROUTE assignments", async () => {
      const orderA = await makeOrder("t5-a");
      const orderB = await makeOrder("t5-b");

      await makeAssignment(orderA.id, "EN_ROUTE");
      await makeAssignment(orderB.id, "ACCEPTED");

      const active = await DeliveryAssignmentService.getActiveAssignmentsForDriver(driverUserId);

      const statuses = active.map((a) => a.status).sort();
      expect(statuses).toEqual(["ACCEPTED", "EN_ROUTE"]);
      expect(active.length).toBe(2);
    });

    it("driver active list count matches capacity count", async () => {
      const orderA = await makeOrder("t5b-a");
      const orderB = await makeOrder("t5b-b");
      const orderC = await makeOrder("t5b-c");

      await makeAssignment(orderA.id, "EN_ROUTE");
      await makeAssignment(orderB.id, "PICKED_UP");
      await makeAssignment(orderC.id, "DELIVERED"); // terminal, should not appear in active list

      const active = await DeliveryAssignmentService.getActiveAssignmentsForDriver(driverUserId);
      const activeCount = await prisma.deliveryAssignment.count({
        where: { deliveryPersonId, status: { in: [DeliveryStatus.ASSIGNED, DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE] } },
      });

      expect(active.length).toBe(activeCount);
      expect(active.length).toBe(2);
      expect(active.every((a) => ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"].includes(a.status))).toBe(true);
    });
  });
});
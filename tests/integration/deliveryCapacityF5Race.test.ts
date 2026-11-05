/**
 * F5-B — per-driver capacity (MAX_STACK = 3) under REAL concurrent writers.
 *
 * F5-B added a `SELECT ... FROM "DeliveryPerson" ... FOR UPDATE` lock to the two
 * authoritative assignment paths (`assignOrder`'s manual branch and
 * `acceptBroadcast`), re-checking capacity inside that lock before the F3
 * Order-row claim and the assignment insert. Everything so far has been proven
 * with an in-memory fake.
 *
 * This file proves the same invariant against a REAL PostgreSQL database,
 * because the property under test is the database's own row-lock arbitration:
 * a mocked Prisma cannot demonstrate that a second transaction genuinely blocks
 * on `FOR UPDATE`, re-reads the committed state, and refuses.
 *
 * Determinism — the `$extends` barrier (same technique as
 * `tests/integration/assignmentStatusCas.test.ts`):
 *
 *   Each of the two racing requests performs exactly one driver-scoped
 *   `DeliveryAssignment.count` immediately BEFORE it tries to take the driver
 *   row lock:
 *     - `assignOrder` manual: the per-driver preflight scan, outside the tx;
 *     - `acceptBroadcast`:    the `driverLoad` guard, inside the tx.
 *   The interceptor parks the first arrival and releases both together once two
 *   have arrived. Both requests therefore reach
 *   `SELECT ... FROM "DeliveryPerson" ... FOR UPDATE` at the same instant, with
 *   no sleep() and no reliance on scheduling luck. From there the outcome is
 *   decided by PostgreSQL's lock manager, not by the test.
 *
 *   This is why the suite is meaningful: without the lock both transactions
 *   would run their authoritative count against the same snapshot (each seeing
 *   2 active) and both would insert, producing 4 active assignments for a
 *   driver whose ceiling is 3. With the lock, one transaction commits and the
 *   other re-reads 3 and raises the capacity ConflictError. Mutation A/B/C
 *   below demonstrate exactly that.
 *
 * Invariant asserted everywhere:
 *   for every driver, assignments in {ASSIGNED, ACCEPTED, PICKED_UP, EN_ROUTE}
 *   never exceed MAX_STACK = 3.
 */
import { PrismaClient } from "@prisma/client";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { ConflictError } from "../../src/errors/AppError";

jest.setTimeout(60000);

// Side effects are mocked: they are irrelevant to capacity and would otherwise
// require an initialized Socket.IO server.
const emit = jest.fn();
jest.mock("../../src/socket", () => ({
  getIO: () => ({ to: () => ({ emit: (...a: unknown[]) => emit(...a) }) }),
}));
jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));
jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
}));

const STACK: string[] = ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"];
const MAX_STACK = 3;

/**
 * Arms a barrier on the next `size` driver-scoped `DeliveryAssignment.count`
 * calls for a specific SET of DeliveryPersons. Scoping by `where.deliveryPersonId`
 * keeps the interceptor off the F3 per-order guard count, so it always parks at
 * the capacity read that immediately precedes the driver row lock.
 *
 * Scoping to an explicit set (rather than "any driver") also guarantees exactly
 * ONE intercepted count per request: `assignOrder` counts one row per candidate
 * driver, and drivers created by earlier tests in this file are still online, so
 * a wildcard matcher could be satisfied twice by a single request and would stop
 * proving anything about overlap.
 */
type Barrier = { size: number; seen: number; driverIds: string[]; waiters: Array<() => void> } | null;
let barrier: Barrier = null;

function armBarrier(size: number, driverIds: string[]) {
  barrier = { size, seen: 0, driverIds, waiters: [] };
}
function matchesDriver(where: any, driverIds: string[]): boolean {
  if (!where) return false;
  // groupBy: where.deliveryPersonId.in = [ids...]
  if (where.deliveryPersonId?.in && Array.isArray(where.deliveryPersonId.in)) {
    return where.deliveryPersonId.in.some((id: string) => driverIds.includes(id));
  }
  // count: where.deliveryPersonId = "id" (legacy per-driver count)
  if (where.deliveryPersonId && driverIds.includes(where.deliveryPersonId)) {
    return true;
  }
  return false;
}

const raw = new PrismaClient();
const db = raw.$extends({
  query: {
    $allModels: {
      $allOperations: async ({ model, operation, args, query }: any) => {
        const b = barrier;
        if (
          b &&
          model === "DeliveryAssignment" &&
          (operation === "count" || operation === "groupBy") &&
          matchesDriver(args?.where, b.driverIds)
        ) {
          b.seen += 1;
          if (b.seen >= b.size) {
            const waiters = b.waiters.splice(0);
            barrier = null;
            waiters.forEach((fn) => fn());
          } else {
            await new Promise<void>((r) => b.waiters.push(() => r()));
          }
        }
        return query(args);
      },
    },
  },
});

// The service uses the prisma singleton, which must be the instrumented
// client. jest hoists mock factories above module initialisation, so the export
// is a lazy getter resolved on first access (at call time).
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return (globalThis as any).__f5bDb;
  },
}));

(globalThis as any).__f5bDb = db;

const tag = `f5brace-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = { users: [] as string[], persons: [] as string[], addresses: [] as string[] };
let testOrders: string[] = [];
let testAssignments: string[] = [];
let testBroadcasts: string[] = [];

async function makeUser(suffix: string, role: "VENDOR" | "CUSTOMER", verified = true) {
  const u = await raw.user.create({
    data: { email: `${tag}-${suffix}@x.test`, name: `F5B ${suffix}`, role, roles: [role], isEmailVerified: verified },
  });
  created.users.push(u.id);
  return u;
}

async function makeDriver(suffix: string) {
  const u = await makeUser(`driver-${suffix}`, "CUSTOMER");
  const p = await raw.deliveryPerson.create({
    data: { userId: u.id, status: "ACTIVE", walletBalance: 0, isOnline: true, latitude: 6.5244, longitude: 3.3792 },
  });
  created.persons.push(p.id);
  return { user: u, person: p };
}

let vendorId: string;
let customerId: string;

beforeAll(async () => {
  const vendor = await makeUser("vendor", "VENDOR");
  vendorId = vendor.id;
  const customer = await makeUser("customer", "CUSTOMER");
  customerId = customer.id;

  // The driver scan needs the vendor's default address with coordinates.
  const addr = await raw.address.create({
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
  created.addresses.push(addr.id);
});

/** A dispatchable, paid order with no live broadcast — valid for manual assign. */
async function makeOrder() {
  const o = await raw.order.create({
    data: {
      customerId,
      vendorId,
      basePrice: 5000,
      totalPrice: 5500,
      status: "READY_FOR_PICKUP",
      paymentStatus: "SUCCESS",
      idempotencyKey: `${tag}-order-${Math.random().toString(36).slice(2)}`,
    },
  });
  testOrders.push(o.id);
  return o;
}

/** An order that also owns a PENDING, unexpired broadcast for `driverUserId`. */
async function makeOrderWithBroadcast(driverUserId: string) {
  const o = await makeOrder();
  const b = await raw.deliveryBroadcast.create({
    data: {
      orderId: o.id,
      driverIds: [driverUserId],
      status: "PENDING",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  testBroadcasts.push(b.id);
  return { order: o, broadcast: b };
}

/** Seeds one of the driver's stack slots on its own dedicated order. */
async function seedActive(personId: string, status: string) {
  const o = await makeOrder();
  const a = await raw.deliveryAssignment.create({
    data: { orderId: o.id, deliveryPersonId: personId, status: status as any },
  });
  testAssignments.push(a.id);
  return a;
}

const settle = <T>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));

/** The invariant, read straight from the database. */
const activeRows = (personId: string) =>
  raw.deliveryAssignment.findMany({
    where: { deliveryPersonId: personId, status: { in: STACK as any } },
    select: { id: true, status: true, orderId: true },
  });

const activeCount = async (personId: string) => (await activeRows(personId)).length;

beforeEach(() => {
  jest.clearAllMocks();
  barrier = null;
});

afterEach(async () => {
  barrier = null;
  if (testAssignments.length)
    await raw.deliveryAssignment.deleteMany({ where: { id: { in: testAssignments } } }).catch(() => {});
  if (testBroadcasts.length)
    await raw.deliveryBroadcast.deleteMany({ where: { id: { in: testBroadcasts } } }).catch(() => {});
  if (testOrders.length)
    await raw.order.deleteMany({ where: { id: { in: testOrders } } }).catch(() => {});
  testOrders = [];
  testAssignments = [];
  testBroadcasts = [];
});

afterAll(async () => {
  if (created.addresses.length)
    await raw.address.deleteMany({ where: { id: { in: created.addresses } } }).catch(() => {});
  if (created.persons.length)
    await raw.deliveryPerson.deleteMany({ where: { id: { in: created.persons } } }).catch(() => {});
  if (created.users.length)
    await raw.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await raw.$disconnect();
});

describe("F5-B — per-driver MAX_STACK under real PostgreSQL concurrency", () => {
  it("Test 1: manual assign vs manual assign — one wins, driver never exceeds 3", async () => {
    const { user, person } = await makeDriver("t1");
    await seedActive(person.id, "EN_ROUTE");
    await seedActive(person.id, "PICKED_UP");
    expect(await activeCount(person.id)).toBe(2);

    // Two DIFFERENT orders, so the F3 Order-row lock cannot arbitrate.
    const orderA = await makeOrder();
    const orderB = await makeOrder();

    armBarrier(2, [person.id]);
    const [a, b] = await Promise.all([
      settle(DeliveryAssignmentService.assignOrder(orderA.id, user.id)),
      settle(DeliveryAssignmentService.assignOrder(orderB.id, user.id)),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok)!;
    expect(loser.error).toBeInstanceOf(ConflictError);
    // The loser must have been stopped by the capacity gate, not by some other guard.
    expect(String((loser.error as Error).message)).toMatch(/exceeds stacking limit/);

    // Both requests reached the barrier before either took the lock, so the
    // overlap was enforced by the test rather than by timing.
    expect(barrier).toBeNull();

    const rows = await activeRows(person.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.status).sort()).toEqual(["ASSIGNED", "EN_ROUTE", "PICKED_UP"]);

    // Exactly one new assignment, on exactly one of the two orders.
    const forA = rows.filter((r) => r.orderId === orderA.id).length;
    const forB = rows.filter((r) => r.orderId === orderB.id).length;
    expect(forA + forB).toBe(1);
  });

  it("Test 2: manual assign vs broadcast acceptance — one wins, driver never exceeds 3", async () => {
    const { user, person } = await makeDriver("t2");
    await seedActive(person.id, "EN_ROUTE");
    await seedActive(person.id, "ACCEPTED");
    expect(await activeCount(person.id)).toBe(2);

    const manualOrder = await makeOrder();
    const { order: bcOrder, broadcast } = await makeOrderWithBroadcast(user.id);

    armBarrier(2, [person.id]);
    const [manual, accept] = await Promise.all([
      settle(DeliveryAssignmentService.assignOrder(manualOrder.id, user.id)),
      settle(DeliveryAssignmentService.acceptBroadcast(broadcast.id, user.id)),
    ]);

    expect([manual, accept].filter((r) => r.ok)).toHaveLength(1);
    const loser = [manual, accept].find((r) => !r.ok)!;
    expect(loser.error).toBeInstanceOf(ConflictError);
    expect(String((loser.error as Error).message)).toMatch(/exceeds stacking limit/);

    expect(barrier).toBeNull();

    const rows = await activeRows(person.id);
    expect(rows).toHaveLength(3);

    // The F3 guards are untouched: the winning path claimed its own order and
    // no second active assignment appeared for either order.
    const newRows = rows.filter((r) => r.orderId === manualOrder.id || r.orderId === bcOrder.id);
    expect(newRows).toHaveLength(1);
    for (const orderId of [manualOrder.id, bcOrder.id]) {
      expect(rows.filter((r) => r.orderId === orderId)).toHaveLength(
        newRows.filter((r) => r.orderId === orderId).length,
      );
    }
  });

  it("Test 3: broadcast acceptance vs broadcast acceptance — one wins, driver never exceeds 3", async () => {
    const { user, person } = await makeDriver("t3");
    await seedActive(person.id, "ASSIGNED");
    await seedActive(person.id, "PICKED_UP");
    expect(await activeCount(person.id)).toBe(2);

    // Two different orders and two different broadcasts, so neither the
    // broadcast CAS nor the F3 per-order guard can be what rejects the loser —
    // only the capacity gate can.
    const first = await makeOrderWithBroadcast(user.id);
    const second = await makeOrderWithBroadcast(user.id);

    armBarrier(2, [person.id]);
    const [a, b] = await Promise.all([
      settle(DeliveryAssignmentService.acceptBroadcast(first.broadcast.id, user.id)),
      settle(DeliveryAssignmentService.acceptBroadcast(second.broadcast.id, user.id)),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok)!;
    expect(loser.error).toBeInstanceOf(ConflictError);
    expect(String((loser.error as Error).message)).toMatch(/exceeds stacking limit/);

    expect(barrier).toBeNull();

    const rows = await activeRows(person.id);
    expect(rows).toHaveLength(3);

    // Only one of the two broadcast orders was dispatched, and the other's
    // broadcast is still PENDING (not silently consumed by the loser).
    const targeted = rows.filter((r) => r.orderId === first.order.id || r.orderId === second.order.id);
    expect(targeted).toHaveLength(1);
    expect(targeted[0].status).toBe("ACCEPTED");
    const stillPending = await raw.deliveryBroadcast.findMany({
      where: { id: { in: [first.broadcast.id, second.broadcast.id] }, status: "PENDING" },
      select: { id: true },
    });
    expect(stillPending).toHaveLength(1);
  });

  it("Test 4: a driver already at 3 refuses both concurrent attempts and stays at 3", async () => {
    const { user, person } = await makeDriver("t4");
    await seedActive(person.id, "EN_ROUTE");
    await seedActive(person.id, "PICKED_UP");
    await seedActive(person.id, "ACCEPTED");
    expect(await activeCount(person.id)).toBe(3);

    const orderA = await makeOrder();
    const orderB = await makeOrder();

    // No barrier here: with 3 active the driver is filtered out by the preflight
    // scan, so no request reaches the lock. The invariant is what matters.
    const [a, b] = await Promise.all([
      settle(DeliveryAssignmentService.assignOrder(orderA.id, user.id)),
      settle(DeliveryAssignmentService.assignOrder(orderB.id, user.id)),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(0);
    for (const loser of [a, b]) {
      if (loser.ok) throw new Error("expected both attempts to be refused");
      expect(loser.error).toBeInstanceOf(ConflictError);
      expect(String((loser.error as Error).message)).toMatch(/exceeds stacking limit/);
    }

    const rows = await activeRows(person.id);
    expect(rows).toHaveLength(3);
    // No fourth assignment, and neither order was dispatched at all.
    expect(rows.filter((r) => r.orderId === orderA.id || r.orderId === orderB.id)).toHaveLength(0);
  });

  it("Test 5: two different drivers are not over-serialized — both succeed independently", async () => {
    const d1 = await makeDriver("t5a");
    const d2 = await makeDriver("t5b");
    const orderA = await makeOrder();
    const orderB = await makeOrder();

    // Release both requests at the same instant so they really do contend for
    // the lock manager; because the rows differ, neither may block the other.
    armBarrier(2, [d1.person.id, d2.person.id]);

    const [a, b] = await Promise.all([
      settle(DeliveryAssignmentService.assignOrder(orderA.id, d1.user.id)),
      settle(DeliveryAssignmentService.assignOrder(orderB.id, d2.user.id)),
    ]);

    // Both requests reached the barrier, so they genuinely overlapped.
    expect(barrier).toBeNull();

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    expect(await activeCount(d1.person.id)).toBe(1);
    expect(await activeCount(d2.person.id)).toBe(1);
    expect((await activeRows(d1.person.id)).map((r) => r.orderId)).toEqual([orderA.id]);
    expect((await activeRows(d2.person.id)).map((r) => r.orderId)).toEqual([orderB.id]);
  });
});

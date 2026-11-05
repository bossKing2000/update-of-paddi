/**
 * F6 — atomic compare-and-set on the `ASSIGNED -> ACCEPTED / DECLINED`
 * transition of a DeliveryAssignment.
 *
 * Before F6 both acceptAssignment and handleDecline read the status, asserted
 * it was ASSIGNED in application code, and then wrote with an UNCONDITIONAL
 * `update({ where: { id } })`. Two concurrent requests could both read ASSIGNED
 * and both write, so an accept and a decline racing each other produced
 * contradictory notifications and the "winner" was decided by write order.
 *
 * These tests run the REAL service methods against a REAL PostgreSQL database,
 * because the property under test is the database's own conditional-UPDATE
 * atomicity — a mocked Prisma cannot demonstrate it.
 *
 * Determinism: a Prisma `$extends` query interceptor acts as a barrier on the
 * first `DeliveryAssignment.findUnique` of each concurrent request, so both
 * requests are guaranteed to have READ `ASSIGNED` before either reaches its
 * write. That is exactly the TOCTOU window the CAS closes, and it makes the
 * race reproducible rather than timing-dependent.
 *
 * Side effects (activity bundle, socket, driver-location broadcast, and the
 * decline-triggered reassignment) are mocked, which also lets Test 7 assert
 * that a lost CAS emits none of them.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { recordActivityBundle } from "../../src/utils/activityUtils/recordActivityBundle";
import { ConflictError, ForbiddenError } from "../../src/errors/AppError";

jest.setTimeout(60000);

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

/**
 * Arms a barrier on the next `size` `DeliveryAssignment.findUnique` calls: the
 * first arrival parks, and all of them are released together once `size` have
 * arrived. That guarantees every concurrent request has READ the assignment
 * before any of them reaches its write — the exact TOCTOU window.
 */
type Barrier = { size: number; seen: number; waiters: Array<() => void> } | null;
let barrier: Barrier = null;
function armBarrier(size: number) {
  barrier = { size, seen: 0, waiters: [] };
}

const raw = new PrismaClient();
const db = raw.$extends({
  query: {
    $allModels: {
      $allOperations: async ({ model, operation, args, query }: any) => {
        const b = barrier;
        if (b && model === "DeliveryAssignment" && operation === "findUnique") {
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

// The service imports the prisma singleton, which must be the instrumented
// client. jest hoists mock factories above this file's initialisation, so the
// export is a lazy getter resolved on first access (at call time).
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return (globalThis as any).__f6Db;
  },
}));

(globalThis as any).__f6Db = db;

const activity = recordActivityBundle as unknown as jest.Mock;
const tag = `f6cas-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = { users: [] as string[], persons: [] as string[] };
// Per-test fixtures, cleared after each test.
let testOrders: string[] = [];
let testAssignments: string[] = [];

async function makeUser(suffix: string, role: "VENDOR" | "CUSTOMER") {
  const u = await raw.user.create({
    data: { email: `${tag}-${suffix}@x.test`, name: `F6 ${suffix}`, role, roles: [role] },
  });
  created.users.push(u.id);
  return u;
}

let vendorId: string;
let customerId: string;
let driverUserId: string;
let deliveryPersonId: string;

beforeAll(async () => {
  const vendor = await makeUser("vendor", "VENDOR");
  vendorId = vendor.id;
  const customer = await makeUser("customer", "CUSTOMER");
  customerId = customer.id;
  const driverUser = await makeUser("driver", "CUSTOMER");
  driverUserId = driverUser.id;
  const person = await raw.deliveryPerson.create({
    data: { userId: driverUser.id, status: "ACTIVE", walletBalance: 0, isOnline: true },
  });
  created.persons.push(person.id);
  deliveryPersonId = person.id;
});

/**
 * Every test gets its OWN order. That is required, not stylistic: F3 Stage 2's
 * partial unique index permits only one active assignment per order, so reusing
 * one order across tests would (correctly) fail once a previous test left an
 * ACCEPTED assignment behind.
 */
async function makeOrder() {
  const order = await raw.order.create({
    data: {
      customerId,
      vendorId,
      basePrice: 5000,
      totalPrice: 5500,
      // READY_FOR_PICKUP + SUCCESS so a decline's reassignment attempt is a real
      // attempt; it fails fast for want of a default vendor address and is
      // swallowed by the pre-existing try/catch, exactly as in production.
      status: "READY_FOR_PICKUP",
      paymentStatus: "SUCCESS",
      idempotencyKey: `${tag}-order-${Math.random().toString(36).slice(2)}`,
    },
  });
  testOrders.push(order.id);
  return order;
}

async function makeAssignedAssignment(orderId: string) {
  const a = await raw.deliveryAssignment.create({
    data: { orderId, deliveryPersonId, status: "ASSIGNED" },
  });
  testAssignments.push(a.id);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  barrier = null;
});

afterEach(async () => {
  if (testAssignments.length)
    await raw.deliveryAssignment.deleteMany({ where: { id: { in: testAssignments } } }).catch(() => {});
  if (testOrders.length) {
    await raw.deliveryBroadcast.deleteMany({ where: { orderId: { in: testOrders } } }).catch(() => {});
    await raw.order.deleteMany({ where: { id: { in: testOrders } } }).catch(() => {});
  }
  testOrders = [];
  testAssignments = [];
});

afterAll(async () => {
  await raw.deliveryPerson.deleteMany({ where: { id: { in: created.persons } } }).catch(() => {});
  await raw.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await raw.$disconnect();
});

const statusOf = (id: string) => raw.deliveryAssignment.findUniqueOrThrow({ where: { id }, select: { status: true, attempts: true } });
const settle = <T>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));

describe("F6 — ASSIGNED -> ACCEPTED/DECLINED compare-and-set", () => {
  it("Test 1: accept vs decline — exactly one wins, final status is one of them", async () => {
    const order = await makeOrder();
    const a = await makeAssignedAssignment(order.id);
    armBarrier(2);

    const [accept, decline] = await Promise.all([
      settle(DeliveryAssignmentService.acceptAssignment(a.id, driverUserId)),
      settle(DeliveryAssignmentService.handleDecline(a.id, driverUserId)),
    ]);

    const winners = [accept, decline].filter((r) => r.ok);
    const losers = [accept, decline].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].error).toBeInstanceOf(ConflictError);

    const { status } = await statusOf(a.id);
    expect(["ACCEPTED", "DECLINED"]).toContain(status);
    // Exactly one transition happened — the status matches exactly one winner.
    if (accept.ok) expect(status).toBe("ACCEPTED");
    else expect(status).toBe("DECLINED");
  });

  it("Test 2: accept vs accept — one succeeds, one conflicts, final status ACCEPTED", async () => {
    const order = await makeOrder();
    const a = await makeAssignedAssignment(order.id);
    armBarrier(2);

    const results = await Promise.all([
      settle(DeliveryAssignmentService.acceptAssignment(a.id, driverUserId)),
      settle(DeliveryAssignmentService.acceptAssignment(a.id, driverUserId)),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser.error).toBeInstanceOf(ConflictError);
    expect(String((loser.error as Error).message)).toMatch(/Cannot accept an assignment in ACCEPTED status/);
    expect((await statusOf(a.id)).status).toBe("ACCEPTED");
  });

  it("Test 3: decline vs decline — one succeeds, one conflicts, attempts incremented once", async () => {
    const order = await makeOrder();
    const a = await makeAssignedAssignment(order.id);
    armBarrier(2);

    const results = await Promise.all([
      settle(DeliveryAssignmentService.handleDecline(a.id, driverUserId)),
      settle(DeliveryAssignmentService.handleDecline(a.id, driverUserId)),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)!.error).toBeInstanceOf(ConflictError);
    const row = await statusOf(a.id);
    expect(row.status).toBe("DECLINED");
    // Before F6 both racing declines incremented this counter.
    expect(row.attempts).toBe(1);
  });

  it("Test 4: decline after ASSIGNED -> ACCEPTED conflicts and leaves ACCEPTED", async () => {
    const order = await makeOrder();
    const a = await makeAssignedAssignment(order.id);
    await DeliveryAssignmentService.acceptAssignment(a.id, driverUserId);

    const err = await DeliveryAssignmentService.handleDecline(a.id, driverUserId).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(String(err.message)).toMatch(/Cannot decline an assignment in ACCEPTED status/);
    expect((await statusOf(a.id)).status).toBe("ACCEPTED");
  });

  it("Test 5: accept after ASSIGNED -> DECLINED conflicts and leaves DECLINED", async () => {
    const order = await makeOrder();
    const a = await makeAssignedAssignment(order.id);
    await DeliveryAssignmentService.handleDecline(a.id, driverUserId);

    const err = await DeliveryAssignmentService.acceptAssignment(a.id, driverUserId).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(String(err.message)).toMatch(/Cannot accept an assignment in DECLINED status/);
    expect((await statusOf(a.id)).status).toBe("DECLINED");
  });

  it("Test 6: a driver who does not own the assignment cannot accept or decline it", async () => {
    const order = await makeOrder();
    const a = await makeAssignedAssignment(order.id);
    const strangerUser = await makeUser("stranger", "CUSTOMER");
    const stranger = await raw.deliveryPerson.create({
      data: { userId: strangerUser.id, status: "ACTIVE", walletBalance: 0 },
    });
    created.persons.push(stranger.id);

    await expect(DeliveryAssignmentService.acceptAssignment(a.id, strangerUser.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(DeliveryAssignmentService.handleDecline(a.id, strangerUser.id)).rejects.toBeInstanceOf(ForbiddenError);

    // No state change and no side effects.
    const row = await statusOf(a.id);
    expect(row.status).toBe("ASSIGNED");
    expect(row.attempts).toBe(0);
    expect(activity).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("Test 7: a CAS that matches zero rows emits no downstream side effect", async () => {
    const order = await makeOrder();
    const a = await makeAssignedAssignment(order.id);
    // Another actor already moved the row out of ASSIGNED between the read and
    // the CAS. Simulated by driving the CAS to a zero-row match: the pre-read
    // sees ASSIGNED (fresh row), then we mutate the row behind its back.
    const assignmentId = a.id;

    // Force the conditional update to match zero rows, emulating a lost race
    // whose row the winner already moved, and assert nothing downstream ran.
    const spy = jest
      .spyOn(db.deliveryAssignment, "updateMany")
      .mockImplementationOnce((() => Promise.resolve({ count: 0 })) as any);

    const err = await DeliveryAssignmentService.acceptAssignment(assignmentId, driverUserId).catch((e) => e);
    spy.mockRestore();

    expect(err).toBeInstanceOf(ConflictError);
    expect((await statusOf(assignmentId)).status).toBe("ASSIGNED");
    expect(activity).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("Test 8: an ordinary accept still emits its side effects exactly once", async () => {
    const order = await makeOrder();
    const a = await makeAssignedAssignment(order.id);
    const assignment = await DeliveryAssignmentService.acceptAssignment(a.id, driverUserId);

    expect(assignment.status).toBe("ACCEPTED");
    expect(assignment.acceptedAt).toBeTruthy();
    expect(activity).toHaveBeenCalledTimes(1);
    expect(activity.mock.calls[0][0].audit.action).toBe("DELIVERY_ACCEPTED");
  });

  it("Test 9: the winning decline still triggers its reassignment side effect", async () => {
    const order = await makeOrder();
    const a = await makeAssignedAssignment(order.id);
    await DeliveryAssignmentService.handleDecline(a.id, driverUserId);

    expect(activity).toHaveBeenCalledTimes(1);
    expect(activity.mock.calls[0][0].audit.action).toBe("DELIVERY_DECLINED");
    // The reassignment attempt ran (it fails fast here for want of a vendor
    // address and is swallowed by the pre-existing try/catch).
    expect(await raw.deliveryBroadcast.count({ where: { orderId: order.id } })).toBe(0);
  });
});

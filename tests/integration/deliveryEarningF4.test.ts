/**
 * F4-2 — an eligible completed delivery pays its rider exactly once.
 *
 * Before F4-2 the only writer of `DeliveryEarning` was the driver path
 * (`updateStatus(DELIVERED)`). An order confirmed COMPLETED through the
 * canonical customer/order path produced no earning and no wallet credit, so a
 * rider who physically delivered an order was routinely never paid.
 *
 * These tests run the REAL service/controller code against a REAL PostgreSQL
 * database, because the property under test is database-level: the Order row
 * lock that serialises the two completion routes, the F9 unique constraint, and
 * transaction rollback.
 *
 * Determinism: the `$extends` barrier from `assignmentStatusCas.test.ts` /
 * `deliveryCapacityF5Race.test.ts` / `deliveryOrderLifecycleF4.test.ts`. Both
 * completion routes hold the `Order` row before crediting, so a race must be
 * parked at each caller's PRE-LOCK read — the driver's
 * `DeliveryAssignment.findUnique` and the order path's `Order.findUnique`.
 * No `sleep`/`setTimeout` is used to create a race anywhere in this file.
 */
import { PrismaClient, DeliveryStatus, OrderStatus } from "@prisma/client";
import { updateOrderStatus } from "../../src/controllers/orderController";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { creditDeliveryEarning } from "../../src/services/deliveryEarning";

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

/* ───────────────────────── barrier / fault injection ───────────────────────── */

type Gate = {
  kind: "barrier" | "fault";
  targets: Array<{ model: string; op: string }>;
  size: number;
  seen: number;
  waiters: Array<() => void>;
};
let gate: Gate | null = null;

function armBarrier(size: number, targets: Array<{ model: string; op: string }>) {
  gate = { kind: "barrier", targets, size, seen: 0, waiters: [] };
}
function armFault(model: string, op: string) {
  gate = { kind: "fault", targets: [{ model, op }], size: 1, seen: 0, waiters: [] };
}

const raw = new PrismaClient();
const db = raw.$extends({
  query: {
    $allModels: {
      $allOperations: async ({ model, operation, args, query }: any) => {
        const g = gate;
        if (g && g.targets.some((t) => t.model === model && t.op === operation)) {
          g.seen += 1;
          if (g.kind === "fault") throw new Error(`INJECTED_FAULT:${model}.${operation}`);
          if (g.seen >= g.size) {
            const w = g.waiters.splice(0);
            gate = null;
            w.forEach((fn) => fn());
          } else {
            await new Promise<void>((r) => g.waiters.push(() => r()));
          }
        }
        return query(args);
      },
    },
  },
});

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return (globalThis as any).__f4b2Db;
  },
}));
(globalThis as any).__f4b2Db = db;

/* ───────────────────────────────── fixtures ───────────────────────────────── */

const tag = `f4b2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = { users: [] as string[], persons: [] as string[], addresses: [] as string[] };
let testOrders: string[] = [];
let testAssignments: string[] = [];

const FEE = 700;          // the order's deliveryFee — the existing compensation amount
const BASE = 300;         // DELIVERY_BASE_FEE default
const PRE_LOCK_TARGETS = [
  { model: "DeliveryAssignment", op: "findUnique" },
  { model: "Order", op: "findUnique" },
];

async function makeUser(suffix: string, role: "VENDOR" | "CUSTOMER") {
  const u = await raw.user.create({
    data: { email: `${tag}-${suffix}@x.test`, name: suffix, role, roles: [role], isEmailVerified: true },
  });
  created.users.push(u.id);
  return u;
}

async function makeRider(suffix: string) {
  const u = await makeUser(`rider-${suffix}`, "CUSTOMER");
  const p = await raw.deliveryPerson.create({
    data: { userId: u.id, status: "ACTIVE", walletBalance: 0, isOnline: true, latitude: 6.5244, longitude: 3.3792 },
  });
  created.persons.push(p.id);
  return { user: u, person: p };
}

let vendorId: string;
let customerId: string;

beforeAll(async () => {
  const v = await makeUser("vendor", "VENDOR");
  vendorId = v.id;
  const c = await makeUser("customer", "CUSTOMER");
  customerId = c.id;
  const addr = await raw.address.create({
    data: { userId: v.id, label: "S", street: "1 R", city: "Lagos", country: "NG", latitude: 6.5244, longitude: 3.3792, isDefault: true },
  });
  created.addresses.push(addr.id);
});

/** OUT_FOR_DELIVERY + SUCCESS — the only state that can carry an active assignment. */
async function makeOutForDeliveryOrder(key: string, fee = FEE) {
  const o = await raw.order.create({
    data: {
      customerId, vendorId, basePrice: 5000, totalPrice: 5500, deliveryFee: fee,
      status: OrderStatus.OUT_FOR_DELIVERY, paymentStatus: "SUCCESS",
      idempotencyKey: `${tag}-${key}-${Math.random().toString(36).slice(2)}`,
    },
  });
  testOrders.push(o.id);
  return o;
}

async function makeActiveAssignment(orderId: string, personId: string, status: DeliveryStatus) {
  const a = await raw.deliveryAssignment.create({ data: { orderId, deliveryPersonId: personId, status } });
  testAssignments.push(a.id);
  return a;
}

/** The financial ground truth, read straight from the database. */
async function financials(orderId: string, personId: string) {
  const earners = await raw.deliveryEarning.findMany({
    where: { orderId },
    select: { id: true, deliveryPersonId: true, baseFee: true, distanceFee: true, totalEarned: true },
  });
  const dp = await raw.deliveryPerson.findUniqueOrThrow({
    where: { id: personId },
    select: { walletBalance: true, totalDeliveries: true },
  });
  return { earners, walletBalance: dp.walletBalance, totalDeliveries: dp.totalDeliveries };
}

const settle = <T,>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));

const customerReq = (orderId: string) =>
  ({ params: { orderId }, body: { status: "COMPLETED" }, user: { id: customerId, role: "CUSTOMER" } }) as any;
const res = { status: () => res, json: () => res } as any;

beforeEach(() => {
  jest.clearAllMocks();
  gate = null;
});

afterEach(async () => {
  gate = null;
  if (testAssignments.length) await raw.deliveryAssignment.deleteMany({ where: { id: { in: testAssignments } } }).catch(() => {});
  if (testOrders.length) {
    await raw.deliveryEarning.deleteMany({ where: { orderId: { in: testOrders } } }).catch(() => {});
    await raw.deliveryBroadcast.deleteMany({ where: { orderId: { in: testOrders } } }).catch(() => {});
    await raw.order.deleteMany({ where: { id: { in: testOrders } } }).catch(() => {});
  }
  testOrders = []; testAssignments = [];
});

afterAll(async () => {
  if (created.addresses.length) await raw.address.deleteMany({ where: { id: { in: created.addresses } } }).catch(() => {});
  if (created.persons.length) await raw.deliveryPerson.deleteMany({ where: { id: { in: created.persons } } }).catch(() => {});
  if (created.users.length) await raw.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await raw.$disconnect();
});

describe("F4-2 — exactly one rider earning per completed delivery (real PostgreSQL)", () => {
  it("F4-2A: customer confirms completion — one earning, one wallet credit, existing amount", async () => {
    const { person } = await makeRider("a");
    const order = await makeOutForDeliveryOrder("A");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    await updateOrderStatus(customerReq(order.id), res);

    const o = await raw.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(o.status).toBe(OrderStatus.COMPLETED);

    const f = await financials(order.id, person.id);
    expect(f.earners).toHaveLength(1);
    // The EXISTING compensation amount, split exactly as the driver path did.
    expect(f.earners[0].totalEarned).toBe(FEE);
    expect(f.earners[0].baseFee).toBe(BASE);
    expect(f.earners[0].distanceFee).toBe(FEE - BASE);
    expect(f.earners[0].deliveryPersonId).toBe(person.id);
    expect(f.walletBalance).toBe(FEE);
    expect(f.totalDeliveries).toBe(1);
  });

  it("F4-2B: driver confirms DELIVERED — existing behaviour preserved", async () => {
    const { user, person } = await makeRider("b");
    const order = await makeOutForDeliveryOrder("B");
    const a = await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    await DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.DELIVERED);

    const f = await financials(order.id, person.id);
    expect(f.earners).toHaveLength(1);
    expect(f.earners[0].totalEarned).toBe(FEE);
    expect(f.earners[0].baseFee).toBe(BASE);
    expect(f.earners[0].distanceFee).toBe(FEE - BASE);
    expect(f.walletBalance).toBe(FEE);
    expect(f.totalDeliveries).toBe(1);
  });

  it("F4-2C: customer and driver completion racing each other cannot double-pay", async () => {
    const { user, person } = await makeRider("c");
    const order = await makeOutForDeliveryOrder("C");
    const a = await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    armBarrier(2, PRE_LOCK_TARGETS);
    await Promise.all([
      settle(DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.DELIVERED)),
      settle(updateOrderStatus(customerReq(order.id), res)),
    ]);
    gate = null;

    const o = await raw.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(o.status).toBe(OrderStatus.COMPLETED);

    const f = await financials(order.id, person.id);
    expect(f.earners).toHaveLength(1);
    expect(f.earners[0].totalEarned).toBe(FEE);
    expect(f.walletBalance).toBe(FEE);
    expect(f.totalDeliveries).toBe(1);
  });

  it("F4-2D: two concurrent customer completions pay exactly once", async () => {
    const { person } = await makeRider("d");
    const order = await makeOutForDeliveryOrder("D");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    armBarrier(2, [{ model: "Order", op: "findUnique" }]);
    const [first, second] = await Promise.all([
      settle(updateOrderStatus(customerReq(order.id), res)),
      settle(updateOrderStatus(customerReq(order.id), res)),
    ]);
    gate = null;

    // Exactly one logical completion: the loser must lose the Order CAS.
    expect([first, second].filter((r) => r.ok)).toHaveLength(1);

    const f = await financials(order.id, person.id);
    expect(f.earners).toHaveLength(1);
    expect(f.walletBalance).toBe(FEE);
    expect(f.totalDeliveries).toBe(1);
  });

  it("F4-2E: two concurrent driver completions pay exactly once", async () => {
    const { user, person } = await makeRider("e");
    const order = await makeOutForDeliveryOrder("E");
    const a = await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    armBarrier(2, [{ model: "DeliveryAssignment", op: "findUnique" }]);
    const [first, second] = await Promise.all([
      settle(DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.DELIVERED)),
      settle(DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.DELIVERED)),
    ]);
    gate = null;

    expect([first, second].filter((r) => r.ok)).toHaveLength(1);

    const rows = await raw.deliveryAssignment.findMany({ where: { orderId: order.id }, select: { status: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(DeliveryStatus.DELIVERED);

    const f = await financials(order.id, person.id);
    expect(f.earners).toHaveLength(1);
    expect(f.walletBalance).toBe(FEE);
    expect(f.totalDeliveries).toBe(1);
  });

  it("F4-2F: a failure after the payout but before commit rolls everything back", async () => {
    const { person } = await makeRider("f");
    const order = await makeOutForDeliveryOrder("F");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    // The customer transaction order is: order CAS -> payout (wallet + earning)
    // -> F4-1 reconciliation. Failing the reconciliation therefore lands AFTER
    // both financial writes and BEFORE commit.
    armFault("DeliveryAssignment", "updateMany");
    const err = await updateOrderStatus(customerReq(order.id), res).then(() => null).catch((e: any) => e);
    gate = null;

    expect(err).toBeTruthy();
    expect(String(err.message)).toContain("INJECTED_FAULT");

    const o = await raw.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(o.status).toBe(OrderStatus.OUT_FOR_DELIVERY);
    const f = await financials(order.id, person.id);
    expect(f.earners).toHaveLength(0);
    expect(f.walletBalance).toBe(0);
    expect(f.totalDeliveries).toBe(0);
  });

  it("F4-2G: retry after a rolled-back payout succeeds cleanly", async () => {
    const { person } = await makeRider("g");
    const order = await makeOutForDeliveryOrder("G");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    armFault("DeliveryAssignment", "updateMany");
    await updateOrderStatus(customerReq(order.id), res).catch(() => null);
    gate = null;
    expect((await financials(order.id, person.id)).earners).toHaveLength(0);

    // Retry with no fault injected.
    await updateOrderStatus(customerReq(order.id), res);

    const f = await financials(order.id, person.id);
    expect(f.earners).toHaveLength(1);
    expect(f.earners[0].totalEarned).toBe(FEE);
    expect(f.walletBalance).toBe(FEE);
    expect(f.totalDeliveries).toBe(1);
  });

  it("F4-2H: an order completed with no rider on any assignment earns nothing", async () => {
    const order = await makeOutForDeliveryOrder("H");
    // No assignment at all: nobody held this order, so nobody is paid.
    await updateOrderStatus(customerReq(order.id), res);
    expect(await raw.deliveryEarning.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("F4-2I: a DECLINED assignment is not treated as the delivery rider", async () => {
    const { person } = await makeRider("i");
    const other = await makeRider("i2");
    const order = await makeOutForDeliveryOrder("I");
    // The first rider declined; a second rider holds the order.
    const declined = await raw.deliveryAssignment.create({
      data: { orderId: order.id, deliveryPersonId: person.id, status: DeliveryStatus.DECLINED },
    });
    testAssignments.push(declined.id);
    await makeActiveAssignment(order.id, other.person.id, DeliveryStatus.EN_ROUTE);

    await updateOrderStatus(customerReq(order.id), res);

    const holders = await financials(order.id, other.person.id);
    expect(holders.earners).toHaveLength(1);
    expect(holders.earners[0].deliveryPersonId).toBe(other.person.id);
    expect(holders.walletBalance).toBe(FEE);
    // The rider who declined earned nothing themselves.
    expect(
      await raw.deliveryEarning.count({ where: { orderId: order.id, deliveryPersonId: person.id } }),
    ).toBe(0);
    expect((await raw.deliveryPerson.findUniqueOrThrow({ where: { id: person.id } })).walletBalance).toBe(0);
  });

  it("F4-2K: the helper is exactly-once on its own, for two callers holding the Order lock", async () => {
    const { person } = await makeRider("k");
    const order = await makeOutForDeliveryOrder("K");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);
    await raw.order.update({ where: { id: order.id }, data: { status: OrderStatus.COMPLETED } });

    // Two concurrent transactions, each taking the Order row lock exactly as
    // BOTH production completion routes do, then invoking the helper.
    //
    // This targets the helper's own contract rather than the entry points: the
    // Order CAS in `updateOrderStatus` and the mirror CAS in `updateStatus`
    // already mean only ONE caller can reach the helper per order, so the
    // end-to-end races above cannot exercise double-invocation. What must hold
    // independently is that the helper itself never pays twice — the wallet
    // credit is not allowed to survive a second call just because `upsert`
    // collapsed the earning row. That would be "one earning, two wallet
    // credits", the exact failure Phase 4 forbids.
    const run = () =>
      raw.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
        return creditDeliveryEarning(tx, order.id);
      });

    const outcomes = await Promise.all([run(), run()]);

    expect(outcomes.filter((o) => o === "credited")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already-credited")).toHaveLength(1);

    const f = await financials(order.id, person.id);
    expect(f.earners).toHaveLength(1);
    expect(f.walletBalance).toBe(FEE);
    expect(f.totalDeliveries).toBe(1);
  });

  it("F4-2J: a free-delivery order preserves the existing zero-amount semantics", async () => {
    const { person } = await makeRider("j");
    // calculateDeliveryFee returns 0 above FREE_DELIVERY_THRESHOLD; the existing
    // driver path still wrote an earning with totalEarned 0. Pinned here so the
    // behaviour is deliberate rather than accidental.
    const order = await makeOutForDeliveryOrder("J", 0);
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    await updateOrderStatus(customerReq(order.id), res);

    const f = await financials(order.id, person.id);
    expect(f.earners).toHaveLength(1);
    expect(f.earners[0].totalEarned).toBe(0);
    expect(f.earners[0].baseFee).toBe(0);
    expect(f.walletBalance).toBe(0);
    expect(f.totalDeliveries).toBe(1);
  });
});

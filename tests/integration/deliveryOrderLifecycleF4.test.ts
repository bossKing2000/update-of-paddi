/**
 * F4-1 — INV-1: a terminal order must never retain an active
 * DeliveryAssignment (ASSIGNED / ACCEPTED / PICKED_UP / EN_ROUTE).
 *
 * These tests run the REAL service/controller code against a REAL PostgreSQL
 * database, because the property under test is the database's own transaction
 * and row-lock behaviour: that the order transition and the assignment
 * reconciliation commit or roll back together, and that two concurrent
 * terminal writers cannot interleave. A mocked Prisma cannot demonstrate that.
 *
 * Determinism — the `$extends` barrier, the same technique used by
 * `tests/integration/assignmentStatusCas.test.ts` and
 * `tests/integration/deliveryCapacityF5Race.test.ts`. No `sleep`/`setTimeout`
 * is used to create a race anywhere in this file. The interceptor parks
 * requests at a named point so both transactions are provably in flight
 * together before either is allowed to finish.
 *
 * Lock order under test: [DeliveryPerson] -> Order -> DeliveryAssignment.
 * The reconciliation paths never take a DeliveryPerson lock, so they cannot
 * form an inverse edge against F5-B.
 */
import { PrismaClient, DeliveryStatus, OrderStatus } from "@prisma/client";
import { updateOrderStatus } from "../../src/controllers/orderController";
import { adminUpdateOrderStatus } from "../../src/controllers/admin.controller";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { completeRefund } from "../../src/services/refundFinalizer.service";
import { ACTIVE_DELIVERY_STATUSES } from "../../src/services/deliveryAssignmentReconciliation";

jest.setTimeout(60000);

const emit = jest.fn();
jest.mock("../../src/socket", () => ({
  getIO: () => ({ to: () => ({ emit: (...a: unknown[]) => emit(...a) }) }),
}));
const activityMock = jest.fn(async () => {});
jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: (...a: unknown[]) => activityMock(...(a as [])),
}));
jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
}));
jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => {}),
}));

/* ───────────────────────── barrier / fault injection ───────────────────────── */

/**
 * `gate` parks the first `size` requests that touch any of `targets`, then
 * releases them together. `fault` throws inside the matching query so the
 * enclosing transaction must roll back.
 *
 * WHY THE TARGETS ARE WHAT THEY ARE
 * `updateStatus` takes the Order row lock BEFORE it CASes the assignment, so
 * parking at the assignment CAS would deadlock the test: the second request
 * would still be blocked on the Order row and could never arrive. The races
 * must instead be parked at each caller's PRE-LOCK read — the driver's
 * `DeliveryAssignment.findUnique` (in `resolveOwnedAssignment`) and the order
 * path's `Order.findUnique`. Both requests then resume together and genuinely
 * contend for the same Order row, so the outcome is decided by PostgreSQL's
 * lock manager rather than by scheduling.
 */
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
          if (g.kind === "fault") {
            throw new Error(`INJECTED_FAULT:${model}.${operation}`);
          }
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
    return (globalThis as any).__f4bDb;
  },
}));
(globalThis as any).__f4bDb = db;

/* ───────────────────────────────── fixtures ───────────────────────────────── */

const tag = `f4b1-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = { users: [] as string[], persons: [] as string[], addresses: [] as string[] };
let testOrders: string[] = [];
let testAssignments: string[] = [];
let testRefunds: string[] = [];
let testPayments: string[] = [];

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

/** An out-for-delivery, paid order — the only state that can hold an active assignment. */
async function makeOutForDeliveryOrder(key: string) {
  const o = await raw.order.create({
    data: {
      customerId, vendorId, basePrice: 5000, totalPrice: 5500, deliveryFee: 700,
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

/* ─────────────────────────────── ground truth ─────────────────────────────── */

const activeFor = (orderId: string) =>
  raw.deliveryAssignment.findMany({
    where: { orderId, status: { in: ACTIVE_DELIVERY_STATUSES as any } },
    select: { id: true, status: true },
  });

/** The invariant, read straight from the database. */
async function assertInv1(orderId: string, expectOrder: OrderStatus[]) {
  const order = await raw.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
  expect(expectOrder).toContain(order.status);
  const active = await activeFor(orderId);
  const TERMINALS: OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.FAILED_DELIVERY, OrderStatus.CANCELLED_UNPAID];
  if (expectOrder.some((s) => TERMINALS.includes(s))) {
    expect(active).toHaveLength(0);
  }
  return order;
}

const settle = <T,>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));

const reqFor = (userId: string, role: string, orderId: string, body: any) =>
  ({ params: { orderId }, body, user: { id: userId, role } }) as any;
const adminReqFor = (id: string, body: any) =>
  ({ params: { id }, body, user: { id: "admin-f4b1", role: "ADMIN" } }) as any;
const res = { status: () => res, json: () => res } as any;

beforeEach(() => {
  jest.clearAllMocks();
  gate = null;
});

afterEach(async () => {
  gate = null;
  if (testAssignments.length) await raw.deliveryAssignment.deleteMany({ where: { id: { in: testAssignments } } }).catch(() => {});
  if (testRefunds.length) await raw.refundRequest.deleteMany({ where: { id: { in: testRefunds } } }).catch(() => {});
  if (testPayments.length) await raw.payment.deleteMany({ where: { id: { in: testPayments } } }).catch(() => {});
  if (testOrders.length) {
    await raw.deliveryEarning.deleteMany({ where: { orderId: { in: testOrders } } }).catch(() => {});
    await raw.deliveryBroadcast.deleteMany({ where: { orderId: { in: testOrders } } }).catch(() => {});
    await raw.order.deleteMany({ where: { id: { in: testOrders } } }).catch(() => {});
  }
  testOrders = []; testAssignments = []; testRefunds = []; testPayments = [];
});

afterAll(async () => {
  if (created.addresses.length) await raw.address.deleteMany({ where: { id: { in: created.addresses } } }).catch(() => {});
  if (created.persons.length) await raw.deliveryPerson.deleteMany({ where: { id: { in: created.persons } } }).catch(() => {});
  if (created.users.length) await raw.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await raw.$disconnect();
});

describe("F4-1 — terminal order / assignment lifecycle consistency (real PostgreSQL)", () => {
  it("F4-1A: customer completes an order while the driver assignment is EN_ROUTE", async () => {
    const { person } = await makeRider("a");
    const order = await makeOutForDeliveryOrder("A");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    await updateOrderStatus(reqFor(customerId, "CUSTOMER", order.id, { status: "COMPLETED" }), res);

    const o = await assertInv1(order.id, [OrderStatus.COMPLETED]);
    expect(o.status).toBe(OrderStatus.COMPLETED);
    const rows = await raw.deliveryAssignment.findMany({ where: { orderId: order.id }, select: { status: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(DeliveryStatus.CANCELLED);
    // Rider compensation is NOT asserted here. F4-1 deliberately created no
    // earning for a customer-completed order; F4-2 then made that path pay the
    // rider. The amount and idempotency are owned and tested by
    // tests/integration/deliveryEarningF4.test.ts. This suite's subject is
    // lifecycle consistency only.
  });

  it("F4-1B: vendor cancels an OUT_FOR_DELIVERY order while the assignment is EN_ROUTE", async () => {
    const { person } = await makeRider("b");
    const order = await makeOutForDeliveryOrder("B");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    await updateOrderStatus(reqFor(vendorId, "VENDOR", order.id, { status: "CANCELLED" }), res);

    await assertInv1(order.id, [OrderStatus.CANCELLED]);
    const rows = await raw.deliveryAssignment.findMany({ where: { orderId: order.id }, select: { status: true } });
    expect(rows[0].status).toBe(DeliveryStatus.CANCELLED);
  });

  it("F4-1C: refund finalization on an OUT_FOR_DELIVERY order reconciles the EN_ROUTE assignment", async () => {
    const { person } = await makeRider("c");
    const order = await makeOutForDeliveryOrder("C");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    const payment = await raw.payment.create({
      data: { userId: customerId, orderId: order.id, reference: `${tag}-pay-C`, amount: 550000, status: "SUCCESS", idempotencyKey: order.idempotencyKey },
    });
    testPayments.push(payment.id);
    const rr = await raw.refundRequest.create({
      data: { userId: customerId, paymentRef: payment.reference, reason: "audit", status: "PROCESSING", requestedAmountKobo: 550000, orderId: order.id },
    });
    testRefunds.push(rr.id);

    const result = await completeRefund(rr.id, { paystackRefundId: "psr-f4b1", source: "webhook" });
    expect(result.outcome).toBe("SUCCESS");

    const o = await raw.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, paymentStatus: true } });
    expect(o.status).toBe(OrderStatus.CANCELLED);
    expect(o.paymentStatus).toBe("REFUNDED");
    expect(await activeFor(order.id)).toHaveLength(0);
  });

  it("F4-1D: admin terminal override reconciles the EN_ROUTE assignment", async () => {
    const { person } = await makeRider("d");
    const order = await makeOutForDeliveryOrder("D");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    await adminUpdateOrderStatus(adminReqFor(order.id, { status: "CANCELLED", reason: "audit" }), res);

    await assertInv1(order.id, [OrderStatus.CANCELLED]);
    expect(await activeFor(order.id)).toHaveLength(0);
  });

  it("F4-1E: driver completion racing customer completion — one winner, no orphan, no double pay", async () => {
    const { user, person } = await makeRider("e");
    const order = await makeOutForDeliveryOrder("E");
    const a = await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    // Park both on the Order row: the driver path locks it with SELECT FOR
    // UPDATE, the customer path locks it with its status CAS. Whichever wins
    // the Order row first, the other must then observe a terminal order.
    armBarrier(2, [{ model: "DeliveryAssignment", op: "findUnique" }, { model: "Order", op: "findUnique" }]);
    const [driver, customer] = await Promise.all([
      settle(DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.DELIVERED)),
      settle(updateOrderStatus(reqFor(customerId, "CUSTOMER", order.id, { status: "COMPLETED" }), res)),
    ]);
    gate = null;

    // Whatever won, exactly one canonical completion happened and no orphan survived.
    const o = await raw.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect([OrderStatus.COMPLETED]).toContain(o.status);
    expect(await activeFor(order.id)).toHaveLength(0);

    const earners = await raw.deliveryEarning.count({ where: { orderId: order.id } });
    expect(earners).toBeLessThanOrEqual(1);
    const dp = await raw.deliveryPerson.findUniqueOrThrow({ where: { id: person.id }, select: { walletBalance: true, totalDeliveries: true } });
    if (earners === 1) {
      expect(dp.totalDeliveries).toBe(1);
      expect(dp.walletBalance).toBe(700);
    } else {
      expect(dp.totalDeliveries).toBe(0);
      expect(dp.walletBalance).toBe(0);
    }
    expect([driver.ok, customer.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });

  it("F4-1F: driver status update racing a cancellation — no terminal order keeps an active assignment", async () => {
    const { user, person } = await makeRider("f");
    const order = await makeOutForDeliveryOrder("F");
    const a = await makeActiveAssignment(order.id, person.id, DeliveryStatus.PICKED_UP);

    armBarrier(2, [{ model: "DeliveryAssignment", op: "findUnique" }, { model: "Order", op: "findUnique" }]);
    const [driver, cancel] = await Promise.all([
      settle(DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.EN_ROUTE)),
      settle(updateOrderStatus(reqFor(vendorId, "VENDOR", order.id, { status: "CANCELLED" }), res)),
    ]);
    gate = null;

    await assertInv1(order.id, [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CANCELLED]);

    const rows = await raw.deliveryAssignment.findMany({ where: { orderId: order.id }, select: { status: true } });
    expect(rows).toHaveLength(1);
    // Only reachable terminal statuses — no impossible combination.
    expect([DeliveryStatus.EN_ROUTE, DeliveryStatus.CANCELLED]).toContain(rows[0].status);
    // A non-completing transition must never produce an earning.
    expect(await raw.deliveryEarning.count({ where: { orderId: order.id } })).toBe(0);
    expect([driver.ok, cancel.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });

  it("F4-1G: two concurrent driver completions transition and pay exactly once", async () => {
    const { user, person } = await makeRider("g");
    const order = await makeOutForDeliveryOrder("G");
    const a = await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    // Park both at their pre-lock read so they contend for the same Order row.
    // The winner CASes EN_ROUTE -> DELIVERED; the loser then matches no row.
    armBarrier(2, [{ model: "DeliveryAssignment", op: "findUnique" }]);
    const [first, second] = await Promise.all([
      settle(DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.DELIVERED)),
      settle(DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.DELIVERED)),
    ]);
    gate = null;

    // Exactly one CAS winner.
    expect([first, second].filter((r) => r.ok)).toHaveLength(1);
    const loser = [first, second].find((r) => !r.ok)!;
    expect(String((loser.error as Error).message)).toMatch(/Cannot transition from/);

    const rows = await raw.deliveryAssignment.findMany({ where: { orderId: order.id }, select: { status: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(DeliveryStatus.DELIVERED);
    expect(await activeFor(order.id)).toHaveLength(0);

    // Exactly one earning, exactly one wallet credit — not a DB unique error.
    expect(await raw.deliveryEarning.count({ where: { orderId: order.id } })).toBe(1);
    const dp = await raw.deliveryPerson.findUniqueOrThrow({ where: { id: person.id }, select: { walletBalance: true, totalDeliveries: true } });
    expect(dp.totalDeliveries).toBe(1);
    expect(dp.walletBalance).toBe(700);
  });

  it("F4-1H: a failure between assignment CAS and commit rolls the whole completion back", async () => {
    const { user, person } = await makeRider("h");
    const order = await makeOutForDeliveryOrder("H");
    const a = await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    // Inject a failure on the wallet write, i.e. AFTER the assignment CAS and
    // the Order mirror but BEFORE commit. Everything must roll back together.
    armFault("DeliveryPerson", "update");
    const err = await DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.DELIVERED)
      .then(() => null).catch((e: any) => e);
    gate = null;

    expect(err).toBeTruthy();
    expect(String(err.message)).toContain("INJECTED_FAULT");

    // No partial completion: assignment still active, order not completed,
    // no earning, no wallet credit.
    const o = await raw.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(o.status).toBe(OrderStatus.OUT_FOR_DELIVERY);
    const rows = await raw.deliveryAssignment.findMany({ where: { orderId: order.id }, select: { status: true } });
    expect(rows[0].status).toBe(DeliveryStatus.EN_ROUTE);
    expect(await raw.deliveryEarning.count({ where: { orderId: order.id } })).toBe(0);
    const dp = await raw.deliveryPerson.findUniqueOrThrow({ where: { id: person.id }, select: { walletBalance: true, totalDeliveries: true } });
    expect(dp.walletBalance).toBe(0);
    expect(dp.totalDeliveries).toBe(0);
  });

  it("F4-1H2: a failure inside the canonical completion rolls the order back too", async () => {
    const { person } = await makeRider("h2");
    const order = await makeOutForDeliveryOrder("H2");
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    // Fail the reconciliation itself, which runs after the order CAS.
    armFault("DeliveryAssignment", "updateMany");
    const err = await updateOrderStatus(reqFor(customerId, "CUSTOMER", order.id, { status: "COMPLETED" }), res)
      .then(() => null).catch((e: any) => e);
    gate = null;

    expect(err).toBeTruthy();
    // Order did NOT commit terminal, and the assignment is untouched.
    const o = await raw.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(o.status).toBe(OrderStatus.OUT_FOR_DELIVERY);
    const active = await activeFor(order.id);
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe(DeliveryStatus.EN_ROUTE);
  });

  it("F4-1I: the order-terminal guard refuses to advance a delivery on a dead order and heals the orphan", async () => {
    const { user, person } = await makeRider("i");
    const order = await makeOutForDeliveryOrder("I");
    const a = await makeActiveAssignment(order.id, person.id, DeliveryStatus.ACCEPTED);

    // Legacy orphan: order already terminal, assignment still active.
    await raw.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    const err = await DeliveryAssignmentService.updateStatus(a.id, user.id, DeliveryStatus.PICKED_UP)
      .then(() => null).catch((e: any) => e);

    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/cannot be advanced/);
    // The advance was refused AND the pre-existing orphan was healed.
    expect(await activeFor(order.id)).toHaveLength(0);
    const rows = await raw.deliveryAssignment.findMany({ where: { orderId: order.id }, select: { status: true } });
    expect(rows[0].status).toBe(DeliveryStatus.CANCELLED);
  });

  it("F4-1J: reconciliation never deletes history and never touches earnings or wallet", async () => {
    const { person } = await makeRider("j");
    const order = await makeOutForDeliveryOrder("J");
    const declined = await raw.deliveryAssignment.create({
      data: { orderId: order.id, deliveryPersonId: person.id, status: DeliveryStatus.DECLINED },
    });
    testAssignments.push(declined.id);
    await makeActiveAssignment(order.id, person.id, DeliveryStatus.EN_ROUTE);

    await updateOrderStatus(reqFor(customerId, "CUSTOMER", order.id, { status: "COMPLETED" }), res);

    const rows = await raw.deliveryAssignment.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    // Both rows survive: the DECLINED history row is untouched, the active one terminalized.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual([DeliveryStatus.CANCELLED, DeliveryStatus.DECLINED]);
    // The reconciliation itself creates nothing. Exactly ONE earning exists, and
    // it comes from the F4-2 completion credit — the terminalizing helper never
    // writes earnings or touches a wallet (see deliveryEarningF4.test.ts).
    expect(await raw.deliveryEarning.count({ where: { orderId: order.id } })).toBe(1);
    const dp = await raw.deliveryPerson.findUniqueOrThrow({ where: { id: person.id }, select: { walletBalance: true } });
    // Credited exactly once by that single earning — not twice.
    expect(dp.walletBalance).toBe(700);
  });
});

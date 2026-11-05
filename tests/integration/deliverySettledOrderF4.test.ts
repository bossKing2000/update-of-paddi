/**
 * F4-4 — a settled (already-paid) order must not be redispatched, and a second
 * rider must never be silently denied payment for completing it.
 *
 * Real PostgreSQL throughout: the properties under test are the Order-row lock
 * that serialises dispatch/completion/admin-override, the transactional
 * rollback, and F9's unique constraint.
 *
 * Determinism: the `$extends` barrier used by assignmentStatusCas /
 * deliveryCapacityF5Race / deliveryOrderLifecycleF4 / deliveryEarningF4. No
 * sleep() or setTimeout is used to manufacture a race in this file.
 */
import { PrismaClient, DeliveryStatus, OrderStatus } from "@prisma/client";
import { updateOrderStatus } from "../../src/controllers/orderController";
import { adminUpdateOrderStatus } from "../../src/controllers/admin.controller";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { creditDeliveryEarning } from "../../src/services/deliveryEarning";

jest.setTimeout(60000);

const emit = jest.fn();
jest.mock("../../src/socket", () => ({
  getIO: () => ({ to: () => ({ emit: (...a: unknown[]) => emit(...a) }) }),
}));
const logError = jest.fn();
const logWarn = jest.fn();
jest.mock("../../src/lib/logger", () => ({
  __esModule: true,
  logger: {
    error: (...a: unknown[]) => logError(...a),
    warn: (...a: unknown[]) => logWarn(...a),
    info: jest.fn(), debug: jest.fn(),
  },
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
    return (globalThis as any).__f4b4Db;
  },
}));
(globalThis as any).__f4b4Db = db;

/* ───────────────────────────────── fixtures ───────────────────────────────── */

const tag = `f4b4-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created = { users: [] as string[], persons: [] as string[], addresses: [] as string[] };
// Riders are per-test: `afterEach` removes them so a long file cannot grow an
// ever-larger online-driver population. `created.*` still holds every id for the
// afterAll safety sweep.
let testPersons: string[] = [];
let testUsers: string[] = [];
let testOrders: string[] = [];
let testAssignments: string[] = [];
let testBroadcasts: string[] = [];

const FEE = 700;
const PRE_LOCK = [
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
  testPersons.push(p.id);
  testUsers.push(u.id);
  return { user: u, person: p };
}

let vendorId: string;
let customerId: string;

beforeAll(async () => {
  const v = await makeUser("vendor", "VENDOR");
  vendorId = v.id;
  const c = await makeUser("customer", "CUSTOMER");
  customerId = c.id;
  const a = await raw.address.create({
    data: { userId: v.id, label: "S", street: "1 R", city: "Lagos", country: "NG", latitude: 6.5244, longitude: 3.3792, isDefault: true },
  });
  created.addresses.push(a.id);
});

// Phase 3.2.17: `OrderStatus` is generated as BOTH a runtime object and a
// string-union type alias (`export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus]`),
// so an un-annotated parameter inferred the literal type "OUT_FOR_DELIVERY"
// from the default and rejected any other status. Annotating with the union
// alias `OrderStatus` is the narrowest correct form — indexing the alias
// itself (`OrderStatus[keyof typeof OrderStatus]`) is not valid TypeScript,
// because in type position `OrderStatus` is the union, not the object.
async function makeOrder(key: string, status: OrderStatus = OrderStatus.OUT_FOR_DELIVERY) {
  const o = await raw.order.create({
    data: {
      customerId, vendorId, basePrice: 5000, totalPrice: 5500, deliveryFee: FEE,
      status, paymentStatus: "SUCCESS",
      idempotencyKey: `${tag}-${key}-${Math.random().toString(36).slice(2)}`,
    },
  });
  testOrders.push(o.id);
  return o;
}
async function makeAssignment(orderId: string, personId: string, status: DeliveryStatus) {
  const a = await raw.deliveryAssignment.create({ data: { orderId, deliveryPersonId: personId, status } });
  testAssignments.push(a.id);
  return a;
}

/** Drives an order to genuinely settled: completed order + one paid earning. */
async function settleOrder(orderId: string, personId: string, riderUserId: string) {
  const assignment = await makeAssignment(orderId, personId, DeliveryStatus.EN_ROUTE);
  await DeliveryAssignmentService.updateStatus(assignment.id, riderUserId, DeliveryStatus.DELIVERED);
  return assignment;
}

const wallet = (id: string) => raw.deliveryPerson.findUniqueOrThrow({ where: { id }, select: { walletBalance: true, totalDeliveries: true } });
const earnings = (orderId: string) => raw.deliveryEarning.findMany({ where: { orderId }, select: { id: true, deliveryPersonId: true, totalEarned: true } });
const assignments = (orderId: string) => raw.deliveryAssignment.findMany({ where: { orderId }, select: { deliveryPersonId: true, status: true } });

const settle = <T,>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
const customerReq = (orderId: string) => ({ params: { orderId }, body: { status: "COMPLETED" }, user: { id: customerId, role: "CUSTOMER" } }) as any;
const adminReq = (id: string, status: string) => ({ params: { id }, body: { status, reason: "audit" }, user: { id: "admin-f4b4", role: "ADMIN" } }) as any;
const res = { status: () => res, json: () => res } as any;

beforeEach(() => { jest.clearAllMocks(); gate = null; });

afterEach(async () => {
  gate = null;
  if (testAssignments.length) await raw.deliveryAssignment.deleteMany({ where: { id: { in: testAssignments } } }).catch(() => {});
  if (testBroadcasts.length) await raw.deliveryBroadcast.deleteMany({ where: { id: { in: testBroadcasts } } }).catch(() => {});
  // DeliveryEarning restricts deletion of BOTH Order and DeliveryPerson, so every
  // earning this test created must go before either of those rows is removed.
  if (testOrders.length) await raw.deliveryEarning.deleteMany({ where: { orderId: { in: testOrders } } }).catch(() => {});
  if (testPersons.length) await raw.deliveryEarning.deleteMany({ where: { deliveryPersonId: { in: testPersons } } }).catch(() => {});
  if (testOrders.length) await raw.order.deleteMany({ where: { id: { in: testOrders } } }).catch(() => {});
  // DeliveryAssignment / DriverLocationLog cascade from DeliveryPerson.
  if (testPersons.length) await raw.deliveryPerson.deleteMany({ where: { id: { in: testPersons } } }).catch(() => {});
  // Addresses reference User; the beforeAll vendor/customer are NOT in testUsers,
  // so only this test's own rider users are removed.
  if (testUsers.length) {
    await raw.address.deleteMany({ where: { userId: { in: testUsers } } }).catch(() => {});
    await raw.user.deleteMany({ where: { id: { in: testUsers } } }).catch(() => {});
  }
  testOrders = []; testAssignments = []; testBroadcasts = []; testPersons = []; testUsers = [];
});

afterAll(async () => {
  if (created.addresses.length) await raw.address.deleteMany({ where: { id: { in: created.addresses } } }).catch(() => {});
  if (created.persons.length) await raw.deliveryPerson.deleteMany({ where: { id: { in: created.persons } } }).catch(() => {});
  if (created.users.length) await raw.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await raw.$disconnect();
});

describe("F4-4 — no redispatch of a settled order, no silent second-rider denial (real PostgreSQL)", () => {
  /* ── Implementation A: dispatch barriers ───────────────────────────────── */

  it("T1: an earned order cannot be manually dispatched", async () => {
    const r1 = await makeRider("t1a");
    const o = await makeOrder("T1");
    await settleOrder(o.id, r1.person.id, r1.user.id);
    // Simulate the reopen that used to enable D1: order back to dispatchable.
    await raw.order.update({ where: { id: o.id }, data: { status: OrderStatus.OUT_FOR_DELIVERY } });

    const r2 = await makeRider("t1b");
    const err = await DeliveryAssignmentService.assignOrder(o.id, r2.user.id).then(() => null).catch((e: any) => e);

    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/already been paid out to a rider/);
    expect((await assignments(o.id)).filter((a) => a.deliveryPersonId === r2.person.id)).toHaveLength(0);
    expect(await earnings(o.id)).toHaveLength(1);
  });

  it("T2: an earned order cannot enter the automatic dispatch/broadcast flow", async () => {
    const r1 = await makeRider("t2a");
    const o = await makeOrder("T2");
    await settleOrder(o.id, r1.person.id, r1.user.id);
    await raw.order.update({ where: { id: o.id }, data: { status: OrderStatus.OUT_FOR_DELIVERY } });

    const err = await DeliveryAssignmentService.assignOrder(o.id).then(() => null).catch((e: any) => e);

    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/already been paid out to a rider/);
    expect(await raw.deliveryBroadcast.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("T3: an earned order cannot be assigned through broadcast acceptance", async () => {
    const r1 = await makeRider("t3a");
    const o = await makeOrder("T3");
    await settleOrder(o.id, r1.person.id, r1.user.id);

    const bc = await raw.deliveryBroadcast.create({
      data: { orderId: o.id, driverIds: [r1.user.id], status: "PENDING", expiresAt: new Date(Date.now() + 60_000) },
    });
    testBroadcasts.push(bc.id);
    await raw.order.update({ where: { id: o.id }, data: { status: OrderStatus.OUT_FOR_DELIVERY } });

    const r2 = await makeRider("t3b");
    await raw.deliveryBroadcast.update({ where: { id: bc.id }, data: { driverIds: [r2.user.id] } });

    const err = await DeliveryAssignmentService.acceptBroadcast(bc.id, r2.user.id).then(() => null).catch((e: any) => e);

    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/already been paid out to a rider/);
    expect((await assignments(o.id)).filter((a) => a.deliveryPersonId === r2.person.id)).toHaveLength(0);
  });

  it("T4: a COMPLETED order with a DELIVERED assignment but no earning is still refused as ordinary dispatch", async () => {
    const r1 = await makeRider("t4a");
    const o = await makeOrder("T4");
    // Assignment history exists (DELIVERED) but no earning was ever written.
    await makeAssignment(o.id, r1.person.id, DeliveryStatus.DELIVERED);
    await raw.order.update({ where: { id: o.id }, data: { status: OrderStatus.OUT_FOR_DELIVERY } });

    const r2 = await makeRider("t4b");
    const err = await DeliveryAssignmentService.assignOrder(o.id, r2.user.id).then(() => null).catch((e: any) => e);

    // Refused explicitly, not silently accepted.
    expect(err).toBeTruthy();
    expect((await assignments(o.id)).filter((a) => a.deliveryPersonId === r2.person.id)).toHaveLength(0);
    expect(await earnings(o.id)).toHaveLength(0);
  });

  /* ── Implementation B: earning helper semantics ────────────────────────── */

  it("T5: same-rider duplicate earning does not credit the wallet twice", async () => {
    const r = await makeRider("t5");
    const o = await makeOrder("T5");
    const a = await makeAssignment(o.id, r.person.id, DeliveryStatus.EN_ROUTE);
    await DeliveryAssignmentService.updateStatus(a.id, r.user.id, DeliveryStatus.DELIVERED);

    const first = (await wallet(r.person.id)).walletBalance;
    expect(first).toBe(FEE);

    // Invoke the helper again for the same rider, in its own transaction.
    const again = await raw.$transaction((tx) => creditDeliveryEarning(tx, o.id, { riderId: r.person.id }));
    expect(again).toBe("already-credited");
    expect((await wallet(r.person.id)).walletBalance).toBe(FEE);
    expect(await earnings(o.id)).toHaveLength(1);
  });

  it("T6: a different-rider duplicate earning raises a conflict and logs the incident", async () => {
    const r1 = await makeRider("t6a");
    const o = await makeOrder("T6");
    await settleOrder(o.id, r1.person.id, r1.user.id);
    const r2 = await makeRider("t6b");
    // Rider 2 legitimately holds an assignment for this order, and the order is
    // still COMPLETED — exactly the state in which a second rider's completion
    // would reach the duplicate check.
    await makeAssignment(o.id, r2.person.id, DeliveryStatus.EN_ROUTE);

    const err = await raw
      .$transaction((tx) => creditDeliveryEarning(tx, o.id, { riderId: r2.person.id }))
      .then(() => null)
      .catch((e: any) => e);

    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/already been completed and paid to another rider/);

    // Structured, actionable log — and no personal data.
    expect(logError).toHaveBeenCalled();
    const meta = (logError.mock.calls.find((c: any[]) => String(c[1]).includes("second rider")) ?? [])[0] as any;
    expect(meta).toMatchObject({ orderId: o.id });
    expect(meta.existingRiderId).toBe(r1.person.id);
    expect(meta.attemptedRiderId).toBe(r2.person.id);
    expect(meta.earningId).toBeTruthy();
    expect(JSON.stringify(meta)).not.toMatch(/@x\.test/);
  });

  it("T7: a different-rider duplicate leaves both wallets and the original earning untouched", async () => {
    const r1 = await makeRider("t7a");
    const o = await makeOrder("T7");
    await settleOrder(o.id, r1.person.id, r1.user.id);
    const r2 = await makeRider("t7b");
    await makeAssignment(o.id, r2.person.id, DeliveryStatus.EN_ROUTE);

    const before1 = await wallet(r1.person.id);
    const before2 = await wallet(r2.person.id);
    const beforeEarnings = await earnings(o.id);

    await raw.$transaction((tx) => creditDeliveryEarning(tx, o.id, { riderId: r2.person.id })).catch(() => null);

    expect(await wallet(r1.person.id)).toEqual(before1);
    expect(await wallet(r2.person.id)).toEqual(before2);
    expect(await earnings(o.id)).toEqual(beforeEarnings);
  });

  it("T8: a failed transaction rolls back the order transition, earning and wallet together", async () => {
    const r = await makeRider("t8");
    const o = await makeOrder("T8");
    await makeAssignment(o.id, r.person.id, DeliveryStatus.EN_ROUTE);

    // Fail after the payout, before commit.
    armFault("DeliveryAssignment", "updateMany");
    const err = await DeliveryAssignmentService.updateStatus(
      (await raw.deliveryAssignment.findFirstOrThrow({ where: { orderId: o.id } })).id,
      r.user.id,
      DeliveryStatus.DELIVERED,
    ).then(() => null).catch((e: any) => e);
    gate = null;

    expect(String(err.message)).toContain("INJECTED_FAULT");
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(OrderStatus.OUT_FOR_DELIVERY);
    expect(await earnings(o.id)).toHaveLength(0);
    expect((await wallet(r.person.id)).walletBalance).toBe(0);
  });

  it("T9: retry after rollback creates exactly one earning and one wallet credit", async () => {
    const r = await makeRider("t9");
    const o = await makeOrder("T9");
    const a = await makeAssignment(o.id, r.person.id, DeliveryStatus.EN_ROUTE);

    armFault("DeliveryAssignment", "updateMany");
    await DeliveryAssignmentService.updateStatus(a.id, r.user.id, DeliveryStatus.DELIVERED).catch(() => null);
    gate = null;

    await DeliveryAssignmentService.updateStatus(a.id, r.user.id, DeliveryStatus.DELIVERED);

    expect(await earnings(o.id)).toHaveLength(1);
    expect((await wallet(r.person.id)).walletBalance).toBe(FEE);
    expect((await wallet(r.person.id)).totalDeliveries).toBe(1);
  });

  /* ── Implementation C: admin guard ─────────────────────────────────────── */

  it("T10: admin cannot move an earned COMPLETED order back to OUT_FOR_DELIVERY", async () => {
    const r = await makeRider("t10");
    const o = await makeOrder("T10");
    await settleOrder(o.id, r.person.id, r.user.id);
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(OrderStatus.COMPLETED);

    const err = await adminUpdateOrderStatus(adminReq(o.id, "OUT_FOR_DELIVERY"), res).then(() => null).catch((e: any) => e);

    // Phase 3.2.15: the current policy is terminal-source immutability.
    // `adminUpdateOrderStatus` refuses a status change when the SOURCE order
    // is terminal (COMPLETED | CANCELLED | FAILED_DELIVERY | CANCELLED_UNPAID
    // | PAYMENT_EXPIRED) BEFORE the F4-4 delivery-earning barrier is
    // consulted, so the terminal guard is the response this override gets.
    //
    // The earning barrier itself is NOT dead coverage: it still governs a
    // non-terminal source order — see T14, which reopens an EARNED order
    // parked at OUT_FOR_DELIVERY (non-terminal) and is refused with the
    // earning message. This test now pins which guard answers first and that
    // the rejection is side-effect free.
    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/terminal state/i);
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(OrderStatus.COMPLETED);
    // Rejected before anything moved: the earning, its wallet credit and the
    // delivery assignment are exactly as they were.
    expect(await earnings(o.id)).toHaveLength(1);
    expect(await assignments(o.id)).toMatchObject([
      { deliveryPersonId: r.person.id, status: DeliveryStatus.DELIVERED },
    ]);
  });

  it("T11: no admin transition out of a terminal order bypasses the guard", async () => {
    const r = await makeRider("t11");
    const o = await makeOrder("T11");
    await settleOrder(o.id, r.person.id, r.user.id);

    // Both dispatchable targets and the non-dispatchable FAILED_DELIVERY are
    // refused, because the rule that binds here is the SOURCE being terminal,
    // not whether the target would be dispatchable. (Previously this test
    // expected COMPLETED -> FAILED_DELIVERY to be permitted; that expectation
    // predates terminal-source immutability and would silently drop the order
    // out of vendor payout candidacy, since payout eligibility requires
    // status COMPLETED.)
    for (const target of ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY", "FAILED_DELIVERY"]) {
      const err = await adminUpdateOrderStatus(adminReq(o.id, target), res).then(() => null).catch((e: any) => e);
      expect(err).toBeTruthy();
      expect(String(err.message)).toMatch(/terminal state/i);
      expect((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(OrderStatus.COMPLETED);
    }

    // Nothing financial moved across the three refused overrides.
    expect(await earnings(o.id)).toHaveLength(1);
    expect(await wallet(r.person.id)).toMatchObject({ totalDeliveries: 1 });
  });

  it("T12: admin operations on a non-terminal, unsettled order are unaffected", async () => {
    // Restructured (Phase 3.2.15): the original case drove this order to
    // COMPLETED — a TERMINAL status — and then expected an admin reopen. That
    // combination is exactly what the current policy forbids, so it could no
    // longer reach the behaviour it meant to cover. The intent ("ordinary
    // admin correction of a non-settled order still works") is preserved with a
    // genuinely non-terminal source order and no earning.
    const o = await makeOrder("T12", OrderStatus.COOKING);
    expect(await earnings(o.id)).toHaveLength(0);

    // No terminal source -> the override applies, and READY_FOR_PICKUP being
    // dispatchable is harmless precisely because no rider was ever paid.
    await adminUpdateOrderStatus(adminReq(o.id, "READY_FOR_PICKUP"), res);
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(OrderStatus.READY_FOR_PICKUP);

    // The barrier that guards THIS path is the earning barrier, not
    // terminality: it stays inert while no earning exists.
    expect(await earnings(o.id)).toHaveLength(0);
  });

  /* ── Concurrency ───────────────────────────────────────────────────────── */

  it("T13: two dispatch attempts cannot both claim an earned order", async () => {
    const r1 = await makeRider("t13a");
    const o = await makeOrder("T13");
    await settleOrder(o.id, r1.person.id, r1.user.id);
    await raw.order.update({ where: { id: o.id }, data: { status: OrderStatus.OUT_FOR_DELIVERY } });
    const r2 = await makeRider("t13b");
    const r3 = await makeRider("t13c");

    armBarrier(2, [{ model: "Order", op: "findUnique" }]);
    const [a, b] = await Promise.all([
      settle(DeliveryAssignmentService.assignOrder(o.id, r2.user.id)),
      settle(DeliveryAssignmentService.assignOrder(o.id, r3.user.id)),
    ]);
    gate = null;

    // Exactly one dispatch can ever win the Order row.
    expect([a, b].filter((x) => x.ok)).toHaveLength(0);
    const rows = await assignments(o.id);
    expect(rows.filter((x) => x.deliveryPersonId === r2.person.id || x.deliveryPersonId === r3.person.id)).toHaveLength(0);
    expect(await earnings(o.id)).toHaveLength(1);
  });

  it("T14: an admin reopen racing a dispatch cannot bypass the earning barrier", async () => {
    const r1 = await makeRider("t14a");
    const o = await makeOrder("T14");
    await settleOrder(o.id, r1.person.id, r1.user.id);
    await raw.order.update({ where: { id: o.id }, data: { status: OrderStatus.OUT_FOR_DELIVERY } });
    const r2 = await makeRider("t14b");

    // Park each transaction at the moment it WRITES the Order row: the admin
    // override writes with `update`, the dispatch claim with `updateMany`.
    // Parking happens before either executes, so neither holds the row lock
    // while waiting and the pair cannot deadlock.
    armBarrier(2, [{ model: "Order", op: "update" }, { model: "Order", op: "updateMany" }]);
    // Each leg is observed at the moment it is created. A peer parked on the
    // barrier must not be able to mask a real failure: if either leg rejects for
    // any reason other than the earning barrier this test expects, the test fails
    // immediately with that error instead of running into the Jest timeout.
    // `masked` never fulfils, so the normal path resolves exactly as before.
    const adminLeg = settle(adminUpdateOrderStatus(adminReq(o.id, "OUT_FOR_DELIVERY"), res));
    const dispatchLeg = settle(DeliveryAssignmentService.assignOrder(o.id, r2.user.id));
    const unexpected = (r: { ok: true; value: unknown } | { ok: false; error: unknown }) =>
      r.ok || /already been paid out to a rider/.test(String((r.error as Error | undefined)?.message ?? ""))
        ? null
        : r.error;
    let reportMasked: (error: unknown) => void = () => {};
    const masked = new Promise<never>((_resolve, reject) => { reportMasked = reject; });
    adminLeg.then((r) => { const e = unexpected(r); if (e) reportMasked(e); });
    dispatchLeg.then((r) => { const e = unexpected(r); if (e) reportMasked(e); });
    const [admin, dispatch] = await Promise.race([Promise.all([adminLeg, dispatchLeg]), masked]);
    gate = null;

    // Whichever order the two transactions take, the settled order never gains
    // a second rider: dispatch must lose on the earning barrier.
    expect(dispatch.ok).toBe(false);
    expect(String((dispatch as any).error.message)).toMatch(/already been paid out to a rider/);
    expect((await assignments(o.id)).filter((x) => x.deliveryPersonId === r2.person.id)).toHaveLength(0);
    expect(await earnings(o.id)).toHaveLength(1);
    expect(admin.ok === true || admin.ok === false).toBe(true);
  });

  it("T15: duplicate completion requests still create one earning and one wallet credit", async () => {
    const r = await makeRider("t15");
    const o = await makeOrder("T15");
    const a = await makeAssignment(o.id, r.person.id, DeliveryStatus.EN_ROUTE);

    armBarrier(2, PRE_LOCK);
    await Promise.all([
      settle(DeliveryAssignmentService.updateStatus(a.id, r.user.id, DeliveryStatus.DELIVERED)),
      settle(updateOrderStatus(customerReq(o.id), res)),
    ]);
    gate = null;

    expect(await earnings(o.id)).toHaveLength(1);
    expect((await wallet(r.person.id)).walletBalance).toBe(FEE);
    expect((await wallet(r.person.id)).totalDeliveries).toBe(1);
  });
});
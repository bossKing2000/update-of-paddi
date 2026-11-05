/**
 * Stage N-05B: a driver may only be assigned to an order that is legally
 * dispatchable and paid.
 *
 * Before this change `DeliveryAssignmentService.assignOrder` validated only
 * that the order and its vendor existed. Nothing looked at `Order.status` or
 * `Order.paymentStatus`, so a vendor (or the retry paths) could dispatch a
 * driver for an order in AWAITING_PAYMENT, CANCELLED, CANCELLED_UNPAID,
 * PAYMENT_EXPIRED, COMPLETED or FAILED_DELIVERY — creating a delivery, driver
 * notifications and (via N-05A's mirror) order-status writes on orders that
 * were never going to be delivered.
 *
 * These are runtime tests against the real service with mocked Prisma only.
 */
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { DeliveryAssignmentController } from "../../src/controllers/deliveryControllers";
import prisma from "../../src/lib/prisma";
import { recordActivityBundle } from "../../src/utils/activityUtils/recordActivityBundle";
import { ConflictError, ForbiddenError } from "../../src/errors/AppError";
import type { AuthRequest } from "../../src/middlewares/auth.middleware";
import type { Response } from "express";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), updateMany: jest.fn() },
    address: { findFirst: jest.fn() },
    deliveryPerson: { findMany: jest.fn(), findUnique: jest.fn() },
    // F4-4: the dispatch barrier reads DeliveryEarning and checks for an
    // existing DELIVERED assignment.
    deliveryEarning: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({ id: "de-1" })) },
    deliveryAssignment: { count: jest.fn(), groupBy: jest.fn(), create: jest.fn(), findFirst: jest.fn(async () => null) },
    deliveryBroadcast: { count: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../../src/socket", () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

const db = prisma as unknown as {
  order: { findUnique: jest.Mock; updateMany: jest.Mock };
  address: { findFirst: jest.Mock };
  deliveryPerson: { findMany: jest.Mock; findUnique: jest.Mock };
  deliveryAssignment: { count: jest.Mock; groupBy: jest.Mock; create: jest.Mock; findFirst: jest.Mock };
  deliveryBroadcast: { count: jest.Mock; create: jest.Mock };
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
};

const activity = recordActivityBundle as unknown as jest.Mock;

const ORDER_ID = "o-1";
const VENDOR_ID = "v-1";
const DELIVERY_PERSON = "dp-1";
const DRIVER_USER = "u-driver";

const DRIVERS = [
  { id: DELIVERY_PERSON, userId: DRIVER_USER, latitude: 6.52, longitude: 3.37, user: { name: "Dee", email: "dee@x.com" } },
];

/**
 * Task 5: the manual path now re-reads the driver row under the
 * DeliveryPerson FOR UPDATE lock and re-asserts eligibility. The candidate
 * `findMany` above selects only id/userId/coordinates, so it never carried the
 * eligibility columns; the re-read does, and this fixture models what the real
 * `findUnique` returns. Tests that need an ineligible driver override it.
 */
const ELIGIBLE_DRIVER_ROW = {
  ...DRIVERS[0],
  isOnline: true,
  status: "ACTIVE",
  user: { ...DRIVERS[0].user, isEmailVerified: true },
};

/** The order as the service/see it. Mutated per-test. */
let currentOrder: Record<string, unknown>;
/** Rows the guard sees when asking "does this order already have a live dispatch?". */
let liveAssignments: number;
let liveBroadcasts: number;

function order(over: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    vendorId: VENDOR_ID,
    customerId: "c-1",
    status: "READY_FOR_PICKUP",
    paymentStatus: "SUCCESS",
    vendor: { id: VENDOR_ID },
    ...over,
  };
}

const assignManually = () => DeliveryAssignmentService.assignOrder(ORDER_ID, DRIVER_USER);
const assignAutomatically = () => DeliveryAssignmentService.assignOrder(ORDER_ID);

/** The predicate the transactional claim must carry. */
function claimCall() {
  return db.order.updateMany.mock.calls[0][0];
}
/** No assignment/broadcast row was written — regardless of how far we got. */
function noDispatchRow() {
  expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
  expect(db.deliveryBroadcast.create).not.toHaveBeenCalled();
}
/** Rejected before the transactional claim was even attempted. */
function nothingDispatched() {
  noDispatchRow();
  expect(db.order.updateMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();

  currentOrder = order();
  liveAssignments = 0;
  liveBroadcasts = 0;

  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );

  // The controller reads only { vendorId }; the service reads the full order.
  db.order.findUnique.mockImplementation(async (args: any) =>
    args?.select ? { vendorId: currentOrder.vendorId } : { ...currentOrder },
  );
  db.order.updateMany.mockResolvedValue({ count: 1 });

  db.address.findFirst.mockResolvedValue({ latitude: 6.5, longitude: 3.3 });
  db.deliveryPerson.findMany.mockResolvedValue(DRIVERS);
  db.deliveryPerson.findUnique.mockResolvedValue(ELIGIBLE_DRIVER_ROW);

  // `count` serves the per-order live-dispatch guard (keyed by orderId).
  db.deliveryAssignment.count.mockImplementation(async (args: any) =>
    args?.where?.orderId ? liveAssignments : 0,
  );
  // Capacity for every candidate now comes from ONE grouped query. No driver in
  // this file is at capacity, so the grouped result is empty — which means
  // "zero active assignments" for each candidate, matching the old per-driver
  // `count` returning 0.
  db.deliveryAssignment.groupBy.mockResolvedValue([]);
  db.deliveryBroadcast.count.mockImplementation(async () => liveBroadcasts);

  db.deliveryAssignment.create.mockImplementation(async ({ data }: any) => ({
    id: "as-1",
    status: "ASSIGNED",
    timeoutSeconds: 30,
    ...data,
  }));
  db.deliveryBroadcast.create.mockImplementation(async ({ data }: any) => ({ id: "bc-1", ...data }));

  // F5-B: driver-row lock via $queryRaw FOR UPDATE
  db.$queryRaw.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
describe("N-05B — valid dispatchable paid order", () => {
  it("1. READY_FOR_PICKUP + SUCCESS: manual assignment is created", async () => {
    const result = await assignManually();

    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
    expect(db.deliveryAssignment.create.mock.calls[0][0].data).toMatchObject({
      orderId: ORDER_ID,
      deliveryPersonId: DELIVERY_PERSON,
    });
    expect(result).toMatchObject({ id: "as-1", orderId: ORDER_ID, deliveryPersonId: DELIVERY_PERSON });
    // Drivers were still screened for online/ACTIVE/verified availability.
    expect(db.deliveryPerson.findMany.mock.calls[0][0].where).toMatchObject({ isOnline: true });
    // Existing behaviour preserved: activity + push notification recorded.
    expect(activity).toHaveBeenCalledTimes(1);
    expect(activity.mock.calls[0][0].audit.action).toBe("DELIVERY_ASSIGNED_MANUAL");
  });

  it("1b. the claim re-validates the full dispatch predicate inside the transaction", async () => {
    await assignManually();

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(claimCall().where).toEqual({
      id: ORDER_ID,
      status: { in: ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"] },
      paymentStatus: "SUCCESS",
    });
  });

  it("1c. auto mode still broadcasts to the nearest drivers", async () => {
    const result = await assignAutomatically();

    expect(db.deliveryBroadcast.create).toHaveBeenCalledTimes(1);
    expect(db.deliveryBroadcast.create.mock.calls[0][0].data).toMatchObject({
      orderId: ORDER_ID,
      driverIds: [DRIVER_USER],
      status: "PENDING",
    });
    expect(result).toMatchObject({ success: true });
    expect(activity.mock.calls[0][0].audit.action).toBe("DELIVERY_BROADCAST_INITIATED");
  });

  it("1d. OUT_FOR_DELIVERY is still dispatchable (vendor already handed the order over)", async () => {
    currentOrder = order({ status: "OUT_FOR_DELIVERY" });
    await expect(assignManually()).resolves.toMatchObject({ id: "as-1" });
    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
  });

  it("1e. reassignment after a DECLINED assignment still works", async () => {
    // handleDecline marks the previous assignment DECLINED before re-entering
    // assignOrder — a declined row must not block the retry.
    liveAssignments = 0;
    await expect(assignAutomatically()).resolves.toMatchObject({ success: true });
    expect(db.deliveryBroadcast.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("N-05B — payment gate", () => {
  it.each([
    ["AWAITING_PAYMENT", "PENDING"],
    ["PENDING", "PENDING"],
  ])("2. unpaid order %s/%s is never dispatched", async (status, paymentStatus) => {
    currentOrder = order({ status, paymentStatus });

    await expect(assignManually()).rejects.toBeInstanceOf(ConflictError);
    nothingDispatched();
  });

  it("2b. READY_FOR_PICKUP but unpaid is rejected on payment, not state", async () => {
    currentOrder = order({ status: "READY_FOR_PICKUP", paymentStatus: "PENDING" });

    const err = await assignAutomatically().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toMatch(/must be paid/);
    nothingDispatched();
  });

  it.each(["EXPIRED", "FAILED", "LATE_PAYMENT", "AMOUNT_MISMATCH", "REFUNDED", null])(
    "2c. paymentStatus %s is not SUCCESS and is rejected",
    async (paymentStatus) => {
      currentOrder = order({ paymentStatus });

      await expect(assignManually()).rejects.toThrow(/must be paid/);
      nothingDispatched();
    },
  );
});

// ---------------------------------------------------------------------------
describe("N-05B — terminal / non-dispatchable states", () => {
  it.each([
    ["CANCELLED", "SUCCESS"],
    ["CANCELLED_UNPAID", "EXPIRED"],
    ["PAYMENT_EXPIRED", "EXPIRED"],
    ["COMPLETED", "SUCCESS"],
  ])("3. %s is never dispatched", async (status, paymentStatus) => {
    currentOrder = order({ status, paymentStatus });

    const err = await assignManually().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as ConflictError).message).toContain(status);
    nothingDispatched();
  });

  it.each([
    ["FAILED_DELIVERY", "SUCCESS"],
    ["COOKING", "SUCCESS"],
    ["PAYMENT_CONFIRMED", "SUCCESS"],
    ["WAITING_VENDOR_CONFIRMATION", "SUCCESS"],
    ["WAITING_CUSTOMER_APPROVAL", "SUCCESS"],
  ])("4. non-dispatchable state %s is rejected", async (status, paymentStatus) => {
    currentOrder = order({ status, paymentStatus });

    await expect(assignAutomatically()).rejects.toBeInstanceOf(ConflictError);
    nothingDispatched();
  });

  it("4b. a CANCELLED order is rejected in auto mode too (no broadcast)", async () => {
    currentOrder = order({ status: "CANCELLED", paymentStatus: "SUCCESS" });
    await expect(assignAutomatically()).rejects.toBeInstanceOf(ConflictError);
    nothingDispatched();
  });
});

// ---------------------------------------------------------------------------
describe("N-05B — authorization must not be weakened", () => {
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() }) as unknown as Response;

  it("8. a vendor cannot assign a driver to another vendor's order", async () => {
    currentOrder = order({ vendorId: "v-other" });
    const req = {
      body: { orderId: ORDER_ID, driverId: DRIVER_USER },
      user: { id: VENDOR_ID, role: "VENDOR" },
    } as unknown as AuthRequest;

    await expect(DeliveryAssignmentController.assignOrder(req, res())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // The service was never reached.
    nothingDispatched();
    expect(db.order.findUnique).toHaveBeenCalledTimes(1);
  });

  it("8b. the owning vendor is still allowed through to the service", async () => {
    const req = {
      body: { orderId: ORDER_ID, driverId: DRIVER_USER },
      user: { id: VENDOR_ID, role: "VENDOR" },
    } as unknown as AuthRequest;

    await DeliveryAssignmentController.assignOrder(req, res());

    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
  });

  it("8c. a driver still cannot self-assign, even to a dispatchable order", async () => {
    const req = {
      body: { orderId: ORDER_ID, driverId: DRIVER_USER },
      user: { id: DRIVER_USER, role: "DELIVERY" },
    } as unknown as AuthRequest;

    await expect(DeliveryAssignmentController.assignOrder(req, res())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    nothingDispatched();
  });
});

// ---------------------------------------------------------------------------
describe("N-05B — driver availability protection is intact", () => {
  it("9a. no online drivers -> rejected, nothing dispatched", async () => {
    db.deliveryPerson.findMany.mockResolvedValue([]);

    await expect(assignManually()).rejects.toThrow(/No available drivers/);
    nothingDispatched();
  });

  it("9b. driver is not among the available ones -> rejected", async () => {
    await expect(DeliveryAssignmentService.assignOrder(ORDER_ID, "u-stranger")).rejects.toThrow(
      /Selected driver unavailable/,
    );
    nothingDispatched();
  });

  it("9c. driver at the stacking cap -> rejected", async () => {
    db.deliveryAssignment.count.mockResolvedValue(3); // >= MAX_STACK

    await expect(assignManually()).rejects.toThrow(/exceeds stacking limit/);
    nothingDispatched();
  });
});

// ---------------------------------------------------------------------------
describe("N-05B — races are resolved at the create, not at the pre-read", () => {
  it("10. order cancelled between the read and the create -> CAS loses, nothing dispatched", async () => {
    // Pre-read saw a healthy READY_FOR_PICKUP order; the claim matched no row
    // because a concurrent cancellation/expiry committed first.
    db.order.updateMany.mockResolvedValue({ count: 0 });

    const err = await assignManually().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as ConflictError).message).toMatch(/no longer dispatchable/);
    noDispatchRow();
    // No driver was notified either.
    expect(activity).not.toHaveBeenCalled();
  });

  it("11. payment state changed between the read and the create -> CAS loses", async () => {
    currentOrder = order({ paymentStatus: "SUCCESS" });
    // Payment expired / was refunded while the assignment was being prepared.
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(assignAutomatically()).rejects.toBeInstanceOf(ConflictError);
    noDispatchRow();
    expect(db.deliveryBroadcast.create).not.toHaveBeenCalled();
  });

  it("12. an order that already has an active assignment is not dispatched again", async () => {
    liveAssignments = 1; // ASSIGNED / ACCEPTED / PICKED_UP / EN_ROUTE

    await expect(assignManually()).rejects.toThrow(/already has an active delivery assignment/);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
  });

  it("12b. a live broadcast for the same order blocks a duplicate offer", async () => {
    liveBroadcasts = 1;

    await expect(assignAutomatically()).rejects.toThrow(/delivery request for this order is already open/);
    expect(db.deliveryBroadcast.create).not.toHaveBeenCalled();
  });
});
// ---------------------------------------------------------------------------
// Task 5 — the manual-assignment / rider-suspension TOCTOU.
//
// Before this task the candidate list (`:979-982`) was read on the GLOBAL
// client, OUTSIDE the transaction, and the F5-B `FOR UPDATE` on the
// DeliveryPerson row only ever re-checked CAPACITY. A suspension committed in
// that window produced an assignment for an ineligible rider.
//
// LIMITATION, stated up front: this suite's `$transaction` mock hands the
// callback the SAME object as the global client (`arg(db)`), so it cannot
// distinguish the transaction client from the global one. These tests establish
// WHICH READ RUNS AND IN WHICH ORDER, and that nothing is written on refusal.
// They do NOT prove PostgreSQL row-lock conflict, transaction visibility, or
// any real concurrency behaviour.
// ---------------------------------------------------------------------------
describe("Task 5: manual assignment re-asserts eligibility under the driver lock", () => {
  it("reads the driver row again after the FOR UPDATE lock", async () => {
    await assignManually();
    const reads = db.deliveryPerson.findUnique.mock.calls.filter(
      (c: unknown[]) => (c[0] as { where: { id?: string; userId?: string } })?.where !== undefined,
    );
    expect(reads.length).toBeGreaterThanOrEqual(1);
    // The re-read is keyed by the locked row's own id, so it is provably the
    // row this transaction holds the lock on.
    expect(db.deliveryPerson.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DELIVERY_PERSON },
        include: { user: { select: { isEmailVerified: true } } },
      }),
    );
  });

  it("takes the driver-row FOR UPDATE lock BEFORE the eligibility re-read", async () => {
    const order: string[] = [];
    let reads = 0;
    const origQuery = db.$queryRaw.getMockImplementation();
    db.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      order.push("lock");
      return origQuery ? origQuery(...(args as [])) : undefined;
    });
    const origFind = db.deliveryPerson.findUnique.getMockImplementation();
    db.deliveryPerson.findUnique.mockImplementation(async (args: any) => {
      reads += 1;
      order.push("reread");
      return origFind ? origFind(args) : ({} as never);
    });

    await assignManually();

    expect(order.indexOf("lock")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("lock")).toBeLessThan(order.indexOf("reread"));
  });

  it("refuses when the rider is suspended between the candidate read and the lock", async () => {
    db.deliveryPerson.findUnique.mockResolvedValue({
      ...ELIGIBLE_DRIVER_ROW,
      status: "SUSPENDED",
    });

    await expect(assignManually()).rejects.toThrow(/Selected driver unavailable/);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });

  it.each([
    ["INACTIVE", { status: "INACTIVE" }],
    ["offline", { isOnline: false }],
    ["email unverified", { user: { ...ELIGIBLE_DRIVER_ROW.user, isEmailVerified: false } }],
  ])("refuses a rider that is %s under the lock", async (_label, over) => {
    db.deliveryPerson.findUnique.mockResolvedValue({ ...ELIGIBLE_DRIVER_ROW, ...over });

    await expect(assignManually()).rejects.toThrow(/Selected driver unavailable/);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });

  it("refuses (fail closed) if the rider row disappeared before the re-read", async () => {
    db.deliveryPerson.findUnique.mockResolvedValue(null);

    await expect(assignManually()).rejects.toThrow(/Selected driver unavailable/);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
  });

  it("uses ConflictError, preserving the established error contract", async () => {
    db.deliveryPerson.findUnique.mockResolvedValue({ ...ELIGIBLE_DRIVER_ROW, status: "SUSPENDED" });
    await expect(assignManually()).rejects.toBeInstanceOf(ConflictError);
  });

  it("the happy path still creates exactly one assignment", async () => {
    const assignment = await assignManually();
    expect(assignment).toMatchObject({ orderId: ORDER_ID, deliveryPersonId: DELIVERY_PERSON });
    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
  });

  it("capacity is still enforced under the lock", async () => {
    db.deliveryAssignment.count.mockResolvedValue(3); // >= MAX_STACK
    await expect(assignManually()).rejects.toThrow(/exceeds stacking limit/);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
  });
});

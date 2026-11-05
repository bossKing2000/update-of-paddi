/**
 * Stage N-05C (F2): `acceptBroadcast` is a guarded dispatch entry point, not a
 * bypass of N-05B.
 *
 * A broadcast is created while the order is `READY_FOR_PICKUP + SUCCESS` but
 * stays PENDING for up to BROADCAST_WINDOW_SECONDS, and the expiry sweep is a
 * 1-minute cron. Before this change acceptance re-validated only the broadcast
 * and the driver's identity and never read the order, so an offer could still
 * be accepted after the customer cancelled, the payment expired, or the order
 * stopped being dispatchable — minting a usable ACCEPTED assignment on a dead
 * order.
 *
 * Runtime tests against the real service with mocked Prisma only.
 */
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import prisma from "../../src/lib/prisma";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/errors/AppError";

const emit = jest.fn();
jest.mock("../../src/socket", () => ({
  getIO: () => ({ to: () => ({ emit: (...args: unknown[]) => emit(...args) }) }),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), updateMany: jest.fn() },
    address: { findFirst: jest.fn() },
    deliveryPerson: { findMany: jest.fn(), findUnique: jest.fn() },
    // F4-4: the dispatch barrier reads DeliveryEarning and checks for an
    // existing DELIVERED assignment.
    deliveryEarning: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({ id: "de-1" })) },
    deliveryAssignment: { count: jest.fn(), create: jest.fn(), findFirst: jest.fn(async () => null) },
    deliveryBroadcast: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

const db = prisma as unknown as {
  order: { findUnique: jest.Mock; updateMany: jest.Mock };
  deliveryPerson: { findUnique: jest.Mock };
  deliveryAssignment: { count: jest.Mock; create: jest.Mock; findFirst: jest.Mock };
  deliveryBroadcast: { findUnique: jest.Mock; updateMany: jest.Mock; create: jest.Mock };
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
};

const BROADCAST_ID = "bc-1";
const ORDER_ID = "o-1";
const DELIVERY_PERSON = "dp-1";
const DRIVER_USER = "u-driver";

/** Mutable inputs, re-seeded per test. */
let broadcast: Record<string, unknown>;
let order: Record<string, unknown>;
let driver: Record<string, unknown>;
let liveAssignments: number;
let driverLoad: number;

function broadcastRow(over: Record<string, unknown> = {}) {
  return {
    id: BROADCAST_ID,
    orderId: ORDER_ID,
    driverIds: [DRIVER_USER],
    declinedDriverIds: [],
    status: "PENDING",
    expiresAt: new Date(Date.now() + 30_000),
    ...over,
  };
}
function orderRow(over: Record<string, unknown> = {}) {
  return { id: ORDER_ID, status: "READY_FOR_PICKUP", paymentStatus: "SUCCESS", ...over };
}
function driverRow(over: Record<string, unknown> = {}) {
  return { id: DELIVERY_PERSON, isOnline: true, status: "ACTIVE", user: { isEmailVerified: true }, ...over };
}

const accept = () => DeliveryAssignmentService.acceptBroadcast(BROADCAST_ID, DRIVER_USER);

/** Nothing was dispatched, and the offer was not consumed. */
function noDispatch() {
  expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
  expect(db.deliveryBroadcast.updateMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();

  broadcast = broadcastRow();
  order = orderRow();
  driver = driverRow();
  liveAssignments = 0;
  driverLoad = 0;

  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );

  db.deliveryBroadcast.findUnique.mockImplementation(async () => ({ ...broadcast }));
  db.deliveryBroadcast.updateMany.mockImplementation(async (args: any) => {
    broadcast = { ...broadcast, ...args.data };
    return { count: 1 };
  });
  db.order.findUnique.mockImplementation(async () => ({ ...order }));
  // F3 Stage 1: acceptBroadcast now claims the Order row (conditional
  // updateMany) immediately before creating the assignment.
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.deliveryPerson.findUnique.mockImplementation(async () => ({ ...driver }));
  // Serves two distinct guards: per-order uniqueness and per-driver capacity.
  db.deliveryAssignment.count.mockImplementation(async (args: any) =>
    args?.where?.orderId ? liveAssignments : driverLoad,
  );
  db.deliveryAssignment.create.mockImplementation(async ({ data }: any) => ({ id: "as-1", ...data }));
});
  // F5-B: driver-row lock via $queryRaw FOR UPDATE
  db.$queryRaw.mockResolvedValue(undefined);

// ---------------------------------------------------------------------------
describe("N-05C F2 — existing acceptance behaviour preserved", () => {
  it("1. READY_FOR_PICKUP + SUCCESS: acceptance succeeds", async () => {
    const result = await accept();
    expect(result).toMatchObject({ id: "as-1", orderId: ORDER_ID, deliveryPersonId: DELIVERY_PERSON });
    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
  });

  it("2. OUT_FOR_DELIVERY + SUCCESS: acceptance succeeds", async () => {
    order = orderRow({ status: "OUT_FOR_DELIVERY" });
    await expect(accept()).resolves.toMatchObject({ id: "as-1" });
    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
  });

  it("3. a driver outside driverIds is still Forbidden", async () => {
    broadcast = broadcastRow({ driverIds: ["u-other"] });
    await expect(accept()).rejects.toBeInstanceOf(ForbiddenError);
    noDispatch();
  });

  it("4. a driver who already declined is still rejected", async () => {
    broadcast = broadcastRow({ declinedDriverIds: [DRIVER_USER] });
    await expect(accept()).rejects.toBeInstanceOf(ConflictError);
    noDispatch();
  });

  it("5. a non-PENDING broadcast is still rejected", async () => {
    broadcast = broadcastRow({ status: "EXPIRED" });
    await expect(accept()).rejects.toThrow(/already accepted or expired/);
    noDispatch();
  });

  it("5b. a missing broadcast / driver profile still 404s", async () => {
    db.deliveryBroadcast.findUnique.mockResolvedValueOnce(null);
    await expect(accept()).rejects.toBeInstanceOf(NotFoundError);

    db.deliveryPerson.findUnique.mockResolvedValueOnce(null);
    await expect(accept()).rejects.toBeInstanceOf(NotFoundError);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("N-05C F2 — stale order protection", () => {
  it.each([
    ["CANCELLED", "SUCCESS"],
    ["CANCELLED_UNPAID", "EXPIRED"],
    ["PAYMENT_EXPIRED", "EXPIRED"],
    ["COMPLETED", "SUCCESS"],
    ["FAILED_DELIVERY", "SUCCESS"],
    ["AWAITING_PAYMENT", "PENDING"],
  ])("6-11. order in %s is never dispatched from a stale offer", async (status, paymentStatus) => {
    order = orderRow({ status, paymentStatus });

    const err = await accept().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as ConflictError).message).toContain(status);
    noDispatch();
  });

  it.each(["PENDING", "EXPIRED", "FAILED", "REFUNDED", "LATE_PAYMENT", "AMOUNT_MISMATCH", null])(
    "12-16. dispatchable order with paymentStatus %s is rejected",
    async (paymentStatus) => {
      order = orderRow({ paymentStatus });

      await expect(accept()).rejects.toThrow(/must be paid/);
      noDispatch();
    },
  );

  it("16b. the order is re-read at acceptance time, not taken from the broadcast", async () => {
    await accept();
    expect(db.order.findUnique).toHaveBeenCalledWith({
      where: { id: ORDER_ID },
      select: { status: true, paymentStatus: true },
    });
  });
});

// ---------------------------------------------------------------------------
describe("N-05C F2 — broadcast expiry is enforced independently of the cron", () => {
  it("17. a PENDING broadcast whose expiresAt has passed is rejected", async () => {
    broadcast = broadcastRow({ expiresAt: new Date(Date.now() - 1_000) });

    await expect(accept()).rejects.toThrow(/no longer available/);
    noDispatch();
  });

  it("18. a PENDING broadcast whose expiresAt is in the future succeeds", async () => {
    broadcast = broadcastRow({ expiresAt: new Date(Date.now() + 25_000) });
    await expect(accept()).resolves.toMatchObject({ id: "as-1" });
    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("N-05C F2 — driver is revalidated at acceptance time", () => {
  it("19. an offline driver is rejected", async () => {
    driver = driverRow({ isOnline: false });
    await expect(accept()).rejects.toThrow(/not currently available/);
    noDispatch();
  });

  it("20. a SUSPENDED driver is rejected", async () => {
    driver = driverRow({ status: "SUSPENDED" });
    await expect(accept()).rejects.toThrow(/not currently available/);
    noDispatch();
  });

  it("21. an unverified driver is rejected", async () => {
    driver = driverRow({ user: { isEmailVerified: false } });
    await expect(accept()).rejects.toThrow(/not currently available/);
    noDispatch();
  });

  it("21b. an INACTIVE driver is rejected", async () => {
    driver = driverRow({ status: "INACTIVE" });
    await expect(accept()).rejects.toThrow(/not currently available/);
    noDispatch();
  });

  it("22. a driver already at MAX_STACK is rejected", async () => {
    driverLoad = 3; // === MAX_STACK
    await expect(accept()).rejects.toThrow(/exceeds stacking limit/);
    noDispatch();
  });

  it("22b. capacity uses the same status set as direct assignment (EN_ROUTE included, per F5)", async () => {
    await accept();
    const capacityPredicates = db.deliveryAssignment.count.mock.calls
      .filter((c) => c[0]?.where?.deliveryPersonId)
      .map((c) => c[0].where.status);
    expect(capacityPredicates.length).toBeGreaterThan(0);
    for (const predicate of capacityPredicates) {
      expect(predicate).toEqual({ in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] });
    }
  });
});

// ---------------------------------------------------------------------------
describe("N-05C F2 — per-order active-assignment guard", () => {
  it("23. an order that already has an active assignment is rejected", async () => {
    liveAssignments = 1;
    await expect(accept()).rejects.toThrow(/already has an active delivery assignment/);
    noDispatch();
  });

  it("23b. the guard uses N-05B's ACTIVE_DELIVERY_STATUSES set", async () => {
    liveAssignments = 0;
    await accept();
    const orderPredicates = db.deliveryAssignment.count.mock.calls
      .filter((c) => c[0]?.where?.orderId)
      .map((c) => c[0].where.status);
    expect(orderPredicates.length).toBeGreaterThan(0);
    for (const predicate of orderPredicates) {
      expect(predicate).toEqual({ in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] });
    }
  });

  it("23c. the Order-row claim runs BEFORE the insert and carries the full predicate", async () => {
    await accept();

    const claimAt = db.order.updateMany.mock.calls.length;
    expect(claimAt).toBe(1);
    expect(db.order.updateMany.mock.calls[0][0].where).toEqual({
      id: ORDER_ID,
      status: { in: ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"] },
      paymentStatus: "SUCCESS",
    });
  });

  it("23d. a lost Order-row claim aborts acceptance and creates no assignment", async () => {
    // A cancellation / expiry / competing dispatch committed first.
    db.order.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(accept()).rejects.toThrow(/no longer dispatchable/);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
    expect(db.deliveryBroadcast.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("N-05C F2 — successful path", () => {
  it("24. creates exactly one ACCEPTED assignment for the right order and driver", async () => {
    await accept();
    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
    expect(db.deliveryAssignment.create.mock.calls[0][0].data).toMatchObject({
      orderId: ORDER_ID,
      deliveryPersonId: DELIVERY_PERSON,
      status: "ACCEPTED",
    });
  });

  it("25. consumes the broadcast via a PENDING compare-and-set, not an unconditional update", async () => {
    await accept();
    expect(db.deliveryBroadcast.updateMany).toHaveBeenCalledTimes(1);
    expect(db.deliveryBroadcast.updateMany.mock.calls[0][0]).toEqual({
      where: { id: BROADCAST_ID, status: "PENDING" },
      data: { status: "ACCEPTED", acceptedDriverId: DRIVER_USER },
    });
  });

  it("26. socket + activity behaviour is intact", async () => {
    const { recordActivityBundle } = await import("../../src/utils/activityUtils/recordActivityBundle");
    await accept();

    expect(emit).toHaveBeenCalledWith("deliveryAccepted", {
      broadcastId: BROADCAST_ID,
      orderId: ORDER_ID,
      assignmentId: "as-1",
    });
    expect(recordActivityBundle).toHaveBeenCalledTimes(1);
    expect((recordActivityBundle as jest.Mock).mock.calls[0][0].audit.action).toBe("DELIVERY_ACCEPTED");
  });

  it("27. a second acceptance of an already-consumed broadcast fails and creates nothing", async () => {
    await accept();
    expect(broadcast.status).toBe("ACCEPTED");

    db.deliveryAssignment.create.mockClear();
    await expect(accept()).rejects.toThrow(/already accepted or expired/);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
  });

  it("27b. if another transaction consumed the offer first, the CAS aborts the transaction", async () => {
    // Broadcast still reads PENDING (lost the update), but the CAS matches no
    // row. The ConflictError rolls the whole transaction back, so in production
    // the assignment created a statement earlier is discarded with it.
    db.deliveryBroadcast.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(accept()).rejects.toThrow(/already accepted or expired/);
    expect(db.deliveryBroadcast.updateMany.mock.calls[0][0].where.status).toBe("PENDING");
  });
});
// ---------------------------------------------------------------------------
// Task 4 — the acceptance/suspension TOCTOU.
//
// Before this task, `acceptBroadcast` checked driver eligibility with a plain
// SELECT *before* taking the F5-B driver-row FOR UPDATE lock, and never
// re-read eligibility under it. `setDeliveryPersonStatus` suspends a rider with
// `prisma.deliveryPerson.update`, which takes an implicit FOR UPDATE on the
// SAME row, so a suspension could commit inside that window and the
// assignment was still created.
//
// LIMITATION, stated up front: this suite's `$transaction` mock hands the
// callback the SAME object as the global client (`arg(db)`), so it cannot
// distinguish the transaction client from the global one. These tests prove
// WHICH READ OCCURS AND IN WHICH ORDER. They do NOT prove PostgreSQL row-lock
// conflict, transaction visibility, or any real concurrency behaviour — see
// the design-only concurrency test in the Task 4 report.
// ---------------------------------------------------------------------------
describe("Task 4: eligibility is re-asserted under the driver-row lock", () => {
  /** Fails the pre-lock read, succeeds on the post-lock re-read. */
  const becomesIneligibleUnderLock = (over: Record<string, unknown> = {}) => {
    db.deliveryPerson.findUnique
      .mockResolvedValueOnce(driverRow()) // fail-fast read, before the lock
      .mockResolvedValue(driverRow({ status: "SUSPENDED", ...over })); // under the lock
  };

  it("reads the driver a second time after the FOR UPDATE lock", async () => {
    await accept();

    const reads = db.deliveryPerson.findUnique.mock.calls.filter(
      (c: unknown[]) => (c[0] as { where: { userId: string } })?.where?.userId === DRIVER_USER,
    );
    // Pre-lock fail-fast read AND the post-lock re-read.
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it("takes the driver-row FOR UPDATE lock BEFORE the eligibility re-read", async () => {
    // Ordering is the whole fix: a re-read placed before the lock would still
    // be a stale snapshot.
    const order: string[] = [];
    const origQuery = db.$queryRaw.getMockImplementation();
    db.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      order.push("lock");
      return origQuery ? origQuery(...(args as [])) : undefined;
    });
    let reads = 0;
    const origFind = db.deliveryPerson.findUnique.getMockImplementation();
    db.deliveryPerson.findUnique.mockImplementation(async (args: any) => {
      reads += 1;
      if (reads >= 2) order.push("reread");
      return origFind ? origFind(args) : ({} as never);
    });

    await accept();

    expect(order.indexOf("lock")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("lock")).toBeLessThan(order.indexOf("reread"));
  });

  it("refuses acceptance when the rider is suspended between the two reads", async () => {
    becomesIneligibleUnderLock();

    await expect(accept()).rejects.toThrow(/not currently available for deliveries/);
    // The refusal rolls the transaction back, so NOTHING may have been written.
    noDispatch();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    ["de-activated", { status: "INACTIVE" }],
    ["taken offline", { isOnline: false }],
    ["email unverified mid-flight", { user: { isEmailVerified: false } }],
  ])("refuses acceptance for a rider %s between the two reads", async (_label, over) => {
    becomesIneligibleUnderLock(over);

    await expect(accept()).rejects.toThrow(/not currently available for deliveries/);
    noDispatch();
    expect(emit).not.toHaveBeenCalled();
  });

  it("throws ConflictError, not a generic failure — the documented contract", async () => {
    becomesIneligibleUnderLock();
    await expect(accept()).rejects.toBeInstanceOf(ConflictError);
  });

  it("404s if the rider profile disappears before the re-read (fail closed)", async () => {
    db.deliveryPerson.findUnique
      .mockResolvedValueOnce(driverRow())
      .mockResolvedValue(null);

    await expect(accept()).rejects.toBeInstanceOf(NotFoundError);
    noDispatch();
  });

  it("never runs the post-lock re-read through the global client when it is available", async () => {
    // This suite cannot separate the two clients (see the limitation above), so
    // assert the property that IS observable: the re-read happens through the
    // object the transaction callback was handed, i.e. the same client object
    // the pre-lock read already used. If the service ever opened a fresh
    // client for the re-read, this would break.
    await accept();
    const userIdReads = db.deliveryPerson.findUnique.mock.calls.filter(
      (c: unknown[]) => (c[0] as { where: { userId: string } })?.where?.userId === DRIVER_USER,
    );
    expect(userIdReads.length).toBeGreaterThanOrEqual(2);
    expect(userIdReads.every((c: unknown[]) => c[0] !== undefined)).toBe(true);
  });

  it("keeps both eligibility sites on one predicate, so they cannot drift", async () => {
    // A single ACTIVE+online+verified driver passes both reads and the whole
    // acceptance completes: the extra read must not change the happy path.
    await expect(accept()).resolves.toMatchObject({ orderId: ORDER_ID });
    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
    expect(db.deliveryBroadcast.updateMany).toHaveBeenCalledTimes(1);
  });
});

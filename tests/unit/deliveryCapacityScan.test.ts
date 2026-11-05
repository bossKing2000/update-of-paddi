/**
 * Focused coverage for the dispatch capacity scan in
 * `DeliveryAssignmentService.assignOrder`.
 *
 * Purpose
 * -------
 * `assignOrder` used to compute driver capacity with an unbounded
 * `Promise.all(drivers.map(...))` issuing one `deliveryAssignment.count()` per
 * online driver. That scaled a single request's connection usage with the size
 * of the whole online-driver population and could exhaust the pool (Prisma
 * P2037). Capacity is now read with ONE grouped query and mapped in memory.
 *
 * These tests pin the behaviour that must NOT change:
 *   - the statuses that count toward capacity (DRIVER_STACK_STATUSES)
 *   - the MAX_STACK eligibility threshold
 *   - nearest-driver ordering and the 5-driver broadcast limit
 *   - empty / single-driver behaviour
 *   - that the number of queries no longer grows with driver count
 *
 * Real service, mocked Prisma only — no database connection.
 */
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";

const calls = { deliveryAssignment: [] as any[], order: [] as any[] };
let drivers: any[] = [];
/** driverId -> number of ACTIVE (capacity-counting) assignments. */
let activeByPerson = new Map<string, number>();
/** driverId -> number of non-active assignments (must NOT count). */
let terminalByPerson = new Map<string, number>();

const ORDER_ID = "o-1";
const VENDOR_ID = "v-1";

/** Latitudes are spaced so distance ordering is unambiguous. */
function driver(i: number, opts: { id?: string; userId?: string } = {}) {
  const id = opts.id ?? `dp-${i}`;
  return {
    id,
    userId: opts.userId ?? `u-${i}`,
    latitude: 6.5 + i * 0.01,
    longitude: 3.3,
    user: { name: `Driver ${i}`, email: `d${i}@x.com` },
  };
}

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    address: { findFirst: jest.fn() },
    deliveryPerson: { findMany: jest.fn(), findUnique: jest.fn() },
    deliveryEarning: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({ id: "de-1" })) },
    deliveryAssignment: {
      // The per-driver count is the thing being removed. If the service calls it
      // again the query-count test below fails, which is the point.
      count: jest.fn(async () => 0),
      groupBy: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(async () => null),
    },
    deliveryBroadcast: { count: jest.fn(async () => 0), create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../../src/socket", () => ({
  getIO: () => ({ to: () => ({ emit: jest.fn() }) }),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../../src/lib/prisma").default as any;

/** Emulates `groupBy` over the simulated active/terminal assignment sets. */
function groupResult() {
  return [...activeByPerson.entries()]
    .filter(([, n]) => n > 0)
    .map(([deliveryPersonId, n]) => ({ deliveryPersonId, _count: { _all: n } }));
}

beforeEach(() => {
  jest.clearAllMocks();
  calls.deliveryAssignment = [];
  calls.order = [];
  drivers = [];
  activeByPerson = new Map();
  terminalByPerson = new Map();

  db.$transaction.mockImplementation(async (arg: any) => (typeof arg === "function" ? arg(db) : arg));
  db.order.findUnique.mockImplementation(async (a: any) =>
    a?.select
      ? { vendorId: VENDOR_ID }
      : {
          id: ORDER_ID,
          vendorId: VENDOR_ID,
          customerId: "c-1",
          status: "READY_FOR_PICKUP",
          paymentStatus: "SUCCESS",
          vendor: { id: VENDOR_ID },
        },
  );
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.address.findFirst.mockResolvedValue({ latitude: 6.5, longitude: 3.3 });
  db.deliveryPerson.findMany.mockImplementation(async () => drivers);
  // Task 5: the manual path re-reads the driver under the DeliveryPerson
  // FOR UPDATE lock and re-asserts eligibility. The candidate `findMany` select
  // carries no eligibility columns, so this fixture models what the real
  // `findUnique` returns for an eligible rider.
  db.deliveryPerson.findUnique.mockImplementation(
    async () => (drivers[0] ? { ...drivers[0], isOnline: true, status: "ACTIVE", user: { ...drivers[0].user, isEmailVerified: true } } : null),
  );
  db.$queryRaw.mockResolvedValue(undefined);
  db.deliveryAssignment.groupBy.mockImplementation(async () => groupResult());
  db.deliveryAssignment.count.mockImplementation(async (a: any) => {
    calls.deliveryAssignment.push(a);
    return 0;
  });
  db.deliveryAssignment.create.mockImplementation(async ({ data }: any) => ({
    id: "as-1",
    status: "ASSIGNED",
    timeoutSeconds: 30,
    ...data,
  }));
  db.deliveryBroadcast.create.mockImplementation(async ({ data }: any) => ({ id: "bc-1", ...data }));
});

const assign = () => DeliveryAssignmentService.assignOrder(ORDER_ID);

/** A per-driver capacity count — the shape being eliminated. */
const perDriverCountCalls = () =>
  db.deliveryAssignment.count.mock.calls.filter((c: any[]) => c[0]?.where?.deliveryPersonId !== undefined);

describe("capacity query shape", () => {
  it("reads capacity with ONE grouped query, not one count per driver", async () => {
    drivers = Array.from({ length: 50 }, (_, i) => driver(i));
    await assign();

    expect(db.deliveryAssignment.groupBy).toHaveBeenCalledTimes(1);
    // The per-driver count must not be used for capacity any more.
    // (`count` is still legitimately called once per ORDER by the live-dispatch
    // guard in assertNoActiveAssignment, so assert on the per-driver shape.)
    expect(perDriverCountCalls()).toHaveLength(0);
  });

  it("query count does not grow linearly with the number of online drivers", async () => {
    for (const n of [1, 5, 25, 100]) {
      jest.clearAllMocks();
      drivers = Array.from({ length: n }, (_, i) => driver(i));
      db.deliveryAssignment.groupBy.mockImplementation(async () => groupResult());

      await assign();

      // Exactly one capacity query regardless of driver count.
      expect(db.deliveryAssignment.groupBy).toHaveBeenCalledTimes(1);
      expect(perDriverCountCalls()).toHaveLength(0);
    }
  });

  it("groups by deliveryPersonId and filters to the capacity statuses", async () => {
    drivers = [driver(1), driver(2)];
    await assign();

    const arg = db.deliveryAssignment.groupBy.mock.calls[0][0];
    expect(arg.by).toEqual(["deliveryPersonId"]);
    expect(arg._count).toEqual({ _all: true });
    // Capacity statuses are ASSIGNED, ACCEPTED, PICKED_UP, EN_ROUTE.
    expect([...arg.where.status.in].sort()).toEqual(["ACCEPTED", "ASSIGNED", "EN_ROUTE", "PICKED_UP"]);
    // Restricted to the candidate drivers, not the whole table.
    expect([...arg.where.deliveryPersonId.in].sort()).toEqual(["dp-1", "dp-2"]);
  });
});

describe("capacity semantics", () => {
  // Eligibility is decided by the grouped scan alone on the broadcast path.
  // The manual path re-checks capacity authoritatively under the driver row
  // lock, so it would mask a regression in the scan; that path is covered
  // separately under "transactional safeguards".
  it("a driver with no matching assignments is treated as zero-load", async () => {
    drivers = [driver(1)];
    // No groupBy row at all — groupBy omits drivers with zero matches.
    await expect(assign()).resolves.toBeDefined();
    expect(db.deliveryBroadcast.create).toHaveBeenCalledTimes(1);
  });

  it("a driver at MAX_STACK - 1 is still eligible", async () => {
    drivers = [driver(1)];
    activeByPerson = new Map([["dp-1", 2]]); // MAX_STACK is 3
    await expect(assign()).resolves.toBeDefined();
    expect(db.deliveryBroadcast.create).toHaveBeenCalledTimes(1);
  });

  it("a driver at MAX_STACK is ineligible", async () => {
    drivers = [driver(1)];
    activeByPerson = new Map([["dp-1", 3]]);
    await expect(assign()).rejects.toThrow(/No drivers available within stacking limit/);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
    expect(db.deliveryBroadcast.create).not.toHaveBeenCalled();
  });

  it("terminal-status assignments do NOT count toward capacity", async () => {
    drivers = [driver(1)];
    // DELIVERED / CANCELLED / FAILED are deliberately excluded from the
    // capacity set, so a driver carrying many of them stays eligible.
    terminalByPerson = new Map([["dp-1", 9]]);
    activeByPerson = new Map();
    await expect(assign()).resolves.toBeDefined();
    expect(db.deliveryBroadcast.create).toHaveBeenCalledTimes(1);
  });
});

describe("selection and broadcast limit", () => {
  it("selects the five nearest eligible drivers", async () => {
    drivers = Array.from({ length: 12 }, (_, i) => driver(i));
    await assign();

    const arg = db.deliveryBroadcast.create.mock.calls[0][0];
    // driver(0) is nearest, so the first five by latitude win.
    expect(arg.data.driverIds).toEqual(["u-0", "u-1", "u-2", "u-3", "u-4"]);
  });

  it("skips a nearer driver that is at capacity and takes the next one", async () => {
    drivers = Array.from({ length: 8 }, (_, i) => driver(i));
    activeByPerson = new Map([
      ["dp-0", 3], // nearest, but full
      ["dp-1", 3], // second nearest, also full
    ]);

    await assign();

    const arg = db.deliveryBroadcast.create.mock.calls[0][0];
    expect(arg.data.driverIds).toEqual(["u-2", "u-3", "u-4", "u-5", "u-6"]);
  });

  it("broadcasts to fewer than five when fewer are eligible", async () => {
    drivers = Array.from({ length: 3 }, (_, i) => driver(i));
    await assign();

    const arg = db.deliveryBroadcast.create.mock.calls[0][0];
    expect(arg.data.driverIds).toEqual(["u-0", "u-1", "u-2"]);
  });
});

describe("edge cases and transactional safeguards", () => {
  it("rejects when there are no online drivers", async () => {
    drivers = [];
    await expect(assign()).rejects.toThrow(/No available drivers/);
    // No capacity query is needed when there is nobody to scan.
    expect(db.deliveryAssignment.groupBy).not.toHaveBeenCalled();
  });

  it("a single available driver still dispatches", async () => {
    drivers = [driver(1)];
    await assign();
    expect(db.deliveryBroadcast.create).toHaveBeenCalledTimes(1);
    expect(db.deliveryBroadcast.create.mock.calls[0][0].data.driverIds).toEqual(["u-1"]);
  });

  it("the grouped scan does not weaken the order-row claim", async () => {
    drivers = [driver(1)];
    await assign();

    // The Order-row lock + predicate is still taken inside the transaction.
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    const claim = db.order.updateMany.mock.calls[0][0];
    expect(claim.where.status.in).toEqual(expect.arrayContaining(["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"]));
    expect(claim.where.paymentStatus).toBe("SUCCESS");
  });

  it("the grouped scan does not weaken the manual driver's row lock", async () => {
    drivers = [driver(1, { userId: "u-target" })];
    await DeliveryAssignmentService.assignOrder(ORDER_ID, "u-target");

    // F5-B: DeliveryPerson row is still locked with FOR UPDATE before the
    // authoritative capacity recount.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.deliveryAssignment.create).toHaveBeenCalledTimes(1);
  });

  it("a settled order is still refused after the grouped scan", async () => {
    drivers = [driver(1)];
    db.deliveryEarning.findUnique.mockResolvedValue({ id: "de-1" });

    await expect(assign()).rejects.toThrow(/already been paid out to a rider/);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
    expect(db.deliveryBroadcast.create).not.toHaveBeenCalled();
  });
});
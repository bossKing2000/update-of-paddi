/**
 * N-05B follow-up: a committed broadcast must not be reported as a failed
 * dispatch when the realtime socket is unavailable.
 *
 * The automatic dispatch path commits its `DeliveryBroadcast` inside
 * `prisma.$transaction`, then emits `deliveryRequest` to each of the top
 * drivers. That emission is POST-COMMIT. `getIO()` THROWS when Socket.IO has
 * not been initialised (src/socket.ts:87-89) rather than returning null, so
 * before this change an uninitialised socket propagated out of `assignOrder`
 * and reached the controller as a 500 — even though the broadcast row was
 * already persisted. A caller retrying that 500 would then be refused by the
 * live-broadcast guard in `claimOrderForDispatch`, leaving a vendor told their
 * dispatch failed when it had in fact succeeded.
 *
 * What these tests pin:
 *   - a socket failure never changes the returned dispatch result
 *   - the broadcast create is not rolled back, retried, or duplicated
 *   - the SUCCESSFUL emission path is unchanged: same event name, same
 *     recipients, same payload
 *   - the isolation is narrow — real dispatch/transaction errors still throw
 *
 * Real service, fully mocked Prisma and socket. No database connection.
 */
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { ConflictError } from "../../src/errors/AppError";

/** Every `.to(userId).emit(event, payload)` recorded by the socket mock. */
const emissions: Array<{ room: string; event: string; payload: any }> = [];

/**
 * Flipped per test to make `getIO()` reproduce the real failure mode: it throws
 * when Socket.IO was never initialised. Leaving this false models a healthy
 * server, so the success-path assertions below exercise the unchanged path.
 */
let socketAvailable = true;

jest.mock("../../src/socket", () => ({
  getIO: () => {
    if (!socketAvailable) {
      throw new Error("Socket.IO not initialized! Call initSocket(server) first.");
    }
    return {
      to: (room: string) => ({
        emit: (event: string, payload: any) => {
          emissions.push({ room, event, payload });
        },
      }),
    };
  },
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
    deliveryEarning: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({ id: "de-1" })) },
    deliveryAssignment: {
      count: jest.fn(async () => 0),
      groupBy: jest.fn(async () => []),
      create: jest.fn(),
      findFirst: jest.fn(async () => null),
    },
    deliveryBroadcast: { count: jest.fn(async () => 0), create: jest.fn(), findMany: jest.fn(async () => []) },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../../src/lib/prisma").default as any;
const recordActivityBundle = require("../../src/utils/activityUtils/recordActivityBundle")
  .recordActivityBundle as jest.Mock;

const ORDER_ID = "o-1";
const EXPIRES_AT = new Date("2030-01-01T00:00:00.000Z");

/** Two eligible drivers; the mock hoists `socketAvailable` into each test. */
function drivers() {
  return [
    { id: "dp-1", userId: "u-1", latitude: 6.5, longitude: 3.3, user: { name: "A", email: "a@x.com" } },
    { id: "dp-2", userId: "u-2", latitude: 6.51, longitude: 3.3, user: { name: "B", email: "b@x.com" } },
  ];
}

const dispatch = () => DeliveryAssignmentService.assignOrder(ORDER_ID);

beforeEach(() => {
  jest.clearAllMocks();
  emissions.length = 0;
  socketAvailable = true;

  db.$transaction.mockImplementation(async (arg: any) => (typeof arg === "function" ? arg(db) : arg));
  db.order.findUnique.mockImplementation(async (a: any) =>
    a?.select
      ? { vendorId: "v-1" }
      : {
          id: ORDER_ID,
          vendorId: "v-1",
          customerId: "c-1",
          status: "READY_FOR_PICKUP",
          paymentStatus: "SUCCESS",
          vendor: { id: "v-1" },
        },
  );
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.address.findFirst.mockResolvedValue({ latitude: 6.5, longitude: 3.3 });
  db.deliveryPerson.findMany.mockImplementation(async () => drivers());
  db.deliveryPerson.findUnique.mockResolvedValue(drivers()[0]);
  db.$queryRaw.mockResolvedValue(undefined);
  db.deliveryAssignment.count.mockResolvedValue(0);
  db.deliveryAssignment.groupBy.mockResolvedValue([]);
  db.deliveryBroadcast.count.mockResolvedValue(0);
  db.deliveryBroadcast.create.mockImplementation(async ({ data }: any) => ({ id: "bc-1", ...data }));
});

describe("committed dispatch survives an unavailable Socket.IO", () => {
  it("returns the normal success result even though getIO() throws", async () => {
    socketAvailable = false;

    const result = await dispatch();

    // The exact shape the caller received before this change succeeded.
    expect(result).toEqual({ success: true, broadcast: expect.objectContaining({ id: "bc-1" }) });
  });

  it("does not roll back, retry or duplicate the committed broadcast", async () => {
    socketAvailable = false;

    await dispatch();

    // Committed exactly once: no second transaction, no compensating delete.
    expect(db.deliveryBroadcast.create).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // The committed row still carries the offer the drivers would have polled.
    expect(db.deliveryBroadcast.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ orderId: ORDER_ID, status: "PENDING", driverIds: ["u-1", "u-2"] }),
    );
  });

  it("still records the activity bundle after a lost emission", async () => {
    socketAvailable = false;

    await dispatch();

    // Only the socket emission is isolated; activity recording is unchanged and
    // is reached because the dispatch itself did not throw.
    expect(recordActivityBundle).toHaveBeenCalledTimes(1);
  });

  it("emits nothing at all when the socket is unavailable", async () => {
    socketAvailable = false;

    await dispatch();

    expect(emissions).toEqual([]);
  });

  it("propagates a genuine dispatch error even when the socket is fine", async () => {
    // Guards against over-catching: the try/catch must not swallow real
    // dispatch failures, only the post-commit socket one.
    socketAvailable = true;
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(dispatch()).rejects.toBeInstanceOf(ConflictError);
    await expect(dispatch()).rejects.toThrow(/no longer dispatchable/);
    expect(db.deliveryBroadcast.create).not.toHaveBeenCalled();
  });

  it("propagates a genuine transaction error even when the socket is fine", async () => {
    socketAvailable = true;
    db.deliveryBroadcast.create.mockRejectedValue(new Error("P2002 unique violation"));

    await expect(dispatch()).rejects.toThrow(/P2002/);
    expect(emissions).toEqual([]);
  });

  it("propagates an in-transaction capacity rejection unchanged", async () => {
    socketAvailable = false;
    db.deliveryAssignment.count.mockResolvedValue(1);

    await expect(dispatch()).rejects.toThrow(/already has an active delivery assignment/);
    expect(db.deliveryBroadcast.create).not.toHaveBeenCalled();
    expect(emissions).toEqual([]);
  });
});

describe("successful emission is unchanged", () => {
  it("emits deliveryRequest to each top driver with the committed payload", async () => {
    await dispatch();

    expect(emissions).toHaveLength(2);
    expect(emissions.map((e) => e.room)).toEqual(["u-1", "u-2"]);
    for (const e of emissions) {
      expect(e.event).toBe("deliveryRequest");
      expect(e.payload).toEqual({ broadcastId: "bc-1", orderId: ORDER_ID, expiresAt: expect.any(Date) });
    }
  });

  it("keeps the same recipients, in the same nearest-first order", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `dp-${i}`, userId: `u-${i}`, latitude: 6.5 + i * 0.01, longitude: 3.3,
      user: { name: `D${i}`, email: `d${i}@x.com` },
    }));
    db.deliveryPerson.findMany.mockImplementation(async () => many);

    await dispatch();

    // TOP_DRIVERS_PER_BROADCAST is 5, nearest-first.
    expect(emissions.map((e) => e.room)).toEqual(["u-0", "u-1", "u-2", "u-3", "u-4"]);
  });

  it("returns the same success result as the healthy path", async () => {
    const result = await dispatch();
    expect(result.success).toBe(true);
    expect(recordActivityBundle).toHaveBeenCalledTimes(1);
  });
});
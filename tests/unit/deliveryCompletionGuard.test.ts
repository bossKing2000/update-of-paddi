/**
 * Stage N-05A: the delivery workflow may only complete an order that is
 * actually completable.
 *
 * Before this change the driver path wrote:
 *
 *   prisma.order.update({ where: { id }, data: { status: COMPLETED } })
 *
 * — an unconditional write that could overwrite a CANCELLED order (already
 * refundable) with COMPLETED (vendor-payout-eligible), and could complete an
 * unpaid order outright. It also credited driver earnings regardless.
 *
 * These are runtime tests against the real service with mocked Prisma only.
 */
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import prisma from "../../src/lib/prisma";
import { ConflictError } from "../../src/errors/AppError";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    deliveryPerson: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
    deliveryAssignment: {
      findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn(), findMany: jest.fn(async () => []),
      // F4-1: updateStatus now CASes the assignment and re-reads it inside the tx.
      findUniqueOrThrow: jest.fn(), count: jest.fn(async () => 0),
    },
    order: { update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(async () => []), findUnique: jest.fn() },
    // F4-1: the earning is written with an idempotent upsert inside the completion tx.
    deliveryEarning: { create: jest.fn(), upsert: jest.fn(), findUnique: jest.fn(async () => null) },
    deliveryBroadcast: { create: jest.fn() },
    address: { findFirst: jest.fn() },
    // F4-1: updateStatus takes the Order row lock with SELECT ... FOR UPDATE.
    $queryRaw: jest.fn(async () => [{ id: "order-1" }]),
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/socket", () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

const db = prisma as unknown as {
  deliveryPerson: { findUnique: jest.Mock; update: jest.Mock };
  deliveryAssignment: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findMany: jest.Mock;
  };
  order: { update: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock };
  deliveryEarning: { create: jest.Mock; upsert: jest.Mock; findUnique: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};

const DRIVER_USER = "u-driver";
const DELIVERY_PERSON = "dp-1";
const ORDER_ID = "o-1";
const FEE = 1500;

function driver() {
  return { id: DELIVERY_PERSON, userId: DRIVER_USER };
}

/** Assignment owned by this driver, with the embedded order. */
function assignment(orderStatus: string, paymentStatus: string, assignStatus = "EN_ROUTE") {
  return {
    id: "as-1",
    deliveryPersonId: DELIVERY_PERSON,
    status: assignStatus,
    orderId: ORDER_ID,
    order: {
      id: ORDER_ID,
      status: orderStatus,
      paymentStatus,
      deliveryFee: FEE,
      customerId: "c-1",
      vendorId: "v-1",
    },
  };
}

/** The single order mirror write. */
function mirrorCall() {
  return db.order.updateMany.mock.calls[0][0];
}
/** The unconditional order.write that N-05A removed. */
function unconditionalOrderWrites() {
  return db.order.update.mock.calls.filter((c) => c[0]?.data?.status);
}

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );
  db.deliveryPerson.findUnique.mockResolvedValue(driver());
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.deliveryAssignment.update.mockImplementation(async (a: any) => ({
    ...assignment("OUT_FOR_DELIVERY", "SUCCESS"),
    ...a.data,
  }));
  db.deliveryPerson.update.mockResolvedValue({ id: DELIVERY_PERSON });
  db.deliveryEarning.create.mockResolvedValue({ id: "de-1" });
  // F4-1: updateStatus reads the Order inside the transaction (after taking the
  // Order row lock) instead of trusting the assignment's embedded copy.
  // F4-2: `creditDeliveryEarning` re-reads the Order AFTER the conditional mirror
  // has moved it to COMPLETED, so this read must reflect the mirror rather than
  // a frozen snapshot — that re-read is what makes the helper eligible.
  let mirrored = false;
  db.order.findUnique.mockImplementation(async () => ({
    id: ORDER_ID,
    status: mirrored ? "COMPLETED" : "OUT_FOR_DELIVERY",
    paymentStatus: "SUCCESS",
    customerId: "c-1",
    deliveryFee: FEE,
  }));
  db.order.updateMany.mockImplementation(async () => {
    mirrored = true;
    return { count: 1 };
  });
  // F4-1: the assignment write is now a CAS — exactly one row must match.
  db.deliveryAssignment.updateMany.mockResolvedValue({ count: 1 });
  // F4-2: the helper identifies the rider from the order's assignments.
  db.deliveryAssignment.findMany.mockResolvedValue([
    { deliveryPersonId: DELIVERY_PERSON, status: "DELIVERED" },
  ]);
  db.deliveryAssignment.findUniqueOrThrow.mockResolvedValue(
    assignment("OUT_FOR_DELIVERY", "SUCCESS", "DELIVERED"),
  );
  // F4-1: the earning is written idempotently, not with a bare create.
  db.deliveryEarning.upsert.mockResolvedValue({ id: "de-1" });
});

const markDelivered = () =>
  DeliveryAssignmentService.updateStatus("as-1", DRIVER_USER, "DELIVERED" as never);

// ---------------------------------------------------------------------------
describe("N-05A — valid completion", () => {
  it("1. OUT_FOR_DELIVERY + SUCCESS: order completes and the driver is credited", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(assignment("OUT_FOR_DELIVERY", "SUCCESS"));

    await markDelivered();

    // Assignment recorded via an F6-style CAS pinned to the expected status.
    expect(db.deliveryAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "as-1", status: "EN_ROUTE" } }),
    );
    // Conditional mirror, carrying the canonical invariants.
    expect(mirrorCall().where).toEqual({
      id: ORDER_ID,
      status: "OUT_FOR_DELIVERY",
      paymentStatus: "SUCCESS",
    });
    expect(mirrorCall().data).toEqual({ status: "COMPLETED" });
    // No unconditional order.status write survives.
    expect(unconditionalOrderWrites()).toHaveLength(0);
    // Driver earnings intact.
    expect(db.deliveryPerson.update).toHaveBeenCalledWith({
      where: { id: DELIVERY_PERSON },
      data: { totalDeliveries: { increment: 1 }, walletBalance: { increment: FEE } },
    });
    expect(db.deliveryEarning.upsert).toHaveBeenCalledTimes(1);
  });

  it("1b. assignment may be PICKED_UP as well as EN_ROUTE", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(
      assignment("OUT_FOR_DELIVERY", "SUCCESS", "PICKED_UP"),
    );
    await markDelivered();
    expect(mirrorCall().data).toEqual({ status: "COMPLETED" });
    expect(db.deliveryEarning.upsert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("N-05A — completion must be rejected", () => {
  it("2. CANCELLED order is never overwritten with COMPLETED (Path A)", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(assignment("CANCELLED", "SUCCESS"));
    // The CAS predicate (OUT_FOR_DELIVERY + SUCCESS) matches nothing.
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(markDelivered()).rejects.toBeInstanceOf(ConflictError);

    // The order write was still CAS-guarded and matched nothing.
    expect(mirrorCall().where.status).toBe("OUT_FOR_DELIVERY");
    expect(mirrorCall().where.paymentStatus).toBe("SUCCESS");
    expect(unconditionalOrderWrites()).toHaveLength(0);
    // No completion earning, no wallet credit.
    expect(db.deliveryEarning.upsert).not.toHaveBeenCalled();
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("3. unpaid order is never completed (Path B)", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(
      assignment("AWAITING_PAYMENT", "PENDING"),
    );
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(markDelivered()).rejects.toBeInstanceOf(ConflictError);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(mirrorCall().where).toEqual({
      id: ORDER_ID,
      status: "OUT_FOR_DELIVERY",
      paymentStatus: "SUCCESS",
    });
    expect(db.deliveryEarning.upsert).not.toHaveBeenCalled();
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it.each([
    ["CANCELLED_UNPAID", "EXPIRED"],
    ["PAYMENT_EXPIRED", "EXPIRED"],
    ["PENDING", "PENDING"],
    ["COOKING", "SUCCESS"],
    ["READY_FOR_PICKUP", "SUCCESS"],
    ["COMPLETED", "SUCCESS"],
  ])("4. non-completable state %s/%s is left untouched", async (orderStatus, paymentStatus) => {
    db.deliveryAssignment.findUnique.mockResolvedValue(assignment(orderStatus, paymentStatus));
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(markDelivered()).rejects.toBeInstanceOf(ConflictError);
    // Only the guarded mirror ran — no unconditional write bypassed it.
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.deliveryEarning.upsert).not.toHaveBeenCalled();
  });

  it("5. CAS failure (concurrent cancellation wins) grants no financial side effect", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(assignment("OUT_FOR_DELIVERY", "SUCCESS"));
    // The loser of the cancellation race: 0 rows transitioned.
    db.order.updateMany.mockResolvedValue({ count: 0 });

    const err = await markDelivered().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect(db.deliveryEarning.upsert).not.toHaveBeenCalled();
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
    // F4-1: the delivery is still recorded — now via the F6-style CAS, which
    // succeeds here because this call owns the assignment transition. What is
    // withheld is the financial side effect.
    expect(db.deliveryAssignment.updateMany).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("N-05A — assignment state machine must not be weakened", () => {
  it("6. duplicate DELIVERED is still rejected by the assignment transition table", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(
      assignment("COMPLETED", "SUCCESS", "DELIVERED"),
    );
    await expect(markDelivered()).rejects.toThrow(/Cannot transition from DELIVERED/);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.deliveryEarning.upsert).not.toHaveBeenCalled();
  });

  it("6b. ASSIGNED cannot jump straight to DELIVERED", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(
      assignment("READY_FOR_PICKUP", "SUCCESS", "ASSIGNED"),
    );
    await expect(markDelivered()).rejects.toThrow(/Cannot transition from ASSIGNED/);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it("7. a foreign driver's assignment is still Forbidden", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue({
      ...assignment("OUT_FOR_DELIVERY", "SUCCESS"),
      deliveryPersonId: "dp-other",
    });
    await expect(markDelivered()).rejects.toThrow(/doesn't belong to you/);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("N-05A — sibling delivery transitions stay safe", () => {
  it("8. PICKED_UP mirrors OUT_FOR_DELIVERY only from a dispatchable state", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(
      assignment("READY_FOR_PICKUP", "SUCCESS", "ACCEPTED"),
    );
    await DeliveryAssignmentService.updateStatus("as-1", DRIVER_USER, "PICKED_UP" as never);
    expect(mirrorCall().where).toEqual({
      id: ORDER_ID,
      status: { in: ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"] },
    });
    expect(mirrorCall().data).toEqual({ status: "OUT_FOR_DELIVERY" });
  });

  it("8b. PICKED_UP cannot resurrect a CANCELLED order", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(
      assignment("CANCELLED", "SUCCESS", "ACCEPTED"),
    );
    db.order.updateMany.mockResolvedValue({ count: 0 });

    // PICKED_UP is not a completion, so no conflict is thrown — but the
    // cancelled order must be left alone.
    await DeliveryAssignmentService.updateStatus("as-1", DRIVER_USER, "PICKED_UP" as never);
    expect(mirrorCall().where).toEqual({
      id: ORDER_ID,
      status: { in: ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"] },
    });
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("9. failed delivery mirrors FAILED_DELIVERY only from OUT_FOR_DELIVERY", async () => {
    db.deliveryAssignment.findUnique.mockResolvedValue(
      assignment("OUT_FOR_DELIVERY", "SUCCESS", "EN_ROUTE"),
    );
    await DeliveryAssignmentService.updateStatus("as-1", DRIVER_USER, "FAILED" as never);
    expect(mirrorCall().where).toEqual({ id: ORDER_ID, status: "OUT_FOR_DELIVERY" });
    expect(mirrorCall().data).toEqual({ status: "FAILED_DELIVERY" });
  });
});

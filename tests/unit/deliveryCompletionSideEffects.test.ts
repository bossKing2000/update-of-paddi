/**
 * Stage N-05C (F1): every path that completes an order awards the same
 * completion effects.
 *
 * `Order.status = COMPLETED` has two production writers — the canonical
 * `orderController.updateOrderStatus` and the driver's
 * `DeliveryAssignmentService.updateStatus(DELIVERED)`. Only the canonical one
 * used to run `creditReferralRewardIfEligible` and
 * `creditPotPointsForCompletedOrder`, so a driver-delivered order — the normal
 * end state of a delivery — silently forfeited the customer's Pot Points and
 * the referrer's first-order reward.
 *
 * These tests mock the two effect functions themselves, so they prove the CALL
 * PATH from each completion source rather than re-testing the idempotency that
 * `potPoints.test.ts` already covers.
 */
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import prisma from "../../src/lib/prisma";
import { creditReferralRewardIfEligible } from "../../src/controllers/referralController";
import {
  creditPotPointsForCompletedOrder,
  logPotPointsFailure,
} from "../../src/services/potPoints.service";
import { recordActivityBundle } from "../../src/utils/activityUtils/recordActivityBundle";
import { ConflictError } from "../../src/errors/AppError";

jest.mock("../../src/socket", () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

jest.mock("../../src/controllers/referralController", () => ({
  __esModule: true,
  creditReferralRewardIfEligible: jest.fn(async () => {}),
}));

jest.mock("../../src/services/potPoints.service", () => ({
  __esModule: true,
  creditPotPointsForCompletedOrder: jest.fn(async () => ({ credited: true, balance: 50 })),
  logPotPointsFailure: jest.fn(),
}));

// Canonical completion path harness (mirrors tests/unit/cancelRefund.test.ts).
jest.mock("../../src/services/inventory.service", () => ({
  __esModule: true,
  restoreStockForOrders: jest.fn(async () => {}),
  assertQuantityAvailable: jest.fn(),
  reserveStockForItems: jest.fn(async () => {}),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
}));

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { findFirst: jest.fn() },
    refundRequest: { findFirst: jest.fn(), create: jest.fn() },
    deliveryPerson: { findUnique: jest.fn(), update: jest.fn() },
    // F4-1: updateStatus CASes the assignment, locks the Order row and writes
    // the earning with an idempotent upsert, all inside one transaction.
    deliveryAssignment: {
      findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(), count: jest.fn(), findMany: jest.fn(async () => []),
    },
    deliveryEarning: { create: jest.fn(), upsert: jest.fn(), findUnique: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => [{ id: "order-1" }]),
    $transaction: jest.fn(),
  },
}));

const { updateOrderStatus } = require("../../src/controllers/orderController");

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const referral = creditReferralRewardIfEligible as unknown as jest.Mock;
const pot = creditPotPointsForCompletedOrder as unknown as jest.Mock;
const potLog = logPotPointsFailure as unknown as jest.Mock;

const DELIVERY_PERSON = "dp-1";
const DRIVER_USER = "u-driver";
const ORDER_ID = "o-1";
const CUSTOMER_ID = "c-1";
const FEE = 1500;

/** Live assignment status, so a second attempt reads what the first wrote. */
let assignStatus: string;

/** The driver's assignment with its embedded order, as the mirror path reads it. */
function assignment(orderStatus: string, paymentStatus: string, status?: string) {
  return {
    id: "as-1",
    deliveryPersonId: DELIVERY_PERSON,
    status: status ?? assignStatus,
    orderId: ORDER_ID,
    order: {
      id: ORDER_ID,
      status: orderStatus,
      paymentStatus,
      deliveryFee: FEE,
      customerId: CUSTOMER_ID,
      vendorId: "v-1",
    },
  };
}

function canonicalOrder(status: string) {
  return {
    id: ORDER_ID,
    vendorId: "v-1",
    customerId: CUSTOMER_ID,
    status,
    paymentStatus: "SUCCESS",
    idempotencyKey: "k-1",
    // Batch 1D.42: lifecycle status read via this relation; fails closed.
    vendor: { vendorStatus: "ACTIVE" },
  };
}

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const markDelivered = () =>
  DeliveryAssignmentService.updateStatus("as-1", DRIVER_USER, "DELIVERED" as never);

beforeEach(() => {
  jest.clearAllMocks();

  assignStatus = "EN_ROUTE";

  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );

  db.deliveryPerson.findUnique.mockResolvedValue({ id: DELIVERY_PERSON, userId: DRIVER_USER });
  db.deliveryAssignment.findUnique.mockImplementation(async () =>
    assignment("OUT_FOR_DELIVERY", "SUCCESS"),
  );
  // F4-1: the assignment write is a CAS pinned to the expected status, and the
  // transitioned row is re-read inside the transaction.
  db.deliveryAssignment.updateMany.mockImplementation(async (a: any) => {
    if (a.data?.status) assignStatus = a.data.status;
    return { count: 1 };
  });
  db.deliveryAssignment.findUniqueOrThrow.mockImplementation(async () =>
    assignment("OUT_FOR_DELIVERY", "SUCCESS", assignStatus),
  );
  // F4-1: updateStatus reads the Order inside the transaction, after locking it.
  // F4-2: the helper re-reads the Order AFTER the mirror moved it to COMPLETED.
  let mirrored = false;
  db.order.findUnique.mockImplementation(async () => ({
    id: ORDER_ID, status: mirrored ? "COMPLETED" : "OUT_FOR_DELIVERY",
    paymentStatus: "SUCCESS", customerId: CUSTOMER_ID, deliveryFee: FEE,
  }));
  // F4-2: the helper identifies the rider from the order's assignments.
  db.deliveryAssignment.findMany.mockResolvedValue([
    { deliveryPersonId: DELIVERY_PERSON, status: assignStatus },
  ]);
  db.order.updateMany.mockImplementation(async () => {
    mirrored = true;
    return { count: 1 };
  });
  db.deliveryPerson.update.mockResolvedValue({ id: DELIVERY_PERSON });
  db.deliveryEarning.create.mockResolvedValue({ id: "de-1" });
  db.deliveryEarning.upsert.mockResolvedValue({ id: "de-1" });
  db.order.update.mockImplementation(async (a: any) => ({ ...canonicalOrder("COMPLETED"), ...a.data }));
});

// ---------------------------------------------------------------------------
describe("N-05C F1 — driver completion awards the completion effects", () => {
  it("29. a completed driver delivery calls pot points exactly once", async () => {
    await markDelivered();

    expect(db.order.updateMany.mock.calls[0][0].where).toEqual({
      id: ORDER_ID,
      status: "OUT_FOR_DELIVERY",
      paymentStatus: "SUCCESS",
    });
    expect(pot).toHaveBeenCalledTimes(1);
    expect(pot).toHaveBeenCalledWith(ORDER_ID, CUSTOMER_ID);
  });

  it("30. a completed driver delivery calls the referral check exactly once", async () => {
    await markDelivered();

    expect(referral).toHaveBeenCalledTimes(1);
    expect(referral).toHaveBeenCalledWith(CUSTOMER_ID, ORDER_ID);
  });

  it("30b. the N-05A earnings path is untouched by the side effects", async () => {
    await markDelivered();

    expect(db.deliveryEarning.upsert).toHaveBeenCalledTimes(1);
    expect(db.deliveryPerson.update).toHaveBeenCalledWith({
      where: { id: DELIVERY_PERSON },
      data: { totalDeliveries: { increment: 1 }, walletBalance: { increment: FEE } },
    });
  });

  it("30c. the effects stay fire-and-forget — a rejection cannot fail the delivery", async () => {
    pot.mockRejectedValueOnce(new Error("loyalty down"));
    referral.mockRejectedValueOnce(new Error("referral down"));

    await expect(markDelivered()).resolves.toBeTruthy();
    await new Promise((r) => setImmediate(r));
    expect(potLog).toHaveBeenCalledTimes(1);
  });

  it("31. when the order CAS loses, neither effect is called", async () => {
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(markDelivered()).rejects.toBeInstanceOf(ConflictError);

    expect(pot).not.toHaveBeenCalled();
    expect(referral).not.toHaveBeenCalled();
    expect(db.deliveryEarning.create).not.toHaveBeenCalled();
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
  });

  it("34. a duplicate completion cannot award the effects twice", async () => {
    await markDelivered();
    expect(pot).toHaveBeenCalledTimes(1);

    // The second DELIVERED is refused by the assignment transition table before
    // any order write is attempted.
    await expect(markDelivered()).rejects.toThrow(/Cannot transition from DELIVERED/);

    expect(pot).toHaveBeenCalledTimes(1);
    expect(referral).toHaveBeenCalledTimes(1);
    expect(db.deliveryEarning.upsert).toHaveBeenCalledTimes(1);
  });

  it("34b. a PICKED_UP assignment completing also awards them exactly once", async () => {
    assignStatus = "PICKED_UP";
    await markDelivered();
    expect(pot).toHaveBeenCalledTimes(1);
    expect(referral).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("N-05C F1 — canonical completion behaviour is preserved", () => {
  it("32. the customer COMPLETED path still invokes both effects", async () => {
    db.order.findUnique.mockResolvedValue(canonicalOrder("OUT_FOR_DELIVERY"));

    await updateOrderStatus(
      { user: { id: CUSTOMER_ID, role: "CUSTOMER", sessionId: "s" }, params: { orderId: ORDER_ID }, body: { status: "COMPLETED" } } as any,
      res(),
    );

    expect(pot).toHaveBeenCalledTimes(1);
    expect(pot).toHaveBeenCalledWith(ORDER_ID, CUSTOMER_ID);
    expect(referral).toHaveBeenCalledTimes(1);
    expect(referral).toHaveBeenCalledWith(CUSTOMER_ID, ORDER_ID);
  });

  it("33. a non-COMPLETED canonical transition invokes neither", async () => {
    db.order.findUnique.mockResolvedValue(canonicalOrder("COOKING"));

    await updateOrderStatus(
      { user: { id: "v-1", role: "VENDOR", sessionId: "s" }, params: { orderId: ORDER_ID }, body: { status: "READY_FOR_PICKUP" } } as any,
      res(),
    );

    expect(db.order.update).toHaveBeenCalledTimes(1);
    expect(pot).not.toHaveBeenCalled();
    expect(referral).not.toHaveBeenCalled();
  });
});
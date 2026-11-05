/**
 * Phase 1B.2-F: paid cancel files the RefundRequest inside the same
 * transaction as the status change (no silent catch), exactly once per
 * payment; unpaid cancels file nothing.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), update: jest.fn() },
    // F4-1: the cancel path reconciles active delivery assignments in-transaction.
    deliveryAssignment: { updateMany: jest.fn(async () => ({ count: 0 })) },
    payment: { findFirst: jest.fn() },
    refundRequest: { findFirst: jest.fn(), create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

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

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { updateOrderStatus } from "../../src/controllers/orderController";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const paidOrder = () => ({
  id: "o-1",
  vendorId: "v-1",
  customerId: "c-1",
  status: "PAYMENT_CONFIRMED",
  paymentStatus: "SUCCESS",
  idempotencyKey: "k-1",
  // Batch 1D.42: updateOrderStatus now reads the vendor's lifecycle status
  // from this relation and fails closed when it cannot. A vendor cancelling
  // their own order is an operating vendor.
  vendor: { vendorStatus: "ACTIVE" },
});

beforeEach(() => jest.clearAllMocks());

describe("cancel with refund", () => {
  it("paid cancel creates exactly one PENDING refund request in-transaction", async () => {
    db.order.findUnique.mockResolvedValue(paidOrder());
    db.order.update.mockImplementation(async (args: any) => ({ ...paidOrder(), ...args.data }));
    db.payment.findFirst.mockResolvedValue({ id: "p-1", reference: "ref-1" });
    db.refundRequest.findFirst.mockResolvedValue(null);
    db.refundRequest.create.mockImplementation(async (args: any) => ({ id: "r-1", ...args.data }));

  // C-2: the paid-cancel path now files the obligation with
  // `INSERT ... ON CONFLICT DO NOTHING RETURNING ...` (raw SQL) rather than a
  // typed `create`. Route it back through the existing `create` double so every
  // assertion below — including the failure-injection one — is unchanged.
  db.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = Array.from(strings as unknown as string[]).join(" ");
      if (!sql.includes('INSERT INTO "RefundRequest"')) return [];
      const [id, userId, paymentRef, reason, status, , , orderId, requestedAmountKobo] =
        values as any[];
      const row = await db.refundRequest.create({
        data: { id, userId, paymentRef, reason, status, orderId, requestedAmountKobo },
      });
      return row ? [row] : [];
    },
  );

    const r = res();
    await updateOrderStatus(
      { user: { id: "v-1", role: "VENDOR", sessionId: "s" }, params: { orderId: "o-1" }, body: { status: "CANCELLED" } } as any,
      r,
    );

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.refundRequest.create).toHaveBeenCalledTimes(1);
    expect(db.refundRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "c-1",
          paymentRef: "ref-1",
          status: "PENDING",
        }),
      }),
    );
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("double-cancel does not duplicate the refund request", async () => {
    db.order.findUnique.mockResolvedValue(paidOrder());
    db.order.update.mockImplementation(async (args: any) => ({ ...paidOrder(), ...args.data }));
    db.payment.findFirst.mockResolvedValue({ id: "p-1", reference: "ref-1" });
    db.refundRequest.findFirst.mockResolvedValue({ id: "r-1", paymentRef: "ref-1", status: "PENDING" });

    const r = res();
    await updateOrderStatus(
      { user: { id: "v-1", role: "VENDOR", sessionId: "s" }, params: { orderId: "o-1" }, body: { status: "CANCELLED" } } as any,
      r,
    );

    expect(db.refundRequest.create).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("unpaid cancel files no refund request", async () => {
    const unpaid = { ...paidOrder(), status: "AWAITING_PAYMENT", paymentStatus: "PENDING" };
    db.order.findUnique.mockResolvedValue(unpaid);
    db.order.update.mockImplementation(async (args: any) => ({ ...unpaid, ...args.data }));

    const r = res();
    await updateOrderStatus(
      { user: { id: "c-1", role: "CUSTOMER", sessionId: "s" }, params: { orderId: "o-1" }, body: { status: "CANCELLED" } } as any,
      r,
    );

    expect(db.payment.findFirst).not.toHaveBeenCalled();
    expect(db.refundRequest.findFirst).not.toHaveBeenCalled();
    expect(db.refundRequest.create).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("a refund-write failure fails the cancel instead of vanishing", async () => {
    db.order.findUnique.mockResolvedValue(paidOrder());
    db.order.update.mockImplementation(async (args: any) => ({ ...paidOrder(), ...args.data }));
    db.payment.findFirst.mockResolvedValue({ id: "p-1", reference: "ref-1" });
    db.refundRequest.findFirst.mockResolvedValue(null);
    db.refundRequest.create.mockRejectedValue(new Error("DB down"));

    await expect(
      updateOrderStatus(
        { user: { id: "v-1", role: "VENDOR", sessionId: "s" }, params: { orderId: "o-1" }, body: { status: "CANCELLED" } } as any,
        res(),
      ),
    ).rejects.toThrow("DB down");
  });
});

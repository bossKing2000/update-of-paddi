/**
 * Batch D — vendor confirmation timeout + admin terminal guard.
 *
 * D1 (README 3C): paid orders get 10 minutes for vendor confirmation; a
 * 2-minute job auto-cancels still-PAYMENT_CONFIRMED orders, files an
 * order-bounded PENDING refund, and notifies the customer. Only the CAS
 * winner acts; retries cannot duplicate refunds or notifications.
 *
 * D2: the admin status override can no longer resurrect terminal orders,
 * and concurrent changes surface as 409 via CAS instead of overwriting.
 *
 * Real job + real controller (mocked Prisma/activity only). No live
 * database, Redis, or scheduler.
 */
import { runExpireUnconfirmedVendorOrders } from "../../src/jobs/workers jobs/expireUnconfirmedVendorOrders";
import { adminUpdateOrderStatus } from "../../src/controllers/admin.controller";
import prisma from "../../src/lib/prisma";
import { recordActivityBundle } from "../../src/utils/activityUtils/recordActivityBundle";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { findFirst: jest.fn() },
    refundRequest: { findFirst: jest.fn(), create: jest.fn() },
    deliveryAssignment: { updateMany: jest.fn(async () => ({ count: 0 })) },
    deliveryEarning: { findUnique: jest.fn(async () => null) },
    product: { updateMany: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => ({})),
}));

jest.mock("../../src/services/deliveryAssignmentReconciliation", () => ({
  __esModule: true,
  isTerminalOrderStatus: jest.fn((s: string) =>
    ["COMPLETED", "CANCELLED", "FAILED_DELIVERY", "CANCELLED_UNPAID"].includes(s),
  ),
  isDispatchableOrderStatus: jest.fn(() => false),
  reconcileActiveDeliveryAssignments: jest.fn(async () => {}),
}));

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedNotify = recordActivityBundle as jest.Mock;

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

const stalePaidOrder = (over: Record<string, unknown> = {}) => ({
  id: "order-T",
  customerId: "cust-1",
  vendorId: "vend-1",
  // Phase 3A: order.totalPrice is integer kobo.
  totalPrice: 550000,
  idempotencyKey: "batch-T",
  paidAt: new Date(Date.now() - 11 * 60_000),
  ...over,
});

const successPayment = () => ({ id: "pay-T", reference: "PSK-T" });

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(db) : arg,
  );

  // C-2: obligations are filed with `INSERT ... ON CONFLICT DO NOTHING
  // RETURNING ...` (raw SQL) instead of a typed `create`. Route it through the
  // existing `create` double so every assertion below is unchanged.
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
  db.order.findMany.mockResolvedValue([]);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.payment.findFirst.mockResolvedValue(successPayment());
  db.refundRequest.findFirst.mockResolvedValue(null);
  db.refundRequest.create.mockImplementation(async (args: any) => ({ id: "rr-1", ...args.data }));
  db.order.findUnique.mockResolvedValue({ status: "COOKING" });
  db.order.update.mockImplementation(async (args: any) => ({ id: "o-1", ...args.data }));
});

describe("Batch D1 — vendor confirmation timeout job", () => {
  it("1. selects only stale paid PAYMENT_CONFIRMED orders", async () => {
    db.order.findMany.mockResolvedValueOnce([stalePaidOrder()]);
    await runExpireUnconfirmedVendorOrders();

    const where = db.order.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("PAYMENT_CONFIRMED");
    expect(where.paymentStatus).toBe("SUCCESS");
    // All orders — immediate and scheduled — share the same confirmation
    // deadline: paidAt + VENDOR_CONFIRM_TIMEOUT_MS (10 minutes).
    expect(where.paidAt).toBeDefined();
    expect(where.paidAt.lt.getTime()).toBeLessThanOrEqual(
      Date.now() - 10 * 60_000,
    );
    // scheduledAt is the fulfilment time, not the confirmation deadline, so
    // it must not appear in the deadline predicate.
    expect(where.OR).toBeUndefined();
  });

  it("2. winner cancels, files an order-bounded refund, and notifies once", async () => {
    db.order.findMany.mockResolvedValueOnce([stalePaidOrder()]);
    await runExpireUnconfirmedVendorOrders();

    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-T", status: "PAYMENT_CONFIRMED" },
      }),
    );
    const data = db.order.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe("CANCELLED");
    expect(data.cancellationReason).toBe("VENDOR_TIMEOUT");
    expect(db.refundRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: "order-T",
          status: "PENDING",
          requestedAmountKobo: 550000,
        }),
      }),
    );
    expect(mockedNotify).toHaveBeenCalledTimes(1);
  });

  it("3. CAS loss (vendor acted first) files nothing and notifies nobody", async () => {
    db.order.findMany.mockResolvedValueOnce([stalePaidOrder()]);
    db.order.updateMany.mockResolvedValue({ count: 0 });
    await runExpireUnconfirmedVendorOrders();

    expect(db.refundRequest.create).not.toHaveBeenCalled();
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("4. retry cannot file a second refund (open-request guard)", async () => {
    db.order.findMany.mockResolvedValueOnce([stalePaidOrder()]);
    db.refundRequest.findFirst.mockResolvedValue({ id: "rr-existing", status: "PENDING" });
    await runExpireUnconfirmedVendorOrders();

    expect(db.refundRequest.create).not.toHaveBeenCalled();
    // The cancellation itself still applied exactly once this run.
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it("5. paid orders never restore stock on timeout", async () => {
    db.order.findMany.mockResolvedValueOnce([stalePaidOrder()]);
    await runExpireUnconfirmedVendorOrders();

    // Paid portions are consumed on success (same as the paid-cancel path):
    // the timeout path issues no stock increment at all.
    expect(db.product.updateMany).not.toHaveBeenCalled();
    expect(db.order.updateMany.mock.calls[0][0].data.status).toBe("CANCELLED");
  });
});

describe("Batch D2 — admin terminal guard", () => {
  const adminReq = (status: string) => ({
    user: { id: "admin-1", sessionId: "s" },
    params: { id: "o-1" },
    body: { status },
  }) as never;

  it("6. terminal orders cannot be resurrected", async () => {
    for (const terminal of ["COMPLETED", "CANCELLED", "FAILED_DELIVERY", "CANCELLED_UNPAID", "PAYMENT_EXPIRED"]) {
      db.order.findUnique.mockResolvedValue({ status: terminal });
      await expect(adminUpdateOrderStatus(adminReq("COOKING"), res())).rejects.toMatchObject({
        statusCode: 409,
      });
    }
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("7. same-state admin writes stay allowed (no-op)", async () => {
    db.order.findUnique.mockResolvedValue({ status: "CANCELLED" });
    await adminUpdateOrderStatus(adminReq("CANCELLED"), res());
    expect(db.order.update).toHaveBeenCalledTimes(1);
  });

  it("8. non-terminal corrections still work with CAS + audit", async () => {
    db.order.findUnique.mockResolvedValue({ status: "COOKING" });
    await adminUpdateOrderStatus(adminReq("READY_FOR_PICKUP"), res());

    expect(db.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "o-1", status: "COOKING" } }),
    );
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it("9. concurrent change surfaces as 409 instead of overwriting", async () => {
    db.order.findUnique.mockResolvedValue({ status: "COOKING" });
    db.order.update.mockRejectedValueOnce(
      Object.assign(new Error("Record to update not found"), { code: "P2025" }),
    );
    await expect(adminUpdateOrderStatus(adminReq("READY_FOR_PICKUP"), res())).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

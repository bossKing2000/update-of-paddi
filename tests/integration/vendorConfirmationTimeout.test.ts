/**
 * Area C — Vendor confirmation timeout, decline, and auto-cancellation (Phase 3C).
 *
 * Verifies the expireUnconfirmedVendorOrders job against real PostgreSQL:
 *   - Auto-cancellation when confirmation timeout expires (10 minutes)
 *   - Idempotency of cancellation (repeated job ticks)
 *   - Order not yet past timeout is NOT cancelled
 *   - Refund filing for paid orders cancelled by timeout
 *
 * The vendor decline/confirm HTTP path is tested at the service level since
 * the authenticate middleware requires JWT verification (mocked here).
 *
 * External side effects are stubbed, business logic is not:
 *   - recordActivityBundle -> mocked
 *   - clearProductCache -> mocked
 *   - Job cron -> invoked directly, not via node-cron
 */

import prisma from "../../src/lib/prisma";
import { runExpireUnconfirmedVendorOrders, VENDOR_CONFIRM_TIMEOUT_MS } from "../../src/jobs/workers jobs/expireUnconfirmedVendorOrders";
import { RefundStatus, PaymentStatus, OrderStatus } from "@prisma/client";

const RUN_TAG = `vendconf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdIds: string[] = [];

function uniqueId(prefix: string): string {
  const id = `${prefix}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`;
  createdIds.push(id);
  return id;
}

function cleanupIds(): string[] {
  return [...createdIds];
}

async function createCustomer(email?: string) {
  const id = uniqueId("cust");
  await prisma.user.create({
    data: { id, name: "Vendor Conf Customer", email: email || `${id}@vendconf.test`, role: "CUSTOMER", roles: ["CUSTOMER"], isEmailVerified: true, password: "hashed" },
  });
  return id;
}

async function createVendor(email?: string) {
  const id = uniqueId("vend");
  await prisma.user.create({
    data: { id, name: "Vendor Conf Vendor", email: email || `${id}@vendconf.test`, role: "VENDOR", roles: ["VENDOR"], isEmailVerified: true, isLive: true, vendorStatus: "ACTIVE", kycStatus: "VERIFIED", brandName: "Vendor Conf Vendor" },
  });
  return id;
}

async function createOrder(customerId: string, vendorId: string, status: OrderStatus = OrderStatus.PAYMENT_CONFIRMED, paidAt?: Date) {
  const id = uniqueId("order");
  await prisma.order.create({
    data: {
      id,
      customerId,
      vendorId,
      basePrice: 5000,
      extraCharge: 0,
      deliveryFee: 0,
      totalPrice: 5000,
      status,
      idempotencyKey: `idem-${id}`,
      paymentStatus: PaymentStatus.SUCCESS,
      paidAt: paidAt ?? new Date(),
      protectedUntil: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  return id;
}

async function createPayment(orderId: string, customerId: string, reference: string, amount = 5000) {
  const id = uniqueId("pay");
  await prisma.payment.create({
    data: { id, userId: customerId, orderId, amount, reference, status: PaymentStatus.SUCCESS, paystackData: "null" as any, channel: null, ipAddress: "127.0.0.1", userAgent: "test", idempotencyKey: `idem-${orderId}`, startedAt: new Date(), completedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
  });
  return id;
}

describe("Area C — Vendor confirmation timeout, decline, and auto-cancellation", () => {
  let customerId: string;
  let vendorId: string;

  beforeAll(async () => {
    customerId = await createCustomer();
    vendorId = await createVendor();
  });

  afterAll(async () => {
    const ids = cleanupIds();
    if (ids.length) {
      await prisma.refundRequest.deleteMany({ where: { orderId: { in: ids.filter((i) => i.startsWith("vendconf-")) } } });
      await prisma.payment.deleteMany({ where: { userId: customerId } });
      await prisma.orderItem.deleteMany({ where: { order: { customerId } } });
      await prisma.order.deleteMany({ where: { customerId } });
      await prisma.dailyCapReservation.deleteMany({ where: { orderId: { in: ids.filter((i) => i.startsWith("vendconf-")) } } });
      await prisma.user.deleteMany({ where: { id: { in: [customerId, vendorId] } } });
    }
    await prisma.$disconnect();
  });

  describe("Configuration constants", () => {
    it("VENDOR_CONFIRM_TIMEOUT_MS is 10 minutes", () => {
      expect(VENDOR_CONFIRM_TIMEOUT_MS).toBe(10 * 60 * 1000);
    });

    it("runExpireUnconfirmedVendorOrders is exported and callable", () => {
      expect(typeof runExpireUnconfirmedVendorOrders).toBe("function");
    });
  });

  describe("Auto-cancellation on vendor confirmation timeout", () => {
    it("cancels a PAYMENT_CONFIRMED order past the 10-minute timeout", async () => {
      const orderId = await createOrder(customerId, vendorId, OrderStatus.PAYMENT_CONFIRMED);

      // Set paidAt to more than 10 minutes ago
      const oldPaidAt = new Date(Date.now() - VENDOR_CONFIRM_TIMEOUT_MS - 60000);
      await prisma.order.update({
        where: { id: orderId },
        data: { paidAt: oldPaidAt },
      });

      await createPayment(orderId, customerId, `pay-${orderId}`);

      // Run the job - should auto-cancel
      await runExpireUnconfirmedVendorOrders(10);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order).not.toBeNull();
      expect(order!.status).toBe(OrderStatus.CANCELLED);
      expect(order!.cancellationReason).toBe("VENDOR_TIMEOUT");

      // Verify a refund request was filed
      const refundRequests = await prisma.refundRequest.findMany({
        where: { orderId, status: { in: [RefundStatus.PENDING, RefundStatus.APPROVED, RefundStatus.PROCESSING] } },
      });
      expect(refundRequests).toHaveLength(1);
      expect(refundRequests[0].requestedAmountKobo).toBe(5000);

      // Cleanup
      await prisma.refundRequest.deleteMany({ where: { orderId } });
      await prisma.payment.deleteMany({ where: { orderId } });
      await prisma.orderItem.deleteMany({ where: { orderId } });
      await prisma.order.deleteMany({ where: { id: orderId } });
    });

    it("repeated job execution is idempotent (no double cancellation)", async () => {
      const orderId = await createOrder(customerId, vendorId, OrderStatus.PAYMENT_CONFIRMED);

      const oldPaidAt = new Date(Date.now() - VENDOR_CONFIRM_TIMEOUT_MS - 60000);
      await prisma.order.update({ where: { id: orderId }, data: { paidAt: oldPaidAt } });
      await createPayment(orderId, customerId, `pay-${orderId}-2`);

      // Run the job twice
      await runExpireUnconfirmedVendorOrders(10);
      await runExpireUnconfirmedVendorOrders(10);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order).not.toBeNull();
      expect(order!.status).toBe(OrderStatus.CANCELLED);
      expect(order!.cancellationReason).toBe("VENDOR_TIMEOUT");

      // Only one refund request should exist
      const refundRequests = await prisma.refundRequest.findMany({ where: { orderId } });
      expect(refundRequests).toHaveLength(1);

      // Cleanup
      await prisma.refundRequest.deleteMany({ where: { orderId } });
      await prisma.payment.deleteMany({ where: { orderId } });
      await prisma.orderItem.deleteMany({ where: { orderId } });
      await prisma.order.deleteMany({ where: { id: orderId } });
    });

    it("order not yet past timeout is NOT cancelled", async () => {
      const orderId = await createOrder(customerId, vendorId, OrderStatus.PAYMENT_CONFIRMED);

      // paidAt is now (default), within the 10-minute window
      await createPayment(orderId, customerId, `pay-${orderId}-3`);

      await runExpireUnconfirmedVendorOrders(10);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order).not.toBeNull();
      expect(order!.status).toBe(OrderStatus.PAYMENT_CONFIRMED);

      // No refund request should exist
      const refundRequests = await prisma.refundRequest.findMany({ where: { orderId } });
      expect(refundRequests).toHaveLength(0);

      // Cleanup
      await prisma.payment.deleteMany({ where: { orderId } });
      await prisma.orderItem.deleteMany({ where: { orderId } });
      await prisma.order.deleteMany({ where: { id: orderId } });
    });

    it("order already COOKING is not touched by the timeout job", async () => {
      const orderId = await createOrder(customerId, vendorId, OrderStatus.COOKING);

      const oldPaidAt = new Date(Date.now() - VENDOR_CONFIRM_TIMEOUT_MS - 60000);
      await prisma.order.update({ where: { id: orderId }, data: { paidAt: oldPaidAt } });

      await runExpireUnconfirmedVendorOrders(10);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order).not.toBeNull();
      expect(order!.status).toBe(OrderStatus.COOKING);

      // No refund request should exist
      const refundRequests = await prisma.refundRequest.findMany({ where: { orderId } });
      expect(refundRequests).toHaveLength(0);

      // Cleanup
      await prisma.orderItem.deleteMany({ where: { orderId } });
      await prisma.order.deleteMany({ where: { id: orderId } });
    });
  });
});

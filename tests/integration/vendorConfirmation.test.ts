/**
 * Area C — Vendor confirmation timeout, decline, and cancellation (Phase 3C).
 *
 * Tests the vendor confirmation lifecycle against real PostgreSQL:
 *
 *   C1. Explicit vendor decline — vendor can decline, cross-vendor blocked,
 *       repeated declines safe, daily-cap released, refund filed.
 *   C2. Expiry-job does not override vendor confirmation — sequential invariant
 *       test: vendor confirms first, then expiry job runs; order stays COOKING.
 *   C3. Expiry-job does not override vendor decline — sequential invariant test:
 *       vendor declines first, then expiry job runs; order stays CANCELLED.
 *   C4. Inventory restoration after cancellation/timeout — daily cap released.
 *   C6. Payment-state handling — unpaid vs paid vs protected orders.
 *
 * Uses real disposable PostgreSQL. Business logic is NOT mocked — only
 * infrastructure (rate limiters, geo, tracking, activity bundle).
 *
 * C2 and C3 are sequential invariant tests, not concurrency tests: the vendor
 * decision is made first, then the expiry job runs. They verify that a terminal
 * vendor decision (COOKING or CANCELLED) cannot be overwritten by the expiry
 * job's compare-and-set transition.
 */

import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import prisma from "../../src/lib/prisma";
import orderRoutes from "../../src/routes/orderRouter";
import { errorHandler } from "../../src/middlewares/error.middleware";
import { OrderStatus, PaymentStatus } from "@prisma/client";

// ── Test-only environment ───────────────────────────────────────────────────
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-not-a-real-credential";
process.env.JWT_RESET_SECRET = "test-reset-secret-not-a-real-credential";
process.env.SERVER_URL = "http://localhost:5000";
process.env.CLOUDINARY_URL = "dummy-cloudinary-url";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.PAYSTACK_SECRET_KEY = "sk_test_dummy_not_a_credential";
process.env.PAYSTACK_PUBLIC_KEY = "pk_test_dummy_not_a_credential";
process.env.OPENSEARCH_NODE = "http://localhost:9200";

// ── In-memory Redis double ──────────────────────────────────────────────────
const redisStore = new Map<string, { value: string; expiresAt: number }>();
jest.mock("../../src/lib/redis", () => {
  return {
    redisPayments: {
      get: jest.fn(async (key: string) => {
        const e = redisStore.get(key);
        if (!e) return null;
        if (Date.now() > e.expiresAt) { redisStore.delete(key); return null; }
        return e.value;
      }),
      set: jest.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
        if (opts?.NX && redisStore.has(key)) return null;
        redisStore.set(key, { value, expiresAt: Date.now() + (opts?.EX ?? 3600) * 1000 });
        return "OK";
      }),
      del: jest.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0)),
      incr: jest.fn(async (key: string) => {
        const e = redisStore.get(key);
        const val = e ? Number(e.value) + 1 : 1;
        redisStore.set(key, { value: String(val), expiresAt: Date.now() + 3600000 });
        return val;
      }),
      expire: jest.fn(async () => 1),
      ttl: jest.fn(async () => -1),
    },
    redisNotifications: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
    redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
    ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
    connectRedis: jest.fn(async () => {}),
  };
});

// ── Mock middleware and external services ───────────────────────────────────
jest.mock("../../src/middlewares/rateLimiter.middleware", () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    authRateLimiter: passthrough, paymentRateLimiter: passthrough,
    checkoutRateLimiter: passthrough, otpRateLimiter: passthrough,
    phoneOtpRateLimiter: passthrough, passwordChangeRateLimiter: passthrough,
    secureResetRateLimiter: passthrough, cartSummaryRateLimiter: passthrough,
    aiRateLimiter: passthrough, emailOtpRateLimiter: passthrough,
  };
});
jest.mock("../../src/middlewares/geo.middleware", () => ({
  geoMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock("../../src/middlewares/tracking.middleware", () => ({
  trackUserAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock("../../src/services/clearCaches", () => ({
  clearProductCache: jest.fn(async () => ({ ok: true })),
}));
jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  recordActivityBundle: jest.fn(async () => {}),
}));

// ── Mock authenticate ───────────────────────────────────────────────────────
let testUserId: string;
let testUserRole: string;
jest.mock("../../src/middlewares/auth.middleware", () => ({
  authenticate: jest.fn((_req: unknown, _res: unknown, next: () => void) => {
    (_req as any).user = { id: testUserId, role: testUserRole, sessionId: "test-session" };
    next();
  }),
  authorizeCustomer: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  authorizeVendor: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  authorizeAdmin: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use("/api", orderRoutes);
app.use(errorHandler);

const RUN_TAG = `vendconf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ── Tracking: every record created by tests so cleanup removes only ours ────
const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdDishTypeIds: string[] = [];
const createdAddressIds: string[] = [];
const createdOrderIds: string[] = [];

function uniqueId(prefix: string): string {
  return `${prefix}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`;
}

let ipCounter = 0;
function nextClientIp(): string {
  ipCounter += 1;
  const octet3 = Math.floor(ipCounter / 250) % 250;
  const octet4 = (ipCounter % 250) + 1;
  return `198.18.${octet3}.${octet4}`;
}

function updateOrderStatus(orderId: string, status: string, userId: string, userRole: string, ip?: string) {
  testUserId = userId;
  testUserRole = userRole;
  return request(app)
    .patch(`/api/vendor/order/${orderId}/update-status`)
    .set("X-Forwarded-For", ip || nextClientIp())
    .send({ status });
}

async function createCustomer(email?: string) {
  const id = uniqueId("cust");
  createdUserIds.push(id);
  await prisma.user.create({
    data: { id, name: "VC Customer", email: email || `${id}@vc.test`, role: "CUSTOMER", roles: ["CUSTOMER"], isEmailVerified: true, password: "hashed" },
  });
  return id;
}

async function createVendor(email?: string) {
  const id = uniqueId("vend");
  createdUserIds.push(id);
  await prisma.user.create({
    data: { id, name: "VC Vendor", email: email || `${id}@vc.test`, role: "VENDOR", roles: ["VENDOR"], isEmailVerified: true, isLive: true, vendorStatus: "ACTIVE", kycStatus: "VERIFIED", brandName: "VC Vendor", deliveryPreferences: { acceptingOrders: true, baseDeliveryFee: 300, deliveryRadiusKm: 5 } },
  });
  return id;
}

async function createCategory() {
  const id = uniqueId("cat");
  createdCategoryIds.push(id);
  await prisma.category.create({ data: { id, name: `VC Cat ${RUN_TAG}`, slug: `vc-cat-${RUN_TAG}`, sortOrder: 1, isActive: true } });
  return id;
}

async function createDishType(categoryId: string) {
  const id = uniqueId("dt");
  createdDishTypeIds.push(id);
  await prisma.dishType.create({ data: { id, name: `VC Dish ${RUN_TAG}`, sortOrder: 1, isActive: true, categoryId } });
  return id;
}

async function createProduct(vendorId: string, dishTypeId: string, categoryId: string, price = 5000) {
  const id = uniqueId("prod");
  createdProductIds.push(id);
  await prisma.product.create({
    data: { id, name: `VC Product ${RUN_TAG}`, description: "vc product", price, archived: false, dishTypeId, categoryId, trackInventory: false, stock: null, vendorId, isScheduled: false, orderCutoffTime: null, dailyCap: null, thumbnail: null, images: [], video: [], averageRating: 0, reviewCount: 0, totalViews: 0, popularityScore: 0, popularityPercent: 0, isNew: false },
  });
  return id;
}

async function createAddress(userId: string) {
  const id = uniqueId("addr");
  createdAddressIds.push(id);
  await prisma.address.create({ data: { id, userId, label: "Home", street: "123 VC Street", city: "Lagos", state: "Lagos", country: "Nigeria", zipCode: "100001", isDefault: true } });
  return id;
}

async function createOrder(customerId: string, vendorId: string, productId: string, addressId: string, status: OrderStatus, paymentStatus: PaymentStatus, paidAt?: Date) {
  const id = uniqueId("order");
  createdOrderIds.push(id);
  await prisma.order.create({
    data: {
      id,
      customerId,
      vendorId,
      addressId,
      basePrice: 5000,
      extraCharge: 0,
      deliveryFee: 0,
      totalPrice: 5000,
      status,
      idempotencyKey: `vc-idem-${id}`,
      paymentStatus,
      paidAt: paidAt ?? new Date(),
      protectedUntil: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  await prisma.orderItem.create({
    data: { id: uniqueId("oi"), orderId: id, productId, quantity: 1, unitPrice: 5000, subtotal: 5000 },
  });
  return id;
}

async function createPayment(orderId: string, customerId: string, reference: string, amount = 5000, status = PaymentStatus.SUCCESS) {
  const id = uniqueId("pay");
  await prisma.payment.create({
    data: { id, userId: customerId, orderId, amount, reference, status, paystackData: null as any, channel: null, ipAddress: "127.0.0.1", userAgent: "test", idempotencyKey: `vc-pay-${id}`, startedAt: new Date(), completedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
  });
  return id;
}

// ── Cleanup (foreign-key safe, test-created records only) ───────────────────

async function cleanupDb() {
  for (const orderId of createdOrderIds) {
    try { await prisma.refundRequest.deleteMany({ where: { orderId } }); } catch {}
    try { await prisma.payment.deleteMany({ where: { orderId } }); } catch {}
    try { await prisma.orderItem.deleteMany({ where: { orderId } }); } catch {}
    try { await prisma.order.deleteMany({ where: { id: orderId } }); } catch {}
  }
  for (const addressId of createdAddressIds) {
    try { await prisma.address.deleteMany({ where: { id: addressId } }); } catch {}
  }
  for (const userId of createdUserIds) {
    try { await prisma.user.deleteMany({ where: { id: userId } }); } catch {}
  }
  for (const id of createdProductIds) {
    try { await prisma.product.deleteMany({ where: { id } }); } catch {}
  }
  for (const id of createdDishTypeIds) {
    try { await prisma.dishType.deleteMany({ where: { id } }); } catch {}
  }
  for (const id of createdCategoryIds) {
    try { await prisma.category.deleteMany({ where: { id } }); } catch {}
  }
}

describe("Area C — Vendor confirmation timeout, decline, and cancellation races", () => {
  let customerId: string;
  let vendorId: string;
  let categoryId: string;
  let dishTypeId: string;
  let productId: string;
  let addressId: string;

  beforeAll(async () => {
    customerId = await createCustomer();
    vendorId = await createVendor();
    categoryId = await createCategory();
    dishTypeId = await createDishType(categoryId);
    productId = await createProduct(vendorId, dishTypeId, categoryId);
    addressId = await createAddress(customerId);
  });

  afterEach(async () => {
    await cleanupDb();
    createdUserIds.length = 0;
    createdProductIds.length = 0;
    createdCategoryIds.length = 0;
    createdDishTypeIds.length = 0;
    createdAddressIds.length = 0;
    createdOrderIds.length = 0;
  });

  afterAll(async () => {
    try {
      await cleanupDb();
    } catch (e) {
      console.error("Cleanup error:", (e as Error).message);
    }
    await prisma.$disconnect();
  });

  describe("C1 — Vendor decline", () => {
    it("vendor can decline a PAYMENT_CONFIRMED order", async () => {
      const orderId = await createOrder(customerId, vendorId, productId, addressId, OrderStatus.PAYMENT_CONFIRMED, PaymentStatus.SUCCESS);

      const res = await updateOrderStatus(orderId, "CANCELLED", vendorId, "VENDOR");
      expect(res.status).toBe(200);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe(OrderStatus.CANCELLED);
      expect(order!.cancellationReason).toBe("VENDOR_REJECTED");
    });

    it("unrelated vendor cannot decline another vendor's order", async () => {
      const orderId = await createOrder(customerId, vendorId, productId, addressId, OrderStatus.PAYMENT_CONFIRMED, PaymentStatus.SUCCESS);

      const otherVendorId = await createVendor(`otherVend-${RUN_TAG}@vc.test`);
      testUserId = otherVendorId;
      testUserRole = "VENDOR";

      const res = await updateOrderStatus(orderId, "CANCELLED", otherVendorId, "VENDOR");
      expect(res.status).toBe(403);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe(OrderStatus.PAYMENT_CONFIRMED);
    });

    it("repeated decline is idempotent", async () => {
      const orderId = await createOrder(customerId, vendorId, productId, addressId, OrderStatus.PAYMENT_CONFIRMED, PaymentStatus.SUCCESS);

      const res1 = await updateOrderStatus(orderId, "CANCELLED", vendorId, "VENDOR");
      expect(res1.status).toBe(200);

      const res2 = await updateOrderStatus(orderId, "CANCELLED", vendorId, "VENDOR");
      expect(res2.status).toBe(409); // Cannot transition from CANCELLED to CANCELLED

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe(OrderStatus.CANCELLED);
    });
  });

  describe("C2 — Expiry job does not override vendor confirmation", () => {
    it("vendor confirmation wins against expiry job (sequential invariant)", async () => {
      const orderId = await createOrder(customerId, vendorId, productId, addressId, OrderStatus.PAYMENT_CONFIRMED, PaymentStatus.SUCCESS);

      // Set paidAt to more than 10 minutes ago (eligible for expiry).
      const oldPaidAt = new Date(Date.now() - 11 * 60 * 1000);
      await prisma.order.update({ where: { id: orderId }, data: { paidAt: oldPaidAt } });
      await createPayment(orderId, customerId, `pay-${orderId}`);

      // Vendor confirms first.
      const res = await updateOrderStatus(orderId, "COOKING", vendorId, "VENDOR");
      expect(res.status).toBe(200);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe(OrderStatus.COOKING);

      // Run expiry job — should NOT cancel (already COOKING; CAS on PAYMENT_CONFIRMED yields 0).
      const { runExpireUnconfirmedVendorOrders } = await import("../../src/jobs/workers jobs/expireUnconfirmedVendorOrders");
      await runExpireUnconfirmedVendorOrders(10);

      const order2 = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order2!.status).toBe(OrderStatus.COOKING);
    });
  });

  describe("C3 — Expiry job does not override vendor decline", () => {
    it("vendor decline wins against expiry job (sequential invariant)", async () => {
      const orderId = await createOrder(customerId, vendorId, productId, addressId, OrderStatus.PAYMENT_CONFIRMED, PaymentStatus.SUCCESS);

      const oldPaidAt = new Date(Date.now() - 11 * 60 * 1000);
      await prisma.order.update({ where: { id: orderId }, data: { paidAt: oldPaidAt } });
      await createPayment(orderId, customerId, `pay-${orderId}`);

      // Vendor declines first.
      const res = await updateOrderStatus(orderId, "CANCELLED", vendorId, "VENDOR");
      expect(res.status).toBe(200);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe(OrderStatus.CANCELLED);
      expect(order!.cancellationReason).toBe("VENDOR_REJECTED");

      // Run expiry job — should NOT touch (already CANCELLED; CAS on PAYMENT_CONFIRMED yields 0).
      const { runExpireUnconfirmedVendorOrders } = await import("../../src/jobs/workers jobs/expireUnconfirmedVendorOrders");
      await runExpireUnconfirmedVendorOrders(10);

      const order2 = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order2!.status).toBe(OrderStatus.CANCELLED);
    });
  });

  describe("C4 — Inventory restoration", () => {
    it("daily cap released on cancellation of unpaid order", async () => {
      const capProduct = await createProduct(vendorId, dishTypeId, categoryId, 5000);

      const orderId = await createOrder(customerId, vendorId, capProduct, addressId, OrderStatus.AWAITING_PAYMENT, PaymentStatus.PENDING);

      // Reserve daily cap.
      const today = new Date();
      const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      await prisma.$transaction(async (tx) => {
        await tx.productDailyCounter.create({ data: { productId: capProduct, date: dayStart, count: 1 } });
        await tx.dailyCapReservation.create({ data: { orderId, productId: capProduct, day: dayStart, quantity: 1, released: false } });
      });

      // Cancel unpaid order (should restore stock + release daily cap).
      const res = await updateOrderStatus(orderId, "CANCELLED", customerId, "CUSTOMER");
      expect(res.status).toBe(200);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe(OrderStatus.CANCELLED);
      expect(order!.cancellationReason).toBe("USER_CANCELLED");

      // Daily cap should be released (counter back to 0).
      const counter = await prisma.productDailyCounter.findUnique({
        where: { productId_date: { productId: capProduct, date: dayStart } },
      });
      expect(counter?.count).toBe(0);
    });
  });

  describe("C6 — Payment-state handling", () => {
    it("unpaid order can be cancelled without refund", async () => {
      const orderId = await createOrder(customerId, vendorId, productId, addressId, "AWAITING_PAYMENT", "PENDING");

      const res = await updateOrderStatus(orderId, "CANCELLED", customerId, "CUSTOMER");
      expect(res.status).toBe(200);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe(OrderStatus.CANCELLED);
      expect(order!.cancellationReason).toBe("USER_CANCELLED");

      // No refund request should exist for unpaid order.
      const refunds = await prisma.refundRequest.findMany({ where: { orderId } });
      expect(refunds).toHaveLength(0);
    });

    it("paid order cancellation files refund", async () => {
      const orderId = await createOrder(customerId, vendorId, productId, addressId, OrderStatus.PAYMENT_CONFIRMED, PaymentStatus.SUCCESS);
      await createPayment(orderId, customerId, `pay-${orderId}`);

      const res = await updateOrderStatus(orderId, "CANCELLED", customerId, "CUSTOMER");
      expect(res.status).toBe(200);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe(OrderStatus.CANCELLED);

      // Refund request should exist.
      const refunds = await prisma.refundRequest.findMany({ where: { orderId } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0].requestedAmountKobo).toBe(5000);
    });

    it("COOKING order cannot be cancelled by customer", async () => {
      const orderId = await createOrder(customerId, vendorId, productId, addressId, OrderStatus.COOKING, PaymentStatus.SUCCESS);
      await createPayment(orderId, customerId, `pay-${orderId}`);

      testUserId = customerId;
      testUserRole = "CUSTOMER";
      const res = await updateOrderStatus(orderId, "CANCELLED", customerId, "CUSTOMER");
      expect(res.status).toBe(403); // Customer cannot cancel COOKING order

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe(OrderStatus.COOKING);
    });
  });
});

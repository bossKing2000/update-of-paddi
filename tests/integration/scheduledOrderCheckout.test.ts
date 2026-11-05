/**
 * Area A — Scheduled-order HTTP checkout integration (Phase 3D).
 *
 * Drives the real Express checkout router (POST /api/cart/checkout) against
 * real PostgreSQL + in-memory Redis double, verifying scheduled-order
 * enforcement end to end.
 *
 * External side effects are stubbed, business logic is not:
 *   - Rate limiters -> passthrough
 *   - Geo/tracking middlewares -> passthrough
 *   - Paystack -> mocked at initializePayment
 *   - Redis -> in-memory double (checkout idempotency + promo cache)
 *   - clearProductCache -> mocked
 *   - recordActivityBundle -> mocked
 */

import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import prisma from "../../src/lib/prisma";
import cartRoutes from "../../src/routes/cartRouter";
import { errorHandler } from "../../src/middlewares/error.middleware";

// In-memory Redis double for redisPayments (checkout idempotency + promo cache).
// Defined inline in jest.mock factory because jest.mock is hoisted above
// variable initialization.
const redisStoreA = new Map<string, { value: string; expiresAt: number }>();
jest.mock("../../src/lib/redis", () => ({
  redisPayments: {
    get: jest.fn(async (key: string) => {
      const e = redisStoreA.get(key);
      if (!e) return null;
      if (Date.now() > e.expiresAt) { redisStoreA.delete(key); return null; }
      return e.value;
    }),
    set: jest.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && redisStoreA.has(key)) return null;
      redisStoreA.set(key, { value, expiresAt: Date.now() + (opts?.EX ?? 3600) * 1000 });
      return "OK";
    }),
    del: jest.fn(async (key: string) => (redisStoreA.delete(key) ? 1 : 0)),
    incr: jest.fn(async (key: string) => {
      const e = redisStoreA.get(key);
      const val = e ? Number(e.value) + 1 : 1;
      redisStoreA.set(key, { value: String(val), expiresAt: Date.now() + 3600000 });
      return val;
    }),
    expire: jest.fn(async () => 1),
    ttl: jest.fn(async () => -1),
  },
  redisNotifications: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  connectRedis: jest.fn(async () => {}),
}));

jest.mock("../../src/middlewares/rateLimiter.middleware", () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    authRateLimiter: passthrough,
    paymentRateLimiter: passthrough,
    checkoutRateLimiter: passthrough,
    otpRateLimiter: passthrough,
    phoneOtpRateLimiter: passthrough,
    passwordChangeRateLimiter: passthrough,
    secureResetRateLimiter: passthrough,
    cartSummaryRateLimiter: passthrough,
    aiRateLimiter: passthrough,
    emailOtpRateLimiter: passthrough,
  };
});

jest.mock("../../src/middlewares/geo.middleware", () => ({
  geoMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../src/middlewares/tracking.middleware", () => ({
  trackUserAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../src/services/paymentService", () => ({
  initializePayment: jest.fn(async () => ({ reference: `pay_${Date.now()}`, authorization_url: "https://paystack.test/initialize" })),
  verifyPayment: jest.fn(),
}));

jest.mock("../../src/services/clearCaches", () => ({
  clearProductCache: jest.fn(async () => ({ ok: true })),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  recordActivityBundle: jest.fn(async () => {}),
}));

// Mock authenticate middleware to inject a test user (bypasses JWT verification)
// The test sets `globalThis.__testUserId` before each request to match the created customer.
jest.mock("../../src/middlewares/auth.middleware", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => {
    const uid = (globalThis as any).__testUserId || "test-user-id";
    (_req as any).user = { id: uid, role: "CUSTOMER", sessionId: "test-session" };
    next();
  },
  authorizeCustomer: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeVendor: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use("/api/cart", cartRoutes);
app.use(errorHandler);

const RUN_TAG = `sched-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdIds: string[] = [];

function uniqueId(prefix: string): string {
  const id = `${prefix}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`;
  createdIds.push(id);
  return id;
}

function cleanupIds(): string[] {
  return [...createdIds];
}

// Each request gets a distinct client address so Redis per-IP budgets are isolated.
let ipCounter = 0;
function nextClientIp(): string {
  ipCounter += 1;
  const octet3 = Math.floor(ipCounter / 250) % 250;
  const octet4 = (ipCounter % 250) + 1;
  return `198.18.${octet3}.${octet4}`;
}

function postCheckout(body: any, key: string, ip?: string) {
  return request(app)
    .post("/api/cart/checkout")
    .set("idempotency-key", key)
    .set("X-Forwarded-For", ip || nextClientIp())
    .send(body);
}

async function createCustomer(email?: string) {
  const id = uniqueId("cust");
  await prisma.user.create({
    data: {
      id,
      name: "Scheduled Checkout Customer",
      email: email || `${id}@sched.test`,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
      isEmailVerified: true,
      password: "hashed",
    },
  });
  return id;
}

async function createVendor(email?: string) {
  const id = uniqueId("vend");
  await prisma.user.create({
    data: {
      id,
      name: "Scheduled Checkout Vendor",
      email: email || `${id}@sched.test`,
      role: "VENDOR",
      roles: ["VENDOR"],
      isEmailVerified: true,
      isLive: true,
      vendorStatus: "ACTIVE",
      kycStatus: "VERIFIED",
      brandName: "Scheduled Vendor",
    },
  });
  return id;
}

async function createCategory() {
  const id = uniqueId("cat");
  await prisma.category.create({
    data: { id, name: `Scheduled Category ${RUN_TAG}`, slug: `sched-cat-${RUN_TAG}`, sortOrder: 1, isActive: true },
  });
  return id;
}

async function createDishType(categoryId: string) {
  const id = uniqueId("dt");
  await prisma.dishType.create({
    data: { id, name: `Scheduled Dish ${RUN_TAG}`, sortOrder: 1, isActive: true, categoryId },
  });
  return id;
}

async function createProduct(vendorId: string, dishTypeId: string, categoryId: string, overrides: { isScheduled?: boolean; orderCutoffTime?: string | null; dailyCap?: number | null; price?: number; archived?: boolean } = {}) {
  const id = uniqueId("prod");
  await prisma.product.create({
    data: {
      id,
      name: `Scheduled Product ${RUN_TAG}`,
      description: "scheduled order product",
      price: overrides.price ?? 5000,
      archived: overrides.archived ?? false,
      dishTypeId,
      categoryId,
      trackInventory: false,
      stock: null,
      vendorId,
      isScheduled: overrides.isScheduled ?? false,
      orderCutoffTime: overrides.orderCutoffTime ?? null,
      dailyCap: overrides.dailyCap ?? null,
      thumbnail: null,
      images: [],
      video: [],
      averageRating: 0,
      reviewCount: 0,
      totalViews: 0,
      popularityScore: 0,
      popularityPercent: 0,
      isNew: false,
    },
  });
  return id;
}

async function createAddress(userId: string) {
  const id = uniqueId("addr");
  await prisma.address.create({
    data: {
      id,
      userId,
      label: "Home",
      street: "123 Scheduled Street",
      city: "Lagos",
      state: "Lagos",
      country: "Nigeria",
      zipCode: "100001",
      latitude: 6.5244,
      longitude: 3.3792,
      isDefault: true,
    },
  });
  return id;
}

async function createCart(customerId: string, productId: string, quantity = 1, unitPrice = 5000) {
  const cartId = uniqueId("cart");
  const cartItemId = uniqueId("cartitem");
  await prisma.cart.create({
    data: { id: cartId, customerId, isLocked: false },
  });
  await prisma.cartItem.create({
    data: {
      id: cartItemId,
      cartId,
      productId,
      quantity,
      unitPrice,
      subtotal: unitPrice * quantity,
      specialRequest: null,
      options: { create: [] },
    },
  });
  return { cartId, cartItemId };
}

async function getCartSummaryId(customerId: string, addressId: string) {
  const res = await request(app)
    .get(`/api/cart/summary?addressId=${addressId}`)
    .set("X-Forwarded-For", nextClientIp());
  expect(res.status).toBe(200);
  expect(res.body.data.summaryId).toBeTruthy();
  return res.body.data.summaryId;
}

describe("Area A — Scheduled-order HTTP checkout integration", () => {
  let customerId: string;
  let vendorId: string;
  let categoryId: string;
  let dishTypeId: string;
  let schedulableProductId: string;
  let nonSchedulableProductId: string;
  let addressId: string;

  beforeAll(async () => {
    customerId = await createCustomer();
    vendorId = await createVendor();
    categoryId = await createCategory();
    dishTypeId = await createDishType(categoryId);

    // Schedulable product with daily cap
    schedulableProductId = await createProduct(vendorId, dishTypeId, categoryId, {
      isScheduled: true,
      orderCutoffTime: "14:00",
      dailyCap: 5,
      price: 5000,
    });

    // Non-schedulable product
    nonSchedulableProductId = await createProduct(vendorId, dishTypeId, categoryId, {
      isScheduled: false,
      orderCutoffTime: null,
      dailyCap: null,
      price: 3000,
    });

    addressId = await createAddress(customerId);
    (globalThis as any).__testUserId = customerId;
  });

  afterAll(async () => {
    const ids = cleanupIds();
    if (ids.length) {
      await prisma.orderItemOption.deleteMany({ where: { orderItem: { order: { customerId } } } });
      await prisma.orderItem.deleteMany({ where: { order: { customerId } } });
      await prisma.order.deleteMany({ where: { customerId } });
      await prisma.payment.deleteMany({ where: { userId: customerId } });
      await prisma.refundRequest.deleteMany({ where: { userId: customerId } });
      await prisma.dailyCapReservation.deleteMany({ where: { orderId: { in: ids.filter((i) => i.startsWith("cap-") || i.startsWith("sched-")) } } });
      await prisma.productDailyCounter.deleteMany({ where: { productId: { in: [schedulableProductId, nonSchedulableProductId] } } });
      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cart: { customerId } } } });
      await prisma.cartItem.deleteMany({ where: { cart: { customerId } } });
      await prisma.cart.deleteMany({ where: { customerId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { userId: customerId } });
      await prisma.address.deleteMany({ where: { userId: customerId } });
      await prisma.product.deleteMany({ where: { id: { in: [schedulableProductId, nonSchedulableProductId] } } });
      await prisma.dishType.deleteMany({ where: { id: dishTypeId } });
      await prisma.category.deleteMany({ where: { id: categoryId } });
      await prisma.user.deleteMany({ where: { id: { in: [customerId, vendorId] } } });
    }
    await prisma.$disconnect();
  });

  describe("Valid scheduled order", () => {
    it("creates an order with scheduledAt when product supports scheduling", async () => {
      const { cartId } = await createCart(customerId, schedulableProductId, 1, 5000);
      const snapshotId = await getCartSummaryId(customerId, addressId);

      // Schedule for tomorrow at 10:00 Lagos time
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      const res = await postCheckout(
        { summaryId: snapshotId, addressId, scheduledAt: tomorrow.toISOString() },
        `sched-valid-${Date.now()}`,
      );

      expect(res.status).toBe(201);
      const body = res.body;
      expect(body.success).toBe(true);
      expect(body.data.orders).toHaveLength(1);
      const order = body.data.orders[0];
      expect(order.scheduledAt).toBeTruthy();
      expect(order.status).toBe("AWAITING_PAYMENT");
      expect(order.idempotencyKey).toBeDefined();

      // Verify persisted in DB
      const persisted = await prisma.order.findUnique({ where: { id: order.id } });
      expect(persisted).not.toBeNull();
      expect(persisted!.scheduledAt).not.toBeNull();

      // Verify daily-cap reservation was created
      const reservations = await prisma.dailyCapReservation.findMany({
        where: { orderId: order.id, released: false },
      });
      expect(reservations).toHaveLength(1);
      expect(reservations[0].productId).toBe(schedulableProductId);

      // Cleanup cart
      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });

    it("rejects scheduled ordering for a product that does not support it", async () => {
      const { cartId } = await createCart(customerId, nonSchedulableProductId, 1, 3000);
      const snapshotId = await getCartSummaryId(customerId, addressId);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      const key = `sched-nonsched-${Date.now()}`;
      const res = await postCheckout(
        { summaryId: snapshotId, addressId, scheduledAt: tomorrow.toISOString() },
        key,
      );

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("does not accept scheduled orders");

      // No order should have been created with this idempotency key
      const orders = await prisma.order.findMany({ where: { idempotencyKey: key } });
      expect(orders).toHaveLength(0);

      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });

    it("rejects a malformed scheduledAt", async () => {
      const { cartId } = await createCart(customerId, schedulableProductId, 1, 5000);
      const snapshotId = await getCartSummaryId(customerId, addressId);

      const res = await postCheckout(
        { summaryId: snapshotId, addressId, scheduledAt: "not-a-date" },
        `sched-malformed-${Date.now()}`,
      );

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("valid ISO-8601");

      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });

    it("rejects a past scheduledAt", async () => {
      const { cartId } = await createCart(customerId, schedulableProductId, 1, 5000);
      const snapshotId = await getCartSummaryId(customerId, addressId);

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(10, 0, 0, 0);

      const res = await postCheckout(
        { summaryId: snapshotId, addressId, scheduledAt: yesterday.toISOString() },
        `sched-past-${Date.now()}`,
      );

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("minutes in the future");

      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });

    it("rejects a scheduledAt more than 30 days ahead", async () => {
      const { cartId } = await createCart(customerId, schedulableProductId, 1, 5000);
      const snapshotId = await getCartSummaryId(customerId, addressId);

      const farFuture = new Date();
      farFuture.setDate(farFuture.getDate() + 31);
      farFuture.setHours(10, 0, 0, 0);

      const res = await postCheckout(
        { summaryId: snapshotId, addressId, scheduledAt: farFuture.toISOString() },
        `sched-far-${Date.now()}`,
      );

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("within 30 days");

      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });
  });

  describe("Immediate checkout compatibility", () => {
    it("creates an immediate order (null scheduledAt) for a non-schedulable product", async () => {
      const { cartId } = await createCart(customerId, nonSchedulableProductId, 1, 3000);
      const snapshotId = await getCartSummaryId(customerId, addressId);

      const key = `sched-immediate-${Date.now()}`;
      const res = await postCheckout(
        { summaryId: snapshotId, addressId, scheduledAt: null },
        key,
      );

      expect(res.status).toBe(201);
      const body = res.body;
      expect(body.success).toBe(true);
      expect(body.data.orders[0].scheduledAt).toBeNull();
      expect(body.data.orders[0].status).toBe("AWAITING_PAYMENT");

      // Verify persisted in DB
      const persisted = await prisma.order.findUnique({ where: { id: body.data.orders[0].id } });
      expect(persisted).not.toBeNull();
      expect(persisted!.scheduledAt).toBeNull();

      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });

    it("creates an immediate order for a schedulable product when scheduledAt is null", async () => {
      const { cartId } = await createCart(customerId, schedulableProductId, 1, 5000);
      const snapshotId = await getCartSummaryId(customerId, addressId);

      const key = `sched-immediate2-${Date.now()}`;
      const res = await postCheckout(
        { summaryId: snapshotId, addressId, scheduledAt: null },
        key,
      );

      expect(res.status).toBe(201);
      expect(res.body.data.orders[0].scheduledAt).toBeNull();

      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });
  });
});

/**
 * Area A — Daily-cap fix verification through real HTTP checkout.
 *
 * Verifies that reserveDailyCap() is called AFTER tx.order.create() but still
 * inside the same Prisma transaction, so the DailyCapReservation.orderId foreign
 * key is satisfied and the whole checkout (order + reservation + counter) is
 * atomic.
 *
 * Covers:
 *   A1. Successful reservation — order created, reservation references it, no FK violation
 *   A2. Reservation failure rolls back checkout — exhausted daily cap → 409, order rolled back, counter unchanged
 *   A3. Multi-vendor checkout — each vendor order gets its own reservation
 *   A4. Concurrent final-slot reservation — competing checkouts cannot exceed cap
 *   A5. Reservation release and idempotency — direct service call
 *
 * Uses real disposable PostgreSQL (port 55432) and in-memory Redis double
 * (checkout idempotency + promo cache).
 */

import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import prisma from "../../src/lib/prisma";
import cartRoutes from "../../src/routes/cartRouter";
import { errorHandler } from "../../src/middlewares/error.middleware";
import { cartSummaryService } from "../../src/services/cartSummary.service";
import { releaseOrderDailyCaps } from "../../src/services/scheduling.service";

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

// ── Mock middleware ─────────────────────────────────────────────────────────
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

// ── Mock authenticate ───────────────────────────────────────────────────────
let testUserId: string;
jest.mock("../../src/middlewares/auth.middleware", () => ({
  authenticate: jest.fn((_req: unknown, _res: unknown, next: () => void) => {
    (_req as any).user = { id: testUserId, role: "CUSTOMER", sessionId: "test-session" };
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
app.use("/api/cart", cartRoutes);
app.use(errorHandler);

const RUN_TAG = `dailycap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ── Tracking: every record created by tests so cleanup removes only ours ────
const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdDishTypeIds: string[] = [];
const createdAddressIds: string[] = [];
const createdCartIds: string[] = [];
const createdSnapshotIds: string[] = [];
const createdOrderIds: string[] = [];
const createdCounterKeys: Array<{ productId: string; date: Date }> = [];
const createdReservationOrderIds: string[] = [];

function uniqueId(prefix: string): string {
  const id = `${prefix}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`;
  return id;
}

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

async function createVendor(email?: string) {
  const id = uniqueId("vend");
  createdUserIds.push(id);
  await prisma.user.create({
    data: { id, name: "DC Vendor", email: email || `${id}@dc.test`, role: "VENDOR", roles: ["VENDOR"], isEmailVerified: true, isLive: true, vendorStatus: "ACTIVE", kycStatus: "VERIFIED", brandName: "DC Vendor", deliveryPreferences: { acceptingOrders: true, baseDeliveryFee: 300, deliveryRadiusKm: 5 } },
  });
  return id;
}

async function createCustomer(email?: string) {
  const id = uniqueId("cust");
  createdUserIds.push(id);
  await prisma.user.create({
    data: { id, name: "DC Customer", email: email || `${id}@dc.test`, role: "CUSTOMER", roles: ["CUSTOMER"], isEmailVerified: true, password: "hashed" },
  });
  return id;
}

async function createCategory() {
  const id = uniqueId("cat");
  createdCategoryIds.push(id);
  await prisma.category.create({ data: { id, name: `DC Cat ${RUN_TAG}`, slug: `dc-cat-${RUN_TAG}`, sortOrder: 1, isActive: true } });
  return id;
}

async function createDishType(categoryId: string) {
  const id = uniqueId("dt");
  createdDishTypeIds.push(id);
  await prisma.dishType.create({ data: { id, name: `DC Dish ${RUN_TAG}`, sortOrder: 1, isActive: true, categoryId } });
  return id;
}

async function createProduct(vendorId: string, dishTypeId: string, categoryId: string, overrides: { isScheduled?: boolean; orderCutoffTime?: string | null; dailyCap?: number | null; price?: number; archived?: boolean } = {}) {
  const id = uniqueId("prod");
  createdProductIds.push(id);
  await prisma.product.create({
    data: { id, name: `DC Product ${RUN_TAG}`, description: "dc product", price: overrides.price ?? 5000, archived: overrides.archived ?? false, dishTypeId, categoryId, trackInventory: false, stock: null, vendorId, isScheduled: overrides.isScheduled ?? false, orderCutoffTime: overrides.orderCutoffTime ?? null, dailyCap: overrides.dailyCap ?? null, thumbnail: null, images: [], video: [], averageRating: 0, reviewCount: 0, totalViews: 0, popularityScore: 0, popularityPercent: 0, isNew: false },
  });
  return id;
}

async function createAddress(userId: string) {
  const id = uniqueId("addr");
  createdAddressIds.push(id);
  await prisma.address.create({ data: { id, userId, label: "Home", street: "123 DC Street", city: "Lagos", state: "Lagos", country: "Nigeria", zipCode: "100001", isDefault: true } });
  return id;
}

async function createCart(customerId: string, productId: string, quantity = 1, unitPrice = 5000) {
  const cartId = uniqueId("cart");
  const cartItemId = uniqueId("cartitem");
  createdCartIds.push(cartId);
  await prisma.cart.create({ data: { id: cartId, customerId, isLocked: false } });
  await prisma.cartItem.create({ data: { id: cartItemId, cartId, productId, quantity, unitPrice, subtotal: unitPrice * quantity, specialRequest: null, options: { create: [] } } });
  return { cartId, cartItemId };
}

async function createSnapshot(userId: string, addressId: string) {
  const summary = await cartSummaryService({ userId, addressId });
  const summaryId = uniqueId("snap");
  createdSnapshotIds.push(summaryId);
  await prisma.cartSummarySnapshot.create({ data: { id: summaryId, userId, snapshot: summary as any, createdAt: new Date() } });
  return summaryId;
}

// ── Cleanup (foreign-key safe, test-created records only) ───────────────────

async function cleanupDb() {
  // Orders, reservations, counters first (they reference each other and products).
  for (const orderId of createdOrderIds) {
    try { await prisma.orderItemOption.deleteMany({ where: { orderItem: { orderId } } }); } catch {}
    try { await prisma.orderItem.deleteMany({ where: { orderId } }); } catch {}
    try { await prisma.order.deleteMany({ where: { id: orderId } }); } catch {}
  }
  for (const { productId, date } of createdCounterKeys) {
    try { await prisma.productDailyCounter.deleteMany({ where: { productId, date } }); } catch {}
  }
  for (const orderId of createdReservationOrderIds) {
    try { await prisma.dailyCapReservation.deleteMany({ where: { orderId } }); } catch {}
  }
  // Carts and snapshots.
  for (const cartId of createdCartIds) {
    try { await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } }); } catch {}
    try { await prisma.cartItem.deleteMany({ where: { cartId } }); } catch {}
    try { await prisma.cart.deleteMany({ where: { id: cartId } }); } catch {}
  }
  for (const summaryId of createdSnapshotIds) {
    try { await prisma.cartSummarySnapshot.deleteMany({ where: { id: summaryId } }); } catch {}
  }
  // Addresses then users.
  for (const addressId of createdAddressIds) {
    try { await prisma.address.deleteMany({ where: { id: addressId } }); } catch {}
  }
  for (const userId of createdUserIds) {
    try { await prisma.user.deleteMany({ where: { id: userId } }); } catch {}
  }
  // Catalog: products before dish types/categories (RESTRICT FK).
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

describe("Area A — Daily-cap fix verification through HTTP checkout", () => {
  let customerId: string;
  let vendorId: string;
  let categoryId: string;
  let dishTypeId: string;
  let schedulableProductId: string;
  let addressId: string;

  beforeAll(async () => {
    customerId = await createCustomer();
    testUserId = customerId;
    vendorId = await createVendor();
    categoryId = await createCategory();
    dishTypeId = await createDishType(categoryId);
    schedulableProductId = await createProduct(vendorId, dishTypeId, categoryId, {
      isScheduled: true, orderCutoffTime: "14:00", dailyCap: 3, price: 5000,
    });
    addressId = await createAddress(customerId);
  });

  afterEach(async () => {
    await cleanupDb();
    createdUserIds.length = 0;
    createdProductIds.length = 0;
    createdCategoryIds.length = 0;
    createdDishTypeIds.length = 0;
    createdAddressIds.length = 0;
    createdCartIds.length = 0;
    createdSnapshotIds.length = 0;
    createdOrderIds.length = 0;
    createdCounterKeys.length = 0;
    createdReservationOrderIds.length = 0;
  });

  afterAll(async () => {
    try {
      await cleanupDb();
    } catch (e) {
      console.error("Cleanup error:", (e as Error).message);
    }
    await prisma.$disconnect();
  });

  describe("A1 — Successful reservation", () => {
    it("creates order + reservation + counter atomically, no FK violation", async () => {
      const { cartId } = await createCart(customerId, schedulableProductId, 1, 5000);
      const snapshotId = await createSnapshot(customerId, addressId);

      const key = `dailycap-a1-${Date.now()}`;
      const res = await postCheckout({ summaryId: snapshotId, addressId }, key);
      expect(res.status).toBe(201);

      const order = res.body.data.orders[0];
      expect(order.id).toBeDefined();
      expect(order.idempotencyKey).toBe(key);

      const persisted = await prisma.order.findUnique({ where: { id: order.id } });
      expect(persisted).not.toBeNull();
      expect(persisted!.vendorId).toBe(vendorId);
      expect(persisted!.customerId).toBe(customerId);

      const reservations = await prisma.dailyCapReservation.findMany({
        where: { orderId: order.id, released: false },
      });
      expect(reservations).toHaveLength(1);
      expect(reservations[0].productId).toBe(schedulableProductId);

      const today = new Date();
      const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const counter = await prisma.productDailyCounter.findUnique({
        where: { productId_date: { productId: schedulableProductId, date: dayStart } },
      });
      expect(counter?.count).toBe(1);
    });
  });

  describe("A2 — Reservation failure rolls back checkout", () => {
    it("exhausted daily cap → 409, order rolled back, counter unchanged", async () => {
      const cappedProduct = await createProduct(vendorId, dishTypeId, categoryId, {
        isScheduled: true, orderCutoffTime: null, dailyCap: 1, price: 5000,
      });

      const preOrderId = uniqueId("preorder");
      await prisma.order.create({
        data: { id: preOrderId, customerId, vendorId, basePrice: 1000, extraCharge: 0, deliveryFee: 0, totalPrice: 1000, status: "AWAITING_PAYMENT", idempotencyKey: `pre-${Date.now()}`, paymentStatus: "PENDING", paidAt: new Date(), protectedUntil: new Date(Date.now() + 15 * 60 * 1000) },
      });

      const today = new Date();
      const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      await prisma.$transaction(async (tx) => {
        await tx.productDailyCounter.create({ data: { productId: cappedProduct, date: dayStart, count: 1 } });
        await tx.dailyCapReservation.create({ data: { orderId: preOrderId, productId: cappedProduct, day: dayStart, quantity: 1, released: false } });
      });
      createdCounterKeys.push({ productId: cappedProduct, date: dayStart });
      createdReservationOrderIds.push(preOrderId);

      const { cartId } = await createCart(customerId, cappedProduct, 1, 5000);
      const snapshotId = await createSnapshot(customerId, addressId);

      const key = `dailycap-a2-${Date.now()}`;
      const res = await postCheckout({ summaryId: snapshotId, addressId }, key);
      expect(res.status).toBe(409);

      const orders = await prisma.order.findMany({ where: { idempotencyKey: key } });
      expect(orders).toHaveLength(0);

      const counter = await prisma.productDailyCounter.findUnique({
        where: { productId_date: { productId: cappedProduct, date: dayStart } },
      });
      expect(counter?.count).toBe(1);
    });
  });

  describe("A3 — Multi-vendor checkout", () => {
    it("each vendor order gets its own reservation", async () => {
      const vendor2Id = await createVendor(`vend2-${RUN_TAG}@dc.test`);
      const product2Id = await createProduct(vendor2Id, dishTypeId, categoryId, {
        isScheduled: true, orderCutoffTime: "14:00", dailyCap: 2, price: 7000,
      });

      const cartId = uniqueId("cart-multi");
      createdCartIds.push(cartId);
      await prisma.cart.create({ data: { id: cartId, customerId, isLocked: false } });
      await prisma.cartItem.create({ data: { id: uniqueId("ci1"), cartId, productId: schedulableProductId, quantity: 1, unitPrice: 5000, subtotal: 5000, specialRequest: null, options: { create: [] } } });
      await prisma.cartItem.create({ data: { id: uniqueId("ci2"), cartId, productId: product2Id, quantity: 1, unitPrice: 7000, subtotal: 7000, specialRequest: null, options: { create: [] } } });

      const snapshotId = await createSnapshot(customerId, addressId);
      const key = `dailycap-a3-${Date.now()}`;
      const res = await postCheckout({ summaryId: snapshotId, addressId }, key);
      expect(res.status).toBe(201);

      expect(res.body.data.orders).toHaveLength(2);
      for (const order of res.body.data.orders) {
        const reservations = await prisma.dailyCapReservation.findMany({
          where: { orderId: order.id, released: false },
        });
        expect(reservations).toHaveLength(1);
      }
    });
  });

  describe("A4 — Concurrent final-slot reservation", () => {
    it("competing checkouts cannot exceed the daily cap", async () => {
      const capProduct = await createProduct(vendorId, dishTypeId, categoryId, {
        isScheduled: true, orderCutoffTime: null, dailyCap: 2, price: 5000,
      });

      const today = new Date();
      const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const preOrderId = uniqueId("preorder");
      await prisma.order.create({
        data: { id: preOrderId, customerId, vendorId, basePrice: 1000, extraCharge: 0, deliveryFee: 0, totalPrice: 1000, status: "AWAITING_PAYMENT", idempotencyKey: `pre-${Date.now()}`, paymentStatus: "PENDING", paidAt: new Date(), protectedUntil: new Date(Date.now() + 15 * 60 * 1000) },
      });
      await prisma.$transaction(async (tx) => {
        await tx.productDailyCounter.create({ data: { productId: capProduct, date: dayStart, count: 1 } });
        await tx.dailyCapReservation.create({ data: { orderId: preOrderId, productId: capProduct, day: dayStart, quantity: 1, released: false } });
      });
      createdCounterKeys.push({ productId: capProduct, date: dayStart });
      createdReservationOrderIds.push(preOrderId);

      const carts = [];
      for (let i = 0; i < 2; i++) {
        const { cartId } = await createCart(customerId, capProduct, 1, 5000);
        const snapshotId = await createSnapshot(customerId, addressId);
        carts.push({ cartId, snapshotId });
      }

      const keyBase = `dailycap-a4-${Date.now()}`;
      const results = await Promise.allSettled(
        carts.map((c, i) =>
          postCheckout({ summaryId: c.snapshotId, addressId }, `${keyBase}-${i}`, nextClientIp()),
        ),
      );

      const statuses = results.map((r) =>
        r.status === "fulfilled" ? (r.value as any).status : "rejected"
      );

      // Exactly 1 should succeed (201), 1 should fail (409 cap exceeded).
      expect(statuses.filter((s) => s === 201).length).toBe(1);
      expect(statuses.filter((s) => s === 409).length).toBe(1);

      const counter = await prisma.productDailyCounter.findUnique({
        where: { productId_date: { productId: capProduct, date: dayStart } },
      });
      expect(counter?.count).toBe(2);
    });
  });

  describe("A5 — Reservation release (direct service call)", () => {
    it("release decrements counter once, idempotent", async () => {
      const releaseProduct = await createProduct(vendorId, dishTypeId, categoryId, {
        isScheduled: false, orderCutoffTime: null, dailyCap: 3, price: 5000,
      });

      const orderId = uniqueId("order");
      createdOrderIds.push(orderId);
      await prisma.order.create({
        data: { id: orderId, customerId, vendorId, basePrice: 5000, extraCharge: 0, deliveryFee: 0, totalPrice: 5000, status: "AWAITING_PAYMENT", idempotencyKey: `rel-${Date.now()}`, paymentStatus: "PENDING", paidAt: new Date(), protectedUntil: new Date(Date.now() + 15 * 60 * 1000) },
      });

      const today = new Date();
      const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

      // Reserve 1 unit directly.
      await prisma.$transaction(async (tx) => {
        await tx.productDailyCounter.create({ data: { productId: releaseProduct, date: dayStart, count: 1 } });
        await tx.dailyCapReservation.create({ data: { orderId, productId: releaseProduct, day: dayStart, quantity: 1, released: false } });
      });
      createdCounterKeys.push({ productId: releaseProduct, date: dayStart });
      createdReservationOrderIds.push(orderId);

      let counter = await prisma.productDailyCounter.findUnique({
        where: { productId_date: { productId: releaseProduct, date: dayStart } },
      });
      expect(counter?.count).toBe(1);

      // Release once via service call.
      await prisma.$transaction(async (tx) => {
        const orderForCaps = await tx.order.findUnique({
          where: { id: orderId },
          select: { id: true, scheduledAt: true, items: { select: { productId: true } } },
        });
        if (orderForCaps) {
          await releaseOrderDailyCaps(tx, orderForCaps);
        }
      });

      counter = await prisma.productDailyCounter.findUnique({
        where: { productId_date: { productId: releaseProduct, date: dayStart } },
      });
      expect(counter?.count).toBe(0);

      // Release again - idempotent (counter stays 0).
      await prisma.$transaction(async (tx) => {
        const orderForCaps = await tx.order.findUnique({
          where: { id: orderId },
          select: { id: true, scheduledAt: true, items: { select: { productId: true } } },
        });
        if (orderForCaps) {
          await releaseOrderDailyCaps(tx, orderForCaps);
        }
      });

      counter = await prisma.productDailyCounter.findUnique({
        where: { productId_date: { productId: releaseProduct, date: dayStart } },
      });
      expect(counter?.count).toBe(0);
    });
  });
});

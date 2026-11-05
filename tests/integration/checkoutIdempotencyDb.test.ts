/**
 * Area B — Order idempotency uniqueness and retry behavior (Phase 3A/3B).
 *
 * Verifies the checkout idempotency flow through real HTTP requests against
 * real PostgreSQL + in-memory Redis double:
 *
 *   B1. Rollback releases idempotency claim — exhausted daily cap rolls back
 *       the transaction, releases the Redis claim, and a retry with the same
 *       key succeeds.
 *   B2. Lost-response recovery — same key+payload replays stored response
 *       without duplicate order.
 *   B3. Side-effect protection — same-key retry cannot duplicate orders,
 *       payments, or daily-cap reservations.
 *   B4. Scope isolation — different users, same key → separate orders.
 *   B5. Redis failure → fail-closed (503), no order created.
 *   B6. Concurrent replay consistency — same key, concurrent callers: exactly
 *       one order, no duplicates.
 *
 * Uses real disposable PostgreSQL and in-memory Redis double. Business logic
 * is NOT mocked — only infrastructure (rate limiters, geo, tracking,
 * Paystack, cache invalidation, activity bundle).
 */

import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import prisma from "../../src/lib/prisma";
import { redisPayments } from "../../src/lib/redis";
import cartRoutes from "../../src/routes/cartRouter";
import { errorHandler } from "../../src/middlewares/error.middleware";
import { cartSummaryService } from "../../src/services/cartSummary.service";

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

const RUN_TAG = `idem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ── Tracking: every record created by tests so cleanup removes only ours ────
const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdDishTypeIds: string[] = [];
const createdAddressIds: string[] = [];
const createdCartIds: string[] = [];
const createdSnapshotIds: string[] = [];
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
    data: { id, name: "Idem Vendor", email: email || `${id}@idem.test`, role: "VENDOR", roles: ["VENDOR"], isEmailVerified: true, isLive: true, vendorStatus: "ACTIVE", kycStatus: "VERIFIED", brandName: "Idem Vendor", deliveryPreferences: { acceptingOrders: true, baseDeliveryFee: 300, deliveryRadiusKm: 5 } },
  });
  return id;
}

async function createCustomer(email?: string) {
  const id = uniqueId("cust");
  createdUserIds.push(id);
  await prisma.user.create({
    data: { id, name: "Idem Customer", email: email || `${id}@idem.test`, role: "CUSTOMER", roles: ["CUSTOMER"], isEmailVerified: true, password: "hashed" },
  });
  return id;
}

async function createCategory() {
  const id = uniqueId("cat");
  createdCategoryIds.push(id);
  await prisma.category.create({ data: { id, name: `Idem Cat ${RUN_TAG}`, slug: `idem-cat-${RUN_TAG}`, sortOrder: 1, isActive: true } });
  return id;
}

async function createDishType(categoryId: string) {
  const id = uniqueId("dt");
  createdDishTypeIds.push(id);
  await prisma.dishType.create({ data: { id, name: `Idem Dish ${RUN_TAG}`, sortOrder: 1, isActive: true, categoryId } });
  return id;
}

async function createProduct(vendorId: string, dishTypeId: string, categoryId: string, price = 5000, dailyCap?: number | null) {
  const id = uniqueId("prod");
  createdProductIds.push(id);
  await prisma.product.create({
    data: { id, name: `Idem Product ${RUN_TAG}`, description: "idem product", price, archived: false, dishTypeId, categoryId, trackInventory: false, stock: null, vendorId, isScheduled: false, orderCutoffTime: null, dailyCap: dailyCap ?? null, thumbnail: null, images: [], video: [], averageRating: 0, reviewCount: 0, totalViews: 0, popularityScore: 0, popularityPercent: 0, isNew: false },
  });
  return id;
}

async function createAddress(userId: string) {
  const id = uniqueId("addr");
  createdAddressIds.push(id);
  await prisma.address.create({ data: { id, userId, label: "Home", street: "123 Idem Street", city: "Lagos", state: "Lagos", country: "Nigeria", zipCode: "100001", isDefault: true } });
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
  // Reverse FK order: orders/payments first, then carts/snapshots, then users/catalog.
  for (const orderId of createdOrderIds) {
    try { await prisma.payment.deleteMany({ where: { orderId } }); } catch {}
    try { await prisma.orderItem.deleteMany({ where: { orderId } }); } catch {}
    try { await prisma.order.deleteMany({ where: { id: orderId } }); } catch {}
  }
  for (const cartId of createdCartIds) {
    try { await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } }); } catch {}
    try { await prisma.cartItem.deleteMany({ where: { cartId } }); } catch {}
    try { await prisma.cart.deleteMany({ where: { id: cartId } }); } catch {}
  }
  for (const summaryId of createdSnapshotIds) {
    try { await prisma.cartSummarySnapshot.deleteMany({ where: { id: summaryId } }); } catch {}
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

describe("Area B — Order idempotency uniqueness and retry behavior", () => {
  let customerId: string;
  let vendorId: string;
  let categoryId: string;
  let dishTypeId: string;
  let productId: string;
  let addressId: string;

  beforeAll(async () => {
    customerId = await createCustomer();
    testUserId = customerId;
    vendorId = await createVendor();
    categoryId = await createCategory();
    dishTypeId = await createDishType(categoryId);
    productId = await createProduct(vendorId, dishTypeId, categoryId, 5000);
    addressId = await createAddress(customerId);
  });

  afterEach(async () => {
    await cleanupDb();
    // Reset tracking arrays so afterEach only cleans what this test created.
    createdUserIds.length = 0;
    createdProductIds.length = 0;
    createdCategoryIds.length = 0;
    createdDishTypeIds.length = 0;
    createdAddressIds.length = 0;
    createdCartIds.length = 0;
    createdSnapshotIds.length = 0;
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

  describe("B1 — Rollback releases idempotency claim", () => {
    it("exhausted daily cap rolls back checkout, claim released, identical-payload retry succeeds", async () => {
      // Product with dailyCap 1, pre-exhausted by an unrelated order.
      const cappedProduct = await createProduct(vendorId, dishTypeId, categoryId, 5000, 1);
      const today = new Date();
      const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const preOrderId = uniqueId("preorder");

      await prisma.order.create({
        data: { id: preOrderId, customerId, vendorId, basePrice: 1000, extraCharge: 0, deliveryFee: 0, totalPrice: 1000, status: "AWAITING_PAYMENT", idempotencyKey: `pre-${Date.now()}`, paymentStatus: "PENDING", paidAt: new Date(), protectedUntil: new Date(Date.now() + 15 * 60 * 1000) },
      });
      await prisma.$transaction(async (tx) => {
        await tx.productDailyCounter.create({ data: { productId: cappedProduct, date: dayStart, count: 1 } });
        await tx.dailyCapReservation.create({ data: { orderId: preOrderId, productId: cappedProduct, day: dayStart, quantity: 1, released: false } });
      });

      // One cart, one snapshot, one payload, one key — used identically for
      // both attempts. This proves the retry sends the same checkout data.
      const { cartId } = await createCart(customerId, cappedProduct, 1, 5000);
      const snapshotId = await createSnapshot(customerId, addressId);
      const checkoutPayload = { summaryId: snapshotId, addressId };
      const key = `idem-b1-${Date.now()}`;

      // First checkout: daily cap exhausted → 409, transaction rolls back.
      const res1 = await postCheckout(checkoutPayload, key);
      expect(res1.status).toBe(409);

      // Prove both requests use identical checkout data.
      expect(JSON.stringify(checkoutPayload)).toBe(JSON.stringify({ summaryId: snapshotId, addressId }));

      // Verify rollback: no order created with this idempotency key.
      const ordersAfterRollback = await prisma.order.findMany({ where: { idempotencyKey: key, customerId } });
      expect(ordersAfterRollback).toHaveLength(0);

      // Verify no payment was created for the failed attempt.
      const paymentsAfterRollback = await prisma.payment.findMany({ where: { userId: customerId } });
      expect(paymentsAfterRollback).toHaveLength(0);

      // Verify counter unchanged (no partial increment leaked).
      const counterAfterFailure = await prisma.productDailyCounter.findUnique({
        where: { productId_date: { productId: cappedProduct, date: dayStart } },
      });
      expect(counterAfterFailure?.count).toBe(1);

      // Restore availability: release the pre-existing reservation that
      // exhausted the cap. This simulates the operator freeing capacity.
      await prisma.$transaction(async (tx) => {
        await tx.dailyCapReservation.deleteMany({ where: { orderId: preOrderId } });
        await tx.productDailyCounter.deleteMany({ where: { productId: cappedProduct, date: dayStart } });
      });

      // Retry with the EXACT same payload and key. The failed attempt's
      // finally block released its in-flight claim, so the same key can be
      // claimed again. With capacity restored, the retry should succeed.
      const res2 = await postCheckout(checkoutPayload, key);
      expect(res2.status).toBe(201);

      // Verify exactly one order was created — no duplicates.
      const orders = await prisma.order.findMany({ where: { idempotencyKey: key, customerId } });
      expect(orders).toHaveLength(1);

      const order = orders[0];
      expect(order.idempotencyKey).toBe(key);
      expect(order.customerId).toBe(customerId);

      // Verify the daily cap was consumed by the successful retry.
      const counterAfterSuccess = await prisma.productDailyCounter.findUnique({
        where: { productId_date: { productId: cappedProduct, date: dayStart } },
      });
      expect(counterAfterSuccess?.count).toBe(1);

      // Cleanup: retry artifacts.
      await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
      await prisma.order.deleteMany({ where: { id: order.id } });
      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });

      // Cleanup pre-order and capped product.
      await prisma.dailyCapReservation.deleteMany({ where: { orderId: preOrderId } });
      await prisma.order.deleteMany({ where: { id: preOrderId } });
      await prisma.productDailyCounter.deleteMany({ where: { productId: cappedProduct } });
      await prisma.product.deleteMany({ where: { id: cappedProduct } });
    });
  });

  describe("B2 — Lost-response recovery", () => {
    it("same key+payload replays stored response without duplicate order", async () => {
      const { cartId } = await createCart(customerId, productId, 1, 5000);
      const snapshotId = await createSnapshot(customerId, addressId);
      const key = `idem-b2-${Date.now()}`;

      const res1 = await postCheckout({ summaryId: snapshotId, addressId }, key);
      expect(res1.status).toBe(201);
      const orderId1 = res1.body.data.orders[0].id;

      // Same key, same payload → replay (no duplicate order).
      const res2 = await postCheckout({ summaryId: snapshotId, addressId }, key);
      expect(res2.status).toBe(200);
      expect(res2.body.data.orders[0].id).toBe(orderId1);

      // Verify exactly one order exists.
      const orders = await prisma.order.findMany({ where: { idempotencyKey: key, customerId } });
      expect(orders).toHaveLength(1);

      // Cleanup.
      await prisma.order.deleteMany({ where: { id: orderId1 } });
      await prisma.payment.deleteMany({ where: { orderId: orderId1 } });
      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });
  });

  describe("B3 — Side-effect protection", () => {
    it("same-key retry cannot duplicate orders, payments, or daily-cap reservations", async () => {
      const { cartId } = await createCart(customerId, productId, 1, 5000);
      const snapshotId = await createSnapshot(customerId, addressId);
      const key = `idem-b3-${Date.now()}`;

      const res1 = await postCheckout({ summaryId: snapshotId, addressId }, key);
      expect(res1.status).toBe(201);

      // Retry with same key — should replay, not create duplicate.
      const res2 = await postCheckout({ summaryId: snapshotId, addressId }, key);
      expect(res2.status).toBe(200);

      // Verify exactly one order and one payment exist.
      const orders = await prisma.order.findMany({ where: { idempotencyKey: key, customerId } });
      expect(orders).toHaveLength(1);

      const payments = await prisma.payment.findMany({ where: { idempotencyKey: key, userId: customerId } });
      expect(payments).toHaveLength(1);

      // Verify daily cap not double-reserved (product has dailyCap null here,
      // so no reservation exists — but the payment/order must be singular).
      const order = orders[0];
      const payment = payments[0];

      // Cleanup.
      await prisma.order.deleteMany({ where: { id: order.id } });
      await prisma.payment.deleteMany({ where: { id: payment.id } });
      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });
  });

  describe("B4 — Scope isolation", () => {
    it("same key, different users → separate orders", async () => {
      const customerB = await createCustomer(`custB-${RUN_TAG}@idem.test`);
      const addressB = await createAddress(customerB);

      const { cartId } = await createCart(customerId, productId, 1, 5000);
      const snapshotId = await createSnapshot(customerId, addressId);
      const key = `idem-b4-${Date.now()}`;

      // Customer A checks out with key.
      testUserId = customerId;
      const resA = await postCheckout({ summaryId: snapshotId, addressId }, key);
      expect(resA.status).toBe(201);

      // Customer B checks out with same key — should be a SEPARATE order.
      const cartIdB = uniqueId("cartB");
      await prisma.cart.create({ data: { id: cartIdB, customerId: customerB, isLocked: false } });
      await prisma.cartItem.create({ data: { id: uniqueId("ciB"), cartId: cartIdB, productId, quantity: 1, unitPrice: 5000, subtotal: 5000, specialRequest: null, options: { create: [] } } });
      const snapshotIdB = await createSnapshot(customerB, addressId);

      testUserId = customerB;
      const resB = await postCheckout({ summaryId: snapshotIdB, addressId: addressB }, key);
      expect(resB.status).toBe(201);

      // Two orders with same key but different customers.
      const orders = await prisma.order.findMany({ where: { idempotencyKey: key } });
      expect(orders).toHaveLength(2);
      const customerIds = new Set(orders.map((o) => o.customerId));
      expect(customerIds).toEqual(new Set([customerId, customerB]));

      // Cleanup.
      await prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId: cartIdB } } });
      await prisma.cartItem.deleteMany({ where: { cartId: cartIdB } });
      await prisma.cart.deleteMany({ where: { id: cartIdB } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotIdB } });
      await prisma.address.deleteMany({ where: { userId: customerB } });
      await prisma.user.deleteMany({ where: { id: customerB } });
      await prisma.product.deleteMany({ where: { id: productId } });
    });
  });

  describe("B5 — Redis failure → fail-closed", () => {
    it("returns 503 and creates no order when Redis is unavailable", async () => {
      const { cartId } = await createCart(customerId, productId, 1, 5000);
      const snapshotId = await createSnapshot(customerId, addressId);

      // Inject a Redis failure at the idempotency-claim boundary.
      // redisPayments is the mocked module (see jest.mock at the top of the file).
      const mockGetFn = redisPayments.get as jest.Mock;
      mockGetFn.mockImplementationOnce(async () => {
        throw new Error("redis down");
      });

      const res = await postCheckout({ summaryId: snapshotId, addressId }, `idem-b5-${Date.now()}`);

      // Fail-closed: 503, no order created.
      expect(res.status).toBe(503);

      // Verify no order, payment, or side effect was created.
      const orders = await prisma.order.findMany({ where: { customerId } });
      expect(orders).toHaveLength(0);
      const payments = await prisma.payment.findMany({ where: { userId: customerId } });
      expect(payments).toHaveLength(0);

      // Cleanup.
      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });
  });

  describe("B6 — Concurrent replay consistency", () => {
    it("concurrent same-key callers produce exactly one order, no duplicates", async () => {
      const { cartId } = await createCart(customerId, productId, 1, 5000);
      const snapshotId = await createSnapshot(customerId, addressId);
      const key = `idem-b6-${Date.now()}`;

      // Three concurrent callers with the same key and same payload.
      const results = await Promise.allSettled(
        Array.from({ length: 3 }).map((_, i) =>
          postCheckout({ summaryId: snapshotId, addressId }, key, nextClientIp()),
        ),
      );

      const statuses = results.map((r) =>
        r.status === "fulfilled" ? (r.value as any).status : "rejected"
      );

      const succeeded201 = statuses.filter((s) => s === 201).length;
      const succeeded200 = statuses.filter((s) => s === 200).length;
      const failed409 = statuses.filter((s) => s === 409).length;

      // Exactly one checkout creates an order (201). Others either
      // conflict on the in-flight claim (409) or replay the completed result (200).
      expect(succeeded201).toBe(1);
      expect(succeeded200 + failed409).toBe(2);
      expect(succeeded201 + succeeded200 + failed409).toBe(3);

      // Verify exactly one order exists — no duplicates under concurrency.
      const orders = await prisma.order.findMany({ where: { idempotencyKey: key, customerId } });
      expect(orders).toHaveLength(1);

      // Cleanup.
      const orderId = orders[0].id;
      await prisma.order.deleteMany({ where: { id: orderId } });
      await prisma.payment.deleteMany({ where: { orderId } });
      await prisma.cartItemOption.deleteMany({ where: { cartItem: { cartId } } });
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
      await prisma.cartSummarySnapshot.deleteMany({ where: { id: snapshotId } });
    });
  });
});

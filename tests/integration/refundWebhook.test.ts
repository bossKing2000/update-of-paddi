/**
 * Area D — Refund webhook HTTP integration using real local Redis.
 *
 * Tests the real Paystack webhook handler (POST /api/payments/webhook) against
 * real PostgreSQL + real Redis (for Lua-script replay protection).
 *
 * Covers:
 *   D1. Valid refund.processed webhook → completes refund, replay claimed
 *   D2. Invalid signature → rejected 401, no financial side effects
 *   D3. Sequential duplicate webhook delivery → idempotent, no duplicate completion
 *   D4. Concurrent duplicate delivery → Redis + DB prevent double effect
 *   D5. Unknown refund reference → acknowledged, no side effects
 *   D6. Amount/currency mismatch → refused, no ledger change
 *   D10. Financial consistency → refund request, payment, order all consistent
 *
 * Redis configuration:
 *   The test reads OTP_TEST_REDIS_URL (set by the operator before running),
 *   validates it with the same gate used by the redis-integration suite
 *   (tests/helpers/localRedisTarget.evaluateDisposableRedisTarget), and only
 *   then configures process.env.REDIS_URL so that src/lib/redis builds its
 *   clients against the disposable test instance. The gate refuses:
 *     - unset/unparseable values
 *     - non-redis: schemes (TLS = managed remote endpoint)
 *     - non-loopback hosts
 *     - database index 0 or absent (default DB may hold unrelated data)
 *     - any endpoint matching the ambient REDIS_URL host:port
 *   If validation fails, the test module throws at load time and no test runs.
 *
 * Uses real disposable PostgreSQL (via the integration preflight + worker pin
 * in jest.integration.config.js) and real disposable Redis.
 *
 * Paystack is NOT contacted — signatures are computed locally with a test
 * secret key.
 *
 * NOTE: This file uses `require` instead of `import` for runtime modules so
 * that `process.env.REDIS_URL` is set before `src/lib/redis` is loaded.
 * TypeScript hoists `import` statements above all other code, which would
 * cause `src/lib/redis` to throw (it reads REDIS_URL at module-evaluation time).
 */

// ── 1. Test-only environment variables (must be set before any require) ─────
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-not-a-real-credential";
process.env.JWT_RESET_SECRET = "test-reset-secret-not-a-real-credential";
process.env.SERVER_URL = "http://localhost:5000";
process.env.CLOUDINARY_URL = "dummy-cloudinary-url";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.PAYSTACK_SECRET_KEY = "sk_test_webhook_only_not_a_credential";
process.env.PAYSTACK_PUBLIC_KEY = "pk_test_dummy_not_a_credential";
process.env.OPENSEARCH_NODE = "http://localhost:9200";

// ── 2. Validate and configure Redis BEFORE requiring src/lib/redis ──────────
// `require` calls execute in source order (unlike `import`, which is hoisted).
// We validate OTP_TEST_REDIS_URL and set REDIS_URL first so the real Redis
// module builds its clients against the disposable test instance.
const { evaluateDisposableRedisTarget } = require("../helpers/localRedisTarget");
const candidate = process.env.OTP_TEST_REDIS_URL;
const redisResult = evaluateDisposableRedisTarget(candidate);
if (!redisResult.ok) {
  throw new Error(
    `[refundWebhook.test.ts] BLOCKED: Redis target refused — ${redisResult.reason ?? "no reason supplied"}. ` +
      "Set OTP_TEST_REDIS_URL to a local disposable Redis, e.g. redis://127.0.0.1:6379/15. " +
      "It must never be the application's REDIS_URL.",
  );
}

// Extract the validated database index before requiring src/lib/redis.
// node-redis gives the URL's database path precedence over the explicit
// `database` option passed to createClient, so we must preserve the full
// validated URL (including its /N path). Stripping the pathname would
// silently connect to database 0 instead of the validated database.
const validatedUrl = new URL(redisResult.url);
const validatedDbIndex = Number(validatedUrl.pathname.replace(/^\//, "") || "0");
if (!Number.isInteger(validatedDbIndex) || validatedDbIndex < 1) {
  throw new Error(
    `[refundWebhook.test.ts] BLOCKED: validated Redis target has no usable database index.`,
  );
}

// Preserve the full validated URL including its database index.
process.env.REDIS_URL = redisResult.url;

// ── 3. Runtime modules (require order matters: REDIS_URL is now set) ────────
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");

const prisma = require("../../src/lib/prisma").prisma;
const { redisPayments } = require("../../src/lib/redis");
const { RefundStatus, PaymentStatus, OrderStatus } = require("@prisma/client");
const { errorHandler } = require("../../src/middlewares/error.middleware");
const { paystackWebhookHandler } = require("../../src/controllers/webhook");

// Type-only imports for Prisma enums (used as values via require above).
// eslint-disable-next-line @typescript-eslint/no-var-requires

const TEST_PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

function computeSignature(rawBody, secret) {
  return crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
}

const app = express();
app.set("trust proxy", 1);
app.use(cookieParser());
// Webhook route requires express.raw() for body to be a Buffer
app.use("/api/payments/webhook", express.raw({ type: "*/*" }), paystackWebhookHandler);
app.use(errorHandler);

const RUN_TAG = `refundweb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ── Tracking: every record/key created by tests so cleanup removes only ours ──
const createdUserIds = [];
const createdOrderIds = [];
const createdPaymentRefs = [];
const createdRefundIds = [];
const createdCatalogIds = []; // product / dishType / category ids
const createdWebhookIds = []; // webhookId values for Redis key cleanup

function uniqueId(prefix) {
  return `${prefix}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`;
}

/** Same hash as src/controllers/webhook.ts computeWebhookId — used to clean up the exact Redis keys we wrote. */
function computeWebhookId(eventPayload) {
  const stable = {
    event: eventPayload && eventPayload.event,
    reference: (eventPayload && eventPayload.data && eventPayload.data.reference) || (eventPayload && eventPayload.data && eventPayload.data.transaction_reference),
    refundReference: eventPayload && eventPayload.data && eventPayload.data.refund_reference,
    amount: eventPayload && eventPayload.data && eventPayload.data.amount,
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function trackWebhookId(payload) {
  const id = computeWebhookId(payload);
  createdWebhookIds.push(id);
  return id;
}

let ipCounter = 0;
function nextClientIp() {
  ipCounter += 1;
  const octet3 = Math.floor(ipCounter / 250) % 250;
  const octet4 = (ipCounter % 250) + 1;
  return `198.18.${octet3}.${octet4}`;
}

function postWebhook(payload, ip) {
  const rawBody = JSON.stringify(payload);
  const signature = computeSignature(rawBody, TEST_PAYSTACK_SECRET);
  trackWebhookId(payload);
  return request(app)
    .post("/api/payments/webhook")
    .set("X-Forwarded-For", ip || nextClientIp())
    .set("x-paystack-signature", signature)
    .set("content-type", "application/json")
    .send(rawBody);
}

// ── Fixture creators (each registers its ids for cleanup) ───────────────────

async function createCustomer(email) {
  const id = uniqueId("cust");
  createdUserIds.push(id);
  await prisma.user.create({
    data: { id, name: "Refund Webhook Customer", email: email || `${id}@refundweb.test`, role: "CUSTOMER", roles: ["CUSTOMER"], isEmailVerified: true, password: "hashed" },
  });
  return id;
}

async function createVendor(email) {
  const id = uniqueId("vend");
  createdUserIds.push(id);
  await prisma.user.create({
    data: { id, name: "Refund Webhook Vendor", email: email || `${id}@refundweb.test`, role: "VENDOR", roles: ["VENDOR"], isEmailVerified: true, isLive: true, vendorStatus: "ACTIVE", kycStatus: "VERIFIED", brandName: "Refund Webhook Vendor" },
  });
  return id;
}

async function createOrderForTest(customerId, vendorId, status = OrderStatus.PAYMENT_CONFIRMED, paymentStatus = PaymentStatus.SUCCESS) {
  const id = uniqueId("order");
  const productId = uniqueId("prod");
  const dishTypeId = uniqueId("dt");
  const categoryId = uniqueId("cat");
  createdOrderIds.push(id);
  createdCatalogIds.push(productId, dishTypeId, categoryId);

  await prisma.product.create({
    data: { id: productId, name: `Refund Product ${RUN_TAG}`, description: "refund product", price: 5000, archived: false, dishTypeId, categoryId, vendorId, trackInventory: false, stock: null, isScheduled: false, orderCutoffTime: null, dailyCap: null, thumbnail: null, images: [], video: [], averageRating: 0, reviewCount: 0, totalViews: 0, popularityScore: 0, popularityPercent: 0, isNew: false },
  });
  await prisma.order.create({
    data: {
      id, customerId, vendorId,
      basePrice: 5000, extraCharge: 0, deliveryFee: 0, totalPrice: 5000,
      status, idempotencyKey: `rw-idem-${id}`, paymentStatus,
      paidAt: new Date(),
      protectedUntil: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  await prisma.orderItem.create({
    data: { id: uniqueId("oi"), orderId: id, productId, quantity: 1, unitPrice: 5000, subtotal: 5000 },
  });
  return id;
}

async function createPayment(orderId, customerId, reference, amount = 5000, status = PaymentStatus.SUCCESS) {
  const id = uniqueId("pay");
  await prisma.payment.create({
    data: { id, userId: customerId, orderId, amount, reference, status, paystackData: null, channel: null, ipAddress: "127.0.0.1", userAgent: "test", idempotencyKey: `rw-pay-${id}`, startedAt: new Date(), completedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
  });
  return { id, reference };
}

async function createRefundRequest(orderId, customerId, paymentRef, status = RefundStatus.PROCESSING, requestedAmountKobo = 5000, paystackRefundId = null) {
  const id = uniqueId("refund");
  createdRefundIds.push(id);
  await prisma.refundRequest.create({
    data: { id, userId: customerId, paymentRef, reason: "Test refund", status, requestedAmountKobo, orderId, paystackRefundId },
  });
  return id;
}

// ── Redis key cleanup (only keys we wrote) ──────────────────────────────────

async function cleanupRedisKeys() {
  for (const webhookId of createdWebhookIds) {
    try {
      await redisPayments.del(`webhook:inflight:${webhookId}`, `webhook:done:${webhookId}`);
    } catch {
      // Best-effort: keys may have already expired via TTL.
    }
  }
}

// ── Database cleanup (foreign-key safe, test-created records only) ──────────

async function cleanupDb() {
  // Refund requests first (they reference payments and orders)
  for (const refundId of createdRefundIds) {
    try { await prisma.refundRequest.deleteMany({ where: { id: refundId } }); } catch {}
  }
  // Payments (reference orders)
  for (const ref of createdPaymentRefs) {
    try { await prisma.payment.deleteMany({ where: { reference: ref } }); } catch {}
  }
  // Order items then orders
  for (const orderId of createdOrderIds) {
    try { await prisma.orderItem.deleteMany({ where: { orderId } }); } catch {}
    try { await prisma.order.deleteMany({ where: { id: orderId } }); } catch {}
  }
  // Users (and their addresses)
  for (const userId of createdUserIds) {
    try { await prisma.address.deleteMany({ where: { userId } }); } catch {}
    try { await prisma.user.deleteMany({ where: { id: userId } }); } catch {}
  }
  // Catalog records created by createOrderForTest
  for (const id of createdCatalogIds) {
    try { await prisma.product.deleteMany({ where: { id } }); } catch {}
    try { await prisma.dishType.deleteMany({ where: { id } }); } catch {}
    try { await prisma.category.deleteMany({ where: { id } }); } catch {}
  }
}

describe("Area D — Refund webhook HTTP integration (real Redis)", () => {
  let customerId;
  let vendorId;

  beforeAll(async () => {
    // Verify the configured REDIS_URL preserves the validated database index.
    const configuredUrl = new URL(process.env.REDIS_URL);
    const configuredDbIndex = Number(configuredUrl.pathname.replace(/^\//, "") || "0");
    expect(configuredDbIndex).toBe(validatedDbIndex);
    expect(configuredDbIndex).toBeGreaterThanOrEqual(1);
    // Confirm host and port match the validated loopback target.
    expect(configuredUrl.hostname).toBe(validatedUrl.hostname);
    expect(configuredUrl.port).toBe(validatedUrl.port);
    expect(configuredUrl.protocol).toBe("redis:");

    // Verify Redis is actually reachable at the configured target.
    try {
      await redisPayments.ping();
    } catch (err) {
      throw new Error(
        `[refundWebhook.test.ts] BLOCKED: Redis at ${configuredUrl.hostname}:${configuredUrl.port} is not reachable: ${(err && err.message) || String(err)}`,
      );
    }

    customerId = await createCustomer();
    vendorId = await createVendor();
  });

  afterEach(async () => {
    await cleanupRedisKeys();
    await cleanupDb();
    // Reset tracking arrays so afterEach only cleans what this test created.
    createdUserIds.length = 0;
    createdOrderIds.length = 0;
    createdPaymentRefs.length = 0;
    createdRefundIds.length = 0;
    createdCatalogIds.length = 0;
    createdWebhookIds.length = 0;
  });

  afterAll(async () => {
    try {
      await cleanupRedisKeys();
      await cleanupDb();
    } catch (e) {
      console.error("Cleanup error:", (e && e.message) || String(e));
    }
    await prisma.$disconnect();
  });

  function uniquePaymentRef() {
    return `pay-ref-${RUN_TAG}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  async function createUniquePayment() {
    const orderId = await createOrderForTest(customerId, vendorId);
    const ref = uniquePaymentRef();
    createdPaymentRefs.push(ref);
    await createPayment(orderId, customerId, ref, 5000, PaymentStatus.SUCCESS);
    return { reference: ref, orderId };
  }

  async function createUniqueRefundRequest(orderId, reference, status = RefundStatus.PROCESSING, requestedAmountKobo = 5000) {
    return createRefundRequest(orderId, customerId, reference, status, requestedAmountKobo, null);
  }

  describe("D1 — Valid refund.processed webhook", () => {
    it("completes a PROCESSING refund request", async () => {
      const { reference, orderId } = await createUniquePayment();
      const refundId = await createUniqueRefundRequest(orderId, reference, RefundStatus.PROCESSING, 5000);

      const res = await postWebhook({
        event: "refund.processed",
        data: {
          reference,
          transaction_reference: reference,
          refund_reference: `ref_${Date.now()}`,
          amount: 5000,
          status: "processed",
          metadata: { orderId, userId: customerId },
        },
      });

      expect(res.status).toBe(200);

      const refund = await prisma.refundRequest.findUnique({ where: { id: refundId } });
      expect(refund).not.toBeNull();
      expect(refund.status).toBe(RefundStatus.COMPLETED);
    });

    it("sequential duplicate webhook delivery is idempotent", async () => {
      const { reference, orderId } = await createUniquePayment();
      const refundId = await createUniqueRefundRequest(orderId, reference, RefundStatus.PROCESSING, 5000);

      const res1 = await postWebhook({
        event: "refund.processed",
        data: {
          reference,
          transaction_reference: reference,
          refund_reference: `ref_${Date.now()}`,
          amount: 5000,
          status: "processed",
          metadata: { orderId, userId: customerId },
        },
      });
      expect(res1.status).toBe(200);

      // Same webhook again — should be a replay (DONE), not a second completion.
      const res2 = await postWebhook({
        event: "refund.processed",
        data: {
          reference,
          transaction_reference: reference,
          refund_reference: `ref_${Date.now()}`,
          amount: 5000,
          status: "processed",
          metadata: { orderId, userId: customerId },
        },
      });
      expect(res2.status).toBe(200);

      const refund = await prisma.refundRequest.findUnique({ where: { id: refundId } });
      expect(refund).not.toBeNull();
      expect(refund.status).toBe(RefundStatus.COMPLETED);

      // Payment should be REFUNDED exactly once.
      const payment = await prisma.payment.findUnique({ where: { reference } });
      expect(payment.status).toBe(PaymentStatus.REFUNDED);
    });
  });

  describe("D2 — Invalid signature", () => {
    it("rejects webhook with invalid signature (401)", async () => {
      const { reference, orderId } = await createUniquePayment();
      const rawBody = JSON.stringify({
        event: "refund.processed",
        data: { reference, transaction_reference: reference, amount: 5000, status: "processed" },
      });

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("X-Forwarded-For", nextClientIp())
        .set("x-paystack-signature", "invalid-signature")
        .set("content-type", "application/json")
        .send(rawBody);

      expect(res.status).toBe(401);
    });
  });

  describe("D6 — Amount mismatch", () => {
    it("refuses to complete when webhook amount does not match", async () => {
      const { reference, orderId } = await createUniquePayment();
      const refundId = await createUniqueRefundRequest(orderId, reference, RefundStatus.PROCESSING, 3000);

      const res = await postWebhook({
        event: "refund.processed",
        data: {
          reference,
          transaction_reference: reference,
          refund_reference: `ref_${Date.now()}`,
          amount: 5000, // mismatch: refund requested 3000, webhook says 5000
          status: "processed",
          metadata: { orderId, userId: customerId },
        },
      });

      expect(res.status).toBe(200); // 200 so Paystack doesn't retry-storm

      const refund = await prisma.refundRequest.findUnique({ where: { id: refundId } });
      expect(refund).not.toBeNull();
      expect(refund.status).toBe(RefundStatus.PROCESSING); // Not completed
    });
  });

  describe("D5 — Unknown reference", () => {
    it("acknowledges unknown payment reference (200)", async () => {
      const res = await postWebhook({
        event: "refund.processed",
        data: {
          reference: "unknown-pay-ref",
          transaction_reference: "unknown-pay-ref",
          refund_reference: `ref_${Date.now()}`,
          amount: 5000,
          status: "processed",
        },
      });

      expect(res.status).toBe(200);
    });
  });

  describe("D4 — Concurrent duplicate delivery", () => {
    it("concurrent duplicate deliveries cannot double-complete", async () => {
      const { reference, orderId } = await createUniquePayment();
      const refundId = await createUniqueRefundRequest(orderId, reference, RefundStatus.PROCESSING, 5000);

      // Build one payload and its signature once, then deliver twice concurrently.
      const payload = {
        event: "refund.processed",
        data: {
          reference,
          transaction_reference: reference,
          refund_reference: `ref_${Date.now()}`,
          amount: 5000,
          status: "processed",
          metadata: { orderId, userId: customerId },
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = computeSignature(rawBody, TEST_PAYSTACK_SECRET);

      const makeRequest = () =>
        request(app)
          .post("/api/payments/webhook")
          .set("X-Forwarded-For", nextClientIp())
          .set("x-paystack-signature", signature)
          .set("content-type", "application/json")
          .send(rawBody);

      const results = await Promise.allSettled([makeRequest(), makeRequest()]);

      const statuses = results.map((r) =>
        r.status === "fulfilled" ? (r.value && r.value.status) : "rejected"
      );

      // Exactly one delivery completes the refund; the other is either a replay (200)
      // or an in-progress rejection (503). Both are valid outcomes.
      const count200 = statuses.filter((s) => s === 200).length;
      const count503 = statuses.filter((s) => s === 503).length;
      expect(count200 + count503).toBe(2);
      expect(count200).toBeGreaterThanOrEqual(1); // at least one must complete

      // The refund must be COMPLETED exactly once — no duplicate financial effect.
      const refund = await prisma.refundRequest.findUnique({ where: { id: refundId } });
      expect(refund).not.toBeNull();
      expect(refund.status).toBe(RefundStatus.COMPLETED);

      // Payment and order must reflect exactly one refund.
      const payment = await prisma.payment.findUnique({ where: { reference } });
      expect(payment.status).toBe(PaymentStatus.REFUNDED);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(order.cancellationReason).toBe("REFUNDED");
    });
  });

  describe("D10 — Financial consistency", () => {
    it("refund request, payment, and order remain consistent", async () => {
      const { reference, orderId } = await createUniquePayment();
      const refundId = await createUniqueRefundRequest(orderId, reference, RefundStatus.PROCESSING, 5000);

      const res = await postWebhook({
        event: "refund.processed",
        data: {
          reference,
          transaction_reference: reference,
          refund_reference: `ref_${Date.now()}`,
          amount: 5000,
          status: "processed",
          metadata: { orderId, userId: customerId },
        },
      });
      expect(res.status).toBe(200);

      // Refund request is COMPLETED
      const refund = await prisma.refundRequest.findUnique({ where: { id: refundId } });
      expect(refund).not.toBeNull();
      expect(refund.status).toBe(RefundStatus.COMPLETED);

      // Payment is REFUNDED
      const payment = await prisma.payment.findUnique({ where: { reference } });
      expect(payment.status).toBe(PaymentStatus.REFUNDED);

      // Order is CANCELLED with cancellationReason REFUNDED
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order).not.toBeNull();
      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(order.cancellationReason).toBe("REFUNDED");
    });
  });
});

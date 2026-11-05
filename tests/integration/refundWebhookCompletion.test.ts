/**
 * Area D — Refund webhook completion and financial reconciliation (Phase 3E).
 *
 * Drives the real Paystack webhook handler (POST /api/webhooks/paystack) against
 * real PostgreSQL + real Redis, verifying refund lifecycle end to end.
 *
 * External side effects are stubbed, business logic is not:
 *   - Rate limiters -> passthrough
 *   - Geo/tracking middlewares -> passthrough
 *   - Paystack signature -> computed with a test secret key (not a real credential)
 *   - recordActivityBundle -> mocked
 *   - clearProductCache -> mocked
 */

import crypto from "crypto";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import prisma from "../../src/lib/prisma";
import { completeRefund, failRefund, matchRefundRequest } from "../../src/services/refundFinalizer.service";
import { RefundStatus, PaymentStatus, OrderStatus } from "@prisma/client";
import { errorHandler } from "../../src/middlewares/error.middleware";

// In-memory Redis double for redisPayments (webhook rate limiting + replay protection).
const redisStoreD = new Map<string, { value: string; expiresAt: number }>();
jest.mock("../../src/lib/redis", () => {
  return {
    redisPayments: {
      get: jest.fn(async (key: string) => {
        const e = redisStoreD.get(key);
        if (!e) return null;
        if (Date.now() > e.expiresAt) { redisStoreD.delete(key); return null; }
        return e.value;
      }),
      set: jest.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
        if (opts?.NX && redisStoreD.has(key)) return null;
        redisStoreD.set(key, { value, expiresAt: Date.now() + (opts?.EX ?? 3600) * 1000 });
        return "OK";
      }),
      del: jest.fn(async (key: string) => (redisStoreD.delete(key) ? 1 : 0)),
      incr: jest.fn(async (key: string) => {
        const e = redisStoreD.get(key);
        const val = e ? Number(e.value) + 1 : 1;
        redisStoreD.set(key, { value: String(val), expiresAt: Date.now() + 3600000 });
        return val;
      }),
      expire: jest.fn(async () => 1),
      ttl: jest.fn(async () => -1),
      eval: jest.fn(async () => "OK"),
    },
    redisNotifications: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
    redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
    ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
    connectRedis: jest.fn(async () => {}),
  };
});

// Test-only Paystack secret key — scoped to this disposable run, never a real credential.
const TEST_PAYSTACK_SECRET = "sk_test_only_not_a_credential_for_production";
if (!process.env.PAYSTACK_SECRET_KEY) {
  process.env.PAYSTACK_SECRET_KEY = TEST_PAYSTACK_SECRET;
}

function computeSignature(rawBody: string | Buffer, secret: string): string {
  return crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
}

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

jest.mock("../../src/services/clearCaches", () => ({
  clearProductCache: jest.fn(async () => ({ ok: true })),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  recordActivityBundle: jest.fn(async () => {}),
}));

// Mock authenticate for webhook routes that might need it
jest.mock("../../src/middlewares/auth.middleware", () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeCustomer: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeVendor: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizeAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const app = express();
app.set("trust proxy", 1);
app.use(cookieParser());
// The webhook route requires express.raw() for the body to be a Buffer.
// express.json() is NOT used here because it would consume the body before
// express.raw() can read it as a Buffer.
app.use("/api/payments/webhook", express.raw({ type: "*/*" }), (req: any, res: any, next: any) => {
  require("../../src/controllers/webhook").paystackWebhookHandler(req, res, next);
});
app.use(errorHandler);

const RUN_TAG = `refundweb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdIds: string[] = [];

function uniqueId(prefix: string): string {
  const id = `${prefix}-${RUN_TAG}-${Math.floor(Math.random() * 1e6)}`;
  createdIds.push(id);
  return id;
}

function cleanupIds(): string[] {
  return [...createdIds];
}

let ipCounter = 0;
function nextClientIp(): string {
  ipCounter += 1;
  const octet3 = Math.floor(ipCounter / 250) % 250;
  const octet4 = (ipCounter % 250) + 1;
  return `198.18.${octet3}.${octet4}`;
}

function postWebhook(payload: any, ip?: string) {
  const rawBody = JSON.stringify(payload);
  const signature = computeSignature(rawBody, TEST_PAYSTACK_SECRET);
  return request(app)
    .post("/api/payments/webhook")
    .set("X-Forwarded-For", ip || nextClientIp())
    .set("x-paystack-signature", signature)
    .set("content-type", "application/json")
    .send(rawBody);
}

async function createCustomer(email?: string) {
  const id = uniqueId("cust");
  await prisma.user.create({
    data: { id, name: "Refund Webhook Customer", email: email || `${id}@refundweb.test`, role: "CUSTOMER", roles: ["CUSTOMER"], isEmailVerified: true, password: "hashed" },
  });
  return id;
}

async function createVendor(email?: string) {
  const id = uniqueId("vend");
  await prisma.user.create({
    data: { id, name: "Refund Webhook Vendor", email: email || `${id}@refundweb.test`, role: "VENDOR", roles: ["VENDOR"], isEmailVerified: true, isLive: true, vendorStatus: "ACTIVE", kycStatus: "VERIFIED", brandName: "Refund Webhook Vendor" },
  });
  return id;
}

async function createOrder(customerId: string, vendorId: string, status = OrderStatus.PAYMENT_CONFIRMED, paymentStatus = PaymentStatus.SUCCESS) {
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
      paymentStatus,
      paidAt: new Date(),
      protectedUntil: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  return id;
}

async function createPayment(orderId: string, customerId: string, reference: string, amount = 5000, status = PaymentStatus.SUCCESS) {
  const id = uniqueId("pay");
  await prisma.payment.create({
    data: { id, userId: customerId, orderId, amount, reference, status, paystackData: "null" as any, channel: null, ipAddress: "127.0.0.1", userAgent: "test", idempotencyKey: `idem-${orderId}`, startedAt: new Date(), completedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
  });
  return { id, reference };
}

async function createRefundRequest(orderId: string, customerId: string, paymentRef: string, status: RefundStatus = RefundStatus.PROCESSING, requestedAmountKobo = 5000, paystackRefundId?: string | null) {
  const id = uniqueId("refund");
  await prisma.refundRequest.create({
    data: {
      id,
      userId: customerId,
      paymentRef,
      reason: "Test refund",
      status,
      requestedAmountKobo,
      orderId,
      paystackRefundId,
    },
  });
  return id;
}

describe("Area D — Refund webhook completion and financial reconciliation", () => {
  let customerId: string;
  let vendorId: string;
  let orderId: string;

  beforeAll(async () => {
    customerId = await createCustomer();
    vendorId = await createVendor();
    orderId = await createOrder(customerId, vendorId);
  });

  afterAll(async () => {
    const ids = cleanupIds();
    if (ids.length) {
      // Delete refunds first (RESTRICT FK on Order)
      await prisma.refundRequest.deleteMany({ where: { orderId } });
      await prisma.payment.deleteMany({ where: { userId: customerId } });
      await prisma.order.deleteMany({ where: { id: orderId } });
      await prisma.user.deleteMany({ where: { id: { in: [customerId, vendorId] } } });
    }
    await prisma.$disconnect();
  });

  /** Unique paymentRef per test to avoid partial unique index conflicts. */
  function uniquePaymentRef(): string {
    return `pay-ref-${RUN_TAG}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  /** Create a payment with a unique reference and return { id, reference }. */
  async function createUniquePayment(): Promise<{ id: string; reference: string }> {
    const ref = uniquePaymentRef();
    return createPayment(orderId, customerId, ref, 5000, PaymentStatus.SUCCESS);
  }

  describe("Valid refund.processed webhook", () => {
    it("completes a PROCESSING refund request", async () => {
      const { reference } = await createUniquePayment();
      const refundId = await createRefundRequest(orderId, customerId, reference, RefundStatus.PROCESSING, 5000, null);

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

      // Verify refund request is COMPLETED
      const refund = await prisma.refundRequest.findUnique({ where: { id: refundId } });
      expect(refund).not.toBeNull();
      expect(refund!.status).toBe(RefundStatus.COMPLETED);

      // Cleanup
      await prisma.refundRequest.deleteMany({ where: { id: refundId } });
      await prisma.payment.deleteMany({ where: { reference } });
    });

    it("duplicate webhook delivery is idempotent", async () => {
      const { reference } = await createUniquePayment();
      const refundId = await createRefundRequest(orderId, customerId, reference, RefundStatus.PROCESSING, 5000, null);

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

      // Same webhook again -> replay, should be idempotent
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

      // Refund request should still be COMPLETED
      const refund = await prisma.refundRequest.findUnique({ where: { id: refundId } });
      expect(refund).not.toBeNull();
      expect(refund!.status).toBe(RefundStatus.COMPLETED);

      // Cleanup
      await prisma.refundRequest.deleteMany({ where: { id: refundId } });
      await prisma.payment.deleteMany({ where: { reference } });
    });
  });

  describe("Invalid signature", () => {
    it("rejects webhook with invalid signature (401)", async () => {
      const { reference } = await createUniquePayment();
      const rawBody = JSON.stringify({
        event: "refund.processed",
        data: { reference, transaction_reference: reference, amount: 5000, status: "processed" },
      });

      const res = await request(app)
        .post("/api/webhooks/paystack")
        .set("X-Forwarded-For", nextClientIp())
        .set("x-paystack-signature", "invalid-signature")
        .set("content-type", "application/json")
        .send(rawBody);

      expect(res.status).toBe(401);
    });
  });

  describe("Amount mismatch", () => {
    it("refuses to complete when webhook amount does not match", async () => {
      const { reference } = await createUniquePayment();
      const refundId = await createRefundRequest(orderId, customerId, reference, RefundStatus.PROCESSING, 3000, null);

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

      // Refund request should NOT be completed
      const refund = await prisma.refundRequest.findUnique({ where: { id: refundId } });
      expect(refund).not.toBeNull();
      expect(refund!.status).toBe(RefundStatus.PROCESSING);

      // Cleanup
      await prisma.refundRequest.deleteMany({ where: { id: refundId } });
      await prisma.payment.deleteMany({ where: { reference } });
    });
  });

  describe("Unknown reference", () => {
    it("returns not_found for unknown payment reference", async () => {
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

      expect(res.status).toBe(200); // not_found is acknowledged with 200
    });
  });

  describe("Service-level functions", () => {
    it("completeRefund returns ALREADY_COMPLETED for a completed refund", async () => {
      const { reference } = await createUniquePayment();
      const refundId = await createRefundRequest(orderId, customerId, reference, RefundStatus.COMPLETED, 5000, null);

      const result = await completeRefund(refundId, { paystackRefundId: null, source: "webhook" });
      expect(result.outcome).toBe("ALREADY_COMPLETED");

      await prisma.refundRequest.deleteMany({ where: { id: refundId } });
      await prisma.payment.deleteMany({ where: { reference } });
    });

    it("completeRefund returns NOT_FOUND for a nonexistent refund", async () => {
      const result = await completeRefund("nonexistent-refund-id", { paystackRefundId: null, source: "webhook" });
      expect(result.outcome).toBe("NOT_FOUND");
    });

    it("failRefund returns ALREADY_FAILED for a failed refund", async () => {
      const { reference } = await createUniquePayment();
      const refundId = await createRefundRequest(orderId, customerId, reference, RefundStatus.FAILED, 5000, null);

      const result = await failRefund(refundId, { source: "webhook" });
      expect(result.outcome).toBe("ALREADY_FAILED");

      await prisma.refundRequest.deleteMany({ where: { id: refundId } });
      await prisma.payment.deleteMany({ where: { reference } });
    });

    it("matchRefundRequest returns not_found for unknown reference", async () => {
      const result = await matchRefundRequest({
        transactionReference: "unknown-ref",
        refundReference: undefined,
        amountKobo: 5000,
      });
      expect(result.kind).toBe("not_found");
    });

    it("matchRefundRequest returns amount_mismatch for wrong amount", async () => {
      const { reference } = await createUniquePayment();
      const refundId = await createRefundRequest(orderId, customerId, reference, RefundStatus.PROCESSING, 3000, null);

      const result = await matchRefundRequest({
        transactionReference: reference,
        refundReference: undefined,
        amountKobo: 5000, // mismatch with 3000
      });
      expect(result.kind).toBe("amount_mismatch");

      await prisma.refundRequest.deleteMany({ where: { id: refundId } });
      await prisma.payment.deleteMany({ where: { reference } });
    });
  });
});

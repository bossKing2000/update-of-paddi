import { Response } from "express";
import { z } from "zod";
import axios from "axios";
import { initializePayment, verifyPayment } from "../services/paymentService";
import { resolveRefundOrderId } from "../services/orderSnapshot.service";
import { finalizePaymentSuccess } from "../services/paymentFinalizer.service";
import { createAuditLog } from "../utils/auditLog.service";
import prisma from "../lib/prisma";
import config from "../config/config";
import { getClientInfo } from "../utils/ip";
import { AuthRequest } from "../middlewares/auth.middleware";
import {
  OrderStatus,
  PaymentStatus,
  ActivityType,
  RefundStatus,
  Prisma,
} from "@prisma/client";
import { recordActivityBundle } from "../utils/activityUtils";
import { assertVendorAvailableForOrdering } from "../services/vendorAvailability.service";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import {
  AppError,
  NotFoundError,
  ValidationError,
  ConflictError,
  ForbiddenError,
  UpstreamServiceError,
} from "../errors/AppError";
import { ensureString } from "../utils/paramUtils";
import { nowUtc, toUtc, addMinutesUtc, isBeforeUtc } from "../utils/time";
import { logger } from "../lib/logger";
import { redisPayments } from "../lib/redis";
import { acquireLock, releaseLock, PAYMENT_LOCK_COMMAND_TIMEOUT_MS } from "../lib/redisLock";
import { SUPPORTED_CHANNELS } from "../services/paymentService";

// Single source — paymentService is authority for allowed channels.
// For NGN marketplace: filter to relevant channels only (hide ZA/EFT etc by default)
const NGN_ALLOWED_CHANNELS = ["card", "bank", "ussd", "bank_transfer"] as const;
const ALLOWED_CHANNELS = NGN_ALLOWED_CHANNELS;

export const startPaymentSchema = z.object({
  idempotencyKey: z.string().min(1, "idempotencyKey is required"),
  mobileSdk: z.boolean().optional(),
  channels: z.array(z.enum(ALLOWED_CHANNELS)).optional(),
});

/**
 * Fetches every order in a checkout batch (a multi-vendor cart produces
 * one order per vendor, all sharing an idempotencyKey) and validates
 * they're all eligible for payment together — one Paystack transaction
 * covers the whole batch.
 */

// Stage F (E-02): shared active-payment lookup backing the P2002
// race-loser path. Matches the pre-charge reuse lookups exactly:
// newest PENDING/INITIATED row for this (user, key).
async function findActivePayment(userId: string, idempotencyKey: string) {
  return prisma.payment.findFirst({
    where: {
      idempotencyKey,
      userId,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
    },
    orderBy: { createdAt: "desc" },
  });
}

function isUniqueConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}
async function getPayableOrderBatch(idempotencyKey: string, userId: string) {
  const orders = await prisma.order.findMany({
    where: { idempotencyKey, customerId: userId },
    include: {
      payments: true,
      items: {
        include: {
          product: { select: { id: true, name: true, archived: true } },
        },
      },
    },
  });

  if (orders.length === 0) throw new NotFoundError("Order");

  const notAwaitingPayment = orders.find(
    (o) => o.status !== OrderStatus.AWAITING_PAYMENT,
  );
  if (notAwaitingPayment) {
    throw new ConflictError(
      `Order ${notAwaitingPayment.id} is not eligible for payment (status: ${notAwaitingPayment.status})`,
    );
  }

  const alreadyPaid = orders.some((o) =>
    o.payments.some((p) => p.status === PaymentStatus.SUCCESS),
  );
  if (alreadyPaid)
    throw new ConflictError("This order has already been paid for");

  return orders;
}

/** Throws if any item across the whole batch belongs to a product that's been archived. */
function assertProductsStillLive(
  orders: Awaited<ReturnType<typeof getPayableOrderBatch>>,
) {
  for (const order of orders) {
    for (const item of order.items) {
      if (item.product.archived) {
        throw new ValidationError(
          `Product "${item.product.name}" is no longer available and cannot accept payments.`,
        );
      }
    }
  }
}

/**
 * Vendor Live gate: no NEW payment may be initiated for orders whose vendor
 * has gone offline or paused orders. Already-paid/completed orders are
 * untouched — this only stops fresh marketplace activity mid-flow.
 */
async function assertVendorsStillOperating(
  orders: Awaited<ReturnType<typeof getPayableOrderBatch>>,
) {
  const vendorIds = [...new Set(orders.map((o) => o.vendorId))];
  const vendors = await prisma.user.findMany({
    where: { id: { in: vendorIds } },
    select: {
      id: true,
      name: true,
      brandName: true,
      isLive: true,
      vendorStatus: true,
      deliveryPreferences: true,
    },
  });
  const byId = new Map(vendors.map((v) => [v.id, v]));

  for (const vendorId of vendorIds) {
    const vendor = byId.get(vendorId);
    assertVendorAvailableForOrdering(
      vendor ? { ...vendor, kycStatus: null } : null,
      vendor ? `${vendor.brandName || vendor.name}` : "This vendor",
    );
  }
}

// POST /api/payments/start
export const initiateOrderPayment = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const parsed = startPaymentSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid request data",
      parsed.error.flatten().fieldErrors,
    );
  const { idempotencyKey, mobileSdk = false, channels } = parsed.data;

  const orders = await getPayableOrderBatch(idempotencyKey, userId);
  assertProductsStillLive(orders);
  await assertVendorsStillOperating(orders);

  const now = nowUtc();
  const paymentWindowMinutes = 15;
  const finalPaymentExpiresAt = addMinutesUtc(now, paymentWindowMinutes);
  const totalAmount = orders.reduce((sum, o) => sum + o.totalPrice, 0); // integer kobo (Phase 3A)

  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new ValidationError("Invalid order amount", { totalAmount });
  }
  // totalAmount is already integer kobo; Paystack's minimum is ₦1.00 = 100 kobo.
  if (totalAmount < 100) {
    throw new ValidationError("Amount too small for Paystack (minimum ₦1.00)");
  }

  const customer = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!customer) throw new NotFoundError("User");
  if (
    !customer.email ||
    !z.string().email().safeParse(customer.email).success
  ) {
    throw new AppError(
      "Customer email is invalid. Please update your profile.",
      409,
      "PROFILE_EMAIL_INVALID",
      { code: "PROFILE_EMAIL_INVALID", email: customer.email },
    );
  }
  if (!config.paystackSecret || !config.paystackSecret.startsWith("sk_")) {
    logger.error({ userId, idempotencyKey }, "Paystack secret misconfigured");
    throw new UpstreamServiceError(
      "Paystack",
      "Payment service is temporarily unavailable. Your order is saved and you can try payment again from Orders.",
      { code: "PAYSTACK_INVALID_KEY" },
    );
  }

  // Validate channels against canonical allowlist
  if (channels && channels.length > 0) {
    const invalid = channels.filter(
      (c) => !(ALLOWED_CHANNELS as readonly string[]).includes(c),
    );
    if (invalid.length > 0) {
      throw new ValidationError(
        "Invalid payment channel",
        { invalidChannels: invalid, allowedChannels: ALLOWED_CHANNELS },
        "INVALID_PAYMENT_METHOD",
      );
    }
  }

  const { ip, userAgent, deviceId } = getClientInfo(req);
  // mobileSdk flag no longer creates unverifiable local reference — all flows use hosted Paystack checkout
  if (mobileSdk) {
    logger.warn(
      { userId, idempotencyKey, mobileSdk },
      "mobileSdk flag deprecated — routing through hosted checkout",
    );
  }
  const channel =
    req.headers["x-device-channel"]?.toString().toLowerCase() === "mobile"
      ? "mobile"
      : "web";

  logger.info(
    {
      idempotencyKey,
      orderIds: orders.map((o) => o.id),
      amount: totalAmount,
      channel,
      channels,
    },
    "Initiating payment",
  );

  // Concurrency lock: two simultaneous POST /payments/start for the same
  // batch (double-click, two tabs/WebViews, a client retry racing the
  // original) can both pass the "any existing PENDING?" check below
  // before either has written its Payment row, producing two separate
  // Paystack transactions for one order batch. SET NX EX makes claiming
  // this idempotencyKey atomic across all instances; only the request
  // holding the lock may create/reuse a Payment for it. 20s comfortably
  // covers a Paystack initialize round-trip; the lock is always released
  // in `finally`, and NX means a crash before release just costs the
  // next request a short wait for the TTL rather than corrupting state.
  const initLockKey = `payment:init:${userId}:${idempotencyKey}`;
  const lock = await acquireLock(redisPayments, initLockKey, 20, {
    timeoutMs: PAYMENT_LOCK_COMMAND_TIMEOUT_MS,
  });
  if (lock === null) {
    // Someone else is mid-initialization for this exact batch right now.
    // Don't create a competing Paystack transaction — surface a
    // retry-friendly conflict instead.
    throw new ConflictError(
      "Payment is already being initialized for this order — please wait a moment and retry.",
    );
  }

  try {
    // Idempotency: reuse existing valid PENDING payment for same checkout batch instead of creating a second Paystack transaction.
    // Prevents double-click / retry / concurrent duplicate initialization. Respects existing 15-minute payment window.
    const existingPending = await prisma.payment.findFirst({
      where: {
        idempotencyKey,
        userId,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (
      existingPending &&
      existingPending.expiresAt &&
      isBeforeUtc(now, toUtc(existingPending.expiresAt))
    ) {
      const existingUrl = (existingPending.paystackData as any)
        ?.authorization_url as string | undefined;
      logger.info(
        { idempotencyKey, existingReference: existingPending.reference },
        "Reusing existing PENDING payment",
      );
      return sendCreated(
        res,
        {
          paymentUrl:
            existingUrl ||
            `https://checkout.paystack.com/${existingPending.reference}`,
          reference: existingPending.reference,
          startedAt: (
            existingPending.startedAt || existingPending.createdAt
          ).toISOString(),
          expiresAt: existingPending.expiresAt.toISOString(),
        },
        "Payment already initialized",
      );
    }

    // Record that payment was actually attempted — this field existed in
    // the schema but was never set anywhere before.
    await prisma.order.updateMany({
      where: { id: { in: orders.map((o) => o.id) } },
      data: { paymentInitiatedAt: now },
    });

    const basePaymentData = {
      amount: totalAmount, // integer kobo (Phase 3A) — Paystack expects kobo
      status: PaymentStatus.PENDING,
      startedAt: now,
      expiresAt: finalPaymentExpiresAt,
      channel: channels ? channels.join(",") : channel,
      ipAddress: ip || "unknown",
      deviceId,
      userAgent: userAgent || "unknown",
      user: { connect: { id: userId } },
      order: { connect: { id: orders[0].id } }, // primary order — full batch resolved via idempotencyKey
      idempotencyKey,
    };

    let paymentInit: any;
    try {
      paymentInit = await initializePayment(
        basePaymentData.amount,
        customer.email,
        { userId, idempotencyKey, platform: "web" },
        {
          channels,
          currency: "NGN",
          callbackUrl: config.paystackCallbackUrl || undefined,
        },
      );
    } catch (err: any) {
      const paystackData = err?.response?.data;
      const paystackMessage: string =
        paystackData?.message || err?.message || "Unknown Paystack error";
      const paystackStatus: number | undefined = err?.response?.status;
      // Structured logging without secrets
      logger.error(
        {
          err: paystackData || err.message,
          userId,
          idempotencyKey,
          amount: basePaymentData.amount,
          hasEmail: !!customer.email,
          channels,
          paystackStatus,
        },
        "initializePayment Paystack failed",
      );

      // Map to customer-friendly but structured error
      let code: string | undefined;
      let clientMessage =
        "Payment service is temporarily unavailable. Your order is saved and you can try payment again from Orders.";
      if (
        paystackStatus === 401 ||
        paystackMessage.toLowerCase().includes("invalid key") ||
        paystackMessage.toLowerCase().includes("api key")
      ) {
        code = "PAYSTACK_INVALID_KEY";
        clientMessage = "Payment configuration error. Please contact support.";
      } else if (paystackMessage.toLowerCase().includes("email")) {
        code = "PAYSTACK_INVALID_EMAIL";
        clientMessage =
          "Customer email is invalid. Please update your profile.";
      } else if (paystackMessage.toLowerCase().includes("amount")) {
        code = "PAYSTACK_INVALID_AMOUNT";
      } else if (
        paystackStatus === 400 &&
        paystackMessage.toLowerCase().includes("channel")
      ) {
        code = "PAYSTACK_INVALID_CHANNEL";
        clientMessage =
          "Selected payment method is not available. Please try another method.";
      } else if (!paystackStatus) {
        code = "PAYSTACK_UNAVAILABLE";
      }

      throw new UpstreamServiceError("Paystack", clientMessage, {
        provider: "Paystack",
        paystackStatus,
        paystackMessage,
        code,
        channels,
      } as any);
    }
    // Stage F (E-02): the partial unique backstop
    // (Payment_userId_idempotencyKey_active_key) turns a lost lookup race
    // into P2002 instead of a duplicate row. Reread the winner and reuse
    // it — never initialize Paystack twice, never create a second row.
    try {
      await prisma.payment.create({
        data: {
          ...basePaymentData,
          reference: paymentInit.reference,
          paystackData: {
            authorization_url: paymentInit.authorization_url,
            access_code: (paymentInit as any).access_code,
          } as any,
        },
      });
    } catch (err) {
      if (!isUniqueConflict(err)) throw err;
      const winner = await findActivePayment(userId, idempotencyKey);
      if (!winner || !winner.expiresAt) throw err;
      const winnerUrl = (winner.paystackData as any)
        ?.authorization_url as string | undefined;
      logger.info(
        { idempotencyKey, winnerReference: winner.reference },
        "Payment create raced on active backstop; reusing winner",
      );
      return sendCreated(
        res,
        {
          paymentUrl:
            winnerUrl || `https://checkout.paystack.com/${winner.reference}`,
          reference: winner.reference,
          startedAt: (winner.startedAt || winner.createdAt).toISOString(),
          expiresAt: winner.expiresAt.toISOString(),
        },
        "Payment already initialized",
      );
    }

    return sendCreated(
      res,
      {
        paymentUrl: paymentInit.authorization_url,
        reference: paymentInit.reference,
        startedAt: now.toISOString(),
        expiresAt: finalPaymentExpiresAt.toISOString(),
      },
      "Payment initialized successfully",
    );
  } finally {
    const released = await releaseLock(redisPayments, lock, {
      timeoutMs: PAYMENT_LOCK_COMMAND_TIMEOUT_MS,
    });
    if (!released) {
      logger.warn(
        { initLockKey },
        "Payment init lock had already expired/been reassigned by release time",
      );
    }
  }
};

// GET /api/payments/confirm/:reference — post-redirect fallback confirmation
export const confirmPayment = async (req: AuthRequest, res: Response) => {
  const reference = ensureString(req.params.reference);

  const existing = await prisma.payment.findUnique({ where: { reference } });
  if (!existing) throw new NotFoundError("Payment");
  // BOLA fix: ensure caller owns the payment before triggering verification/finalize
  if (existing.userId !== req.user!.id) {
    throw new ForbiddenError(
      "You don't have permission to confirm this payment",
      "FORBIDDEN",
    );
  }

  if (existing.status === PaymentStatus.SUCCESS) {
    return sendSuccess(res, { payment: existing }, "Payment already confirmed");
  }

  const paymentData = await verifyPayment(reference);
  if (paymentData.status !== "success") {
    throw new ValidationError("Payment not successful", {
      paystackStatus: paymentData.status,
    });
  }

  const result = await finalizePaymentSuccess({
    reference,
    amountKobo: paymentData.amount, // integer kobo from Paystack (Phase 3A)
    currency: paymentData.currency,
    customerIdFromGateway: paymentData.metadata?.userId,
    channel: paymentData.channel,
    paystackData: paymentData,
    authorization: paymentData.authorization,
  });

  if (
    result.outcome === "SUCCESS" ||
    result.outcome === "ALREADY_PROCESSED" ||
    result.outcome === "SUCCESS_REFUND_PENDING"
  ) {
    // Phase 3.2.6 (F-A3): the charge is real and captured, but one or more
    // orders were already cancelled, so a refund request was filed for them
    // instead of confirming fulfilment. The customer is told their money is
    // being returned rather than that the order is confirmed.
    return sendSuccess(
      res,
      {
        orders: result.orders,
        refundPendingOrderIds: result.refundPendingOrderIds ?? [],
      },
      result.outcome === "SUCCESS_REFUND_PENDING"
        ? "Payment received. This order was already cancelled, so a refund has been requested."
        : "Payment verified and order(s) confirmed",
    );
  }

  const outcomeMessages: Record<string, string> = {
    AMOUNT_MISMATCH:
      "The amount paid doesn't match the order total. Our team has been notified.",
    CUSTOMER_MISMATCH: "This payment doesn't belong to your account.",
    LATE_PAYMENT:
      "This payment arrived after the order's payment window expired.",
    // FIN-07-02: the charge is real but the order can no longer be fulfilled.
    // The obligation is filed and waits for administrative approval; saying so
    // is more honest than the generic fallback below.
    LATE_CAPTURE_REFUND_FILED:
      "This payment arrived after the order expired, so a refund has been requested.",
    LOCKED:
      "This payment is already being processed — please check back in a moment.",
    PAYMENT_NOT_FOUND: "Payment not found.",
  };
  throw new ConflictError(
    outcomeMessages[result.outcome] || "Unable to confirm payment",
  );
};

// GET /api/payments/user
export const getAllPaymentsForUser = async (
  req: AuthRequest,
  res: Response,
) => {
  const payments = await prisma.payment.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      reference: true,
      amount: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
      metadata: true,
      orderId: true,
      idempotencyKey: true,
      order: {
        select: { protectedUntil: true, status: true, totalPrice: true },
      },
    },
  });

  // A payment's idempotencyKey may cover more than one order (multi-vendor
  // checkout) — resolve the full order list per payment in one batched
  // query rather than N+1 queries.
  const keysNeedingLookup = [
    ...new Set(
      payments.filter((p) => p.idempotencyKey).map((p) => p.idempotencyKey!),
    ),
  ];
  const ordersByKey = keysNeedingLookup.length
    ? await prisma.order.findMany({
        where: {
          idempotencyKey: { in: keysNeedingLookup },
          customerId: req.user!.id,
        },
        select: {
          id: true,
          idempotencyKey: true,
          status: true,
          totalPrice: true,
          vendorId: true,
        },
      })
    : [];

  const mappedPayments = payments.map((p) => {
    const batchOrders = p.idempotencyKey
      ? ordersByKey.filter((o) => o.idempotencyKey === p.idempotencyKey)
      : [];
    return {
      id: p.id,
      reference: p.reference,
      amount: p.amount,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      expiresAt: p.expiresAt,
      metadata: p.metadata,
      orderId: p.orderId,
      orderStatus: p.order?.status,
      orderTotalPrice: p.order?.totalPrice,
      orders: batchOrders.length > 0 ? batchOrders : undefined,
    };
  });

  return sendSuccess(
    res,
    { payments: mappedPayments },
    "Payments retrieved successfully",
  );
};

// POST /api/payments/refund
export const requestRefund = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { reference, reason, requestedAmountKobo } = req.body as {
    reference?: string;
    reason?: string;
    requestedAmountKobo?: number | null;
  };
  if (!reference || !reason)
    throw new ValidationError("reference and reason are required");

  // Validate an explicitly-supplied partial refund amount before it ever
  // reaches the database. Null/undefined means "full remaining balance"
  // (the documented customer self-service default) and is resolved to a
  // concrete kobo value at admin-approval time. A supplied amount must be
  // a finite, strictly-positive integer kobo — zero or negative has no
  // meaning as a customer refund request, and non-integers would silently
  // corrupt the kobo ledger.
  let validatedKobo: number | null = null;
  if (requestedAmountKobo !== undefined && requestedAmountKobo !== null) {
    if (
      typeof requestedAmountKobo !== "number" ||
      !Number.isFinite(requestedAmountKobo) ||
      !Number.isInteger(requestedAmountKobo) ||
      requestedAmountKobo < 1
    ) {
      throw new ValidationError("requestedAmountKobo must be a positive integer in kobo");
    }
    validatedKobo = requestedAmountKobo;
  }

  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment || payment.userId !== userId) throw new NotFoundError("Payment");
  if (payment.status !== PaymentStatus.SUCCESS)
    throw new ValidationError("Only successful payments can be refunded");

  // Batch G: recoverability. A prior request blocks a new one only while
  // it can still move money (PENDING/APPROVED/PROCESSING) or already moved
  // it (COMPLETED). Terminal FAILED/REJECTED requests hold no reservation
  // (released on failure; never reserved on rejection), so the customer
  // may re-request after fixing the underlying issue instead of requiring
  // database intervention. Over-refund protection is unchanged: the admin
  // submit path still bounds every approval by the remaining balance.
  const alreadyRequested = await prisma.refundRequest.findFirst({
    where: {
      paymentRef: reference,
      status: {
        in: [
          RefundStatus.PENDING,
          RefundStatus.APPROVED,
          RefundStatus.PROCESSING,
          RefundStatus.COMPLETED,
        ],
      },
    },
  });
  if (alreadyRequested)
    throw new ConflictError("Refund already requested for this payment");

  // Phase 3.2b: attribute to the exact order when the payment maps to
  // precisely one of this user's orders (multi-order batches stay NULL).
  const refundOrderId = await resolveRefundOrderId(prisma, payment, userId);

  const refundData: {
    userId: string;
    paymentRef: string;
    reason: string;
    status: RefundStatus;
    orderId: string | null;
    requestedAmountKobo?: number | null;
  } = {
    userId,
    paymentRef: reference,
    reason,
    status: RefundStatus.PENDING,
    orderId: refundOrderId,
  };
  // Only persist an explicitly-supplied amount. An amountless (null/undefined)
  // request leaves the column NULL — "full remaining balance" is resolved at
  // admin-approval time — so the key is absent rather than stored as an
  // explicit NULL that the legacy `requestedAmountKobo ?? remaining` fallback
  // would treat identically either way, but keeping the key absent preserves
  // the documented amountless contract.
  if (validatedKobo !== null) {
    refundData.requestedAmountKobo = validatedKobo;
  }

  await prisma.refundRequest.create({
    data: refundData,
  });

  const order = await prisma.order.findUnique({
    where: { id: payment.orderId },
    select: { vendorId: true },
  });

  await recordActivityBundle({
    req,
    actorId: userId,
    orderId: payment.orderId,
    actions: [
      {
        type: ActivityType.REFUND_REQUESTED,
        title: "Refund Requested",
        message: `We've received your refund request for payment #${reference}. Our team will review it shortly.`,
        targetId: userId,
        socketEvent: "REFUND",
        metadata: {
          type: "REFUND_REQUESTED",
          route: `/orders/${payment.orderId}`,
          orderId: payment.orderId,
          reference,
          reason,
        },
      },
    ],
    audit: {
      action: "REFUND_REQUESTED",
      metadata: {
        orderId: payment.orderId,
        reference,
        reason,
        userId,
        vendorId: order?.vendorId,
      },
    },
    notifyRealtime: true,
    notifyPush: true,
  });

  return sendSuccess(res, {}, "Refund request submitted successfully");
};

// GET /api/payments/refunds — customer's own refund requests (no schema change)
export const getMyRefunds = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const refunds = await prisma.refundRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      paymentRef: true,
      reason: true,
      status: true,
      requestedAmountKobo: true,
      paystackRefundId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return sendSuccess(res, { refunds }, "Refunds retrieved successfully");
};

// ───────────────────────────────────────────────
// Utility: verify payment for an order (used internally, e.g. by fulfillment gates)
// ───────────────────────────────────────────────
export async function verifyOrderPayment(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      totalPrice: true,
      payments: {
        where: { status: PaymentStatus.SUCCESS },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
}

// GET /api/payments/orders/:orderId/verify-payment
export const verifyPaymentBeforeFulfillment = async (
  req: AuthRequest,
  res: Response,
) => {
  const orderId = ensureString(req.params.orderId);
  if (!orderId) throw new ValidationError("Missing orderId parameter");

  const result = await verifyOrderPayment(orderId);

  if (
    !result ||
    result.status !== OrderStatus.PAYMENT_CONFIRMED ||
    result.payments.length === 0
  ) {
    await createAuditLog({
      userId: req.user?.id || null,
      action: "FULFILLMENT_CHECK_FAILED",
      req,
      metadata: { orderId, status: result?.status },
    });
    throw new ConflictError("Payment not verified for this order");
  }

  await createAuditLog({
    userId: req.user?.id || null,
    action: "FULFILLMENT_CHECK_PASSED",
    req,
    metadata: { orderId, paymentId: result.payments[0].id },
  });
  return sendSuccess(
    res,
    { confirmed: true, payment: result.payments[0] },
    "Payment verified",
  );
};

/**
 * =========================
 *  SAVE NEW CARD TOKEN
 * =========================
 */
export const saveCardToken = async (req: AuthRequest, res: Response) => {
  const { cardToken, last4, brand } = req.body;
  const userId = req.user!.id;

  if (!cardToken || !last4 || !brand)
    throw new ValidationError(
      "Missing required fields: cardToken, last4, brand",
    );

  const existingCard = await prisma.userPaymentMethod.findFirst({
    where: { cardToken, userId },
  });
  if (existingCard) throw new ConflictError("This card is already saved");
  // Global uniqueness guard — prevent stealing another user's reusable authorization_code
  const globalExisting = await prisma.userPaymentMethod.findUnique({
    where: { cardToken },
  });
  if (globalExisting && globalExisting.userId !== userId) {
    throw new ConflictError("This card is already saved to another account");
  }

  await prisma.userPaymentMethod.create({
    data: { userId, cardToken, last4, brand, isDefault: false },
  });
  await createAuditLog({
    userId,
    action: "CARD_TOKEN_SAVED",
    req,
    metadata: { maskedToken: "****" + last4, brand },
  });

  return sendCreated(res, {}, "Card saved successfully");
};

/**
 * =========================
 *  CHARGE A SAVED CARD
 * =========================
 * Brought online — previously fully commented out, blocked on not having
 * a clean shared finalizer to call into. finalizePaymentSuccess now makes
 * this a thin wrapper around the same confirmation logic every other
 * entry point uses.
 */
const chargeSavedCardSchema = z.object({
  idempotencyKey: z.string().min(1),
  cardId: z.string().min(1),
});

export const chargeSavedCard = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  const parsed = chargeSavedCardSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid request",
      parsed.error.flatten().fieldErrors,
    );
  const { idempotencyKey, cardId } = parsed.data;

  const [card, user] = await Promise.all([
    prisma.userPaymentMethod.findFirst({ where: { id: cardId, userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
  ]);
  if (!card) throw new NotFoundError("Saved card");
  if (!user?.email) throw new NotFoundError("User");
  const userEmail = user.email;

  const orders = await getPayableOrderBatch(idempotencyKey, userId);
  assertProductsStillLive(orders);
  await assertVendorsStillOperating(orders);

  const totalAmount = orders.reduce((sum, o) => sum + o.totalPrice, 0); // integer kobo (Phase 3A)
  const now = nowUtc();

  // Same concurrent-double-charge race as initiateOrderPayment — see the
  // comment there. A double-tap on "pay with saved card" can otherwise
  // fire two charge_authorization calls for the same batch.
  const initLockKey = `payment:init:${userId}:${idempotencyKey}`;
  const lock = await acquireLock(redisPayments, initLockKey, 20, {
    timeoutMs: PAYMENT_LOCK_COMMAND_TIMEOUT_MS,
  });
  if (lock === null) {
    throw new ConflictError(
      "Payment is already being initialized for this order — please wait a moment and retry.",
    );
  }

  try {
    // Phase 3.2b idempotency: reuse the existing active Payment for this
    // exact (user, idempotencyKey) instead of charging Paystack again —
    // same lookup semantics as initiateOrderPayment above. Sequential
    // retries (client timeout, double-tap after lock release, abandoned
    // OTP) must not mint a second Payment row or a second Paystack charge.
    // No amount comparison, matching the normal-path reuse contract.
    const existingActive = await prisma.payment.findFirst({
      where: {
        idempotencyKey,
        userId,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (
      existingActive &&
      existingActive.expiresAt &&
      isBeforeUtc(now, toUtc(existingActive.expiresAt))
    ) {
      logger.info(
        { idempotencyKey, existingReference: existingActive.reference },
        "chargeSavedCard: reusing existing active payment",
      );
      if (existingActive.status === PaymentStatus.INITIATED) {
        return sendSuccess(
          res,
          { requiresOtp: true, reference: existingActive.reference },
          "OTP required to complete this charge",
        );
      }
      return sendSuccess(
        res,
        {
          reference: existingActive.reference,
          startedAt: (
            existingActive.startedAt || existingActive.createdAt
          ).toISOString(),
          expiresAt: existingActive.expiresAt.toISOString(),
        },
        "Payment already in progress for this order",
      );
    }

    await prisma.order.updateMany({
      where: { id: { in: orders.map((o) => o.id) } },
      data: { paymentInitiatedAt: now },
    });

    let response;
    try {
      response = await axios.post(
        "https://api.paystack.co/transaction/charge_authorization",
        {
          authorization_code: card.cardToken,
          email: userEmail,
          amount: totalAmount, // integer kobo (Phase 3A) — Paystack expects kobo
        },
        { headers: { Authorization: `Bearer ${config.paystackSecret}` } },
      );
    } catch (err: any) {
      logger.error(
        { err: err?.response?.data || err.message, userId, idempotencyKey },
        "chargeSavedCard: Paystack request failed",
      );
      throw new UpstreamServiceError("Paystack", "Failed to charge saved card");
    }

    const data = response.data.data;

    // Some cards require an OTP even when charging a saved token — the
    // client needs to collect it and call submitOtp with this reference.
    if (data.status === "send_otp") {
      // Stage F (E-02): same race-loser reuse as the success branch —
      // return the winner's OTP continuation instead of a duplicate row.
      try {
        await prisma.payment.create({
          data: {
            userId,
            orderId: orders[0].id,
            idempotencyKey,
            reference: data.reference,
            amount: totalAmount, // integer kobo (Phase 3A) — Paystack expects kobo
            status: PaymentStatus.INITIATED,
            channel: "saved_card",
            expiresAt: addMinutesUtc(now, 15),
          },
        });
      } catch (err) {
        if (!isUniqueConflict(err)) throw err;
        const winner = await findActivePayment(userId, idempotencyKey);
        if (!winner) throw err;
        logger.info(
          { idempotencyKey, winnerReference: winner.reference },
          "Saved-card OTP create raced on active backstop; reusing winner",
        );
        if (winner.status === PaymentStatus.INITIATED) {
          return sendSuccess(
            res,
            { requiresOtp: true, reference: winner.reference },
            "OTP required to complete this charge",
          );
        }
        if (!winner.expiresAt) throw err;
        return sendSuccess(
          res,
          {
            reference: winner.reference,
            startedAt: (winner.startedAt || winner.createdAt).toISOString(),
            expiresAt: winner.expiresAt.toISOString(),
          },
          "Payment already in progress for this order",
        );
      }
      return sendSuccess(
        res,
        { requiresOtp: true, reference: data.reference },
        "OTP required to complete this charge",
      );
    }

    if (data.status !== "success") {
      await createAuditLog({
        userId,
        action: "CHARGE_SAVED_CARD_FAILED",
        req,
        metadata: { idempotencyKey, paystackResponse: data },
      });
      throw new ValidationError(data.gateway_response || "Charge failed", {
        paystackStatus: data.status,
      });
    }

    // Stage F (E-02): lost lookup race lands here as P2002 from the
    // active-payment backstop. Reuse the winner's reference/response
    // instead of recording a duplicate row. (The loser's Paystack charge,
    // if it succeeded, is an orphan for reconciliation — the Redis lock
    // remains the primary double-charge protection; see Stage E notes.)
    try {
      await prisma.payment.create({
        data: {
          userId,
          orderId: orders[0].id,
          idempotencyKey,
          reference: data.reference,
          amount: totalAmount, // integer kobo (Phase 3A) — Paystack expects kobo
          status: PaymentStatus.PENDING,
          channel: "saved_card",
          expiresAt: addMinutesUtc(now, 15),
        },
      });
    } catch (err) {
      if (!isUniqueConflict(err)) throw err;
      const winner = await findActivePayment(userId, idempotencyKey);
      if (!winner || !winner.expiresAt) throw err;
      logger.info(
        { idempotencyKey, winnerReference: winner.reference },
        "Saved-card create raced on active backstop; reusing winner",
      );
      if (winner.status === PaymentStatus.INITIATED) {
        return sendSuccess(
          res,
          { requiresOtp: true, reference: winner.reference },
          "OTP required to complete this charge",
        );
      }
      return sendSuccess(
        res,
        {
          reference: winner.reference,
          startedAt: (winner.startedAt || winner.createdAt).toISOString(),
          expiresAt: winner.expiresAt.toISOString(),
        },
        "Payment already in progress for this order",
      );
    }

    const result = await finalizePaymentSuccess({
      reference: data.reference,
      amountKobo: data.amount, // integer kobo from Paystack (Phase 3A)
      currency: data.currency,
      customerIdFromGateway: userId,
      channel: "saved_card",
      paystackData: data,
    });

    await createAuditLog({
      userId,
      action: "CHARGE_SAVED_CARD_SUCCESS",
      req,
      metadata: {
        idempotencyKey,
        reference: data.reference,
        outcome: result.outcome,
      },
    });

    return sendSuccess(
      res,
      { reference: data.reference, orders: result.orders },
      "Payment successful",
    );
  } finally {
    const released = await releaseLock(redisPayments, lock, {
      timeoutMs: PAYMENT_LOCK_COMMAND_TIMEOUT_MS,
    });
    if (!released) {
      logger.warn(
        { initLockKey },
        "Payment init lock had already expired/been reassigned by release time",
      );
    }
  }
};

// POST /api/payments/cards/submit-otp
const submitOtpSchema = z.object({
  reference: z.string().min(1),
  otp: z.string().min(1),
});

export const submitOtp = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const parsed = submitOtpSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid request",
      parsed.error.flatten().fieldErrors,
    );
  const { reference, otp } = parsed.data;

  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment || payment.userId !== userId) throw new NotFoundError("Payment");
  if (payment.status === PaymentStatus.SUCCESS)
    return sendSuccess(res, {}, "Payment already confirmed");

  let response;
  try {
    response = await axios.post(
      "https://api.paystack.co/transaction/submit_otp",
      { otp, reference },
      { headers: { Authorization: `Bearer ${config.paystackSecret}` } },
    );
  } catch (err: any) {
    logger.error(
      { err: err?.response?.data || err.message, reference },
      "submitOtp: Paystack request failed",
    );
    throw new UpstreamServiceError("Paystack", "Failed to submit OTP");
  }

  const data = response.data;

  if (data.status === true && data.data.status === "success") {
    const result = await finalizePaymentSuccess({
      reference,
      amountKobo: data.data.amount, // integer kobo from Paystack (Phase 3A)
      currency: data.data.currency,
      customerIdFromGateway: userId,
      paystackData: data.data,
    });
    await createAuditLog({
      userId,
      action: "SUBMIT_OTP_SUCCESS",
      req,
      metadata: { reference, outcome: result.outcome },
    });
    return sendSuccess(
      res,
      { orders: result.orders },
      "Payment confirmed via OTP",
    );
  }

  if (data.status === true && data.data.status === "send_pin") {
    return sendSuccess(
      res,
      { requiresPin: true },
      "Card requires PIN before completing OTP",
    );
  }

  await createAuditLog({
    userId,
    action: "SUBMIT_OTP_FAILED",
    req,
    metadata: { reference, paystackResponse: data },
  });
  throw new ValidationError(data.message || "Failed to confirm OTP", data);
};

/**
 * =========================
 *  GET ALL SAVED CARDS
 * =========================
 */
export const getSavedCards = async (req: AuthRequest, res: Response) => {
  const cards = await prisma.userPaymentMethod.findMany({
    where: { userId: req.user!.id },
    select: {
      id: true,
      last4: true,
      brand: true,
      isDefault: true,
      createdAt: true,
    },
    orderBy: { isDefault: "desc" },
  });
  return sendSuccess(res, { cards }, "Saved cards retrieved successfully");
};

/**
 * =========================
 *  SET DEFAULT CARD
 * =========================
 */
export const setDefaultCard = async (req: AuthRequest, res: Response) => {
  const { cardId } = req.body;
  const userId = req.user!.id;
  if (!cardId) throw new ValidationError("Missing required field: cardId");

  const card = await prisma.userPaymentMethod.findFirst({
    where: { id: cardId, userId },
  });
  if (!card) throw new NotFoundError("Card");

  await prisma.$transaction([
    prisma.userPaymentMethod.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.userPaymentMethod.update({
      where: { id: cardId },
      data: { isDefault: true },
    }),
  ]);

  await createAuditLog({
    userId,
    action: "SET_DEFAULT_CARD",
    req,
    metadata: { cardId },
  });
  return sendSuccess(res, {}, "Default card updated");
};

/**
 * =========================
 *  DELETE SAVED CARD
 * =========================
 */
export const deleteSavedCard = async (req: AuthRequest, res: Response) => {
  const cardId = ensureString(req.params.cardId);
  const userId = req.user!.id;
  if (!cardId) throw new ValidationError("Missing cardId in request params");

  const card = await prisma.userPaymentMethod.findFirst({
    where: { id: cardId, userId },
  });
  if (!card) throw new NotFoundError("Card");

  await prisma.userPaymentMethod.delete({ where: { id: cardId } });
  await createAuditLog({
    userId,
    action: "DELETE_SAVED_CARD",
    req,
    metadata: { cardId },
  });

  return sendSuccess(res, {}, "Card removed successfully");
};

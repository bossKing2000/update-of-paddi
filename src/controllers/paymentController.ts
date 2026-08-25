import { Response } from "express";
import { z } from "zod";
import axios from "axios";
import { initializePayment, verifyPayment } from "../services/paymentService";
import { finalizePaymentSuccess } from "../services/paymentFinalizer.service";
import { createAuditLog } from "../utils/auditLog.service";
import prisma from "../lib/prisma";
import config from "../config/config";
import { getClientInfo } from "../utils/ip";
import { AuthRequest } from "../middlewares/auth.middleware";
import { OrderStatus, PaymentStatus, ActivityType, RefundStatus } from "@prisma/client";
import { recordActivityBundle } from "../utils/activityUtils";
import { assertVendorAvailableForOrdering } from "../services/vendorAvailability.service";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import { NotFoundError, ValidationError, ConflictError, ForbiddenError, UpstreamServiceError } from "../errors/AppError";
import { ensureString } from "../utils/paramUtils";
import { nowUtc, toUtc, addMinutesUtc } from "../utils/time";
import { logger } from "../lib/logger";

export const startPaymentSchema = z.object({
  idempotencyKey: z.string().min(1, "idempotencyKey is required"),
  mobileSdk: z.boolean().optional(),
});

/**
 * Fetches every order in a checkout batch (a multi-vendor cart produces
 * one order per vendor, all sharing an idempotencyKey) and validates
 * they're all eligible for payment together — one Paystack transaction
 * covers the whole batch.
 */
async function getPayableOrderBatch(idempotencyKey: string, userId: string) {
  const orders = await prisma.order.findMany({
    where: { idempotencyKey, customerId: userId },
    include: {
      payments: true,
      items: {
        include: {
          product: { select: { id: true, name: true, isLive: true, productSchedule: { select: { takeDownAt: true, graceMinutes: true } } } },
        },
      },
    },
  });

  if (orders.length === 0) throw new NotFoundError("Order");

  const notAwaitingPayment = orders.find((o) => o.status !== OrderStatus.AWAITING_PAYMENT);
  if (notAwaitingPayment) {
    throw new ConflictError(`Order ${notAwaitingPayment.id} is not eligible for payment (status: ${notAwaitingPayment.status})`);
  }

  const alreadyPaid = orders.some((o) => o.payments.some((p) => p.status === PaymentStatus.SUCCESS));
  if (alreadyPaid) throw new ConflictError("This order has already been paid for");

  return orders;
}

/** Throws if any item across the whole batch belongs to a product that's gone offline. */
function assertProductsStillLive(orders: Awaited<ReturnType<typeof getPayableOrderBatch>>) {
  const now = nowUtc();
  for (const order of orders) {
    for (const item of order.items) {
      const schedule = item.product.productSchedule;
      if (schedule?.takeDownAt) {
        const grace = schedule.graceMinutes ?? 0;
        const effectiveClose = addMinutesUtc(toUtc(schedule.takeDownAt), grace);
        if (now >= effectiveClose) {
          throw new ValidationError(`Product "${item.product.name}" is offline and cannot accept payments.`);
        }
      }
    }
  }
}

/**
 * Vendor Live gate: no NEW payment may be initiated for orders whose vendor
 * has gone offline or paused orders. Already-paid/completed orders are
 * untouched — this only stops fresh marketplace activity mid-flow.
 */
async function assertVendorsStillOperating(orders: Awaited<ReturnType<typeof getPayableOrderBatch>>) {
  const vendorIds = [...new Set(orders.map((o) => o.vendorId))];
  const vendors = await prisma.user.findMany({
    where: { id: { in: vendorIds } },
    select: { id: true, name: true, brandName: true, isLive: true, deliveryPreferences: true },
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
  if (!parsed.success) throw new ValidationError("Invalid request data", parsed.error.flatten().fieldErrors);
  const { idempotencyKey, mobileSdk = false } = parsed.data;

  const orders = await getPayableOrderBatch(idempotencyKey, userId);
  assertProductsStillLive(orders);
  await assertVendorsStillOperating(orders);

  const now = nowUtc();
  const paymentWindowMinutes = 15;
  const finalPaymentExpiresAt = addMinutesUtc(now, paymentWindowMinutes);
  const totalAmount = orders.reduce((sum, o) => sum + o.totalPrice, 0);

  const customer = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!customer) throw new NotFoundError("User");

  const { ip, userAgent, deviceId } = getClientInfo(req);
  const channel = mobileSdk || req.headers["x-device-channel"]?.toString().toLowerCase() === "mobile" ? "mobile" : "web";

  logger.info({ idempotencyKey, orderIds: orders.map((o) => o.id), amount: totalAmount, channel }, "Initiating payment");

  // Record that payment was actually attempted — this field existed in
  // the schema but was never set anywhere before.
  await prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { paymentInitiatedAt: now } });

  const basePaymentData = {
    amount: Math.round(totalAmount * 100), // kobo
    status: PaymentStatus.PENDING,
    startedAt: now,
    expiresAt: finalPaymentExpiresAt,
    channel,
    ipAddress: ip || "unknown",
    deviceId,
    userAgent: userAgent || "unknown",
    user: { connect: { id: userId } },
    order: { connect: { id: orders[0].id } }, // primary order — full batch resolved via idempotencyKey
    idempotencyKey,
  };

  if (mobileSdk) {
    const reference = `order_${orders[0].id}_${Date.now()}`;
    await prisma.payment.create({ data: { ...basePaymentData, reference } });

    return sendSuccess(res, {
      paymentData: {
        reference,
        amount: basePaymentData.amount,
        email: customer.email,
        publicKey: config.paystackPublicKey,
        metadata: { userId, idempotencyKey, platform: "mobile" },
      },
      startedAt: now.toISOString(),
      expiresAt: finalPaymentExpiresAt.toISOString(),
    }, "Mobile payment initialized successfully");
  }

  const paymentInit = await initializePayment(basePaymentData.amount, customer.email, { userId, idempotencyKey, platform: "web" });
  await prisma.payment.create({ data: { ...basePaymentData, reference: paymentInit.reference } });

  return sendCreated(res, {
    paymentUrl: paymentInit.authorization_url,
    reference: paymentInit.reference,
    startedAt: now.toISOString(),
    expiresAt: finalPaymentExpiresAt.toISOString(),
  }, "Payment initialized successfully");
};

// GET /api/payments/confirm/:reference — post-redirect fallback confirmation
export const confirmPayment = async (req: AuthRequest, res: Response) => {
  const reference = ensureString(req.params.reference);

  const existing = await prisma.payment.findUnique({ where: { reference } });
  if (!existing) throw new NotFoundError("Payment");

  if (existing.status === PaymentStatus.SUCCESS) {
    return sendSuccess(res, { payment: existing }, "Payment already confirmed");
  }

  const paymentData = await verifyPayment(reference);
  if (paymentData.status !== "success") {
    throw new ValidationError("Payment not successful", { paystackStatus: paymentData.status });
  }

  const result = await finalizePaymentSuccess({
    reference,
    amountInNaira: paymentData.amount / 100,
    customerIdFromGateway: paymentData.metadata?.userId,
    channel: paymentData.channel,
    paystackData: paymentData,
    authorization: paymentData.authorization,
  });

  if (result.outcome === "SUCCESS" || result.outcome === "ALREADY_PROCESSED") {
    return sendSuccess(res, { orders: result.orders }, "Payment verified and order(s) confirmed");
  }

  const outcomeMessages: Record<string, string> = {
    AMOUNT_MISMATCH: "The amount paid doesn't match the order total. Our team has been notified.",
    CUSTOMER_MISMATCH: "This payment doesn't belong to your account.",
    LATE_PAYMENT: "This payment arrived after the order's payment window expired.",
    LOCKED: "This payment is already being processed — please check back in a moment.",
    PAYMENT_NOT_FOUND: "Payment not found.",
  };
  throw new ConflictError(outcomeMessages[result.outcome] || "Unable to confirm payment");
};

// GET /api/payments/user
export const getAllPaymentsForUser = async (req: AuthRequest, res: Response) => {
  const payments = await prisma.payment.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, reference: true, amount: true, status: true, createdAt: true, updatedAt: true, expiresAt: true,
      metadata: true, orderId: true, idempotencyKey: true,
      order: { select: { protectedUntil: true, status: true, totalPrice: true } },
    },
  });

  // A payment's idempotencyKey may cover more than one order (multi-vendor
  // checkout) — resolve the full order list per payment in one batched
  // query rather than N+1 queries.
  const keysNeedingLookup = [...new Set(payments.filter((p) => p.idempotencyKey).map((p) => p.idempotencyKey!))];
  const ordersByKey = keysNeedingLookup.length
    ? await prisma.order.findMany({ where: { idempotencyKey: { in: keysNeedingLookup } }, select: { id: true, idempotencyKey: true, status: true, totalPrice: true, vendorId: true } })
    : [];

  const mappedPayments = payments.map((p) => {
    const batchOrders = p.idempotencyKey ? ordersByKey.filter((o) => o.idempotencyKey === p.idempotencyKey) : [];
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

  return sendSuccess(res, { payments: mappedPayments }, "Payments retrieved successfully");
};

// POST /api/payments/refund
export const requestRefund = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { reference, reason } = req.body as { reference?: string; reason?: string };
  if (!reference || !reason) throw new ValidationError("reference and reason are required");

  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment || payment.userId !== userId) throw new NotFoundError("Payment");
  if (payment.status !== PaymentStatus.SUCCESS) throw new ValidationError("Only successful payments can be refunded");

  const alreadyRequested = await prisma.refundRequest.findFirst({ where: { paymentRef: reference } });
  if (alreadyRequested) throw new ConflictError("Refund already requested for this payment");

  await prisma.refundRequest.create({ data: { userId, paymentRef: reference, reason, status: RefundStatus.PENDING } });

  const order = await prisma.order.findUnique({ where: { id: payment.orderId }, select: { vendorId: true } });

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
        metadata: { type: "REFUND_REQUESTED", route: `/orders/${payment.orderId}`, orderId: payment.orderId, reference, reason },
      },
    ],
    audit: { action: "REFUND_REQUESTED", metadata: { orderId: payment.orderId, reference, reason, userId, vendorId: order?.vendorId } },
    notifyRealtime: true,
    notifyPush: true,
  });

  return sendSuccess(res, {}, "Refund request submitted successfully");
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
      payments: { where: { status: PaymentStatus.SUCCESS }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
}

// GET /api/payments/orders/:orderId/verify-payment
export const verifyPaymentBeforeFulfillment = async (req: AuthRequest, res: Response) => {
  const orderId = ensureString(req.params.orderId);
  if (!orderId) throw new ValidationError("Missing orderId parameter");

  const result = await verifyOrderPayment(orderId);

  if (!result || result.status !== OrderStatus.PAYMENT_CONFIRMED || result.payments.length === 0) {
    await createAuditLog({ userId: req.user?.id || null, action: "FULFILLMENT_CHECK_FAILED", req, metadata: { orderId, status: result?.status } });
    throw new ConflictError("Payment not verified for this order");
  }

  await createAuditLog({ userId: req.user?.id || null, action: "FULFILLMENT_CHECK_PASSED", req, metadata: { orderId, paymentId: result.payments[0].id } });
  return sendSuccess(res, { confirmed: true, payment: result.payments[0] }, "Payment verified");
};

/**
 * =========================
 *  SAVE NEW CARD TOKEN
 * =========================
 */
export const saveCardToken = async (req: AuthRequest, res: Response) => {
  const { cardToken, last4, brand } = req.body;
  const userId = req.user!.id;

  if (!cardToken || !last4 || !brand) throw new ValidationError("Missing required fields: cardToken, last4, brand");

  const existingCard = await prisma.userPaymentMethod.findFirst({ where: { cardToken, userId } });
  if (existingCard) throw new ConflictError("This card is already saved");

  await prisma.userPaymentMethod.create({ data: { userId, cardToken, last4, brand, isDefault: false } });
  await createAuditLog({ userId, action: "CARD_TOKEN_SAVED", req, metadata: { maskedToken: "****" + last4, brand } });

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
  if (!parsed.success) throw new ValidationError("Invalid request", parsed.error.flatten().fieldErrors);
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

  const totalAmount = orders.reduce((sum, o) => sum + o.totalPrice, 0);
  const now = nowUtc();

  await prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { paymentInitiatedAt: now } });

  let response;
  try {
    response = await axios.post(
      "https://api.paystack.co/transaction/charge_authorization",
      { authorization_code: card.cardToken, email: userEmail, amount: Math.round(totalAmount * 100) },
      { headers: { Authorization: `Bearer ${config.paystackSecret}` } }
    );
  } catch (err: any) {
    logger.error({ err: err?.response?.data || err.message, userId, idempotencyKey }, "chargeSavedCard: Paystack request failed");
    throw new UpstreamServiceError("Paystack", "Failed to charge saved card");
  }

  const data = response.data.data;

  // Some cards require an OTP even when charging a saved token — the
  // client needs to collect it and call submitOtp with this reference.
  if (data.status === "send_otp") {
    await prisma.payment.create({
      data: {
        userId, orderId: orders[0].id, idempotencyKey, reference: data.reference,
        amount: Math.round(totalAmount * 100), status: PaymentStatus.INITIATED, channel: "saved_card",
        expiresAt: addMinutesUtc(now, 15),
      },
    });
    return sendSuccess(res, { requiresOtp: true, reference: data.reference }, "OTP required to complete this charge");
  }

  if (data.status !== "success") {
    await createAuditLog({ userId, action: "CHARGE_SAVED_CARD_FAILED", req, metadata: { idempotencyKey, paystackResponse: data } });
    throw new ValidationError(data.gateway_response || "Charge failed", { paystackStatus: data.status });
  }

  await prisma.payment.create({
    data: {
      userId, orderId: orders[0].id, idempotencyKey, reference: data.reference,
      amount: Math.round(totalAmount * 100), status: PaymentStatus.PENDING, channel: "saved_card",
      expiresAt: addMinutesUtc(now, 15),
    },
  });

  const result = await finalizePaymentSuccess({
    reference: data.reference,
    amountInNaira: data.amount / 100,
    customerIdFromGateway: userId,
    channel: "saved_card",
    paystackData: data,
  });

  await createAuditLog({ userId, action: "CHARGE_SAVED_CARD_SUCCESS", req, metadata: { idempotencyKey, reference: data.reference, outcome: result.outcome } });

  return sendSuccess(res, { reference: data.reference, orders: result.orders }, "Payment successful");
};

// POST /api/payments/cards/submit-otp
const submitOtpSchema = z.object({ reference: z.string().min(1), otp: z.string().min(1) });

export const submitOtp = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const parsed = submitOtpSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid request", parsed.error.flatten().fieldErrors);
  const { reference, otp } = parsed.data;

  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment || payment.userId !== userId) throw new NotFoundError("Payment");
  if (payment.status === PaymentStatus.SUCCESS) return sendSuccess(res, {}, "Payment already confirmed");

  let response;
  try {
    response = await axios.post(
      "https://api.paystack.co/transaction/submit_otp",
      { otp, reference },
      { headers: { Authorization: `Bearer ${config.paystackSecret}` } }
    );
  } catch (err: any) {
    logger.error({ err: err?.response?.data || err.message, reference }, "submitOtp: Paystack request failed");
    throw new UpstreamServiceError("Paystack", "Failed to submit OTP");
  }

  const data = response.data;

  if (data.status === true && data.data.status === "success") {
    const result = await finalizePaymentSuccess({
      reference,
      amountInNaira: data.data.amount / 100,
      customerIdFromGateway: userId,
      paystackData: data.data,
    });
    await createAuditLog({ userId, action: "SUBMIT_OTP_SUCCESS", req, metadata: { reference, outcome: result.outcome } });
    return sendSuccess(res, { orders: result.orders }, "Payment confirmed via OTP");
  }

  if (data.status === true && data.data.status === "send_pin") {
    return sendSuccess(res, { requiresPin: true }, "Card requires PIN before completing OTP");
  }

  await createAuditLog({ userId, action: "SUBMIT_OTP_FAILED", req, metadata: { reference, paystackResponse: data } });
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
    select: { id: true, last4: true, brand: true, isDefault: true, createdAt: true },
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

  const card = await prisma.userPaymentMethod.findFirst({ where: { id: cardId, userId } });
  if (!card) throw new NotFoundError("Card");

  await prisma.$transaction([
    prisma.userPaymentMethod.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } }),
    prisma.userPaymentMethod.update({ where: { id: cardId }, data: { isDefault: true } }),
  ]);

  await createAuditLog({ userId, action: "SET_DEFAULT_CARD", req, metadata: { cardId } });
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

  const card = await prisma.userPaymentMethod.findFirst({ where: { id: cardId, userId } });
  if (!card) throw new NotFoundError("Card");

  await prisma.userPaymentMethod.delete({ where: { id: cardId } });
  await createAuditLog({ userId, action: "DELETE_SAVED_CARD", req, metadata: { cardId } });

  return sendSuccess(res, {}, "Card removed successfully");
};

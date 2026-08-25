"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteSavedCard = exports.setDefaultCard = exports.getSavedCards = exports.submitOtp = exports.chargeSavedCard = exports.saveCardToken = exports.verifyPaymentBeforeFulfillment = exports.requestRefund = exports.getAllPaymentsForUser = exports.confirmPayment = exports.initiateOrderPayment = exports.startPaymentSchema = void 0;
exports.verifyOrderPayment = verifyOrderPayment;
const zod_1 = require("zod");
const axios_1 = __importDefault(require("axios"));
const paymentService_1 = require("../services/paymentService");
const paymentFinalizer_service_1 = require("../services/paymentFinalizer.service");
const auditLog_service_1 = require("../utils/auditLog.service");
const prisma_1 = __importDefault(require("../lib/prisma"));
const config_1 = __importDefault(require("../config/config"));
const ip_1 = require("../utils/ip");
const client_1 = require("@prisma/client");
const activityUtils_1 = require("../utils/activityUtils");
const vendorAvailability_service_1 = require("../services/vendorAvailability.service");
const apiResponse_1 = require("../utils/apiResponse");
const AppError_1 = require("../errors/AppError");
const paramUtils_1 = require("../utils/paramUtils");
const time_1 = require("../utils/time");
const logger_1 = require("../lib/logger");
exports.startPaymentSchema = zod_1.z.object({
    idempotencyKey: zod_1.z.string().min(1, "idempotencyKey is required"),
    mobileSdk: zod_1.z.boolean().optional(),
});
/**
 * Fetches every order in a checkout batch (a multi-vendor cart produces
 * one order per vendor, all sharing an idempotencyKey) and validates
 * they're all eligible for payment together — one Paystack transaction
 * covers the whole batch.
 */
async function getPayableOrderBatch(idempotencyKey, userId) {
    const orders = await prisma_1.default.order.findMany({
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
    if (orders.length === 0)
        throw new AppError_1.NotFoundError("Order");
    const notAwaitingPayment = orders.find((o) => o.status !== client_1.OrderStatus.AWAITING_PAYMENT);
    if (notAwaitingPayment) {
        throw new AppError_1.ConflictError(`Order ${notAwaitingPayment.id} is not eligible for payment (status: ${notAwaitingPayment.status})`);
    }
    const alreadyPaid = orders.some((o) => o.payments.some((p) => p.status === client_1.PaymentStatus.SUCCESS));
    if (alreadyPaid)
        throw new AppError_1.ConflictError("This order has already been paid for");
    return orders;
}
/** Throws if any item across the whole batch belongs to a product that's gone offline. */
function assertProductsStillLive(orders) {
    const now = (0, time_1.nowUtc)();
    for (const order of orders) {
        for (const item of order.items) {
            const schedule = item.product.productSchedule;
            if (schedule?.takeDownAt) {
                const grace = schedule.graceMinutes ?? 0;
                const effectiveClose = (0, time_1.addMinutesUtc)((0, time_1.toUtc)(schedule.takeDownAt), grace);
                if (now >= effectiveClose) {
                    throw new AppError_1.ValidationError(`Product "${item.product.name}" is offline and cannot accept payments.`);
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
async function assertVendorsStillOperating(orders) {
    const vendorIds = [...new Set(orders.map((o) => o.vendorId))];
    const vendors = await prisma_1.default.user.findMany({
        where: { id: { in: vendorIds } },
        select: { id: true, name: true, brandName: true, isLive: true, deliveryPreferences: true },
    });
    const byId = new Map(vendors.map((v) => [v.id, v]));
    for (const vendorId of vendorIds) {
        const vendor = byId.get(vendorId);
        (0, vendorAvailability_service_1.assertVendorAvailableForOrdering)(vendor ? { ...vendor, kycStatus: null } : null, vendor ? `${vendor.brandName || vendor.name}` : "This vendor");
    }
}
// POST /api/payments/start
const initiateOrderPayment = async (req, res) => {
    const userId = req.user.id;
    const parsed = exports.startPaymentSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid request data", parsed.error.flatten().fieldErrors);
    const { idempotencyKey, mobileSdk = false } = parsed.data;
    const orders = await getPayableOrderBatch(idempotencyKey, userId);
    assertProductsStillLive(orders);
    await assertVendorsStillOperating(orders);
    const now = (0, time_1.nowUtc)();
    const paymentWindowMinutes = 15;
    const finalPaymentExpiresAt = (0, time_1.addMinutesUtc)(now, paymentWindowMinutes);
    const totalAmount = orders.reduce((sum, o) => sum + o.totalPrice, 0);
    const customer = await prisma_1.default.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!customer)
        throw new AppError_1.NotFoundError("User");
    const { ip, userAgent, deviceId } = (0, ip_1.getClientInfo)(req);
    const channel = mobileSdk || req.headers["x-device-channel"]?.toString().toLowerCase() === "mobile" ? "mobile" : "web";
    logger_1.logger.info({ idempotencyKey, orderIds: orders.map((o) => o.id), amount: totalAmount, channel }, "Initiating payment");
    // Record that payment was actually attempted — this field existed in
    // the schema but was never set anywhere before.
    await prisma_1.default.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { paymentInitiatedAt: now } });
    const basePaymentData = {
        amount: Math.round(totalAmount * 100), // kobo
        status: client_1.PaymentStatus.PENDING,
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
        await prisma_1.default.payment.create({ data: { ...basePaymentData, reference } });
        return (0, apiResponse_1.sendSuccess)(res, {
            paymentData: {
                reference,
                amount: basePaymentData.amount,
                email: customer.email,
                publicKey: config_1.default.paystackPublicKey,
                metadata: { userId, idempotencyKey, platform: "mobile" },
            },
            startedAt: now.toISOString(),
            expiresAt: finalPaymentExpiresAt.toISOString(),
        }, "Mobile payment initialized successfully");
    }
    const paymentInit = await (0, paymentService_1.initializePayment)(basePaymentData.amount, customer.email, { userId, idempotencyKey, platform: "web" });
    await prisma_1.default.payment.create({ data: { ...basePaymentData, reference: paymentInit.reference } });
    return (0, apiResponse_1.sendCreated)(res, {
        paymentUrl: paymentInit.authorization_url,
        reference: paymentInit.reference,
        startedAt: now.toISOString(),
        expiresAt: finalPaymentExpiresAt.toISOString(),
    }, "Payment initialized successfully");
};
exports.initiateOrderPayment = initiateOrderPayment;
// GET /api/payments/confirm/:reference — post-redirect fallback confirmation
const confirmPayment = async (req, res) => {
    const reference = (0, paramUtils_1.ensureString)(req.params.reference);
    const existing = await prisma_1.default.payment.findUnique({ where: { reference } });
    if (!existing)
        throw new AppError_1.NotFoundError("Payment");
    if (existing.status === client_1.PaymentStatus.SUCCESS) {
        return (0, apiResponse_1.sendSuccess)(res, { payment: existing }, "Payment already confirmed");
    }
    const paymentData = await (0, paymentService_1.verifyPayment)(reference);
    if (paymentData.status !== "success") {
        throw new AppError_1.ValidationError("Payment not successful", { paystackStatus: paymentData.status });
    }
    const result = await (0, paymentFinalizer_service_1.finalizePaymentSuccess)({
        reference,
        amountInNaira: paymentData.amount / 100,
        customerIdFromGateway: paymentData.metadata?.userId,
        channel: paymentData.channel,
        paystackData: paymentData,
        authorization: paymentData.authorization,
    });
    if (result.outcome === "SUCCESS" || result.outcome === "ALREADY_PROCESSED") {
        return (0, apiResponse_1.sendSuccess)(res, { orders: result.orders }, "Payment verified and order(s) confirmed");
    }
    const outcomeMessages = {
        AMOUNT_MISMATCH: "The amount paid doesn't match the order total. Our team has been notified.",
        CUSTOMER_MISMATCH: "This payment doesn't belong to your account.",
        LATE_PAYMENT: "This payment arrived after the order's payment window expired.",
        LOCKED: "This payment is already being processed — please check back in a moment.",
        PAYMENT_NOT_FOUND: "Payment not found.",
    };
    throw new AppError_1.ConflictError(outcomeMessages[result.outcome] || "Unable to confirm payment");
};
exports.confirmPayment = confirmPayment;
// GET /api/payments/user
const getAllPaymentsForUser = async (req, res) => {
    const payments = await prisma_1.default.payment.findMany({
        where: { userId: req.user.id },
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
    const keysNeedingLookup = [...new Set(payments.filter((p) => p.idempotencyKey).map((p) => p.idempotencyKey))];
    const ordersByKey = keysNeedingLookup.length
        ? await prisma_1.default.order.findMany({ where: { idempotencyKey: { in: keysNeedingLookup } }, select: { id: true, idempotencyKey: true, status: true, totalPrice: true, vendorId: true } })
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
    return (0, apiResponse_1.sendSuccess)(res, { payments: mappedPayments }, "Payments retrieved successfully");
};
exports.getAllPaymentsForUser = getAllPaymentsForUser;
// POST /api/payments/refund
const requestRefund = async (req, res) => {
    const userId = req.user.id;
    const { reference, reason } = req.body;
    if (!reference || !reason)
        throw new AppError_1.ValidationError("reference and reason are required");
    const payment = await prisma_1.default.payment.findUnique({ where: { reference } });
    if (!payment || payment.userId !== userId)
        throw new AppError_1.NotFoundError("Payment");
    if (payment.status !== client_1.PaymentStatus.SUCCESS)
        throw new AppError_1.ValidationError("Only successful payments can be refunded");
    const alreadyRequested = await prisma_1.default.refundRequest.findFirst({ where: { paymentRef: reference } });
    if (alreadyRequested)
        throw new AppError_1.ConflictError("Refund already requested for this payment");
    await prisma_1.default.refundRequest.create({ data: { userId, paymentRef: reference, reason, status: client_1.RefundStatus.PENDING } });
    const order = await prisma_1.default.order.findUnique({ where: { id: payment.orderId }, select: { vendorId: true } });
    await (0, activityUtils_1.recordActivityBundle)({
        req,
        actorId: userId,
        orderId: payment.orderId,
        actions: [
            {
                type: client_1.ActivityType.REFUND_REQUESTED,
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
    return (0, apiResponse_1.sendSuccess)(res, {}, "Refund request submitted successfully");
};
exports.requestRefund = requestRefund;
// ───────────────────────────────────────────────
// Utility: verify payment for an order (used internally, e.g. by fulfillment gates)
// ───────────────────────────────────────────────
async function verifyOrderPayment(orderId) {
    return prisma_1.default.order.findUnique({
        where: { id: orderId },
        select: {
            status: true,
            totalPrice: true,
            payments: { where: { status: client_1.PaymentStatus.SUCCESS }, orderBy: { createdAt: "desc" }, take: 1 },
        },
    });
}
// GET /api/payments/orders/:orderId/verify-payment
const verifyPaymentBeforeFulfillment = async (req, res) => {
    const orderId = (0, paramUtils_1.ensureString)(req.params.orderId);
    if (!orderId)
        throw new AppError_1.ValidationError("Missing orderId parameter");
    const result = await verifyOrderPayment(orderId);
    if (!result || result.status !== client_1.OrderStatus.PAYMENT_CONFIRMED || result.payments.length === 0) {
        await (0, auditLog_service_1.createAuditLog)({ userId: req.user?.id || null, action: "FULFILLMENT_CHECK_FAILED", req, metadata: { orderId, status: result?.status } });
        throw new AppError_1.ConflictError("Payment not verified for this order");
    }
    await (0, auditLog_service_1.createAuditLog)({ userId: req.user?.id || null, action: "FULFILLMENT_CHECK_PASSED", req, metadata: { orderId, paymentId: result.payments[0].id } });
    return (0, apiResponse_1.sendSuccess)(res, { confirmed: true, payment: result.payments[0] }, "Payment verified");
};
exports.verifyPaymentBeforeFulfillment = verifyPaymentBeforeFulfillment;
/**
 * =========================
 *  SAVE NEW CARD TOKEN
 * =========================
 */
const saveCardToken = async (req, res) => {
    const { cardToken, last4, brand } = req.body;
    const userId = req.user.id;
    if (!cardToken || !last4 || !brand)
        throw new AppError_1.ValidationError("Missing required fields: cardToken, last4, brand");
    const existingCard = await prisma_1.default.userPaymentMethod.findFirst({ where: { cardToken, userId } });
    if (existingCard)
        throw new AppError_1.ConflictError("This card is already saved");
    await prisma_1.default.userPaymentMethod.create({ data: { userId, cardToken, last4, brand, isDefault: false } });
    await (0, auditLog_service_1.createAuditLog)({ userId, action: "CARD_TOKEN_SAVED", req, metadata: { maskedToken: "****" + last4, brand } });
    return (0, apiResponse_1.sendCreated)(res, {}, "Card saved successfully");
};
exports.saveCardToken = saveCardToken;
/**
 * =========================
 *  CHARGE A SAVED CARD
 * =========================
 * Brought online — previously fully commented out, blocked on not having
 * a clean shared finalizer to call into. finalizePaymentSuccess now makes
 * this a thin wrapper around the same confirmation logic every other
 * entry point uses.
 */
const chargeSavedCardSchema = zod_1.z.object({
    idempotencyKey: zod_1.z.string().min(1),
    cardId: zod_1.z.string().min(1),
});
const chargeSavedCard = async (req, res) => {
    const userId = req.user.id;
    const parsed = chargeSavedCardSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid request", parsed.error.flatten().fieldErrors);
    const { idempotencyKey, cardId } = parsed.data;
    const [card, user] = await Promise.all([
        prisma_1.default.userPaymentMethod.findFirst({ where: { id: cardId, userId } }),
        prisma_1.default.user.findUnique({ where: { id: userId }, select: { email: true } }),
    ]);
    if (!card)
        throw new AppError_1.NotFoundError("Saved card");
    if (!user?.email)
        throw new AppError_1.NotFoundError("User");
    const userEmail = user.email;
    const orders = await getPayableOrderBatch(idempotencyKey, userId);
    assertProductsStillLive(orders);
    await assertVendorsStillOperating(orders);
    const totalAmount = orders.reduce((sum, o) => sum + o.totalPrice, 0);
    const now = (0, time_1.nowUtc)();
    await prisma_1.default.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { paymentInitiatedAt: now } });
    let response;
    try {
        response = await axios_1.default.post("https://api.paystack.co/transaction/charge_authorization", { authorization_code: card.cardToken, email: userEmail, amount: Math.round(totalAmount * 100) }, { headers: { Authorization: `Bearer ${config_1.default.paystackSecret}` } });
    }
    catch (err) {
        logger_1.logger.error({ err: err?.response?.data || err.message, userId, idempotencyKey }, "chargeSavedCard: Paystack request failed");
        throw new AppError_1.UpstreamServiceError("Paystack", "Failed to charge saved card");
    }
    const data = response.data.data;
    // Some cards require an OTP even when charging a saved token — the
    // client needs to collect it and call submitOtp with this reference.
    if (data.status === "send_otp") {
        await prisma_1.default.payment.create({
            data: {
                userId, orderId: orders[0].id, idempotencyKey, reference: data.reference,
                amount: Math.round(totalAmount * 100), status: client_1.PaymentStatus.INITIATED, channel: "saved_card",
                expiresAt: (0, time_1.addMinutesUtc)(now, 15),
            },
        });
        return (0, apiResponse_1.sendSuccess)(res, { requiresOtp: true, reference: data.reference }, "OTP required to complete this charge");
    }
    if (data.status !== "success") {
        await (0, auditLog_service_1.createAuditLog)({ userId, action: "CHARGE_SAVED_CARD_FAILED", req, metadata: { idempotencyKey, paystackResponse: data } });
        throw new AppError_1.ValidationError(data.gateway_response || "Charge failed", { paystackStatus: data.status });
    }
    await prisma_1.default.payment.create({
        data: {
            userId, orderId: orders[0].id, idempotencyKey, reference: data.reference,
            amount: Math.round(totalAmount * 100), status: client_1.PaymentStatus.PENDING, channel: "saved_card",
            expiresAt: (0, time_1.addMinutesUtc)(now, 15),
        },
    });
    const result = await (0, paymentFinalizer_service_1.finalizePaymentSuccess)({
        reference: data.reference,
        amountInNaira: data.amount / 100,
        customerIdFromGateway: userId,
        channel: "saved_card",
        paystackData: data,
    });
    await (0, auditLog_service_1.createAuditLog)({ userId, action: "CHARGE_SAVED_CARD_SUCCESS", req, metadata: { idempotencyKey, reference: data.reference, outcome: result.outcome } });
    return (0, apiResponse_1.sendSuccess)(res, { reference: data.reference, orders: result.orders }, "Payment successful");
};
exports.chargeSavedCard = chargeSavedCard;
// POST /api/payments/cards/submit-otp
const submitOtpSchema = zod_1.z.object({ reference: zod_1.z.string().min(1), otp: zod_1.z.string().min(1) });
const submitOtp = async (req, res) => {
    const userId = req.user.id;
    const parsed = submitOtpSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid request", parsed.error.flatten().fieldErrors);
    const { reference, otp } = parsed.data;
    const payment = await prisma_1.default.payment.findUnique({ where: { reference } });
    if (!payment || payment.userId !== userId)
        throw new AppError_1.NotFoundError("Payment");
    if (payment.status === client_1.PaymentStatus.SUCCESS)
        return (0, apiResponse_1.sendSuccess)(res, {}, "Payment already confirmed");
    let response;
    try {
        response = await axios_1.default.post("https://api.paystack.co/transaction/submit_otp", { otp, reference }, { headers: { Authorization: `Bearer ${config_1.default.paystackSecret}` } });
    }
    catch (err) {
        logger_1.logger.error({ err: err?.response?.data || err.message, reference }, "submitOtp: Paystack request failed");
        throw new AppError_1.UpstreamServiceError("Paystack", "Failed to submit OTP");
    }
    const data = response.data;
    if (data.status === true && data.data.status === "success") {
        const result = await (0, paymentFinalizer_service_1.finalizePaymentSuccess)({
            reference,
            amountInNaira: data.data.amount / 100,
            customerIdFromGateway: userId,
            paystackData: data.data,
        });
        await (0, auditLog_service_1.createAuditLog)({ userId, action: "SUBMIT_OTP_SUCCESS", req, metadata: { reference, outcome: result.outcome } });
        return (0, apiResponse_1.sendSuccess)(res, { orders: result.orders }, "Payment confirmed via OTP");
    }
    if (data.status === true && data.data.status === "send_pin") {
        return (0, apiResponse_1.sendSuccess)(res, { requiresPin: true }, "Card requires PIN before completing OTP");
    }
    await (0, auditLog_service_1.createAuditLog)({ userId, action: "SUBMIT_OTP_FAILED", req, metadata: { reference, paystackResponse: data } });
    throw new AppError_1.ValidationError(data.message || "Failed to confirm OTP", data);
};
exports.submitOtp = submitOtp;
/**
 * =========================
 *  GET ALL SAVED CARDS
 * =========================
 */
const getSavedCards = async (req, res) => {
    const cards = await prisma_1.default.userPaymentMethod.findMany({
        where: { userId: req.user.id },
        select: { id: true, last4: true, brand: true, isDefault: true, createdAt: true },
        orderBy: { isDefault: "desc" },
    });
    return (0, apiResponse_1.sendSuccess)(res, { cards }, "Saved cards retrieved successfully");
};
exports.getSavedCards = getSavedCards;
/**
 * =========================
 *  SET DEFAULT CARD
 * =========================
 */
const setDefaultCard = async (req, res) => {
    const { cardId } = req.body;
    const userId = req.user.id;
    if (!cardId)
        throw new AppError_1.ValidationError("Missing required field: cardId");
    const card = await prisma_1.default.userPaymentMethod.findFirst({ where: { id: cardId, userId } });
    if (!card)
        throw new AppError_1.NotFoundError("Card");
    await prisma_1.default.$transaction([
        prisma_1.default.userPaymentMethod.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } }),
        prisma_1.default.userPaymentMethod.update({ where: { id: cardId }, data: { isDefault: true } }),
    ]);
    await (0, auditLog_service_1.createAuditLog)({ userId, action: "SET_DEFAULT_CARD", req, metadata: { cardId } });
    return (0, apiResponse_1.sendSuccess)(res, {}, "Default card updated");
};
exports.setDefaultCard = setDefaultCard;
/**
 * =========================
 *  DELETE SAVED CARD
 * =========================
 */
const deleteSavedCard = async (req, res) => {
    const cardId = (0, paramUtils_1.ensureString)(req.params.cardId);
    const userId = req.user.id;
    if (!cardId)
        throw new AppError_1.ValidationError("Missing cardId in request params");
    const card = await prisma_1.default.userPaymentMethod.findFirst({ where: { id: cardId, userId } });
    if (!card)
        throw new AppError_1.NotFoundError("Card");
    await prisma_1.default.userPaymentMethod.delete({ where: { id: cardId } });
    await (0, auditLog_service_1.createAuditLog)({ userId, action: "DELETE_SAVED_CARD", req, metadata: { cardId } });
    return (0, apiResponse_1.sendSuccess)(res, {}, "Card removed successfully");
};
exports.deleteSavedCard = deleteSavedCard;

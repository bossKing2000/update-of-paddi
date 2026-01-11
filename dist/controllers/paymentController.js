"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteSavedCard = exports.setDefaultCard = exports.getSavedCards = exports.saveCardToken = exports.verifyPaymentBeforeFulfillment = exports.requestRefund = exports.getAllPaymentsForUser = exports.confirmPayment = exports.initiateOrderPayment = exports.startPaymentSchema = void 0;
exports.verifyOrderPayment = verifyOrderPayment;
const paymentService_1 = require("../services/paymentService");
const auditLog_service_1 = require("../utils/auditLog.service");
const prisma_1 = __importDefault(require("../lib/prisma"));
const config_1 = __importDefault(require("../config/config"));
const ip_1 = require("../utils/ip");
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
const activityUtils_1 = require("../utils/activityUtils");
const codeMessage_1 = require("../validators/codeMessage");
const time_1 = require("../utils/time");
exports.startPaymentSchema = zod_1.z.object({
    orderId: zod_1.z.string().min(1, 'Order ID is required or wrong id'),
    couponCode: zod_1.z.string().optional(),
});
// ✅ UTC time helpers
const initiateOrderPayment = async (req, res) => {
    try {
        const { orderId, mobileSdk = false } = req.body;
        const userId = req.user?.id;
        if (!userId)
            return res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
        const parsed = exports.startPaymentSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: "Invalid request data",
                details: parsed.error.flatten().fieldErrors,
            });
        }
        const order = await prisma_1.default.order.findUnique({
            where: { id: orderId },
            include: {
                customer: true,
                payments: true,
                items: {
                    include: {
                        product: {
                            select: {
                                id: true,
                                name: true,
                                isLive: true,
                                productSchedule: { select: { takeDownAt: true, graceMinutes: true } },
                            },
                        },
                    },
                },
            },
        });
        if (!order || order.customerId !== userId) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_ORDER", "Invalid order for payment"));
        }
        if (order.status !== "AWAITING_PAYMENT") {
            return res.status(400).json((0, codeMessage_1.errorResponse)("NOT_READY_FOR_PAYMENT", "Order is not eligible for payment"));
        }
        const hasPaid = order.payments.some((p) => p.status.toLowerCase() === "success");
        if (hasPaid) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("ALREADY_PAID", "Order already paid for"));
        }
        // ✅ Current UTC time
        const now = (0, time_1.nowUtc)();
        const paymentWindowMinutes = 15; // strictly 15 minutes
        // ✅ Check product schedules for live status
        for (const item of order.items) {
            const schedule = item.product.productSchedule;
            if (schedule?.takeDownAt) {
                const grace = schedule.graceMinutes ?? 0;
                const takeDownAtUtc = (0, time_1.toUtc)(schedule.takeDownAt);
                const effectiveClose = (0, time_1.addMinutesUtc)(takeDownAtUtc, grace);
                if (now >= effectiveClose) {
                    return res.status(400).json((0, codeMessage_1.errorResponse)("PRODUCT_OFFLINE", `Product "${item.product.name}" is offline and cannot accept payments.`));
                }
            }
        }
        // 💰 Payment expires exactly 15 minutes from now
        const finalPaymentExpiresAt = (0, time_1.addMinutesUtc)(now, paymentWindowMinutes);
        const { ip, userAgent, deviceId, country, city } = (0, ip_1.getClientInfo)(req);
        const channel = mobileSdk || req.headers["x-device-channel"]?.toString().toLowerCase() === "mobile"
            ? "mobile"
            : "web";
        console.log({
            event: "INITIATE_PAYMENT",
            orderId,
            nowUtc: now.toISOString(),
            expiresAtUtc: finalPaymentExpiresAt.toISOString(),
            channel,
        });
        const basePaymentData = {
            amount: order.totalPrice,
            status: "pending",
            startedAt: now,
            expiresAt: finalPaymentExpiresAt,
            channel,
            ipAddress: ip || "unknown",
            deviceId,
            userAgent: userAgent || "unknown",
            geoCity: city || "unknown",
            geoCountry: country || "unknown",
            user: { connect: { id: userId } },
            order: { connect: { id: orderId } },
        };
        if (mobileSdk) {
            const reference = `order_${orderId}_${Date.now()}`;
            await prisma_1.default.payment.create({ data: { ...basePaymentData, reference } });
            return res.status(200).json({
                message: "Mobile payment initialized successfully",
                paymentData: {
                    reference,
                    amount: Math.round(order.totalPrice * 100),
                    email: order.customer.email,
                    publicKey: config_1.default.paystackPublicKey,
                    metadata: { userId, orderId, platform: "mobile" },
                },
                startedAt: now.toISOString(),
                expiresAt: finalPaymentExpiresAt.toISOString(),
            });
        }
        const paymentInit = await (0, paymentService_1.initializePayment)(Math.round(order.totalPrice * 100), order.customer.email, { userId, orderId, platform: "web" });
        await prisma_1.default.payment.create({
            data: { ...basePaymentData, reference: paymentInit.reference },
        });
        return res.status(201).json({
            message: "Payment initialized successfully",
            paymentUrl: paymentInit.authorization_url,
            reference: paymentInit.reference,
            startedAt: now.toISOString(),
            expiresAt: finalPaymentExpiresAt.toISOString(),
        });
    }
    catch (error) {
        console.error("❌ Payment initiation error:", error);
        return res.status(500).json((0, codeMessage_1.errorResponse)("PAYMENT_INIT_FAILED", error?.message || "Failed to initiate payment"));
    }
};
exports.initiateOrderPayment = initiateOrderPayment;
// GET /api/payments/confirm/:reference
const confirmPayment = async (req, res) => {
    try {
        const { reference } = req.params;
        // 1️⃣ Check if payment exists
        const existing = await prisma_1.default.payment.findUnique({
            where: { reference },
        });
        if (!existing) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        if (existing.status.toLowerCase() === 'success') {
            return res.status(200).json({ message: 'Payment already confirmed' });
        }
        // 2️⃣ Verify payment with Paystack
        const paymentData = await (0, paymentService_1.verifyPayment)(reference);
        if (paymentData.status !== 'success') {
            return res.status(400).json({ error: 'Payment not successful' });
        }
        const { metadata } = paymentData;
        const amountInNaira = paymentData.amount / 100;
        // 3️⃣ Secure atomic update for payment + order
        const [updatedPayment, updatedOrder] = await prisma_1.default.$transaction([
            prisma_1.default.payment.update({
                where: { reference },
                data: {
                    status: 'success',
                    amount: paymentData.amount,
                    paystackData: paymentData,
                    updatedAt: new Date(),
                },
            }),
            prisma_1.default.order.update({
                where: { id: metadata.orderId },
                data: {
                    status: client_1.OrderStatus.PAYMENT_CONFIRMED,
                    updatedAt: new Date(),
                },
            }),
        ]);
        // 4️⃣ Fetch vendor ID for notifications
        const order = await prisma_1.default.order.findUnique({
            where: { id: metadata.orderId },
            select: { vendorId: true },
        });
        // 5️⃣ Record multi-action activity, notify, and audit
        await (0, activityUtils_1.recordActivityBundle)({
            req,
            actorId: metadata.userId, // customer who confirmed payment
            orderId: metadata.orderId,
            actions: [
                // 🧾 Customer activity
                {
                    type: client_1.ActivityType.PAYMENT_SUCCESS,
                    title: "Payment Successful",
                    message: `Your payment for order #${metadata.orderId} was confirmed successfully.`,
                    targetId: metadata.userId, // customer receives notification
                    socketEvent: "PAYMENT", // triggers paymentSuccess event
                    metadata: {
                        type: "PAYMENT_SUCCESS",
                        route: `/orders/${metadata.orderId}`,
                        target: {
                            screen: "order_detail",
                            id: metadata.orderId,
                        },
                        orderId: metadata.orderId,
                        userId: metadata.userId,
                        amount: amountInNaira,
                        reference,
                        frontendEvent: "PAYMENT_CONFIRMED",
                    },
                },
                // 🛒 Vendor notification
                {
                    type: client_1.ActivityType.NEW_PAID_ORDER,
                    title: "New Paid Order",
                    message: `You have received a new paid order #${metadata.orderId}.`,
                    targetId: order?.vendorId, // vendor receives notification
                    socketEvent: "ORDER", // triggers newPaidOrder/orderUpdate event
                    metadata: {
                        type: "NEW_PAID_ORDER",
                        route: `/vendor/orders/${metadata.orderId}`,
                        target: {
                            screen: "vendor_order_detail",
                            id: metadata.orderId,
                        },
                        orderId: metadata.orderId,
                        vendorId: order?.vendorId,
                        customerId: metadata.userId,
                        amount: amountInNaira,
                        reference,
                        frontendEvent: "NEW_PAID_ORDER_RECEIVED",
                    },
                },
            ],
            audit: {
                action: "PAYMENT_CONFIRM_SUCCESS",
                metadata: {
                    orderId: metadata.orderId,
                    amount: amountInNaira,
                    reference,
                    userId: metadata.userId,
                    vendorId: order?.vendorId,
                },
            },
            notifyRealtime: true, // emit socket events
            notifyPush: true, // send push notifications
        });
        // 6️⃣ Done
        console.log("[PAYMENT] ✅ Manual confirmation successful for:", reference);
        return res.status(200).json({
            message: "Payment verified and order confirmed.",
            payment: updatedPayment,
            order: updatedOrder,
        });
    }
    catch (error) {
        console.error("confirmPayment error:", error);
        return res.status(500).json({ error: "Verification failed" });
    }
};
exports.confirmPayment = confirmPayment;
// GET /api/payments/transactions
const getAllPaymentsForUser = async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const payments = await prisma_1.default.payment.findMany({
            where: { userId: req.user.id },
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
                order: {
                    select: {
                        protectedUntil: true,
                        status: true,
                        totalPrice: true,
                        items: {
                            select: {
                                product: {
                                    select: {
                                        id: true,
                                        name: true,
                                        isLive: true,
                                        productSchedule: {
                                            select: { takeDownAt: true, graceMinutes: true },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
        // Map the response for frontend clarity
        const mappedPayments = payments.map((p) => {
            // Compute effective product live until for the order
            const productLiveUntil = p.order?.items.reduce((earliest, item) => {
                const schedule = item.product.productSchedule;
                if (!schedule?.takeDownAt)
                    return earliest;
                const effectiveClose = new Date(schedule.takeDownAt.getTime() + (schedule.graceMinutes ?? 15) * 60000);
                return earliest ? new Date(Math.min(earliest.getTime(), effectiveClose.getTime())) : effectiveClose;
            }, null);
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
            };
        });
        return res.status(200).json({ payments: mappedPayments });
    }
    catch (error) {
        console.error("getAllPaymentsForUser error:", error);
        return res.status(500).json({ error: "Failed to fetch payments" });
    }
};
exports.getAllPaymentsForUser = getAllPaymentsForUser;
// POST /api/payments/refund
const requestRefund = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { reference, reason } = req.body;
        // 1️⃣ Validate payment belongs to user
        const payment = await prisma_1.default.payment.findUnique({ where: { reference } });
        if (!payment || payment.userId !== userId) {
            return res.status(404).json({ error: 'Payment not found or not yours' });
        }
        if (payment.status !== client_1.PaymentStatus.SUCCESS) {
            return res.status(400).json({ error: 'Only successful payments can be refunded' });
        }
        // 2️⃣ Prevent duplicate refund request
        const alreadyRequested = await prisma_1.default.refundRequest.findFirst({
            where: { paymentRef: reference },
        });
        if (alreadyRequested) {
            return res.status(400).json({ error: 'Refund already requested' });
        }
        // 3️⃣ Create refund request
        await prisma_1.default.refundRequest.create({
            data: {
                userId,
                paymentRef: reference,
                reason,
                status: 'PENDING',
            },
        });
        // 4️⃣ Record multi-action activity, notify, and audit
        await (0, activityUtils_1.recordActivityBundle)({
            req,
            actorId: userId, // Customer requesting refund
            orderId: payment.orderId,
            actions: [
                // 🧾 Customer activity
                {
                    type: client_1.ActivityType.REFUND_REQUESTED,
                    title: "Refund Requested",
                    message: `We’ve received your refund request for payment #${reference}. Our team will review it shortly.`,
                    targetId: userId, // Customer receives notification
                    socketEvent: "REFUND", // event category for refund updates
                    metadata: {
                        type: "REFUND_REQUESTED",
                        route: `/orders/${payment.orderId}`,
                        target: {
                            screen: "order_detail",
                            id: payment.orderId,
                        },
                        orderId: payment.orderId,
                        userId,
                        reference,
                        reason,
                        frontendEvent: "REFUND_REQUEST_SUBMITTED",
                    },
                },
                // 🏪 Optional: Notify vendor/admin about refund request
                {
                    type: client_1.ActivityType.REFUND_REQUESTED,
                    title: "Refund Request Received",
                    message: `A refund has been requested by a customer for order #${payment.orderId}.`,
                    // targetId: payment.vendorId, // Vendor gets alert if needed
                    socketEvent: "REFUND",
                    metadata: {
                        type: "REFUND_REQUESTED_VENDOR",
                        route: `/vendor/orders/${payment.orderId}`,
                        target: {
                            screen: "vendor_order_detail",
                            id: payment.orderId,
                        },
                        orderId: payment.orderId,
                        // vendorId: payment.vendorId,
                        customerId: userId,
                        reference,
                        reason,
                        frontendEvent: "VENDOR_REFUND_ALERT",
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
                    // vendorId: payment.vendorId,
                },
            },
            notifyRealtime: true, // emit socket events
            notifyPush: true, // send push notifications
        });
        // 5️⃣ Done
        console.log("[REFUND] ✅ Refund request submitted for:", reference);
        return res.status(200).json({
            message: "Refund request submitted successfully.",
        });
    }
    catch (error) {
        console.error("refund error:", error);
        res.status(500).json({ error: "Failed to request refund" });
    }
};
exports.requestRefund = requestRefund;
// ───────────────────────────────────────────────
// Utility: verify payment for an order
// ───────────────────────────────────────────────
async function verifyOrderPayment(orderId) {
    return prisma_1.default.order.findUnique({
        where: { id: orderId },
        select: {
            status: true,
            totalPrice: true,
            payments: {
                where: { status: "success" },
                orderBy: { createdAt: "desc" }, // latest first
                take: 1,
            },
        },
    });
}
// ───────────────────────────────────────────────
// Controller: verify before fulfillment
// ───────────────────────────────────────────────
const verifyPaymentBeforeFulfillment = async (req, res) => {
    const { orderId } = req.params;
    if (!orderId) {
        return res.status(400).json({ error: "Missing orderId parameter" });
    }
    try {
        const result = await verifyOrderPayment(orderId);
        if (!result || result.status !== client_1.OrderStatus.PAYMENT_CONFIRMED || result.payments.length === 0) {
            await (0, auditLog_service_1.createAuditLog)({
                userId: req.user?.id || null,
                action: "FULFILLMENT_CHECK_FAILED",
                req,
                metadata: {
                    orderId,
                    status: result?.status,
                    hasPayment: !!result?.payments.length,
                },
            });
            return res.status(402).json({
                error: "Payment not verified",
                details: {
                    hasPayment: !!result?.payments.length,
                    currentStatus: result?.status ?? "NOT_FOUND",
                },
            });
        }
        // Optional: Audit success for traceability
        await (0, auditLog_service_1.createAuditLog)({
            userId: req.user?.id || null,
            action: "FULFILLMENT_CHECK_PASSED",
            req,
            metadata: { orderId, paymentId: result.payments[0].id },
        });
        return res.json({
            confirmed: true,
            payment: result.payments[0],
        });
    }
    catch (error) {
        console.error("[VERIFY_PAYMENT] ❌ Error:", error);
        await (0, auditLog_service_1.createAuditLog)({
            userId: req.user?.id || null,
            action: "FULFILLMENT_CHECK_ERROR",
            req,
            metadata: { orderId, error: error.message },
        });
        return res.status(500).json({ error: "Internal server error" });
    }
};
exports.verifyPaymentBeforeFulfillment = verifyPaymentBeforeFulfillment;
/**
 * =========================
 *  SAVE NEW CARD TOKEN
 * =========================
 */
const saveCardToken = async (req, res) => {
    try {
        const { cardToken, last4, brand } = req.body;
        const userId = req.user.id;
        // ---- Input validation ----
        if (!cardToken || !last4 || !brand) {
            return res.status(400).json({
                code: "VALIDATION_ERROR",
                message: "Missing required fields: cardToken, last4, brand",
            });
        }
        // ---- Check if card already exists for this user ----
        const existingCard = await prisma_1.default.userPaymentMethod.findFirst({
            where: { cardToken, userId },
        });
        if (existingCard) {
            return res.status(409).json({
                code: "CARD_ALREADY_EXISTS",
                message: "This card is already saved.",
            });
        }
        // ---- Save the new card ----
        await prisma_1.default.userPaymentMethod.create({
            data: {
                userId,
                cardToken,
                last4,
                brand,
                isDefault: false, // remains false until explicitly set
            },
        });
        // ---- Log the action (mask the token) ----
        await (0, auditLog_service_1.createAuditLog)({
            userId,
            action: "CARD_TOKEN_SAVED",
            req,
            metadata: { maskedToken: "****" + last4, brand },
        });
        return res.status(201).json({
            code: "CARD_SAVED",
            message: "Card saved successfully",
        });
    }
    catch (error) {
        console.error("Save card error:", error);
        return res.status(500).json({
            code: "SERVER_ERROR",
            message: "Failed to save card",
        });
    }
};
exports.saveCardToken = saveCardToken;
/**
 * =========================
 *  CHARGE A SAVED CARD
 * =========================
 */
// export const chargeSavedCard = async (req: AuthRequest, res: Response) => {
//   try {
//     const { orderId, cardId } = req.body;
//     const userId = req.user!.id;
//     const userEmail = req.user!.email;
//     if (!orderId || !cardId) {
//       return res.status(400).json({
//         code: "VALIDATION_ERROR",
//         message: "Missing required fields: orderId, cardId",
//       });
//     }
//     // 1. Get saved card
//     const card = await prisma.userPaymentMethod.findFirst({
//       where: { id: cardId, userId },
//     });
//     if (!card) {
//       return res.status(404).json({
//         code: "CARD_NOT_FOUND",
//         message: "Selected saved card not found.",
//       });
//     }
//     // 2. Get order details
//     const order = await prisma.order.findUnique({
//       where: { id: orderId },
//     });
//     if (!order) {
//       return res.status(404).json({
//         code: "ORDER_NOT_FOUND",
//         message: "Order not found.",
//       });
//     }
//     if (order.status !== OrderStatus.AWAITING_PAYMENT) {
//       return res.status(400).json({
//         code: "INVALID_ORDER_STATUS",
//         message: "Order is not eligible for payment.",
//         currentStatus: order.status,
//       });
//     }
//     // 3. Charge via Paystack
//     const response = await axios.post(
//       "https://api.paystack.co/transaction/charge_authorization",
//       {
//         authorization_code: card.cardToken,
//         email: userEmail,
//         amount: order.totalPrice * 100, // convert to kobo
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${config.paystackSecret}`,
//         },
//       }
//     );
//     // 4. Process response
//     if (response.data.status === "success") {
//       await handleSuccessfulPayment(order, response.data.reference);
//       await createAuditLog({
//         userId,
//         action: "CHARGE_SAVED_CARD_SUCCESS",
//         req,
//         metadata: {
//           orderId: order.id,
//           reference: response.data.reference,
//           amount: order.totalPrice,
//         },
//       });
//       return res.json({
//         code: "PAYMENT_SUCCESS",
//         message: "Payment successful",
//         reference: response.data.reference,
//       });
//     }
//     throw new Error(response.data.message || "Payment failed");
//   } catch (error: any) {
//     console.error("Charge saved card error:", error);
//     await createAuditLog({
//       userId: req.user!.id,
//       action: "CHARGE_SAVED_CARD_FAILED",
//       req,
//       metadata: { error: error.message },
//     });
//     return res.status(500).json({
//       code: "PAYMENT_FAILED",
//       message: "Payment attempt failed.",
//       details: error.message,
//     });
//   }
// };
/**
 * =========================
 *  GET ALL SAVED CARDS
 * =========================
 */
const getSavedCards = async (req, res) => {
    try {
        const userId = req.user.id;
        const cards = await prisma_1.default.userPaymentMethod.findMany({
            where: { userId },
            select: {
                id: true,
                last4: true,
                brand: true,
                isDefault: true,
                createdAt: true,
            },
            orderBy: { isDefault: "desc" },
        });
        return res.json({ cards });
    }
    catch (error) {
        console.error("Get saved cards error:", error);
        return res.status(500).json({
            code: "SERVER_ERROR",
            message: "Failed to retrieve saved cards",
        });
    }
};
exports.getSavedCards = getSavedCards;
/**
 * =========================
 *  SET DEFAULT CARD
 * =========================
 */
const setDefaultCard = async (req, res) => {
    try {
        const { cardId } = req.body;
        const userId = req.user.id;
        if (!cardId) {
            return res.status(400).json({
                code: "VALIDATION_ERROR",
                message: "Missing required field: cardId",
            });
        }
        await prisma_1.default.$transaction([
            prisma_1.default.userPaymentMethod.updateMany({
                where: { userId, isDefault: true },
                data: { isDefault: false },
            }),
            prisma_1.default.userPaymentMethod.update({
                where: { id: cardId, userId },
                data: { isDefault: true },
            }),
        ]);
        await (0, auditLog_service_1.createAuditLog)({
            userId,
            action: "SET_DEFAULT_CARD",
            req,
            metadata: { cardId },
        });
        return res.json({
            code: "DEFAULT_UPDATED",
            message: "Default card updated",
        });
    }
    catch (error) {
        console.error("Set default card error:", error);
        return res.status(500).json({
            code: "SERVER_ERROR",
            message: "Failed to update default card",
        });
    }
};
exports.setDefaultCard = setDefaultCard;
/**
 * =========================
 *  DELETE SAVED CARD
 * =========================
 */
const deleteSavedCard = async (req, res) => {
    try {
        const { cardId } = req.params;
        const userId = req.user.id;
        if (!cardId) {
            return res.status(400).json({
                code: "VALIDATION_ERROR",
                message: "Missing cardId in request params",
            });
        }
        await prisma_1.default.userPaymentMethod.delete({
            where: { id: cardId, userId },
        });
        await (0, auditLog_service_1.createAuditLog)({
            userId,
            action: "DELETE_SAVED_CARD",
            req,
            metadata: { cardId },
        });
        return res.json({
            code: "CARD_DELETED",
            message: "Card removed successfully",
        });
    }
    catch (error) {
        console.error("Delete saved card error:", error);
        return res.status(500).json({
            code: "SERVER_ERROR",
            message: "Failed to delete card",
        });
    }
};
exports.deleteSavedCard = deleteSavedCard;
// export const submitOtp = async (req: AuthRequest, res: Response) => {
//   try {
//     const { reference, otp } = req.body;
//     const userId = req.user!.id;
//     if (!reference || !otp) {
//       return res.status(400).json({
//         code: 'VALIDATION_ERROR',
//         message: 'Missing required fields: reference, otp',
//       });
//     }
//     // 1️⃣ Verify the payment exists
//     const payment = await prisma.payment.findUnique({
//       where: { reference },
//     });
//     if (!payment || payment.userId !== userId) {
//       return res.status(404).json({
//         code: 'PAYMENT_NOT_FOUND',
//         message: 'Payment not found or not yours',
//       });
//     }
//     if (payment.status === 'success') {
//       return res.status(200).json({ message: 'Payment already confirmed' });
//     }
//     // 2️⃣ Call Paystack submit_otp endpoint
//     const response = await axios.post(
//       'https://api.paystack.co/transaction/submit_otp',
//       {
//         otp,
//         reference,
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${config.paystackSecret}`,
//         },
//       }
//     );
//     const data = response.data;
//     // 3️⃣ Handle Paystack response
//     if (data.status === true && data.data.status === 'success') {
//       // Payment successful
//       const order = await prisma.order.findUnique({ where: { id: payment.orderId } });
//       if (!order) throw new Error('Order not found for payment');
//       await handleSuccessfulPayment(order, reference);
//       await createAuditLog({
//         userId,
//         action: 'SUBMIT_OTP_SUCCESS',
//         req,
//         metadata: {
//           reference,
//           orderId: order.id,
//           amount: payment.amount,
//         },
//       });
//       return res.json({
//         code: 'PAYMENT_SUCCESS',
//         message: 'Payment confirmed via OTP',
//         reference,
//       });
//     } else if (data.status === true && data.data.status === 'send_pin') {
//       // Additional PIN required
//       return res.status(200).json({
//         code: 'SEND_PIN',
//         message: 'Card requires PIN before completing OTP',
//         reference,
//       });
//     } else {
//       // Any other status is failure
//       await createAuditLog({
//         userId,
//         action: 'SUBMIT_OTP_FAILED',
//         req,
//         metadata: { reference, paystackResponse: data },
//       });
//       return res.status(400).json({
//         code: 'OTP_FAILED',
//         message: data.message || 'Failed to confirm OTP',
//         details: data,
//       });
//     }
//   } catch (error: any) {
//     console.error('submitOtp error:', error);
//     await createAuditLog({
//       userId: req.user!.id,
//       action: 'SUBMIT_OTP_ERROR',
//       req,
//       metadata: { error: error.message },
//     });
//     return res.status(500).json({
//       code: 'SERVER_ERROR',
//       message: 'Failed to submit OTP',
//       details: error.message,
//     });
//   }
// };

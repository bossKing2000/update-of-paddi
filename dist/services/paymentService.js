"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSuccessfulPayment = exports.verifyPayment = exports.initializePayment = void 0;
exports.cancelOrdersForOfflineProduct = cancelOrdersForOfflineProduct;
// src/services/paymentService.ts
const client_1 = require("@prisma/client");
const axiosClient_1 = require("../lib/axiosClient");
const recordActivityBundle_1 = require("../utils/activityUtils/recordActivityBundle");
const prisma_1 = __importDefault(require("../lib/prisma"));
const async_retry_1 = __importDefault(require("async-retry"));
const generateReceipt_1 = require("../utils/generate Receipt/generateReceipt");
const time_1 = require("../utils/time");
/**
 * ----------------------------
 *  PAYSTACK PAYMENT FUNCTIONS
 * ----------------------------
 */
const initializePayment = async (amount, email, metadata) => {
    const response = await axiosClient_1.paystack.post("/transaction/initialize", {
        email,
        amount,
        metadata,
    });
    return response.data.data;
};
exports.initializePayment = initializePayment;
const verifyPayment = async (reference) => {
    const response = await axiosClient_1.paystack.get(`/transaction/verify/${reference}`);
    return response.data.data;
};
exports.verifyPayment = verifyPayment;
/**
 * ----------------------------
 *  HANDLE SUCCESSFUL PAYMENT
 * ----------------------------
 */
const handleSuccessfulPayment = async (order, reference, meta = {}) => {
    const amountInNaira = order.totalPrice;
    await (0, async_retry_1.default)(async (bail, attempt) => {
        try {
            const now = (0, time_1.nowUtc)();
            const graceMinutes = order.paymentGraceMinutes ?? 15;
            // 🕒 Determine earliest product takeDown + grace window (UTC)
            const productLiveUntil = order.Product?.reduce((earliest, prod) => {
                if (!prod.productSchedule?.takeDownAt)
                    return earliest;
                const takeDownUtc = (0, time_1.toUtc)(prod.productSchedule.takeDownAt);
                const grace = prod.productSchedule.graceMinutes ?? graceMinutes;
                const effectiveClose = (0, time_1.addMinutesUtc)(takeDownUtc, grace);
                return earliest
                    ? new Date(Math.min(earliest.getTime(), effectiveClose.getTime()))
                    : effectiveClose;
            }, null) ?? null;
            // Grace deadline for order itself (UTC)
            const paymentStartUtc = order.paymentInitiatedAt
                ? (0, time_1.toUtc)(order.paymentInitiatedAt)
                : now;
            const graceDeadline = (0, time_1.addMinutesUtc)(paymentStartUtc, graceMinutes);
            const productStillLive = productLiveUntil && (0, time_1.isBeforeUtc)(now, productLiveUntil);
            const isWithinGrace = (0, time_1.isBeforeUtc)(now, graceDeadline);
            // ❌ CASE: Payment never started & product offline
            if (!order.paymentInitiatedAt && !productStillLive) {
                console.warn(`[WEBHOOK] ❌ Order ${order.id} expired before payment — marking expired`);
                await prisma_1.default.payment.upsert({
                    where: { reference },
                    update: { status: "expired_before_payment" },
                    create: {
                        userId: order.customerId,
                        orderId: order.id,
                        amount: amountInNaira,
                        reference,
                        status: "expired_before_payment",
                        channel: meta.channel || "saved_card",
                        ipAddress: meta.ipAddress,
                        deviceId: meta.deviceId,
                        geoCity: meta.geoCity || "",
                        geoCountry: meta.geoCountry || "",
                        expiresAt: graceDeadline,
                    },
                });
                return;
            }
            // ⚠️ CASE: Grace expired or product went offline before payment
            if (!productStillLive || !isWithinGrace) {
                console.warn(`[WEBHOOK] ⚠️ Late or expired payment for order ${order.id}`);
                await prisma_1.default.payment.upsert({
                    where: { reference },
                    update: { status: "late_payment_flagged" },
                    create: {
                        userId: order.customerId,
                        orderId: order.id,
                        amount: amountInNaira,
                        reference,
                        status: "late_payment_flagged",
                        channel: meta.channel || "saved_card",
                        ipAddress: meta.ipAddress,
                        deviceId: meta.deviceId,
                        geoCity: meta.geoCity || "",
                        geoCountry: meta.geoCountry || "",
                        expiresAt: graceDeadline,
                    },
                });
                return;
            }
            // ✅ Normal successful payment
            const existingPayment = await prisma_1.default.payment.findUnique({
                where: { reference },
            });
            if (existingPayment) {
                if (existingPayment.status === "success")
                    return;
                await prisma_1.default.$transaction([
                    prisma_1.default.payment.update({
                        where: { reference },
                        data: {
                            status: "success",
                            expiresAt: graceDeadline,
                            channel: meta.channel,
                            ipAddress: meta.ipAddress,
                            deviceId: meta.deviceId,
                            geoCity: meta.geoCity || "",
                            geoCountry: meta.geoCountry || "",
                        },
                    }),
                    prisma_1.default.order.update({
                        where: { id: order.id },
                        data: {
                            status: client_1.OrderStatus.PAYMENT_CONFIRMED,
                            paidAt: now,
                        },
                    }),
                ]);
            }
            else {
                await prisma_1.default.$transaction([
                    prisma_1.default.payment.create({
                        data: {
                            userId: order.customerId,
                            orderId: order.id,
                            amount: amountInNaira,
                            reference,
                            status: "success",
                            channel: meta.channel || "saved_card",
                            ipAddress: meta.ipAddress,
                            deviceId: meta.deviceId,
                            geoCity: meta.geoCity || "",
                            geoCountry: meta.geoCountry || "",
                            expiresAt: graceDeadline,
                        },
                    }),
                    prisma_1.default.order.update({
                        where: { id: order.id },
                        data: {
                            status: client_1.OrderStatus.PAYMENT_CONFIRMED,
                            paidAt: now,
                        },
                    }),
                ]);
            }
            // 🧾 Generate receipt + record activity
            try {
                const receipt = await (0, generateReceipt_1.generateReceipt)(reference);
                console.log(`[RECEIPT] ✅ Generated at ${receipt.pdfUrl}`);
            }
            catch (err) {
                console.error(`[RECEIPT] ❌ Failed to generate receipt: ${err.message}`);
            }
            await (0, recordActivityBundle_1.recordActivityBundle)({
                actorId: order.customerId,
                orderId: order.id,
                actions: [
                    {
                        type: client_1.ActivityType.PAYMENT_SUCCESS,
                        title: "Payment Successful",
                        message: `Your payment for order #${order.id} confirmed.`,
                        targetId: order.customerId,
                        socketEvent: "PAYMENT",
                        metadata: { orderId: order.id, amount: amountInNaira, reference },
                    },
                    {
                        type: client_1.ActivityType.NEW_PAID_ORDER,
                        title: "New Paid Order",
                        message: `You have received a new paid order #${order.id}.`,
                        targetId: order.vendorId,
                        socketEvent: "ORDER",
                        metadata: { orderId: order.id, amount: amountInNaira, reference },
                    },
                ],
                audit: {
                    action: "HANDLE_PAYMENT_WEBHOOK",
                    metadata: {
                        orderId: order.id,
                        customerId: order.customerId,
                        vendorId: order.vendorId,
                        reference,
                        amount: amountInNaira,
                    },
                },
                notifyRealtime: true,
                notifyPush: true,
            });
        }
        catch (err) {
            if (err.code === "P2002")
                bail(err);
            throw err;
        }
    }, { retries: 3, factor: 2, minTimeout: 500, maxTimeout: 2000 });
};
exports.handleSuccessfulPayment = handleSuccessfulPayment;
/**
 * ----------------------------
 * CANCEL ORDERS FOR SPECIFIC OFFLINE PRODUCT
 * ----------------------------
 */
async function cancelOrdersForOfflineProduct(productId) {
    try {
        const now = (0, time_1.nowUtc)();
        const defaultGraceMinutes = 15;
        // Fetch active orders containing this product
        const orders = await prisma_1.default.order.findMany({
            where: {
                items: { some: { productId } },
                status: { in: [client_1.OrderStatus.AWAITING_PAYMENT] },
            },
            include: {
                payments: { orderBy: { createdAt: "desc" }, take: 1 },
                items: {
                    include: {
                        product: {
                            include: {
                                productSchedule: {
                                    select: { takeDownAt: true, graceMinutes: true },
                                },
                            },
                        },
                    },
                },
            },
        });
        for (const order of orders) {
            const latestPayment = order.payments[0];
            const orderGrace = order.paymentGraceMinutes ?? defaultGraceMinutes;
            // Determine earliest product offline time (UTC)
            const productLiveUntil = order.items.reduce((earliest, item) => {
                const sch = item.product.productSchedule;
                if (!sch?.takeDownAt)
                    return earliest;
                const takeDownUtc = (0, time_1.toUtc)(sch.takeDownAt);
                const grace = sch.graceMinutes ?? orderGrace;
                const effectiveClose = (0, time_1.addMinutesUtc)(takeDownUtc, grace);
                return earliest
                    ? new Date(Math.min(earliest.getTime(), effectiveClose.getTime()))
                    : effectiveClose;
            }, null);
            const productOffline = productLiveUntil && (0, time_1.isAfterUtc)(now, productLiveUntil);
            const paymentExpired = latestPayment?.expiresAt && (0, time_1.isAfterUtc)(now, latestPayment.expiresAt);
            // Only cancel if both product is offline and payment expired (or no payment)
            if (!latestPayment || (productOffline && paymentExpired)) {
                await prisma_1.default.order.update({
                    where: { id: order.id },
                    data: {
                        status: client_1.OrderStatus.CANCELLED,
                        cancelledAt: now,
                        cancellationReason: productOffline
                            ? "PRODUCT_WENT_OFFLINE_BEFORE_PAYMENT"
                            : "PAYMENT_EXPIRED",
                        paymentStatus: "FAILED",
                    },
                });
            }
        }
        console.log(`[cancelOrdersForOfflineProduct] 🧹 Completed for product ${productId}`);
    }
    catch (err) {
        console.error(`[cancelOrdersForOfflineProduct] ❌ Failed for product ${productId}:`, err);
    }
}

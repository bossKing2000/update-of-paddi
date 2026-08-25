"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOrderCleanupJob = void 0;
const time_1 = require("../../utils/time");
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const logger_1 = require("../../lib/logger");
/**
 * 🧹 Automatically cancels expired or offline orders in batches
 */
const runOrderCleanupJob = async (batchSize = 1000) => {
    const now = (0, time_1.nowUtc)();
    const graceMinutesDefault = 15;
    let offlineUpdated = 0;
    try {
        logger_1.logger.info({ now: now.toISOString() }, "Running order cleanup job");
        let loopCounter = 0;
        while (true) {
            loopCounter++;
            if (loopCounter > 1000)
                break;
            const batch = await prismaClient_1.default.order.findMany({
                where: {
                    status: client_1.OrderStatus.AWAITING_PAYMENT,
                    OR: [
                        // Product-level offline (existing rule)
                        {
                            items: {
                                some: {
                                    product: {
                                        OR: [
                                            { isLive: false },
                                            { productSchedule: { takeDownAt: { lt: now } } },
                                        ],
                                    },
                                },
                            },
                        },
                        // Vendor Live: vendor went offline or paused orders (same
                        // lifecycle treatment as product-offline — only affects
                        // AWAITING_PAYMENT orders; paid/completed orders are untouched)
                        {
                            vendor: {
                                OR: [
                                    { isLive: false },
                                    { deliveryPreferences: { path: ["acceptingOrders"], equals: false } },
                                ],
                            },
                        },
                    ],
                },
                include: {
                    vendor: { select: { id: true, isLive: true, deliveryPreferences: true } },
                    items: {
                        include: {
                            product: {
                                select: {
                                    id: true,
                                    isLive: true,
                                    liveUntil: true,
                                    productSchedule: {
                                        select: { takeDownAt: true, graceMinutes: true },
                                    },
                                },
                            },
                        },
                    },
                    payments: { orderBy: { createdAt: "desc" }, take: 1 },
                },
                take: batchSize,
            });
            if (batch.length === 0)
                break;
            for (const order of batch) {
                const latestPayment = order.payments[0];
                const orderGrace = order.paymentGraceMinutes ?? graceMinutesDefault;
                const productOffline = order.items.some((item) => {
                    const prod = item.product;
                    const sch = prod.productSchedule;
                    const grace = sch?.graceMinutes ?? orderGrace;
                    const scheduledClose = sch?.takeDownAt
                        ? (0, time_1.addMinutesUtc)(sch.takeDownAt, grace)
                        : null;
                    const liveUntilClose = prod.liveUntil ? new Date(prod.liveUntil) : null;
                    return (!prod.isLive ||
                        (scheduledClose && (0, time_1.isAfterUtc)(now, scheduledClose)) ||
                        (liveUntilClose && (0, time_1.isAfterUtc)(now, liveUntilClose)));
                });
                // Vendor Live: vendor offline / paused orders blocks the unpaid
                // purchase flow exactly like product-offline does.
                const vendorOffline = !order.vendor.isLive ||
                    (order.vendor.deliveryPreferences?.acceptingOrders === false);
                const paymentExpired = latestPayment?.expiresAt
                    ? (0, time_1.isAfterUtc)(now, latestPayment.expiresAt)
                    : true;
                const offline = productOffline || vendorOffline;
                if (!latestPayment || (offline && paymentExpired)) {
                    await prismaClient_1.default.order.update({
                        where: { id: order.id },
                        data: {
                            status: client_1.OrderStatus.CANCELLED,
                            cancelledAt: now,
                            cancellationReason: productOffline
                                ? "PRODUCT_WENT_OFFLINE_BEFORE_PAYMENT"
                                : vendorOffline
                                    ? "VENDOR_WENT_OFFLINE_BEFORE_PAYMENT"
                                    : "PAYMENT_EXPIRED",
                            paymentStatus: "FAILED",
                        },
                    });
                    offlineUpdated++;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        logger_1.logger.info({ offlineUpdated }, "Order cleanup job complete");
    }
    catch (err) {
        logger_1.logger.error({ err }, "Error in order cleanup job");
    }
};
exports.runOrderCleanupJob = runOrderCleanupJob;

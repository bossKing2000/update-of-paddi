"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOrderCleanupJob = void 0;
const time_1 = require("../../utils/time");
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
/**
 * 🧹 Automatically cancels expired or offline orders in batches
 */
const runOrderCleanupJob = async (batchSize = 1000) => {
    const now = (0, time_1.nowUtc)();
    const graceMinutesDefault = 15;
    let offlineUpdated = 0;
    try {
        console.log("🧹 Running order cleanup job (UTC)...", now.toISOString());
        let loopCounter = 0;
        while (true) {
            loopCounter++;
            if (loopCounter > 1000)
                break;
            const batch = await prismaClient_1.default.order.findMany({
                where: {
                    status: client_1.OrderStatus.AWAITING_PAYMENT,
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
                include: {
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
                const paymentExpired = latestPayment?.expiresAt
                    ? (0, time_1.isAfterUtc)(now, latestPayment.expiresAt)
                    : true;
                if (!latestPayment || (productOffline && paymentExpired)) {
                    await prismaClient_1.default.order.update({
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
                    offlineUpdated++;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        console.log(`✅ Cleanup done (UTC) → Offline cancelled: ${offlineUpdated}`);
    }
    catch (err) {
        console.error("❌ Error in order cleanup job:", err instanceof Error ? err.message : err);
    }
};
exports.runOrderCleanupJob = runOrderCleanupJob;

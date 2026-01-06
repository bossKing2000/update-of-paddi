"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.productDeactivateWorker = exports.productDeactivateQueue = void 0;
const bullmq_1 = require("bullmq");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const bullmqConnection_1 = require("../../lib/bullmqConnection");
const product_service_1 = require("../../services/product.service");
const paymentService_1 = require("../../services/paymentService");
const time_1 = require("../../utils/time");
const redis_1 = require("../../lib/redis");
const clearCaches_1 = require("../../services/clearCaches");
exports.productDeactivateQueue = new bullmq_1.Queue("productDeactivateJob", {
    connection: bullmqConnection_1.bullmqConnection,
});
exports.productDeactivateWorker = new bullmq_1.Worker("productDeactivateJob", async (job) => {
    const { productId } = job.data;
    const now = (0, time_1.nowUtc)(); // ✅ Always UTC
    // 1️⃣ Fetch the product schedule
    const schedule = await prismaClient_1.default.productSchedule.findUnique({
        where: { productId },
    });
    if (!schedule)
        return;
    // 2️⃣ Handle auto-grace if enabled (delay calculated in UTC-safe way)
    if (schedule.autoGraceEnabled && schedule.graceMinutes && schedule.graceMinutes > 0) {
        const graceDelayMs = schedule.graceMinutes * 60 * 1000;
        const graceEndUtc = (0, time_1.addMinutesUtc)(now, schedule.graceMinutes);
        await exports.productDeactivateQueue.add("finalDeactivate", { productId }, { delay: graceDelayMs });
        console.log(`[productDeactivateWorker] Grace period active for ${schedule.graceMinutes} minutes (until ${graceEndUtc.toISOString()}).`);
        return;
    }
    // 3️⃣ Fetch the actual product (needed for vendorId & category for cache clearing)
    const product = await prismaClient_1.default.product.findUnique({
        where: { id: productId },
        select: { id: true, vendorId: true, category: true },
    });
    if (!product) {
        console.warn(`[productDeactivateWorker] Product not found for ${productId}`);
        return;
    }
    // 4️⃣ Deactivate product schedule & product in transaction (UTC timestamps)
    await prismaClient_1.default.$transaction([
        prismaClient_1.default.productSchedule.updateMany({
            where: { productId },
            data: {
                isLive: false,
                goLiveAt: null,
                takeDownAt: null,
                updatedAt: now,
            },
        }),
        prismaClient_1.default.product.update({
            where: { id: productId },
            data: {
                isLive: false,
                liveUntil: null,
                updatedAt: now,
            },
        }),
    ]);
    console.log(`[productDeactivateWorker] Product ${productId} marked as offline at ${now.toISOString()} (UTC).`);
    // 5️⃣ Clear related caches & carts
    await (0, clearCaches_1.clearProductCache)(productId);
    await (0, product_service_1.clearProductFromCarts)(productId);
    if (product.category)
        await redis_1.redisProducts.del(`category:${product.category}:products`);
    // 7️⃣ Cancel linked orders safely
    await (0, paymentService_1.cancelOrdersForOfflineProduct)(productId);
    console.log(`[productDeactivateWorker] Linked orders and caches for product ${productId} processed safely at ${now.toISOString()} (UTC).`);
}, { connection: bullmqConnection_1.bullmqConnection });

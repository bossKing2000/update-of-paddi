"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.productLiveWorker = exports.productLiveQueue = void 0;
const bullmq_1 = require("bullmq");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const bullmqConnection_1 = require("../../lib/bullmqConnection");
const recordActivityBundle_1 = require("../../utils/activityUtils/recordActivityBundle");
const product_service_1 = require("../../services/product.service");
const clearCaches_1 = require("../../services/clearCaches");
const client_1 = require("@prisma/client");
/**
 * 🎯 BullMQ queue for product "Go Live" notifications
 */
exports.productLiveQueue = new bullmq_1.Queue("productLiveNotifications", {
    connection: bullmqConnection_1.bullmqConnection,
});
/**
 * 👷 Worker that processes product live notifications
 */
exports.productLiveWorker = new bullmq_1.Worker("productLiveNotifications", async (job) => {
    if (!job?.data)
        return;
    const { productId, vendorId } = job.data;
    console.log(`[productLiveWorker] 🚀 Starting processing for product: ${productId}`);
    const product = await prismaClient_1.default.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, category: true, vendorId: true, isLive: true },
    });
    if (!product)
        return console.warn(`[productLiveWorker] ⚠️ Product not found: ${productId}`);
    if (product.isLive)
        return console.log(`[productLiveWorker] ℹ️ Product ${product.name} already live`);
    try {
        // ✅ 1️⃣ Mark product as live in DB
        await prismaClient_1.default.$transaction([
            prismaClient_1.default.productSchedule.updateMany({ where: { productId }, data: { isLive: true } }),
            prismaClient_1.default.product.update({ where: { id: productId }, data: { isLive: true } }),
        ]);
        console.log(`[productLiveWorker] ✅ Product ${product.name} is now live`);
        // ✅ 2️⃣ Clear caches
        await (0, clearCaches_1.clearProductCache)(product.id, vendorId);
        await (0, product_service_1.clearProductFromCarts)(product.id);
        // 5️⃣ Notify users
        const [followers, cartUsers] = await Promise.all([
            prismaClient_1.default.vendorFollower.findMany({ where: { vendorId }, select: { customerId: true } }),
            prismaClient_1.default.cartItem.findMany({ where: { productId }, select: { cart: { select: { customerId: true } } } }),
        ]);
        const userIds = Array.from(new Set([
            ...followers.map(f => f.customerId),
            ...cartUsers.map(c => c.cart.customerId),
        ]));
        if (userIds.length) {
            const notificationPromises = userIds.map(userId => (0, recordActivityBundle_1.recordActivityBundle)({
                actorId: vendorId,
                actions: [{
                        type: client_1.ActivityType.GENERAL,
                        title: "Product is now live 🎉",
                        message: `${product.name} is now available for order!`,
                        targetId: userId,
                        socketEvent: "GENERAL",
                        relation: "customer",
                        metadata: {
                            type: "PRODUCT_GO_LIVE",
                            route: `/products/${product.id}`,
                            target: { screen: "product_detail", id: product.id },
                            productId: product.id,
                            productName: product.name,
                            vendorId,
                            frontendEvent: "PRODUCT_NOW_LIVE",
                            timestamp: new Date().toISOString(),
                        },
                    }],
                audit: { action: "PRODUCT_GO_LIVE", metadata: { vendorId, productId: product.id, productName: product.name, liveAt: new Date().toISOString() } },
                notifyPush: true,
                notifyRealtime: true,
            }));
            const results = await Promise.allSettled(notificationPromises);
            console.log(`[productLiveWorker] ✅ Notifications: ${results.filter(r => r.status === 'fulfilled').length} succeeded, ${results.filter(r => r.status === 'rejected').length} failed`);
        }
    }
    catch (error) {
        console.error(`[productLiveWorker] ❌ Error processing product ${productId}:`, error);
        throw error;
    }
}, {
    connection: bullmqConnection_1.bullmqConnection,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
});

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fixLiveStatuses = exports.errorResponses = exports.successResponses = exports.extendGrace = exports.takeDown = exports.goLive = void 0;
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const codeMessage_1 = require("../validators/codeMessage");
const productLiveWorker_1 = require("../jobs/workers jobs/productLiveWorker");
const productDeactivateJob_1 = require("../jobs/workers jobs/productDeactivateJob");
const time_1 = require("../utils/time");
const paramUtils_1 = require("../utils/paramUtils");
const product_service_1 = require("../services/product.service");
const clearCaches_1 = require("../services/clearCaches");
const redis_1 = require("../lib/redis");
const recordActivityBundle_1 = require("../utils/activityUtils/recordActivityBundle");
const client_1 = require("@prisma/client");
/**
 * Vendor schedules a product to go live or immediately goes live
 */
const goLive = async (req, res) => {
    try {
        const productId = (0, paramUtils_1.ensureString)(req.params.id);
        const { goLiveAt, takeDownAt, graceMinutes = 15 } = req.body;
        if (!req.user || req.user.role !== "VENDOR") {
            return res.status(403).json((0, codeMessage_1.errorResponse)("FORBIDDEN", "Only vendors can perform this."));
        }
        if (!goLiveAt || !takeDownAt) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_INPUT", "goLiveAt and takeDownAt are required."));
        }
        const product = await prismaClient_1.default.product.findUnique({
            where: { id: productId },
            include: { vendor: true, productSchedule: true },
        });
        if (!product || product.vendorId !== req.user.id) {
            return res.status(404).json((0, codeMessage_1.errorResponse)("NOT_FOUND", "Product not found or unauthorized."));
        }
        const liveTime = (0, time_1.toUtc)(goLiveAt);
        const endTime = (0, time_1.toUtc)(takeDownAt);
        const now = (0, time_1.nowUtc)();
        if (!(0, time_1.isBeforeUtc)(liveTime, endTime)) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_TIME", "takeDownAt must be after goLiveAt."));
        }
        const isImmediate = liveTime <= now;
        // Upsert product schedule and update product status
        await prismaClient_1.default.$transaction([
            prismaClient_1.default.productSchedule.upsert({
                where: { productId },
                create: {
                    productId,
                    goLiveAt: liveTime,
                    takeDownAt: endTime,
                    graceMinutes,
                    isLive: isImmediate,
                },
                update: {
                    goLiveAt: liveTime,
                    takeDownAt: endTime,
                    graceMinutes,
                    isLive: isImmediate,
                },
            }),
            prismaClient_1.default.product.update({
                where: { id: productId },
                data: { isLive: isImmediate, liveUntil: endTime },
            }),
        ]);
        // Extend pending payments expiry for this product
        const paymentExpiry = (0, time_1.addMinutesUtc)(endTime, graceMinutes);
        await prismaClient_1.default.$executeRaw `
      UPDATE "Payment"
      SET "expiresAt" = GREATEST(COALESCE("expiresAt", NOW()), ${paymentExpiry})
      WHERE "status" = 'pending'
        AND "orderId" IN (
          SELECT "id" FROM "Order"
          WHERE "status" = 'AWAITING_PAYMENT'
            AND EXISTS (
              SELECT 1 FROM "OrderItem"
              WHERE "OrderItem"."orderId" = "Order"."id"
                AND "OrderItem"."productId" = ${productId}
            )
        )
    `;
        const nowTime = (0, time_1.nowUtc)();
        if (!isImmediate) {
            // Scheduled → queue go-live job
            await productLiveWorker_1.productLiveQueue.add("makeLive", { productId, vendorId: req.user.id }, {
                delay: Math.max(0, liveTime.getTime() - nowTime.getTime()),
            });
        }
        else {
            // Immediate → clear caches using helper
            // await clearProductCache(productId, req.user.id);
            // 🚀 ALWAYS clear cache immediately after DB change
            await Promise.all([
                (0, clearCaches_1.clearProductCache)(productId, req.user.id),
            ]);
            // 🚀 Record activity + send notification to vendor
            await (0, recordActivityBundle_1.recordActivityBundle)({
                actorId: req.user.id,
                actions: [
                    {
                        type: client_1.ActivityType.GENERAL, // or PRODUCT if defined
                        title: isImmediate ? "Product is live!" : "Product scheduled",
                        message: isImmediate
                            ? `Your product "${product.name}" is now live and will be taken down at ${endTime.toISOString()} (UTC).`
                            : `Your product "${product.name}" is scheduled to go live at ${liveTime.toISOString()} (UTC).`,
                        targetId: req.user.id,
                        socketEvent: "GENERAL",
                        metadata: { productId, goLiveAt: liveTime, liveUntil: endTime },
                    },
                ],
                audit: {
                    action: isImmediate ? "PRODUCT_LIVE_NOW" : "PRODUCT_SCHEDULED",
                    metadata: { productId, vendorId: req.user.id },
                },
                notifyRealtime: true,
                notifyPush: true,
            });
        }
        // Schedule takedown job
        await productDeactivateJob_1.productDeactivateQueue.add("takeDown", { productId }, {
            delay: Math.max(0, endTime.getTime() - nowTime.getTime()),
        });
        const message = isImmediate
            ? `✅ Product is now live! Will be taken down at ${endTime.toISOString()} (UTC).`
            : `✅ Product scheduled successfully (UTC). Will go live at ${liveTime.toISOString()}.`;
        return res.json((0, codeMessage_1.successResponse)(isImmediate ? "LIVE_NOW" : "SCHEDULED", message, {
            isLive: isImmediate,
            goLiveAt: liveTime.toISOString(),
            liveUntil: endTime.toISOString(),
            graceMinutes,
        }));
    }
    catch (err) {
        console.error("[goLive] ❌ Error scheduling product:", err);
        return res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to schedule product."));
    }
};
exports.goLive = goLive;
/**
 * POST /:id/schedule/take-down
 */
/**
 * POST /:id/schedule/take-down
 * Vendor takes down a product immediately.
 */
const takeDown = async (req, res) => {
    try {
        const productId = (0, paramUtils_1.ensureString)(req.params.id);
        // Fetch product
        const product = await prismaClient_1.default.product.findUnique({ where: { id: productId } });
        if (!product)
            return res.status(404).json((0, codeMessage_1.errorResponse)("NOT_FOUND", "Product not found."));
        // Update product and schedule in a transaction
        await prismaClient_1.default.$transaction([
            prismaClient_1.default.productSchedule.updateMany({
                where: { productId },
                data: { isLive: false, goLiveAt: null, takeDownAt: null, graceMinutes: 0 },
            }),
            prismaClient_1.default.product.update({
                where: { id: productId },
                data: { isLive: false, liveUntil: null },
            }),
        ]);
        // Invalidate caches and remove from carts
        await (0, clearCaches_1.clearProductCache)(productId);
        await (0, product_service_1.clearProductFromCarts)(productId);
        // 🚀 Record activity + notify vendor
        await (0, recordActivityBundle_1.recordActivityBundle)({
            actorId: req.user?.id || "system",
            actions: [
                {
                    type: client_1.ActivityType.GENERAL, // or PRODUCT if defined
                    title: "Product taken down",
                    message: `Your product "${product.name}" has been taken down.`,
                    targetId: product.vendorId, // vendor who owns the product
                    socketEvent: "GENERAL",
                    metadata: { productId },
                },
            ],
            audit: {
                action: "PRODUCT_TAKEN_DOWN",
                metadata: { productId, vendorId: product.vendorId },
            },
            notifyRealtime: true,
            notifyPush: true,
        });
        // Vendor-specific product lists
        await redis_1.redisProducts.del(`vendor:${product.vendorId}:products`);
        await redis_1.redisProducts.del(`vendor:${product.vendorId}:products:available`);
        // Global product lists
        await redis_1.redisProducts.del(`products:all`);
        await redis_1.redisProducts.del(`products:featured`);
        // Category-specific cache
        if (product.category) {
            await redis_1.redisProducts.del(`category:${product.category}:products`);
        }
        // Optional: search & filtered lists
        const searchPatterns = [
            `search:*${product.name}*`,
            `api:products:*`,
            `api:search:*`,
        ];
        for (const pattern of searchPatterns) {
            let cursor = '0';
            do {
                const result = await redis_1.redisProducts.scan(cursor, { MATCH: pattern, COUNT: 50 });
                cursor = result.cursor;
                const keys = result.keys;
                if (keys.length > 0)
                    await redis_1.redisProducts.del(keys);
            } while (cursor !== '0');
        }
        return res.json((0, codeMessage_1.successResponse)("TAKEN_DOWN", "Product taken down successfully."));
    }
    catch (err) {
        console.error("takeDown error:", err);
        return res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to take down product."));
    }
};
exports.takeDown = takeDown;
/**
 * POST /:id/schedule/extend-grace
 */
const extendGrace = async (req, res) => {
    try {
        const productId = (0, paramUtils_1.ensureString)(req.params.id);
        const { extraMinutes } = req.body;
        if (!extraMinutes || extraMinutes <= 0)
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_INPUT", "extraMinutes must be positive."));
        const schedule = await prismaClient_1.default.productSchedule.findUnique({ where: { productId } });
        if (!schedule || !schedule.isLive)
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_STATE", "Product is not currently live."));
        await prismaClient_1.default.productSchedule.update({
            where: { productId },
            data: { graceMinutes: (schedule.graceMinutes || 0) + extraMinutes },
        });
        await productDeactivateJob_1.productDeactivateQueue.add("finalDeactivate", { productId }, { delay: extraMinutes * 60 * 1000 });
        await prismaClient_1.default.productSchedule.update({
            where: { productId },
            data: { graceMinutes: (schedule.graceMinutes || 0) + extraMinutes },
        });
        // 🚀 Record activity + notify vendor
        await (0, recordActivityBundle_1.recordActivityBundle)({
            actorId: req.user?.id || "system",
            actions: [
                {
                    type: client_1.ActivityType.GENERAL, // or PRODUCT if defined
                    title: "Grace period extended",
                    message: `The grace period for your product "${productId}" has been extended by ${extraMinutes} minutes.`,
                    targetId: req.user?.id || undefined,
                    socketEvent: "GENERAL",
                    metadata: { productId, extraMinutes },
                },
            ],
            audit: {
                action: "GRACE_PERIOD_EXTENDED",
                metadata: { productId, vendorId: req.user?.id, extraMinutes },
            },
            notifyRealtime: true,
            notifyPush: true,
        });
        return res.json((0, codeMessage_1.successResponse)("GRACE_EXTENDED", "Grace period extended successfully."));
    }
    catch (err) {
        console.error("extendGrace error:", err);
        return res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to extend grace."));
    }
};
exports.extendGrace = extendGrace;
/**
 * ✅ Success Response Helper
 */
const successResponses = (code, data, message = "Operation successful") => ({
    success: true,
    code,
    message,
    data,
});
exports.successResponses = successResponses;
/**
 * ❌ Error Response Helper
 */
const errorResponses = (code, message, error) => ({
    success: false,
    code,
    message,
    error: process.env.NODE_ENV === "development" ? error : undefined,
});
exports.errorResponses = errorResponses;
/**
 * 🧩 Fix Live Statuses Controller
 *
 * Ensures all products' live statuses match their schedules.
 * Automatically sets `isLive` and `liveUntil` based on `goLiveAt`, `takeDownAt`, and `graceMinutes`.
 */
const fixLiveStatuses = async (req, res) => {
    const now = new Date();
    console.log("🛠 Running product live-status fixer via controller...", now.toISOString());
    try {
        // 🧠 Fetch all products that have schedules
        const products = await prismaClient_1.default.product.findMany({
            where: {
                productSchedule: {
                    isNot: null,
                },
            },
            include: {
                productSchedule: {
                    select: {
                        id: true,
                        goLiveAt: true,
                        takeDownAt: true,
                        graceMinutes: true,
                        isLive: true,
                    },
                },
            },
        });
        if (products.length === 0) {
            res.json((0, exports.successResponses)("NO_SCHEDULES_FOUND", null, "No products with schedules found."));
        }
        let updatedCount = 0;
        const updates = [];
        for (const product of products) {
            const sched = product.productSchedule;
            if (!sched)
                continue;
            // ✅ Guard against invalid date fields
            if (!sched.goLiveAt || !sched.takeDownAt)
                continue;
            const goLiveAt = new Date(sched.goLiveAt);
            const takeDownAt = new Date(sched.takeDownAt);
            // ⏰ Extend grace period if applicable
            const graceExpiry = new Date(takeDownAt);
            if (sched.graceMinutes && sched.graceMinutes > 0) {
                graceExpiry.setMinutes(graceExpiry.getMinutes() + sched.graceMinutes);
            }
            const shouldBeLive = now >= goLiveAt && now <= graceExpiry;
            // 🧾 Detect mismatched states
            const productLiveMismatch = product.isLive !== shouldBeLive;
            const productLiveUntilMismatch = !product.liveUntil || product.liveUntil.getTime() !== takeDownAt.getTime();
            const scheduleLiveMismatch = sched.isLive !== shouldBeLive;
            // 🚫 Skip products that are already in sync
            if (!productLiveMismatch && !scheduleLiveMismatch && !productLiveUntilMismatch)
                continue;
            console.log(`[fixLiveStatuses] Updating product=${product.id} (${product.name}) → shouldBeLive=${shouldBeLive}`);
            const ops = [];
            // 🧩 Update Product
            if (productLiveMismatch || productLiveUntilMismatch) {
                ops.push(prismaClient_1.default.product.update({
                    where: { id: product.id },
                    data: {
                        isLive: shouldBeLive,
                        liveUntil: takeDownAt,
                        updatedAt: new Date(),
                    },
                }));
            }
            // 🧩 Update Product Schedule
            if (scheduleLiveMismatch) {
                ops.push(prismaClient_1.default.productSchedule.update({
                    where: { id: sched.id },
                    data: { isLive: shouldBeLive },
                }));
            }
            // 🧠 Execute updates atomically
            if (ops.length > 0) {
                await prismaClient_1.default.$transaction(ops);
                // 🧹 Invalidate cache safely
                try {
                    await (0, clearCaches_1.clearProductCache)(product.id);
                }
                catch (cacheErr) {
                    console.warn(`[CACHE] Failed to invalidate product ${product.id}:`, cacheErr);
                }
                updates.push(`Product "${product.name}" (${product.id}) → ${shouldBeLive ? "LIVE ✅" : "OFFLINE ⛔"}`);
                updatedCount++;
            }
        }
        // ✅ Send summary response
        res.json((0, exports.successResponses)("LIVE_STATUS_FIXED", { updatedCount, updates }, "Product live statuses updated successfully."));
    }
    catch (error) {
        console.error("❌ Error in fixLiveStatuses:", error);
        res.status(500).json((0, exports.errorResponses)("SERVER_ERROR", "Failed to fix product live statuses. Please check server logs.", error));
    }
};
exports.fixLiveStatuses = fixLiveStatuses;

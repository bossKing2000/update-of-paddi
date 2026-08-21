"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fixLiveStatuses = exports.extendGrace = exports.takeDown = exports.goLive = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const productLiveWorker_1 = require("../jobs/workers jobs/productLiveWorker");
const productDeactivateJob_1 = require("../jobs/workers jobs/productDeactivateJob");
const time_1 = require("../utils/time");
const paramUtils_1 = require("../utils/paramUtils");
const product_service_1 = require("../services/product.service");
const clearCaches_1 = require("../services/clearCaches");
const recordActivityBundle_1 = require("../utils/activityUtils/recordActivityBundle");
const client_1 = require("@prisma/client");
const apiResponse_1 = require("../utils/apiResponse");
const AppError_1 = require("../errors/AppError");
const logger_1 = require("../lib/logger");
/**
 * Vendor schedules a product to go live, or goes live immediately
 */
const goLive = async (req, res) => {
    const productId = (0, paramUtils_1.ensureString)(req.params.id);
    const { goLiveAt, takeDownAt, graceMinutes = 15 } = req.body;
    if (!req.user || req.user.role !== "VENDOR")
        throw new AppError_1.ForbiddenError("Only vendors can perform this.");
    if (!goLiveAt || !takeDownAt)
        throw new AppError_1.ValidationError("goLiveAt and takeDownAt are required.");
    const product = await prisma_1.default.product.findUnique({
        where: { id: productId },
        include: { vendor: true, productSchedule: true },
    });
    if (!product || product.vendorId !== req.user.id)
        throw new AppError_1.NotFoundError("Product");
    const liveTime = (0, time_1.toUtc)(goLiveAt);
    const endTime = (0, time_1.toUtc)(takeDownAt);
    const now = (0, time_1.nowUtc)();
    if (!(0, time_1.isBeforeUtc)(liveTime, endTime))
        throw new AppError_1.ValidationError("takeDownAt must be after goLiveAt.");
    const isImmediate = liveTime <= now;
    await prisma_1.default.$transaction([
        prisma_1.default.productSchedule.upsert({
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
        prisma_1.default.product.update({
            where: { id: productId },
            data: { isLive: isImmediate, liveUntil: endTime },
        }),
    ]);
    // Extend pending payments' expiry so a customer mid-checkout isn't cut
    // off right as the vendor extends their live window.
    // Fixed: was comparing against 'pending' (lowercase) — Payment.status
    // is an enum now (uppercase values), so this raw SQL silently matched
    // zero rows after that change. This predates the Payments-domain pass
    // and lived undetected here since it's outside Prisma's typed query
    // API (a raw SQL string), so the earlier codebase-wide sweep for
    // Payment.status literals didn't catch it.
    const paymentExpiry = (0, time_1.addMinutesUtc)(endTime, graceMinutes);
    await prisma_1.default.$executeRaw `
    UPDATE "Payment"
    SET "expiresAt" = GREATEST(COALESCE("expiresAt", NOW()), ${paymentExpiry})
    WHERE "status" = 'PENDING'
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
        await productLiveWorker_1.productLiveQueue.add("makeLive", { productId, vendorId: req.user.id }, { delay: Math.max(0, liveTime.getTime() - nowTime.getTime()) });
    }
    else {
        await (0, clearCaches_1.clearProductCache)(productId, req.user.id);
        await (0, recordActivityBundle_1.recordActivityBundle)({
            actorId: req.user.id,
            actions: [
                {
                    type: client_1.ActivityType.GENERAL,
                    title: "Product is live!",
                    message: `Your product "${product.name}" is now live and will be taken down at ${endTime.toISOString()} (UTC).`,
                    targetId: req.user.id,
                    socketEvent: "GENERAL",
                    metadata: { productId, goLiveAt: liveTime, liveUntil: endTime },
                },
            ],
            audit: {
                action: "PRODUCT_LIVE_NOW",
                metadata: { productId, vendorId: req.user.id },
            },
            notifyRealtime: true,
            notifyPush: true,
        });
    }
    await productDeactivateJob_1.productDeactivateQueue.add("takeDown", { productId }, { delay: Math.max(0, endTime.getTime() - nowTime.getTime()) });
    const message = isImmediate
        ? `Product is now live! Will be taken down at ${endTime.toISOString()} (UTC).`
        : `Product scheduled successfully (UTC). Will go live at ${liveTime.toISOString()}.`;
    return (0, apiResponse_1.sendSuccess)(res, {
        isLive: isImmediate,
        goLiveAt: liveTime.toISOString(),
        liveUntil: endTime.toISOString(),
        graceMinutes,
    }, message);
};
exports.goLive = goLive;
/**
 * POST /:id/schedule/take-down — vendor takes their own product down immediately.
 *
 * Previously had NO ownership check at all (didn't even look at req.user),
 * and the route itself had no authentication middleware either — meaning
 * literally anyone on the internet, logged in or not, could take down any
 * vendor's product just by knowing its id. Both holes are closed: route
 * now requires auth, and this verifies the product actually belongs to
 * the caller.
 */
const takeDown = async (req, res) => {
    const productId = (0, paramUtils_1.ensureString)(req.params.id);
    if (!req.user)
        throw new AppError_1.ForbiddenError("Authentication required");
    const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
    if (!product)
        throw new AppError_1.NotFoundError("Product");
    if (product.vendorId !== req.user.id && req.user.role !== "ADMIN") {
        throw new AppError_1.ForbiddenError("You can only take down your own products");
    }
    await prisma_1.default.$transaction([
        prisma_1.default.productSchedule.updateMany({
            where: { productId },
            data: {
                isLive: false,
                goLiveAt: null,
                takeDownAt: null,
                graceMinutes: 0,
            },
        }),
        prisma_1.default.product.update({
            where: { id: productId },
            data: { isLive: false, liveUntil: null },
        }),
    ]);
    // clearProductCache already does a comprehensive SCAN-based invalidation
    // across every relevant key pattern and every Redis instance — the
    // extra manual per-key deletes and a second duplicate SCAN loop that
    // used to run right after it were redundant work doing the same thing
    // twice.
    await (0, clearCaches_1.clearProductCache)(productId, product.vendorId);
    await (0, product_service_1.clearProductFromCarts)(productId);
    await (0, recordActivityBundle_1.recordActivityBundle)({
        actorId: req.user.id,
        actions: [
            {
                type: client_1.ActivityType.GENERAL,
                title: "Product taken down",
                message: `Your product "${product.name}" has been taken down.`,
                targetId: product.vendorId,
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
    return (0, apiResponse_1.sendSuccess)(res, {}, "Product taken down successfully.");
};
exports.takeDown = takeDown;
/**
 * POST /:id/schedule/extend-grace
 */
const extendGrace = async (req, res) => {
    const productId = (0, paramUtils_1.ensureString)(req.params.id);
    const { extraMinutes } = req.body;
    if (!req.user)
        throw new AppError_1.ForbiddenError("Authentication required");
    if (!extraMinutes || extraMinutes <= 0)
        throw new AppError_1.ValidationError("extraMinutes must be positive.");
    const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
    if (!product)
        throw new AppError_1.NotFoundError("Product");
    if (product.vendorId !== req.user.id && req.user.role !== "ADMIN") {
        throw new AppError_1.ForbiddenError("You can only extend grace on your own products");
    }
    const schedule = await prisma_1.default.productSchedule.findUnique({
        where: { productId },
    });
    if (!schedule || !schedule.isLive)
        throw new AppError_1.ValidationError("Product is not currently live.");
    // Was previously run twice in a row (identical update called twice) —
    // a single update is all that's needed.
    await prisma_1.default.productSchedule.update({
        where: { productId },
        data: { graceMinutes: (schedule.graceMinutes || 0) + extraMinutes },
    });
    await productDeactivateJob_1.productDeactivateQueue.add("finalDeactivate", { productId }, { delay: extraMinutes * 60 * 1000 });
    await (0, recordActivityBundle_1.recordActivityBundle)({
        actorId: req.user.id,
        actions: [
            {
                type: client_1.ActivityType.GENERAL,
                title: "Grace period extended",
                message: `The grace period for your product "${product.name}" has been extended by ${extraMinutes} minutes.`,
                targetId: req.user.id,
                socketEvent: "GENERAL",
                metadata: { productId, extraMinutes },
            },
        ],
        audit: {
            action: "GRACE_PERIOD_EXTENDED",
            metadata: { productId, vendorId: req.user.id, extraMinutes },
        },
        notifyRealtime: true,
        notifyPush: true,
    });
    return (0, apiResponse_1.sendSuccess)(res, {}, "Grace period extended successfully.");
};
exports.extendGrace = extendGrace;
/**
 * Ensures all products' live statuses match their schedules. This is an
 * internal maintenance endpoint (also runs on a cron via fixLiveStatusJob)
 * — restricted to admin, since it was previously reachable by anyone with
 * no authentication at all.
 */
const fixLiveStatuses = async (_req, res) => {
    const now = new Date();
    logger_1.logger.info({ now: now.toISOString() }, "Running product live-status fixer via controller");
    const products = await prisma_1.default.product.findMany({
        where: { productSchedule: { isNot: null } },
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
    let updatedCount = 0;
    const updates = [];
    for (const product of products) {
        const sched = product.productSchedule;
        if (!sched || !sched.goLiveAt || !sched.takeDownAt)
            continue;
        const goLiveAt = new Date(sched.goLiveAt);
        const takeDownAt = new Date(sched.takeDownAt);
        const graceExpiry = new Date(takeDownAt);
        if (sched.graceMinutes && sched.graceMinutes > 0)
            graceExpiry.setMinutes(graceExpiry.getMinutes() + sched.graceMinutes);
        const shouldBeLive = now >= goLiveAt && now <= graceExpiry;
        const productLiveMismatch = product.isLive !== shouldBeLive;
        const productLiveUntilMismatch = !product.liveUntil ||
            product.liveUntil.getTime() !== takeDownAt.getTime();
        const scheduleLiveMismatch = sched.isLive !== shouldBeLive;
        if (!productLiveMismatch &&
            !scheduleLiveMismatch &&
            !productLiveUntilMismatch)
            continue;
        const ops = [];
        if (productLiveMismatch || productLiveUntilMismatch) {
            ops.push(prisma_1.default.product.update({
                where: { id: product.id },
                data: {
                    isLive: shouldBeLive,
                    liveUntil: takeDownAt,
                    updatedAt: new Date(),
                },
            }));
        }
        if (scheduleLiveMismatch) {
            ops.push(prisma_1.default.productSchedule.update({
                where: { id: sched.id },
                data: { isLive: shouldBeLive },
            }));
        }
        if (ops.length > 0) {
            await prisma_1.default.$transaction(ops);
            await (0, clearCaches_1.clearProductCache)(product.id).catch((err) => logger_1.logger.warn({ err, productId: product.id }, "Failed to invalidate cache"));
            updates.push(`Product "${product.name}" (${product.id}) -> ${shouldBeLive ? "LIVE" : "OFFLINE"}`);
            updatedCount++;
        }
    }
    return (0, apiResponse_1.sendSuccess)(res, { updatedCount, updates }, "Product live statuses updated successfully.");
};
exports.fixLiveStatuses = fixLiveStatuses;

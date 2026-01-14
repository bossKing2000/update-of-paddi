import prisma from "../config/prismaClient";
import { AuthRequest } from "../middlewares/auth.middleware";
import { errorResponse, successResponse } from "../validators/codeMessage";
import { productLiveQueue } from "../jobs/workers jobs/productLiveWorker";
import { productDeactivateQueue } from "../jobs/workers jobs/productDeactivateJob";
import { addMinutesUtc, isBeforeUtc, nowUtc, toUtc } from "../utils/time";
import { clearProductFromCarts } from "../services/product.service";
import { Request, Response, RequestHandler } from "express";
import { clearProductCache } from "../services/clearCaches";
import { redisProducts } from "../lib/redis";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { ActivityType } from "@prisma/client";



/**
 * Vendor schedules a product to go live or immediately goes live
 */
export const goLive = async (req: AuthRequest, res: Response) => {
  try {
    const { id: productId } = req.params;
    const { goLiveAt, takeDownAt, graceMinutes = 15 } = req.body;

    if (!req.user || req.user.role !== "VENDOR") {
      return res.status(403).json(errorResponse("FORBIDDEN", "Only vendors can perform this."));
    }

    if (!goLiveAt || !takeDownAt) {
      return res.status(400).json(errorResponse("INVALID_INPUT", "goLiveAt and takeDownAt are required."));
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { vendor: true, productSchedule: true },
    });

    if (!product || product.vendorId !== req.user.id) {
      return res.status(404).json(errorResponse("NOT_FOUND", "Product not found or unauthorized."));
    }

    const liveTime = toUtc(goLiveAt);
    const endTime = toUtc(takeDownAt);
    const now = nowUtc();

    if (!isBeforeUtc(liveTime, endTime)) {
      return res.status(400).json(errorResponse("INVALID_TIME", "takeDownAt must be after goLiveAt."));
    }

    const isImmediate = liveTime <= now;

    // Upsert product schedule and update product status
    await prisma.$transaction([
      prisma.productSchedule.upsert({
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
      prisma.product.update({
        where: { id: productId },
        data: { isLive: isImmediate, liveUntil: endTime },
      }),
    ]);

    // Extend pending payments expiry for this product
    const paymentExpiry = addMinutesUtc(endTime, graceMinutes);
    await prisma.$executeRaw`
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

    const nowTime = nowUtc();

    if (!isImmediate) {
      // Scheduled → queue go-live job
      await productLiveQueue.add("makeLive", { productId, vendorId: req.user.id }, {
        delay: Math.max(0, liveTime.getTime() - nowTime.getTime()),
      });
    } else {
      // Immediate → clear caches using helper
      // await clearProductCache(productId, req.user.id);
      // 🚀 ALWAYS clear cache immediately after DB change
await Promise.all([
  clearProductCache(productId, req.user.id),
]);

// 🚀 Record activity + send notification to vendor
await recordActivityBundle({
  actorId: req.user.id,
  actions: [
    {
      type: ActivityType.GENERAL, // or PRODUCT if defined
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
    await productDeactivateQueue.add("takeDown", { productId }, {
      delay: Math.max(0, endTime.getTime() - nowTime.getTime()),
    });

    const message = isImmediate 
      ? `✅ Product is now live! Will be taken down at ${endTime.toISOString()} (UTC).`
      : `✅ Product scheduled successfully (UTC). Will go live at ${liveTime.toISOString()}.`;

    return res.json(
      successResponse(
        isImmediate ? "LIVE_NOW" : "SCHEDULED",
        message,
        {
          isLive: isImmediate,
          goLiveAt: liveTime.toISOString(),
          liveUntil: endTime.toISOString(),
          graceMinutes,
        }
      )
    );

  } catch (err) {
    console.error("[goLive] ❌ Error scheduling product:", err);
    return res.status(500).json(errorResponse("SERVER_ERROR", "Failed to schedule product."));
  }
};


/**
 * POST /:id/schedule/take-down
 */

/**
 * POST /:id/schedule/take-down
 * Vendor takes down a product immediately.
 */
export const takeDown = async (req: AuthRequest, res: Response) => {
  try {
    const { id: productId } = req.params;

    // Fetch product
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product)
      return res.status(404).json(errorResponse("NOT_FOUND", "Product not found."));

    // Update product and schedule in a transaction
    await prisma.$transaction([
      prisma.productSchedule.updateMany({
        where: { productId },
        data: { isLive: false, goLiveAt: null, takeDownAt: null, graceMinutes: 0 },
      }),
      prisma.product.update({
        where: { id: productId },
        data: { isLive: false, liveUntil: null },
      }),
    ]);

    // Invalidate caches and remove from carts
    await clearProductCache(productId);
    await clearProductFromCarts(productId);

    // 🚀 Record activity + notify vendor
await recordActivityBundle({
  actorId: req.user?.id || "system",
  actions: [
    {
      type: ActivityType.GENERAL, // or PRODUCT if defined
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
    await redisProducts.del(`vendor:${product.vendorId}:products`);
    await redisProducts.del(`vendor:${product.vendorId}:products:available`);

    // Global product lists
    await redisProducts.del(`products:all`);
    await redisProducts.del(`products:featured`);

    // Category-specific cache
    if (product.category) {
      await redisProducts.del(`category:${product.category}:products`);
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
    const result = await redisProducts.scan(cursor, { MATCH: pattern, COUNT: 50 });
    cursor = result.cursor;
    const keys = result.keys;
    if (keys.length > 0) await redisProducts.del(keys);
  } while (cursor !== '0');
}


    return res.json(successResponse("TAKEN_DOWN", "Product taken down successfully."));
  } catch (err) {
    console.error("takeDown error:", err);
    return res.status(500).json(errorResponse("SERVER_ERROR", "Failed to take down product."));
  }
};


/**
 * POST /:id/schedule/extend-grace
 */
export const extendGrace = async (req: AuthRequest, res: Response) => {
  try {
    const { id: productId } = req.params;
    const { extraMinutes } = req.body;

    if (!extraMinutes || extraMinutes <= 0)
      return res.status(400).json(errorResponse("INVALID_INPUT", "extraMinutes must be positive."));

    const schedule = await prisma.productSchedule.findUnique({ where: { productId } });
    if (!schedule || !schedule.isLive)
      return res.status(400).json(errorResponse("INVALID_STATE", "Product is not currently live."));

    await prisma.productSchedule.update({
      where: { productId },
      data: { graceMinutes: (schedule.graceMinutes || 0) + extraMinutes },
    });

    await productDeactivateQueue.add(
      "finalDeactivate",
      { productId },
      { delay: extraMinutes * 60 * 1000 }
    );
    await prisma.productSchedule.update({
  where: { productId },
  data: { graceMinutes: (schedule.graceMinutes || 0) + extraMinutes },
});

// 🚀 Record activity + notify vendor
await recordActivityBundle({
  actorId: req.user?.id || "system",
  actions: [
    {
      type: ActivityType.GENERAL, // or PRODUCT if defined
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


    return res.json(successResponse("GRACE_EXTENDED", "Grace period extended successfully."));
  } catch (err) {
    console.error("extendGrace error:", err);
    return res.status(500).json(errorResponse("SERVER_ERROR", "Failed to extend grace."));
  }
};











/**
 * ✅ Success Response Helper
 */
export const successResponses = (
  code: string,
  data?: any,
  message: string = "Operation successful"
) => ({
  success: true,
  code,
  message,
  data,
});

/**
 * ❌ Error Response Helper
 */
export const errorResponses = (
  code: string,
  message: string,
  error?: any
) => ({
  success: false,
  code,
  message,
  error: process.env.NODE_ENV === "development" ? error : undefined,
});

/**
 * 🧩 Fix Live Statuses Controller
 * 
 * Ensures all products' live statuses match their schedules.
 * Automatically sets `isLive` and `liveUntil` based on `goLiveAt`, `takeDownAt`, and `graceMinutes`.
 */
export const fixLiveStatuses = async (req: Request, res: Response): Promise<void> => {
  const now = new Date();
  console.log("🛠 Running product live-status fixer via controller...", now.toISOString());

  try {
    // 🧠 Fetch all products that have schedules
    const products = await prisma.product.findMany({
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
       res.json(
        successResponses("NO_SCHEDULES_FOUND", null, "No products with schedules found.")
      );
    }

    let updatedCount = 0;
    const updates: string[] = [];

    for (const product of products) {
      const sched = product.productSchedule;
      if (!sched) continue;

      // ✅ Guard against invalid date fields
      if (!sched.goLiveAt || !sched.takeDownAt) continue;

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
      const productLiveUntilMismatch =
        !product.liveUntil || product.liveUntil.getTime() !== takeDownAt.getTime();
      const scheduleLiveMismatch = sched.isLive !== shouldBeLive;

      // 🚫 Skip products that are already in sync
      if (!productLiveMismatch && !scheduleLiveMismatch && !productLiveUntilMismatch) continue;

      console.log(
        `[fixLiveStatuses] Updating product=${product.id} (${product.name}) → shouldBeLive=${shouldBeLive}`
      );

      const ops = [];

      // 🧩 Update Product
      if (productLiveMismatch || productLiveUntilMismatch) {
        ops.push(
          prisma.product.update({
            where: { id: product.id },
            data: {
              isLive: shouldBeLive,
              liveUntil: takeDownAt,
              updatedAt: new Date(),
            },
          })
        );
      }

      // 🧩 Update Product Schedule
      if (scheduleLiveMismatch) {
        ops.push(
          prisma.productSchedule.update({
            where: { id: sched.id },
            data: { isLive: shouldBeLive },
          })
        );
      }

      // 🧠 Execute updates atomically
      if (ops.length > 0) {
        await prisma.$transaction(ops);

        // 🧹 Invalidate cache safely
        try {
          await clearProductCache(product.id);
        } catch (cacheErr) {
          console.warn(`[CACHE] Failed to invalidate product ${product.id}:`, cacheErr);
        }

        updates.push(
          `Product "${product.name}" (${product.id}) → ${shouldBeLive ? "LIVE ✅" : "OFFLINE ⛔"}`
        );
        updatedCount++;
      }
    }

    // ✅ Send summary response
     res.json(
      successResponses(
        "LIVE_STATUS_FIXED",
        { updatedCount, updates },
        "Product live statuses updated successfully."
      )
    );
  } catch (error) {
    console.error("❌ Error in fixLiveStatuses:", error);
     res.status(500).json(
      errorResponses(
        "SERVER_ERROR",
        "Failed to fix product live statuses. Please check server logs.",
        error
      )
    );
  }
};

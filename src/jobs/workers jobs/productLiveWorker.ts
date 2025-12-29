import { Queue, Worker, Job } from "bullmq";
import prisma from "../../config/prismaClient";
import { bullmqConnection } from "../../lib/bullmqConnection";
import { recordActivityBundle } from "../../utils/activityUtils/recordActivityBundle";
import { clearProductFromCarts } from "../../services/product.service";
import { clearProductCache } from "../../services/clearCaches";
import { ActivityType } from "@prisma/client";
import { redisProducts } from "../../lib/redis";

/**
 * 🎯 BullMQ queue for product "Go Live" notifications
 */
export const productLiveQueue = new Queue("productLiveNotifications", {
  connection: bullmqConnection,
});

/**
 * 👷 Worker that processes product live notifications
 */
export const productLiveWorker = new Worker(
  "productLiveNotifications",
  async (job: Job) => {
    if (!job?.data) return;

    const { productId, vendorId } = job.data as { productId: string; vendorId: string };

    console.log(`[productLiveWorker] 🚀 Starting processing for product: ${productId}`);

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, category: true, vendorId: true, isLive: true },
    });

    if (!product) return console.warn(`[productLiveWorker] ⚠️ Product not found: ${productId}`);
    if (product.isLive) return console.log(`[productLiveWorker] ℹ️ Product ${product.name} already live`);

    try {
      // ✅ 1️⃣ Mark product as live in DB
      await prisma.$transaction([
        prisma.productSchedule.updateMany({ where: { productId }, data: { isLive: true } }),
        prisma.product.update({ where: { id: productId }, data: { isLive: true } }),
      ]);
      console.log(`[productLiveWorker] ✅ Product ${product.name} is now live`);

      // ✅ 2️⃣ Clear caches
      await clearProductCache(product.id);
      await clearProductFromCarts(product.id);

      const cacheKeysToDelete = [
        `product:${productId}:detail`,
        `product:${productId}`,
        `api:product:${productId}`,
        `api:/api/product/${productId}`,
        `vendor:${vendorId}:products`,
        `vendor:${vendorId}:products:available`,
        `products:all`,
        `products:featured`,
        ...(product.category ? [`category:${product.category}:products`] : []),
      ];

      await Promise.allSettled(cacheKeysToDelete.map(async key => {
        try { await redisProducts.del(key); }
        catch (err) { console.warn(`[CACHE] Failed to delete key ${key}:`, err); }
      }));

      // ✅ 3️⃣ Clear all vendor product page caches using scanIterator
      try {
        for await (const key of redisProducts.scanIterator({ MATCH: `vendor:${vendorId}:products:page:*`, COUNT: 50 })) {
          await redisProducts.del(key);
        }
        console.log(`[CACHE] Cleared vendor product page caches for vendor ${vendorId}`);
      } catch (err) {
        console.warn('[CACHE] Failed to clear vendor product page caches:', err);
      }

      // ✅ 4️⃣ Pattern-based deletion (optional)
      const patterns = [`products:*`, `search:*`, `api:products:*`, `api:search:*`, `vendor:*:products*`, `category:*:products`];
      try {
        for (const pattern of patterns) {
          for await (const key of redisProducts.scanIterator({ MATCH: pattern, COUNT: 50 })) {
            await redisProducts.del(key);
          }
        }
      } catch (err) {
        console.warn('[CACHE] Pattern-based cache deletion failed:', err);
      }

      // 5️⃣ Notify users
      const [followers, cartUsers] = await Promise.all([
        prisma.vendorFollower.findMany({ where: { vendorId }, select: { customerId: true } }),
        prisma.cartItem.findMany({ where: { productId }, select: { cart: { select: { customerId: true } } } }),
      ]);

      const userIds = Array.from(new Set([
        ...followers.map(f => f.customerId),
        ...cartUsers.map(c => c.cart.customerId),
      ]));

      if (userIds.length) {
        const notificationPromises = userIds.map(userId =>
          recordActivityBundle({
            actorId: vendorId,
            actions: [{
              type: ActivityType.GENERAL,
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
          })
        );

        const results = await Promise.allSettled(notificationPromises);
        console.log(`[productLiveWorker] ✅ Notifications: ${results.filter(r => r.status === 'fulfilled').length} succeeded, ${results.filter(r => r.status === 'rejected').length} failed`);
      }

    } catch (error) {
      console.error(`[productLiveWorker] ❌ Error processing product ${productId}:`, error);
      throw error;
    }
  },
  {
    connection: bullmqConnection,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  }
);

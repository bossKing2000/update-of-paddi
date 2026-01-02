
import { Worker, Queue, Job } from "bullmq";
import prisma from "../../config/prismaClient";
import { bullmqConnection } from "../../lib/bullmqConnection";
import {
  clearProductFromCarts,
} from "../../services/product.service";
import { cancelOrdersForOfflineProduct } from "../../services/paymentService";
import { nowUtc, addMinutesUtc } from "../../utils/time";
import { redisProducts } from "../../lib/redis";
import { clearProductCache } from "../../services/clearCaches";

export const productDeactivateQueue = new Queue("productDeactivateJob", {
  connection: bullmqConnection,
});

export const productDeactivateWorker = new Worker(
  "productDeactivateJob",
  async (job: Job) => {
    const { productId } = job.data as { productId: string };
    const now = nowUtc(); // ✅ Always UTC

    // 1️⃣ Fetch the product schedule
    const schedule = await prisma.productSchedule.findUnique({
      where: { productId },
    });
    if (!schedule) return;

    // 2️⃣ Handle auto-grace if enabled (delay calculated in UTC-safe way)
    if (schedule.autoGraceEnabled && schedule.graceMinutes && schedule.graceMinutes > 0) {
      const graceDelayMs = schedule.graceMinutes * 60 * 1000;
      const graceEndUtc = addMinutesUtc(now, schedule.graceMinutes);

      await productDeactivateQueue.add(
        "finalDeactivate",
        { productId },
        { delay: graceDelayMs }
      );

      console.log(
        `[productDeactivateWorker] Grace period active for ${schedule.graceMinutes} minutes (until ${graceEndUtc.toISOString()}).`
      );
      return;
    }

    // 3️⃣ Fetch the actual product (needed for vendorId & category for cache clearing)
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, vendorId: true, category: true },
    });
    if (!product) {
      console.warn(`[productDeactivateWorker] Product not found for ${productId}`);
      return;
    }

    // 4️⃣ Deactivate product schedule & product in transaction (UTC timestamps)
    await prisma.$transaction([
      prisma.productSchedule.updateMany({
        where: { productId },
        data: {
          isLive: false,
          goLiveAt: null,
          takeDownAt: null,
          updatedAt: now,
        },
      }),
      prisma.product.update({
        where: { id: productId },
        data: {
          isLive: false,
          liveUntil: null,
          updatedAt: now,
        },
      }),
    ]);

    console.log(
      `[productDeactivateWorker] Product ${productId} marked as offline at ${now.toISOString()} (UTC).`
    );

    // 5️⃣ Clear related caches & carts
    await clearProductCache(productId);
    await clearProductFromCarts(productId);
    if (product.category) await redisProducts.del(`category:${product.category}:products`);

    // 7️⃣ Cancel linked orders safely
    await cancelOrdersForOfflineProduct(productId);

    console.log(
      `[productDeactivateWorker] Linked orders and caches for product ${productId} processed safely at ${now.toISOString()} (UTC).`
    );
  },
  { connection: bullmqConnection }
);

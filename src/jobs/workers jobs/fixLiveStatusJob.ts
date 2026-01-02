
// import prisma from "../../config/prismaClient";
// import { redisProducts } from "../../lib/redis";
// import { clearProductCache } from "../../services/clearCaches";
// import { Prisma } from "@prisma/client";

// // Use Prisma’s generated type for Product with schedule
// type ProductWithSchedule = Prisma.ProductGetPayload<{ include: { productSchedule: true } }>;

// export const fixLiveStatusJob = async (isServerStartup: boolean = false, silent: boolean = false) => {
//   const now = new Date();
//   if (!silent) console.log("🛠 Running product live-status fixer...", now.toISOString());

//   try {
//     let updatedCount = 0;

//     // Helper to compute whether a product should be live
//     const computeShouldBeLive = (sched: NonNullable<ProductWithSchedule["productSchedule"]>) => {
//       if (!sched.goLiveAt || !sched.takeDownAt) return false;
//       const goLiveAt = new Date(sched.goLiveAt);
//       const takeDownAt = new Date(sched.takeDownAt);
//       const graceExpiry = new Date(takeDownAt);
//       if (sched.graceMinutes && sched.graceMinutes > 0) {
//         graceExpiry.setMinutes(graceExpiry.getMinutes() + sched.graceMinutes);
//       }
//       return now >= goLiveAt && now <= graceExpiry;
//     };

//     // -------------------------------
//     // SERVER STARTUP: Full scan in batches
//     // -------------------------------
//     if (isServerStartup) {
//       if (!silent) console.log("🔍 Starting full scan of products with schedules (in batches)...");

//       const batchSize = 50;
//       let skip = 0;
//       let totalProcessed = 0;

//       while (true) {
//         const batch: ProductWithSchedule[] = await prisma.product.findMany({
//           where: { productSchedule: { isNot: null } },
//           include: { productSchedule: true },
//           skip,
//           take: batchSize,
//           orderBy: { id: "asc" },
//         });

//         if (batch.length === 0) break;
//         totalProcessed += batch.length;
//         if (!silent) console.log(`   Processing batch ${Math.floor(skip / batchSize) + 1}: ${batch.length} products (total: ${totalProcessed})`);

//         for (const product of batch) {
//           const sched = product.productSchedule!;
//           const shouldBeLive = computeShouldBeLive(sched);

//           const productNeedsUpdate =
//             product.isLive !== shouldBeLive ||
//             product.liveUntil?.getTime() !== (sched.takeDownAt ? new Date(sched.takeDownAt).getTime() : null);
//           const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

//           if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

//           let updated = false;

//           if (productNeedsUpdate) {
//             await prisma.product.update({
//               where: { id: product.id },
//               data: {
//                 isLive: shouldBeLive,
//                 liveUntil: shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null,
//                 updatedAt: now,
//               },
//             });
//             updated = true;
//           }

//           if (scheduleNeedsUpdate) {
//             await prisma.productSchedule.update({
//               where: { id: sched.id },
//               data: { isLive: shouldBeLive },
//             });
//             updated = true;
//           }

//           if (updated) {
//             await clearProductCache(product.id);
//             await redisProducts.del(`vendor:${product.vendorId}:products`);
//             await redisProducts.del(`vendor:${product.vendorId}:products:available`);
//             if (product.category) await redisProducts.del(`category:${product.category}:products`);

//             updatedCount++;
//             if (!silent) console.log(`[fixLiveStatusJob] 🔄 Updated product=${product.id} → shouldBeLive=${shouldBeLive}`);
//           }
//         }

//         skip += batchSize;
//         if (batch.length === batchSize) await new Promise((resolve) => setTimeout(resolve, 100));
//       }

//       if (!silent) console.log(`🔍 Full scan completed: Processed ${totalProcessed} products`);
//     }

//     // -------------------------------
//     // REGULAR RUN: Only products likely to change soon
//     // -------------------------------
//     else {
//       const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

//       const products: ProductWithSchedule[] = await prisma.product.findMany({
//         where: {
//           productSchedule: {
//             is: {
//               OR: [
//                 { goLiveAt: { lte: fiveMinutesFromNow } },
//                 { takeDownAt: { lte: fiveMinutesFromNow } },
//               ],
//             },
//           },
//         },
//         include: { productSchedule: true },
//       });

//       if (!silent) console.log(`🔍 Found ${products.length} products with relevant schedules`);

//       for (const product of products) {
//         const sched = product.productSchedule!;
//         const shouldBeLive = computeShouldBeLive(sched);

//         const productNeedsUpdate =
//           product.isLive !== shouldBeLive ||
//           product.liveUntil?.getTime() !== (sched.takeDownAt ? new Date(sched.takeDownAt).getTime() : null);
//         const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

//         if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

//         let updated = false;

//         if (productNeedsUpdate) {
//           await prisma.product.update({
//             where: { id: product.id },
//             data: {
//               isLive: shouldBeLive,
//               liveUntil: shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null,
//               updatedAt: now,
//             },
//           });
//           updated = true;
//         }

//         if (scheduleNeedsUpdate) {
//           await prisma.productSchedule.update({
//             where: { id: sched.id },
//             data: { isLive: shouldBeLive },
//           });
//           updated = true;
//         }

//         if (updated) {
//           await clearProductCache(product.id);
//           await redisProducts.del(`vendor:${product.vendorId}:products`);
//           await redisProducts.del(`vendor:${product.vendorId}:products:available`);
//           if (product.category) await redisProducts.del(`category:${product.category}:products`);

//           updatedCount++;
//           if (!silent) console.log(`[fixLiveStatusJob] 🔄 Updated product=${product.id} → shouldBeLive=${shouldBeLive}`);
//         }
//       }
//     }

//     if (!silent) console.log(`✅ Fixed ${updatedCount} product live statuses`);
//     return { updatedCount, timestamp: now };
//   } catch (error) {
//     console.error("❌ Error in fixLiveStatusJob:", error);
//     throw error;
//   }
// };

import prisma from "../../config/prismaClient";
import { redisProducts } from "../../lib/redis";
import { clearProductCache } from "../../services/clearCaches";
import { Prisma } from "@prisma/client";

// Prisma type with schedule included
type ProductWithSchedule = Prisma.ProductGetPayload<{ include: { productSchedule: true } }>;

export const fixLiveStatusJob = async (isServerStartup: boolean = false, silent: boolean = false) => {
  const now = new Date();
  if (!silent) console.log("🛠 Running product live-status fixer...", now.toISOString());

  try {
    let updatedCount = 0;

    // Helper to compute if product should be live
    const computeShouldBeLive = (sched: NonNullable<ProductWithSchedule["productSchedule"]>) => {
      if (!sched.goLiveAt || !sched.takeDownAt) return false;
      const goLiveAt = new Date(sched.goLiveAt);
      const takeDownAt = new Date(sched.takeDownAt);
      const graceExpiry = new Date(takeDownAt);

      if (sched.graceMinutes && sched.graceMinutes > 0) {
        graceExpiry.setMinutes(graceExpiry.getMinutes() + sched.graceMinutes);
      }

      return now >= goLiveAt && now <= graceExpiry;
    };

    // -------------------------------
    // SERVER STARTUP: Full batch scan
    // -------------------------------
    if (isServerStartup) {
      if (!silent) console.log("🔍 Starting full scan of products with schedules (in batches)...");

      const batchSize = 50;
      let skip = 0;
      let totalProcessed = 0;

      while (true) {
        const batch: ProductWithSchedule[] = await prisma.product.findMany({
          where: { productSchedule: { isNot: null } },
          include: { productSchedule: true },
          skip,
          take: batchSize,
          orderBy: { id: "asc" },
        });

        if (batch.length === 0) break;
        totalProcessed += batch.length;
        if (!silent) console.log(`   Processing batch ${Math.floor(skip / batchSize) + 1}: ${batch.length} products (total: ${totalProcessed})`);

        for (const product of batch) {
          const sched = product.productSchedule!;
          const shouldBeLive = computeShouldBeLive(sched);
          const computedLiveUntil = shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null;

          const productNeedsUpdate =
            product.isLive !== shouldBeLive ||
            (product.liveUntil?.getTime() || null) !== (computedLiveUntil?.getTime() || null);

          const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

          if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

          if (productNeedsUpdate) {
            await prisma.product.update({
              where: { id: product.id },
              data: {
                isLive: shouldBeLive,
                liveUntil: computedLiveUntil,
                updatedAt: now,
              },
            });
          }

          if (scheduleNeedsUpdate) {
            await prisma.productSchedule.update({
              where: { id: sched.id },
              data: { isLive: shouldBeLive },
            });
          }

          if (productNeedsUpdate || scheduleNeedsUpdate) {
            await clearProductCache(product.id);
            await redisProducts.del(`vendor:${product.vendorId}:products`);
            await redisProducts.del(`vendor:${product.vendorId}:products:available`);
            if (product.category) await redisProducts.del(`category:${product.category}:products`);

            updatedCount++;
            if (!silent) console.log(`[fixLiveStatusJob] 🔄 Updated product=${product.id} → shouldBeLive=${shouldBeLive}`);
          }
        }

        skip += batchSize;
        if (batch.length === batchSize) await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (!silent) console.log(`🔍 Full scan completed: Processed ${totalProcessed} products`);
    }

    // -------------------------------
    // REGULAR RUN: Only products changing soon
    // -------------------------------
    else {
      const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

      const products: ProductWithSchedule[] = await prisma.product.findMany({
        where: {
          productSchedule: {
            is: {
              OR: [
                { goLiveAt: { lte: fiveMinutesFromNow } },
                { takeDownAt: { lte: fiveMinutesFromNow } },
              ],
            },
          },
        },
        include: { productSchedule: true },
      });

      if (!silent) console.log(`🔍 Found ${products.length} products with relevant schedules`);

      for (const product of products) {
        const sched = product.productSchedule!;
        if (!sched?.goLiveAt && !sched?.takeDownAt) continue; // skip products with no schedule

        const shouldBeLive = computeShouldBeLive(sched);
        const computedLiveUntil = shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null;

        const productNeedsUpdate =
          product.isLive !== shouldBeLive ||
          (product.liveUntil?.getTime() || null) !== (computedLiveUntil?.getTime() || null);

        const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

        if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

        if (productNeedsUpdate) {
          await prisma.product.update({
            where: { id: product.id },
            data: {
              isLive: shouldBeLive,
              liveUntil: computedLiveUntil,
              updatedAt: now,
            },
          });
        }

        if (scheduleNeedsUpdate) {
          await prisma.productSchedule.update({
            where: { id: sched.id },
            data: { isLive: shouldBeLive },
          });
        }

        if (productNeedsUpdate || scheduleNeedsUpdate) {
          await clearProductCache(product.id);
          await redisProducts.del(`vendor:${product.vendorId}:products`);
          await redisProducts.del(`vendor:${product.vendorId}:products:available`);
          if (product.category) await redisProducts.del(`category:${product.category}:products`);

          updatedCount++;
          if (!silent) console.log(`[fixLiveStatusJob] 🔄 Updated product=${product.id} → shouldBeLive=${shouldBeLive}`);
        }
      }
    }

    if (!silent) console.log(`✅ Fixed ${updatedCount} product live statuses`);
    return { updatedCount, timestamp: now };
  } catch (error) {
    console.error("❌ Error in fixLiveStatusJob:", error);
    throw error;
  }
};

// import prisma from "../../config/prismaClient";
// import { redisProducts } from "../../lib/redis";
// import { clearProductCache } from "../../services/clearCaches";

// export const fixLiveStatusJob = async (isServerStartup: boolean = false) => {
//   const now = new Date();
  
//   console.log("🛠 Running product live-status fixer...", now.toISOString());

//   try {
//     let updatedCount = 0;

//     if (isServerStartup) {
//       // ⚡ SERVER STARTUP: Process ALL products with schedules in batches
//       console.log('🔍 Starting full scan of products with schedules (in batches)...');
      
//       const batchSize = 50; // Process 50 products at a time
//       let skip = 0;
//       let totalProcessed = 0;
      
//       while (true) {
//         const batch = await prisma.product.findMany({
//           where: {
//             productSchedule: { isNot: null }
//           },
//           include: {
//             productSchedule: true,
//           },
//           skip,
//           take: batchSize,
//           orderBy: { id: "asc" },
//         });

//         if (batch.length === 0) break;
        
//         totalProcessed += batch.length;
//         console.log(`   Processing batch ${Math.floor(skip/batchSize) + 1}: ${batch.length} products (total: ${totalProcessed})`);
        
//         for (const product of batch) {
//           const sched = product.productSchedule;

//           // Force offline if schedule missing or invalid
//           if (!sched?.goLiveAt || !sched?.takeDownAt) {
//             if (product.isLive || sched?.isLive) {
//               console.log(`⚠️ Clearing invalid schedule for product ${product.id}`);
              
//               try {
//                 await prisma.product.update({
//                   where: { id: product.id },
//                   data: { isLive: false, liveUntil: null },
//                 });
                
//                 if (sched) {
//                   await prisma.productSchedule.update({
//                     where: { id: sched.id },
//                     data: { isLive: false },
//                   });
//                 }
//               } catch (error) {
//                 console.error(`⚠️ Failed to clear invalid schedule for product ${product.id}:`, error);
//                 continue;
//               }

//               // ✅ Invalidate only relevant caches
//               await clearProductCache(product.id);
//               await redisProducts.del(`vendor:${product.vendorId}:products`);
//               await redisProducts.del(`vendor:${product.vendorId}:products:available`);
//               if (product.category) await redisProducts.del(`category:${product.category}:products`);

//               updatedCount++;
//             }
//             continue;
//           }

//           const goLiveAt = new Date(sched.goLiveAt);
//           const takeDownAt = new Date(sched.takeDownAt);
//           const graceExpiry = new Date(takeDownAt);

//           if (sched.graceMinutes && sched.graceMinutes > 0) {
//             graceExpiry.setMinutes(graceExpiry.getMinutes() + sched.graceMinutes);
//           }

//           const shouldBeLive = now >= goLiveAt && now <= graceExpiry;
//           const liveUntilMismatch = product.liveUntil?.getTime() !== takeDownAt.getTime();

//           const productNeedsUpdate = product.isLive !== shouldBeLive || liveUntilMismatch;
//           const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

//           if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

//           console.log(
//             `[fixLiveStatusJob] 🔄 Updating product=${product.id} → shouldBeLive=${shouldBeLive}`
//           );

//           try {
//             if (productNeedsUpdate) {
//               await prisma.product.update({
//                 where: { id: product.id },
//                 data: {
//                   isLive: shouldBeLive,
//                   liveUntil: shouldBeLive ? takeDownAt : null,
//                   updatedAt: now,
//                 },
//               });
//             }

//             if (scheduleNeedsUpdate) {
//               await prisma.productSchedule.update({
//                 where: { id: sched.id },
//                 data: { isLive: shouldBeLive },
//               });
//             }
//           } catch (error) {
//             console.error(`⚠️ Failed to update product ${product.id}:`, error);
//             continue;
//           }

//           // ✅ Only invalidate caches that matter
//           await clearProductCache(product.id);
//           await redisProducts.del(`vendor:${product.vendorId}:products`);
//           await redisProducts.del(`vendor:${product.vendorId}:products:available`);
//           if (product.category) await redisProducts.del(`category:${product.category}:products`);

//           updatedCount++;
//         }
        
//         skip += batchSize;
        
//         // Small delay between batches to prevent overwhelming the database
//         if (batch.length === batchSize) {
//           await new Promise(resolve => setTimeout(resolve, 100));
//         }
//       }
      
//       console.log(`🔍 Full scan completed: Processed ${totalProcessed} products in batches`);
//     } else {
//       // REGULAR RUN: Only check products that might need updating NOW
//       const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
//       const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      
//       // Get products with invalid schedules
//       const productsWithInvalidSchedules = await prisma.product.findMany({
//         where: {
//           productSchedule: {
//             OR: [
//               { goLiveAt: null },
//               { takeDownAt: null }
//             ]
//           }
//         },
//         include: {
//           productSchedule: true,
//         },
//       });

//       // Get products with valid schedules that might need updating
//       const productsWithValidSchedules = await prisma.product.findMany({
//         where: {
//           productSchedule: {
//             AND: [
//               { goLiveAt: { not: null } },
//               { takeDownAt: { not: null } },
//               {
//                 OR: [
//                   // Products starting now or soon
//                   {
//                     AND: [
//                       { goLiveAt: { lte: fiveMinutesFromNow } },
//                       { takeDownAt: { gte: now } }
//                     ]
//                   },
//                   // Products that might be in grace period
//                   {
//                     AND: [
//                       { takeDownAt: { lt: now } },
//                       { takeDownAt: { gte: twentyFourHoursAgo } },
//                       { graceMinutes: { gt: 0 } }
//                     ]
//                   }
//                 ]
//               }
//             ]
//           }
//         },
//         include: {
//           productSchedule: true,
//         },
//       });

//       // Combine both sets
//       const products = [...productsWithInvalidSchedules, ...productsWithValidSchedules];
//       console.log(`🔍 Found ${products.length} products with relevant schedules`);

//       for (const product of products) {
//         const sched = product.productSchedule;

//         // Force offline if schedule missing or invalid
//         if (!sched?.goLiveAt || !sched?.takeDownAt) {
//           if (product.isLive || sched?.isLive) {
//             console.log(`⚠️ Clearing invalid schedule for product ${product.id}`);
            
//             try {
//               await prisma.product.update({
//                 where: { id: product.id },
//                 data: { isLive: false, liveUntil: null },
//               });
              
//               if (sched) {
//                 await prisma.productSchedule.update({
//                   where: { id: sched.id },
//                   data: { isLive: false },
//                 });
//               }
//             } catch (error) {
//               console.error(`⚠️ Failed to clear invalid schedule for product ${product.id}:`, error);
//               continue;
//             }

//             // ✅ Invalidate only relevant caches
//             await clearProductCache(product.id);
//             await redisProducts.del(`vendor:${product.vendorId}:products`);
//             await redisProducts.del(`vendor:${product.vendorId}:products:available`);
//             if (product.category) await redisProducts.del(`category:${product.category}:products`);

//             updatedCount++;
//           }
//           continue;
//         }

//         const goLiveAt = new Date(sched.goLiveAt);
//         const takeDownAt = new Date(sched.takeDownAt);
//         const graceExpiry = new Date(takeDownAt);

//         if (sched.graceMinutes && sched.graceMinutes > 0) {
//           graceExpiry.setMinutes(graceExpiry.getMinutes() + sched.graceMinutes);
//         }

//         const shouldBeLive = now >= goLiveAt && now <= graceExpiry;
//         const liveUntilMismatch = product.liveUntil?.getTime() !== takeDownAt.getTime();

//         const productNeedsUpdate = product.isLive !== shouldBeLive || liveUntilMismatch;
//         const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

//         if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

//         console.log(
//           `[fixLiveStatusJob] 🔄 Updating product=${product.id} → shouldBeLive=${shouldBeLive}`
//         );

//         try {
//           if (productNeedsUpdate) {
//             await prisma.product.update({
//               where: { id: product.id },
//               data: {
//                 isLive: shouldBeLive,
//                 liveUntil: shouldBeLive ? takeDownAt : null,
//                 updatedAt: now,
//               },
//             });
//           }

//           if (scheduleNeedsUpdate) {
//             await prisma.productSchedule.update({
//               where: { id: sched.id },
//               data: { isLive: shouldBeLive },
//             });
//           }
//         } catch (error) {
//           console.error(`⚠️ Failed to update product ${product.id}:`, error);
//           continue;
//         }

//         // ✅ Only invalidate caches that matter
//         await clearProductCache(product.id);
//         await redisProducts.del(`vendor:${product.vendorId}:products`);
//         await redisProducts.del(`vendor:${product.vendorId}:products:available`);
//         if (product.category) await redisProducts.del(`category:${product.category}:products`);

//         updatedCount++;
//       }
//     }

//     console.log(`✅ Fixed ${updatedCount} product live statuses`);
    
//     // Return result for potential tracking
//     return { updatedCount, timestamp: now };
//   } catch (error) {
//     console.error("❌ Error in fixLiveStatusJob:", error);
//     throw error; // Re-throw so the caller can handle it if needed
//   }
// };



// import prisma from "../../config/prismaClient";
// import { redisProducts } from "../../lib/redis";
// import { clearProductCache } from "../../services/clearCaches";
// import { Prisma } from "@prisma/client";

// // Use Prisma’s generated type for Product with schedule
// type ProductWithSchedule = Prisma.ProductGetPayload<{ include: { productSchedule: true } }>;

// export const fixLiveStatusJob = async (isServerStartup: boolean = false) => {
//   const now = new Date();
//   console.log("🛠 Running product live-status fixer...", now.toISOString());

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
//       console.log("🔍 Starting full scan of products with schedules (in batches)...");

//       const batchSize = 50;
//       let skip = 0;
//       let totalProcessed = 0;

//       while (true) {
//         // Fetch a batch of products that have a schedule
//         const batch: ProductWithSchedule[] = await prisma.product.findMany({
//           where: {
//             productSchedule: { isNot: null },
//           },
//           include: { productSchedule: true },
//           skip,
//           take: batchSize,
//           orderBy: { id: "asc" },
//         });

//         if (batch.length === 0) break;
//         totalProcessed += batch.length;
//         console.log(
//           `   Processing batch ${Math.floor(skip / batchSize) + 1}: ${batch.length} products (total: ${totalProcessed})`
//         );

//         for (const product of batch) {
//           const sched = product.productSchedule!;
//           const shouldBeLive = computeShouldBeLive(sched);

//           const productNeedsUpdate =
//             product.isLive !== shouldBeLive ||
//             product.liveUntil?.getTime() !== (sched.takeDownAt ? new Date(sched.takeDownAt).getTime() : null);
//           const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

//           if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

//           // Update the product record if needed
//           if (productNeedsUpdate) {
//             await prisma.product.update({
//               where: { id: product.id },
//               data: {
//                 isLive: shouldBeLive,
//                 liveUntil: shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null,
//                 updatedAt: now,
//               },
//             });
//           }

//           // Update the schedule record if needed
//           if (scheduleNeedsUpdate) {
//             await prisma.productSchedule.update({
//               where: { id: sched.id },
//               data: { isLive: shouldBeLive },
//             });
//           }

//           // Clear relevant caches
//           await clearProductCache(product.id);
//           await redisProducts.del(`vendor:${product.vendorId}:products`);
//           await redisProducts.del(`vendor:${product.vendorId}:products:available`);
//           if (product.category) {
//             await redisProducts.del(`category:${product.category}:products`);
//           }

//           updatedCount++;
//           console.log(
//             `[fixLiveStatusJob] 🔄 Updated product=${product.id} → shouldBeLive=${shouldBeLive}`
//           );
//         }

//         skip += batchSize;
//         if (batch.length === batchSize) {
//           // small delay to avoid hammering the DB
//           await new Promise((resolve) => setTimeout(resolve, 100));
//         }
//       }

//       console.log(`🔍 Full scan completed: Processed ${totalProcessed} products`);
//     }

//     // -------------------------------
//     // REGULAR RUN: Only products likely to change soon
//     // -------------------------------
//     else {
//       const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
//       // Query products whose schedules are about to go live or expire
//       const products: ProductWithSchedule[] = await prisma.product.findMany({
//         where: {
//           productSchedule: {
//             // Use 'is' to filter by related fields
//             is: {
//               goLiveAt: { not: null, lte: fiveMinutesFromNow },
//               takeDownAt: { not: null },
//               OR: [
//                 { takeDownAt: { gte: now } }, // still active
//                 {
//                   AND: [
//                     { takeDownAt: { lt: now } }, // past end
//                     { graceMinutes: { gt: 0 } }   // but has grace period
//                   ],
//                 },
//               ],
//             },
//           },
//         },
//         include: { productSchedule: true },
//       });

//       console.log(`🔍 Found ${products.length} products with relevant schedules`);

//       for (const product of products) {
//         const sched = product.productSchedule!;
//         const shouldBeLive = computeShouldBeLive(sched);

//         const productNeedsUpdate =
//           product.isLive !== shouldBeLive ||
//           product.liveUntil?.getTime() !== (sched.takeDownAt ? new Date(sched.takeDownAt).getTime() : null);
//         const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

//         if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

//         // Update the product record if needed
//         if (productNeedsUpdate) {
//           await prisma.product.update({
//             where: { id: product.id },
//             data: {
//               isLive: shouldBeLive,
//               liveUntil: shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null,
//               updatedAt: now,
//             },
//           });
//         }

//         // Update the schedule record if needed
//         if (scheduleNeedsUpdate) {
//           await prisma.productSchedule.update({
//             where: { id: sched.id },
//             data: { isLive: shouldBeLive },
//           });
//         }

//         // Clear caches
//         await clearProductCache(product.id);
//         await redisProducts.del(`vendor:${product.vendorId}:products`);
//         await redisProducts.del(`vendor:${product.vendorId}:products:available`);
//         if (product.category) {
//           await redisProducts.del(`category:${product.category}:products`);
//         }

//         updatedCount++;
//         console.log(
//           `[fixLiveStatusJob] 🔄 Updated product=${product.id} → shouldBeLive=${shouldBeLive}`
//         );
//       }
//     }

//     console.log(`✅ Fixed ${updatedCount} product live statuses`);
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

// Use Prisma’s generated type for Product with schedule
type ProductWithSchedule = Prisma.ProductGetPayload<{ include: { productSchedule: true } }>;

export const fixLiveStatusJob = async (isServerStartup: boolean = false, silent: boolean = false) => {
  const now = new Date();
  if (!silent) console.log("🛠 Running product live-status fixer...", now.toISOString());

  try {
    let updatedCount = 0;

    // Helper to compute whether a product should be live
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
    // SERVER STARTUP: Full scan in batches
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

          const productNeedsUpdate =
            product.isLive !== shouldBeLive ||
            product.liveUntil?.getTime() !== (sched.takeDownAt ? new Date(sched.takeDownAt).getTime() : null);
          const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

          if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

          let updated = false;

          if (productNeedsUpdate) {
            await prisma.product.update({
              where: { id: product.id },
              data: {
                isLive: shouldBeLive,
                liveUntil: shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null,
                updatedAt: now,
              },
            });
            updated = true;
          }

          if (scheduleNeedsUpdate) {
            await prisma.productSchedule.update({
              where: { id: sched.id },
              data: { isLive: shouldBeLive },
            });
            updated = true;
          }

          if (updated) {
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
    // REGULAR RUN: Only products likely to change soon
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
        const shouldBeLive = computeShouldBeLive(sched);

        const productNeedsUpdate =
          product.isLive !== shouldBeLive ||
          product.liveUntil?.getTime() !== (sched.takeDownAt ? new Date(sched.takeDownAt).getTime() : null);
        const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;

        if (!productNeedsUpdate && !scheduleNeedsUpdate) continue;

        let updated = false;

        if (productNeedsUpdate) {
          await prisma.product.update({
            where: { id: product.id },
            data: {
              isLive: shouldBeLive,
              liveUntil: shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null,
              updatedAt: now,
            },
          });
          updated = true;
        }

        if (scheduleNeedsUpdate) {
          await prisma.productSchedule.update({
            where: { id: sched.id },
            data: { isLive: shouldBeLive },
          });
          updated = true;
        }

        if (updated) {
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

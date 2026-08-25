"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fixLiveStatusJob = void 0;
// import prisma from "../../config/prismaClient";
// import { redisProducts } from "../../lib/redis";
// import { clearProductCache } from "../../services/clearCaches";
// import { Prisma } from "@prisma/client";
const scheduleRules_service_1 = require("../../services/scheduleRules.service");
const vendorAvailability_service_1 = require("../../services/vendorAvailability.service");
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
//           include: {
//             productSchedule: { include: { windows: true } },
//             vendor: { select: { timezone: true, operatingHours: true } },
//           },
//           skip,
//           take: batchSize,
//           orderBy: { id: "asc" },
//         });
//         if (batch.length === 0) break;
//         totalProcessed += batch.length;
//         if (!silent) console.log(`   Processing batch ${Math.floor(skip / batchSize) + 1}: ${batch.length} products (total: ${totalProcessed})`);
//         for (const product of batch) {
//           const sched = product.productSchedule!;
//           const vendorTz = (product as any).vendor;
//           const shouldBeLive = computeShouldBeLive({
//             ...(sched as any),
//             windows: (sched as any).windows ?? [],
//             vendorTimezone: resolveVendorTimezone(vendorTz?.timezone, vendorTz?.operatingHours),
//           });
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
//         include: {
//             productSchedule: { include: { windows: true } },
//             vendor: { select: { timezone: true, operatingHours: true } },
//           },
//       });
//       if (!silent) console.log(`🔍 Found ${products.length} products with relevant schedules`);
//       for (const product of products) {
//         const sched = product.productSchedule!;
//         const vendorTz = (product as any).vendor;
//         const shouldBeLive = computeShouldBeLive({
//           ...(sched as any),
//           windows: (sched as any).windows ?? [],
//           vendorTimezone: resolveVendorTimezone(vendorTz?.timezone, vendorTz?.operatingHours),
//         });
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
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const redis_1 = require("../../lib/redis");
const clearCaches_1 = require("../../services/clearCaches");
const fixLiveStatusJob = async (isServerStartup = false, silent = false) => {
    const now = new Date();
    if (!silent)
        console.log("🛠 Running product live-status fixer...", now.toISOString());
    try {
        let updatedCount = 0;
        // Helper to compute if product should be live.
        // WEEKLY schedules: evaluated from their windows in the vendor's
        // effective timezone (recurring — no event jobs needed). ONE_TIME:
        // unchanged absolute-window logic.
        const computeShouldBeLive = (sched) => {
            if (sched.type === "WEEKLY") {
                if (sched.enabled === false)
                    return false;
                return (0, scheduleRules_service_1.evaluateProductSchedule)({ ...sched, type: "WEEKLY" }, now, sched.vendorTimezone ?? null, false);
            }
            if (!sched.goLiveAt || !sched.takeDownAt)
                return false;
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
            if (!silent)
                console.log("🔍 Starting full scan of products with schedules (in batches)...");
            const batchSize = 50;
            let skip = 0;
            let totalProcessed = 0;
            while (true) {
                const batch = await prismaClient_1.default.product.findMany({
                    where: { productSchedule: { isNot: null } },
                    include: {
                        productSchedule: { include: { windows: true } },
                        vendor: { select: { timezone: true, operatingHours: true } },
                    },
                    skip,
                    take: batchSize,
                    orderBy: { id: "asc" },
                });
                if (batch.length === 0)
                    break;
                totalProcessed += batch.length;
                if (!silent)
                    console.log(`   Processing batch ${Math.floor(skip / batchSize) + 1}: ${batch.length} products (total: ${totalProcessed})`);
                for (const product of batch) {
                    const sched = product.productSchedule;
                    const vendorTz = product.vendor;
                    const shouldBeLive = computeShouldBeLive({
                        ...sched,
                        windows: sched.windows ?? [],
                        vendorTimezone: (0, vendorAvailability_service_1.resolveVendorTimezone)(vendorTz?.timezone, vendorTz?.operatingHours),
                    });
                    const computedLiveUntil = shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null;
                    const productNeedsUpdate = product.isLive !== shouldBeLive ||
                        (product.liveUntil?.getTime() || null) !== (computedLiveUntil?.getTime() || null);
                    const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;
                    if (!productNeedsUpdate && !scheduleNeedsUpdate)
                        continue;
                    if (productNeedsUpdate) {
                        await prismaClient_1.default.product.update({
                            where: { id: product.id },
                            data: {
                                isLive: shouldBeLive,
                                liveUntil: computedLiveUntil,
                                updatedAt: now,
                            },
                        });
                    }
                    if (scheduleNeedsUpdate) {
                        await prismaClient_1.default.productSchedule.update({
                            where: { id: sched.id },
                            data: { isLive: shouldBeLive },
                        });
                    }
                    if (productNeedsUpdate || scheduleNeedsUpdate) {
                        await (0, clearCaches_1.clearProductCache)(product.id);
                        await redis_1.redisProducts.del(`vendor:${product.vendorId}:products`);
                        await redis_1.redisProducts.del(`vendor:${product.vendorId}:products:available`);
                        if (product.category)
                            await redis_1.redisProducts.del(`category:${product.category}:products`);
                        updatedCount++;
                        if (!silent)
                            console.log(`[fixLiveStatusJob] 🔄 Updated product=${product.id} → shouldBeLive=${shouldBeLive}`);
                    }
                }
                skip += batchSize;
                if (batch.length === batchSize)
                    await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!silent)
                console.log(`🔍 Full scan completed: Processed ${totalProcessed} products`);
        }
        // -------------------------------
        // REGULAR RUN: Only products changing soon
        // -------------------------------
        else {
            const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
            const products = await prismaClient_1.default.product.findMany({
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
                include: {
                    productSchedule: { include: { windows: true } },
                    vendor: { select: { timezone: true, operatingHours: true } },
                },
            });
            if (!silent)
                console.log(`🔍 Found ${products.length} products with relevant schedules`);
            for (const product of products) {
                const sched = product.productSchedule;
                if (!sched?.goLiveAt && !sched?.takeDownAt)
                    continue; // skip products with no schedule
                const vendorTz = product.vendor;
                const shouldBeLive = computeShouldBeLive({
                    ...sched,
                    windows: sched.windows ?? [],
                    vendorTimezone: (0, vendorAvailability_service_1.resolveVendorTimezone)(vendorTz?.timezone, vendorTz?.operatingHours),
                });
                const computedLiveUntil = shouldBeLive && sched.takeDownAt ? new Date(sched.takeDownAt) : null;
                const productNeedsUpdate = product.isLive !== shouldBeLive ||
                    (product.liveUntil?.getTime() || null) !== (computedLiveUntil?.getTime() || null);
                const scheduleNeedsUpdate = sched.isLive !== shouldBeLive;
                if (!productNeedsUpdate && !scheduleNeedsUpdate)
                    continue;
                if (productNeedsUpdate) {
                    await prismaClient_1.default.product.update({
                        where: { id: product.id },
                        data: {
                            isLive: shouldBeLive,
                            liveUntil: computedLiveUntil,
                            updatedAt: now,
                        },
                    });
                }
                if (scheduleNeedsUpdate) {
                    await prismaClient_1.default.productSchedule.update({
                        where: { id: sched.id },
                        data: { isLive: shouldBeLive },
                    });
                }
                if (productNeedsUpdate || scheduleNeedsUpdate) {
                    await (0, clearCaches_1.clearProductCache)(product.id);
                    await redis_1.redisProducts.del(`vendor:${product.vendorId}:products`);
                    await redis_1.redisProducts.del(`vendor:${product.vendorId}:products:available`);
                    if (product.category)
                        await redis_1.redisProducts.del(`category:${product.category}:products`);
                    updatedCount++;
                    if (!silent)
                        console.log(`[fixLiveStatusJob] 🔄 Updated product=${product.id} → shouldBeLive=${shouldBeLive}`);
                }
            }
        }
        if (!silent)
            console.log(`✅ Fixed ${updatedCount} product live statuses`);
        return { updatedCount, timestamp: now };
    }
    catch (error) {
        console.error("❌ Error in fixLiveStatusJob:", error);
        throw error;
    }
};
exports.fixLiveStatusJob = fixLiveStatusJob;

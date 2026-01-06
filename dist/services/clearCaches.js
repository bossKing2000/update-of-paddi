"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearProductCache = void 0;
const redis_1 = require("../lib/redis");
/**
 * Helper function to scan and delete Redis keys using redis v4/v5
 */
async function scanAndDelete(client, patterns) {
    let cursor = "0";
    do {
        // v4/v5 scan returns { cursor, keys }
        const result = await client.scan(cursor, { COUNT: 50 });
        cursor = result.cursor;
        const keys = result.keys;
        if (keys.length > 0) {
            const filtered = keys.filter((key) => patterns.some((pattern) => key.startsWith(pattern)));
            if (filtered.length > 0) {
                await client.del(filtered);
            }
        }
    } while (cursor !== "0");
}
/**
 * Clears cache for product details, vendor lists, global lists, and pattern-matched keys
 */
const clearProductCache = async (productId, vendorId) => {
    try {
        const keysToDelete = [];
        // ----- Product related keys -----
        if (productId) {
            keysToDelete.push(`product:${productId}:detail`, `product:${productId}`, `api:product:${productId}`, `api:/api/product/${productId}`);
        }
        // ----- Vendor related keys -----
        if (vendorId) {
            keysToDelete.push(`vendor:${vendorId}:products`, `vendor:${vendorId}:products:available`, `vendor:${vendorId}:dashboardSummary`, `products:live`);
            // Paginated vendor product lists
            await scanAndDelete(redis_1.redisProducts, [
                `vendor:${vendorId}:products:page:`,
            ]);
        }
        // ----- Global product keys -----
        keysToDelete.push("products:all", "products:featured");
        // Redis instances to clear
        const redisInstances = [
            redis_1.redisProducts,
            redis_1.redisNotifications,
            redis_1.redisSearch,
            redis_1.redisTotalViews,
            redis_1.redisUsersSessions,
            redis_1.ShopCartRedis,
        ];
        // ----- Delete fixed keys -----
        if (keysToDelete.length > 0) {
            for (const client of redisInstances) {
                await client.del(keysToDelete).catch((err) => {
                    console.warn(`[CACHE] scanAndDelete failed on DB ${client.options?.database ?? "unknown"}:`, err);
                });
            }
        }
        // ----- Pattern-based deletion -----
        const patterns = [
            "products:",
            "category:",
            "search:",
            "api:products:",
            "api:search:",
        ];
        for (const client of redisInstances) {
            await scanAndDelete(client, patterns).catch((err) => {
                console.warn(`[CACHE] scanAndDelete failed on DB ${client.options?.database ?? "unknown"}:`, err);
            });
        }
        console.log(`[CACHE] Cleared productId=${productId ?? "ALL"} vendorId=${vendorId ?? "ALL"}`);
    }
    catch (err) {
        console.error("[CACHE] Cache clear error:", err);
    }
};
exports.clearProductCache = clearProductCache;

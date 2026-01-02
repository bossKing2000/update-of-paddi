import {
  redisProducts,
  redisNotifications,
  redisSearch,
  redisTotalViews,
  redisUsersSessions,
  ShopCartRedis,
} from "../lib/redis";
import { RedisClientType } from "redis";

/**
 * Helper function to scan and delete Redis keys using redis v4/v5
 */
async function scanAndDelete(
  client: RedisClientType,
  patterns: string[]
): Promise<void> {
  let cursor = "0";

  do {
    // v4/v5 scan returns { cursor, keys }
    const result = await client.scan(cursor, { COUNT: 50 });
    cursor = result.cursor;
    const keys: string[] = result.keys;

    if (keys.length > 0) {
      const filtered = keys.filter((key) =>
        patterns.some((pattern) => key.startsWith(pattern))
      );

      if (filtered.length > 0) {
        await client.del(filtered);
      }
    }
  } while (cursor !== "0");
}

/**
 * Clears cache for product details, vendor lists, global lists, and pattern-matched keys
 */
export const clearProductCache = async (
  productId?: string,
  vendorId?: string
) => {
  try {
    const keysToDelete: string[] = [];

    // ----- Product related keys -----
    if (productId) {
      keysToDelete.push(
        `product:${productId}:detail`,
        `product:${productId}`,
        `api:product:${productId}`,
        `api:/api/product/${productId}`
      );
    }

    // ----- Vendor related keys -----
    if (vendorId) {
      keysToDelete.push(
        `vendor:${vendorId}:products`,
        `vendor:${vendorId}:products:available`,
        `vendor:${vendorId}:dashboardSummary`,
        `products:live`,
      );
        // Paginated vendor product lists
      await scanAndDelete(redisProducts, [
        `vendor:${vendorId}:products:page:`,
      ]);
    }

    
    

    // ----- Global product keys -----
    keysToDelete.push("products:all", "products:featured");

    // Redis instances to clear
    const redisInstances: RedisClientType[] = [
      redisProducts,
      redisNotifications,
      redisSearch,
      redisTotalViews,
      redisUsersSessions,
      ShopCartRedis,
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

    console.log(
      `[CACHE] Cleared productId=${productId ?? "ALL"} vendorId=${vendorId ?? "ALL"}`
    );
  } catch (err) {
    console.error("[CACHE] Cache clear error:", err);
  }
};

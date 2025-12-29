// src/utils/vendorCache.ts
import { redisProducts } from "../lib/redis";

// Vendor-specific cache keys
const VENDOR_CACHE_TTL = 60 * 5; // 5 minutes cache for vendor products

export class VendorCache {
  // Generate cache key for vendor products
  static getVendorProductsKey(vendorId: string, page: number, limit: number): string {
    return `vendor:${vendorId}:products:page=${page}:limit=${limit}`;
  }

  // Get cached vendor products
  static async getVendorProducts(vendorId: string, page: number, limit: number): Promise<any | null> {
    try {
      const key = this.getVendorProductsKey(vendorId, page, limit);
      const cached = await redisProducts.get(key);
      
      if (cached) {
        console.log(`✅ [VENDOR CACHE] Hit for vendor ${vendorId}, page ${page}`);
        return JSON.parse(cached);
      }
      return null;
    } catch (error) {
      console.error(`[VENDOR CACHE] Error getting cache:`, error);
      return null;
    }
  }

  // Set vendor products cache - CORRECTED: Redis command is setex (lowercase)
  static async setVendorProducts(vendorId: string, page: number, limit: number, data: any): Promise<void> {
    try {
      const key = this.getVendorProductsKey(vendorId, page, limit);
      // CORRECTED: Redis command is setex (not setEx or setext)
      await redisProducts.setEx(key, VENDOR_CACHE_TTL, JSON.stringify(data));
      console.log(`💾 [VENDOR CACHE] Cached for vendor ${vendorId}, page ${page}`);
    } catch (error) {
      console.error(`[VENDOR CACHE] Error setting cache:`, error);
    }
  }

  // Invalidate ALL cache for a specific vendor
  static async invalidateVendorCache(vendorId: string): Promise<void> {
    try {
      // Get all cache keys for this vendor
      const pattern = `vendor:${vendorId}:*`;
      const keys = await redisProducts.keys(pattern);
      
      if (keys.length > 0) {
        await redisProducts.del(keys);
        console.log(`🗑️ [VENDOR CACHE] Invalidated ${keys.length} cache keys for vendor ${vendorId}`);
      }
    } catch (error) {
      console.error(`[VENDOR CACHE] Error invalidating cache:`, error);
    }
  }

  // Invalidate specific page cache for a vendor
  static async invalidateVendorProductsPage(vendorId: string, page: number, limit: number): Promise<void> {
    try {
      const key = this.getVendorProductsKey(vendorId, page, limit);
      await redisProducts.del(key);
      console.log(`🗑️ [VENDOR CACHE] Invalidated page ${page} cache for vendor ${vendorId}`);
    } catch (error) {
      console.error(`[VENDOR CACHE] Error invalidating page cache:`, error);
    }
  }

  // Clear all vendor cache (for maintenance)
  static async clearAllVendorCache(): Promise<void> {
    try {
      const keys = await redisProducts.keys("vendor:*");
      if (keys.length > 0) {
        await redisProducts.del(keys);
        console.log(`🧹 [VENDOR CACHE] Cleared all vendor cache (${keys.length} keys)`);
      }
    } catch (error) {
      console.error(`[VENDOR CACHE] Error clearing all cache:`, error);
    }
  }

  // Get cache stats for monitoring
  static async getCacheStats(): Promise<{
    totalVendorKeys: number;
    sampleKeys: string[];
  }> {
    try {
      const keys = await redisProducts.keys("vendor:*");
      return {
        totalVendorKeys: keys.length,
        sampleKeys: keys.slice(0, 10), // First 10 keys as sample
      };
    } catch (error) {
      console.error(`[VENDOR CACHE] Error getting stats:`, error);
      return { totalVendorKeys: 0, sampleKeys: [] };
    }
  }
}
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { redisProducts, redisSearch, redisTotalViews, ShopCartRedis } from "../lib/redis";
import { CACHE_KEYS } from "./redisCacheTiming";

// Fetch products with aggregate ratings
export async function getProductsWithAggregates(
  whereClause: Prisma.ProductWhereInput,
  skip: number,
  limit: number,
  sort: string
) {
  const [totalItems, products] = await Promise.all([
    prisma.product.count({ where: whereClause }),
    prisma.product.findMany({
      where: whereClause,
      skip,
      take: limit,
      include: { vendor: { select: { id: true, name: true, brandName: true, avatarUrl: true } }, options: true },
      orderBy: getSortCondition(sort),
    }),
  ]);

  const reviewAggregates = await prisma.productReview.groupBy({
    by: ["productId"],
    where: { productId: { in: products.map(p => p.id) } },
    _count: { id: true },
    _avg: { rating: true },
  });

  const reviewMap = reviewAggregates.reduce((acc, agg) => {
    acc[agg.productId] = { averageRating: agg._avg?.rating ?? 0, reviewCount: agg._count.id };
    return acc;
  }, {} as Record<string, { averageRating: number; reviewCount: number }>);

  const productsWithAggregates = products.map(product => ({
    ...product,
    averageRating: reviewMap[product.id]?.averageRating ?? 0,
    reviewCount: reviewMap[product.id]?.reviewCount ?? 0,
  }));

  return { products: productsWithAggregates, totalItems };
}

// Sort condition helper
export function getSortCondition(sort: string): Prisma.ProductOrderByWithRelationInput {
  switch (sort) {
    case "popular":
      return { popularityScore: "desc" };
    case "price-asc":
      return { price: "asc" };
    case "price-desc":
      return { price: "desc" };
    case "newest":
    default:
      return { createdAt: "desc" };
  }
}


/**
 * Remove product from all user carts caches.
 */

export const clearProductFromCarts = async (productId: string): Promise<void> => {
  try {
    // 1️⃣ Direct mapping
    await redisProducts.del(`cart:product:${productId}:users`).catch(() => {});

    // 2️⃣ Scan all cart keys
    let cursor = "0";
    const cartKeysToDelete: string[] = [];

    do {
      // node-redis v5 returns { cursor, keys }
      const result = await redisProducts.scan(cursor, { MATCH: "cart:*", COUNT: 100 });
      cursor = result.cursor;
      const keys = result.keys;

      for (const key of keys) {
        const value = await redisProducts.get(key).catch(() => "");
        if (value && value.includes(productId)) {
          cartKeysToDelete.push(key);
        }
      }
    } while (cursor !== "0");

if (cartKeysToDelete.length > 0) {
  await Promise.all(cartKeysToDelete.map((key) => redisProducts.del(key)));
  console.log(`[CACHE] Cleared ${cartKeysToDelete.length} cart caches containing product ${productId}`);
}

  } catch (err) {
    console.error(`[CACHE] Error clearing product from carts (${productId}):`, err);
  }
};




// ─── Track total product views ─────────────────────────────
export async function trackProductView(productId: string) {
  const totalKey = `product:${productId}:views:total`;
  try {
    // Increment total views in Redis
    await redisTotalViews.incr(totalKey);

    // Keep the counter for 1 day
    await redisTotalViews.expire(totalKey, 60 * 60 * 24);
  } catch (err) {
    console.error("Track total view error:", err);
  }
}




export async function trackSearchKeyword(keyword: string, userKey: string) {
  const redisKey = `search:${keyword}:hits`;
  await redisSearch.hIncrBy(redisKey, userKey, 1);
  await redisSearch.expire(redisKey, 60 * 60 * 24 * 7);
}



export async function clearSearchCaches() {
  let cursor = "0";

  do {
    const { cursor: nextCursor, keys } = await redisSearch.scan(cursor, {
      MATCH: "search:*",
      COUNT: 100,
    });
    if (keys.length) await redisSearch.del(keys);
    cursor = nextCursor;
  } while (cursor !== "0");

  cursor = "0";
  do {
    const { cursor: nextCursor, keys } = await redisSearch.scan(cursor, {
      MATCH: "suggestions:*",
      COUNT: 100,
    });
    if (keys.length) await redisSearch.del(keys);
    cursor = nextCursor;
  } while (cursor !== "0");

  console.log("🗑️ Cleared search + suggestion caches");
}


"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearProductFromCarts = void 0;
exports.getProductsWithAggregates = getProductsWithAggregates;
exports.getSortCondition = getSortCondition;
exports.trackProductView = trackProductView;
exports.trackSearchKeyword = trackSearchKeyword;
exports.clearSearchCaches = clearSearchCaches;
const prisma_1 = __importDefault(require("../lib/prisma"));
const redis_1 = require("../lib/redis");
// Fetch products with aggregate ratings
async function getProductsWithAggregates(whereClause, skip, limit, sort) {
    const [totalItems, products] = await Promise.all([
        prisma_1.default.product.count({ where: whereClause }),
        prisma_1.default.product.findMany({
            where: whereClause,
            skip,
            take: limit,
            include: { vendor: { select: { id: true, name: true, brandName: true, avatarUrl: true } }, options: true },
            orderBy: getSortCondition(sort),
        }),
    ]);
    const reviewAggregates = await prisma_1.default.productReview.groupBy({
        by: ["productId"],
        where: { productId: { in: products.map(p => p.id) } },
        _count: { id: true },
        _avg: { rating: true },
    });
    const reviewMap = reviewAggregates.reduce((acc, agg) => {
        acc[agg.productId] = { averageRating: agg._avg?.rating ?? 0, reviewCount: agg._count.id };
        return acc;
    }, {});
    const productsWithAggregates = products.map(product => ({
        ...product,
        averageRating: reviewMap[product.id]?.averageRating ?? 0,
        reviewCount: reviewMap[product.id]?.reviewCount ?? 0,
    }));
    return { products: productsWithAggregates, totalItems };
}
// Sort condition helper
function getSortCondition(sort) {
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
const clearProductFromCarts = async (productId) => {
    try {
        // 1️⃣ Direct mapping
        await redis_1.redisProducts.del(`cart:product:${productId}:users`).catch(() => { });
        // 2️⃣ Scan all cart keys
        let cursor = "0";
        const cartKeysToDelete = [];
        do {
            // node-redis v5 returns { cursor, keys }
            const result = await redis_1.redisProducts.scan(cursor, { MATCH: "cart:*", COUNT: 100 });
            cursor = result.cursor;
            const keys = result.keys;
            for (const key of keys) {
                const value = await redis_1.redisProducts.get(key).catch(() => "");
                if (value && value.includes(productId)) {
                    cartKeysToDelete.push(key);
                }
            }
        } while (cursor !== "0");
        if (cartKeysToDelete.length > 0) {
            await Promise.all(cartKeysToDelete.map((key) => redis_1.redisProducts.del(key)));
            console.log(`[CACHE] Cleared ${cartKeysToDelete.length} cart caches containing product ${productId}`);
        }
    }
    catch (err) {
        console.error(`[CACHE] Error clearing product from carts (${productId}):`, err);
    }
};
exports.clearProductFromCarts = clearProductFromCarts;
// ─── Track total product views ─────────────────────────────
async function trackProductView(productId) {
    const totalKey = `product:${productId}:views:total`;
    try {
        // Increment total views in Redis
        await redis_1.redisTotalViews.incr(totalKey);
        // Keep the counter for 1 day
        await redis_1.redisTotalViews.expire(totalKey, 60 * 60 * 24);
    }
    catch (err) {
        console.error("Track total view error:", err);
    }
}
async function trackSearchKeyword(keyword, userKey) {
    const redisKey = `search:${keyword}:hits`;
    await redis_1.redisSearch.hIncrBy(redisKey, userKey, 1);
    await redis_1.redisSearch.expire(redisKey, 60 * 60 * 24 * 7);
}
async function clearSearchCaches() {
    let cursor = "0";
    do {
        const { cursor: nextCursor, keys } = await redis_1.redisSearch.scan(cursor, {
            MATCH: "search:*",
            COUNT: 100,
        });
        if (keys.length)
            await redis_1.redisSearch.del(keys);
        cursor = nextCursor;
    } while (cursor !== "0");
    cursor = "0";
    do {
        const { cursor: nextCursor, keys } = await redis_1.redisSearch.scan(cursor, {
            MATCH: "suggestions:*",
            COUNT: 100,
        });
        if (keys.length)
            await redis_1.redisSearch.del(keys);
        cursor = nextCursor;
    } while (cursor !== "0");
    console.log("🗑️ Cleared search + suggestion caches");
}

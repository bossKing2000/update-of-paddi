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
exports.fetchProductPage = fetchProductPage;
exports.fetchMostPopularProducts = fetchMostPopularProducts;
exports.fetchLiveProducts = fetchLiveProducts;
exports.fetchNewProducts = fetchNewProducts;
const client_1 = require("@prisma/client");
const prisma_1 = __importDefault(require("../lib/prisma"));
const redis_1 = require("../lib/redis");
const vendorAvailability_service_1 = require("./vendorAvailability.service");
const scheduleRules_service_1 = require("./scheduleRules.service");
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
// Vendor-operating condition shared by every marketplace-discovery listing.
// A product is only marketplace-visible while its vendor is live and has
// not paused orders. `deliveryPreferences.acceptingOrders` defaults to
// "accepting" when the JSON is absent (same default computeVendorIsOpen
// uses). Kept inline in the raw-SQL listings; Prisma listings pass the flag
// through options instead.
const VENDOR_OPERATING_SQL = `
    JOIN "User" v ON v."id" = p."vendorId"
      AND v."isLive" = true
      AND COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') <> 'false'`;
// Recurring WEEKLY schedule liveness, evaluated in SQL against the vendor's
// effective timezone so discovery listings are accurate in real time (not
// dependent on mirror-sync jobs). Mirrors scheduleRules.service semantics:
//   - same-day windows: [startMinute, endMinute) on matching dow
//   - overnight windows (end <= start): evening part on the window's own day
//     PLUS the post-midnight tail matched against YESTERDAY's dow
//   - optional inclusive startDate/endDate compared on the local date
// `s` must be the LEFT-JOINED "ProductSchedule" row for this product.
const WEEKLY_SCHEDULE_ACTIVE_SQL = `
      (
        s."type" = 'WEEKLY'
        AND s."enabled" = true
        AND (
          s."startDate" IS NULL OR
          (NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::date >= (s."startDate" AT TIME ZONE 'UTC')::date
        )
        AND (
          s."endDate" IS NULL OR
          (NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::date <= (s."endDate" AT TIME ZONE 'UTC')::date
        )
        AND EXISTS (
          SELECT 1 FROM "ProductScheduleWindow" w
          WHERE w."scheduleId" = s."id"
            AND w."enabled" = true
            AND (
              -- same-day window
              (
                w."dayOfWeek" = EXTRACT(dow FROM NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::int
                AND w."startMinute" <= EXTRACT(HOUR FROM NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::int * 60 + EXTRACT(MINUTE FROM NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::int
                AND (
                  (w."endMinute" > w."startMinute"
                    AND (EXTRACT(HOUR FROM NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::int * 60 + EXTRACT(MINUTE FROM NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::int) < w."endMinute")
                  )
                )
              )
              -- post-midnight tail of YESTERDAY's overnight window
              OR (
                w."endMinute" <= w."startMinute"
                AND w."dayOfWeek" = (EXTRACT(dow FROM NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::int + 6) % 7
                AND (EXTRACT(HOUR FROM NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::int * 60 + EXTRACT(MINUTE FROM NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC'))::int) < w."endMinute"
              )
            )
        )
      )`;
/**
 * Marketplace-liveness predicate for raw SQL listings. Semantics:
 *   - product with a WEEKLY schedule → evaluated live from its windows
 *   - otherwise → stored Product.isLive mirror (+ for fetchLiveProducts,
 *     the legacy absolute-window clause passed via extraLiveClause)
 */
function weeklyAwareLivePredicate(extraLegacyClause) {
    const legacy = extraLegacyClause ? `\n        ${extraLegacyClause}` : "";
    return `
      (
        (s."id" IS NULL OR s."type" = 'ONE_TIME')
        AND p."isLive" = true${legacy}
      )
      OR${WEEKLY_SCHEDULE_ACTIVE_SQL}`;
}
async function fetchProductPage(opts) {
    const { skip, take, category, vendorId, vendorMustBeOperating } = opts;
    const where = { archived: false };
    if (category)
        where.category = category;
    if (vendorId)
        where.vendorId = vendorId;
    if (vendorMustBeOperating) {
        where.vendor = {
            isLive: true,
            AND: [
                {
                    OR: [
                        { deliveryPreferences: { equals: client_1.Prisma.AnyNull } },
                        { NOT: { deliveryPreferences: { path: ["acceptingOrders"], equals: false } } },
                    ],
                },
            ],
        };
    }
    const [dbProducts, total] = await Promise.all([
        prisma_1.default.product.findMany({
            where,
            skip,
            take,
            orderBy: [{ isLive: "desc" }, { createdAt: "desc" }],
            select: {
                id: true,
                name: true,
                price: true,
                category: true,
                thumbnail: true,
                images: true,
                popularityPercent: true,
                isLive: true,
                archived: true,
                productSchedule: {
                    // Full row so the authoritative evaluator (scheduleRules) can
                    // decide ONE_TIME and WEEKLY modes alike for the orderable flag.
                    select: {
                        type: true,
                        enabled: true,
                        goLiveAt: true,
                        takeDownAt: true,
                        graceMinutes: true,
                        startDate: true,
                        endDate: true,
                        windows: true,
                    },
                },
                vendor: {
                    select: {
                        id: true,
                        name: true,
                        brandName: true,
                        avatarUrl: true,
                        isLive: true,
                        deliveryPreferences: true,
                        timezone: true,
                        operatingHours: true,
                    },
                },
            },
        }),
        prisma_1.default.product.count({ where }),
    ]);
    const now = new Date();
    const products = dbProducts.map((p) => {
        const vendorOperating = (0, vendorAvailability_service_1.isVendorOperating)(p.vendor);
        // Authoritative marketplace-availability result from the existing
        // evaluator + Vendor Live state — exposed as `orderable` so discovery
        // clients never recompute availability locally.
        const orderable = !p.archived &&
            vendorOperating &&
            (0, scheduleRules_service_1.evaluateProductSchedule)(p.productSchedule, now, (0, vendorAvailability_service_1.resolveVendorTimezone)(p.vendor.timezone, p.vendor.operatingHours), p.isLive);
        return {
            id: p.id,
            name: p.name,
            price: p.price,
            category: p.category,
            images: p.thumbnail ? [p.thumbnail] : p.images.length > 0 ? [p.images[0]] : [],
            popularityPercent: p.popularityPercent,
            isLive: computeIsLiveFromSchedule(p.productSchedule, p.isLive),
            goLiveAt: p.productSchedule?.goLiveAt || null,
            liveUntil: p.productSchedule?.takeDownAt || null,
            vendorOperating,
            orderable,
            vendor: p.vendor,
        };
    });
    return { products, total };
}
async function fetchMostPopularProducts(opts) {
    const { skip, take } = opts;
    // Filtered by isLive directly in SQL (both the page query and the count
    // query), and — since the Vendor Live migration — restricted to products
    // whose vendor is currently operating. isLive is recomputed from the
    // schedule for display accuracy — see getMostPopularProducts for the
    // full rationale.
    const rawProducts = await prisma_1.default.$queryRawUnsafe(`
    SELECT p.id, p.name, p.price, p.images, p."averageRating", p."reviewCount",
           p."popularityScore", p."popularityPercent", p."totalViews", p.category,
           p."isLive", p."archived",
           s."goLiveAt", s."takeDownAt", s."graceMinutes", s."type" AS "scheduleType",
           v."isLive"::text AS "vendorIsLive",
           COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') AS "acceptingOrders"
    FROM "Product" p
    ${VENDOR_OPERATING_SQL}
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
    WHERE p."archived" = false
      AND ${weeklyAwareLivePredicate()}
    ORDER BY p."popularityScore" DESC
    LIMIT $1 OFFSET $2;
    `, take, skip);
    const products = rawProducts.map((p) => {
        if (p.scheduleType === "WEEKLY")
            return { ...p, isLive: true, orderable: true };
        const schedule = p.goLiveAt || p.takeDownAt || p.graceMinutes
            ? {
                goLiveAt: p.goLiveAt ?? undefined,
                takeDownAt: p.takeDownAt ?? undefined,
                graceMinutes: p.graceMinutes ?? undefined,
            }
            : null;
        return {
            ...p,
            isLive: computeIsLiveFromSchedule(schedule, p.isLive),
            // Authoritative marketplace-availability result for discovery UI.
            vendorOperating: p.vendorIsLive === "true" && p.acceptingOrders !== "false",
            orderable: p.archived === false &&
                computeIsLiveFromSchedule(schedule, p.isLive),
        };
    });
    const totalResult = await prisma_1.default.$queryRawUnsafe(`SELECT COUNT(*)::int AS count
     FROM "Product" p
     ${VENDOR_OPERATING_SQL}
     LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
     WHERE p."archived" = false
       AND ${weeklyAwareLivePredicate()};`);
    const total = totalResult[0]?.count ?? 0;
    return { products: products, total };
}
// Schedule-aware live listing for the home feed's LIVE NOW section.
//
// The stored Product.isLive column is a mirror kept fresh by
// fixLiveStatusJob / productLiveWorker. Between syncs it can go stale —
// e.g. right after seeding, a product whose schedule window is active now
// still has isLive=false in the row, which made the feed's live section
// empty while GET /product correctly displayed it as live (computed from
// the schedule). This query treats the ACTIVE SCHEDULE WINDOW as the
// source of truth:
//
//   live = archived = false AND (
//            stored isLive = true
//            OR (goLiveAt <= now AND takeDownAt + graceMinutes >= now)
//          )
//
// Rows whose stored flag is true but whose window has fully expired are
// dropped afterward via computeIsLiveFromSchedule (same display rule as
// getMostPopularProducts / getAllProducts), so "live" never outlives its
// schedule unless no schedule exists at all.
async function fetchLiveProducts(opts) {
    const { take, category } = opts;
    const categoryFilter = category != null && category !== ""
        ? `AND p."category"::text = $2`
        : "";
    const params = [take];
    if (category != null && category !== "")
        params.push(category);
    const rawProducts = await prisma_1.default.$queryRawUnsafe(`
    SELECT p.id, p.name, p.price, p.images, p."averageRating", p."reviewCount",
           p."popularityScore", p."popularityPercent", p."totalViews", p.category,
           p."isLive", p."archived",
           s."goLiveAt", s."takeDownAt", s."graceMinutes", s."type" AS "scheduleType",
           v."isLive"::text AS "vendorIsLive",
           COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') AS "acceptingOrders"
    FROM "Product" p
    ${VENDOR_OPERATING_SQL}
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
    WHERE p."archived" = false
      AND ${weeklyAwareLivePredicate(`
        OR (
          s."goLiveAt" IS NOT NULL
          AND s."takeDownAt" IS NOT NULL
          AND s."goLiveAt" <= NOW()
          AND s."takeDownAt" + (COALESCE(s."graceMinutes", 0) * INTERVAL '1 minute') >= NOW()
        )`)}
      ${categoryFilter}
    ORDER BY p."popularityScore" DESC
    LIMIT $1;
    `, ...params);
    const countParams = [];
    let countCategoryFilter = "";
    if (category != null && category !== "") {
        countCategoryFilter = `AND p."category"::text = $1`;
        countParams.push(category);
    }
    const totalResult = await prisma_1.default.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS count
    FROM "Product" p
    ${VENDOR_OPERATING_SQL}
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
    WHERE p."archived" = false
      AND ${weeklyAwareLivePredicate(`
        OR (
          s."goLiveAt" IS NOT NULL
          AND s."takeDownAt" IS NOT NULL
          AND s."goLiveAt" <= NOW()
          AND s."takeDownAt" + (COALESCE(s."graceMinutes", 0) * INTERVAL '1 minute') >= NOW()
        )`)}
      ${countCategoryFilter}
    ;
    `, ...countParams);
    // Same display rule as every other product listing: liveness is
    // recomputed for accuracy — WEEKLY rows were matched live by the SQL
    // window predicate; ONE_TIME/legacy rows recheck the absolute window and
    // otherwise defer to the stored mirror. The post-filter also drops rows
    // that only matched via a stale stored flag.
    const products = rawProducts
        .map((p) => {
        if (p.scheduleType === "WEEKLY") {
            return { ...p, isLive: true, vendorOperating: true, orderable: true };
        }
        const schedule = p.goLiveAt || p.takeDownAt || p.graceMinutes
            ? {
                goLiveAt: p.goLiveAt ?? undefined,
                takeDownAt: p.takeDownAt ?? undefined,
                graceMinutes: p.graceMinutes ?? undefined,
            }
            : null;
        return {
            ...p,
            isLive: computeIsLiveFromSchedule(schedule, p.isLive),
            vendorOperating: p.vendorIsLive === "true" && p.acceptingOrders !== "false",
            // Live-listing rows are marketplace-available by construction.
            orderable: true,
        };
    })
        .filter((p) => p.isLive);
    return { products: products, total: totalResult[0]?.count ?? products.length };
}
async function fetchNewProducts(opts) {
    const { take, category } = opts;
    const where = { archived: false, isNew: true };
    if (category)
        where.category = category;
    const [items, total] = await Promise.all([
        prisma_1.default.product.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take,
            select: {
                id: true,
                name: true,
                price: true,
                category: true,
                images: true,
                thumbnail: true,
                isNew: true,
                createdAt: true,
                isLive: true,
                vendor: {
                    select: { id: true, name: true, brandName: true, avatarUrl: true },
                },
            },
        }),
        prisma_1.default.product.count({ where }),
    ]);
    return {
        items: items.map((p) => ({
            id: p.id,
            name: p.name,
            price: p.price,
            category: p.category,
            images: p.thumbnail ? [p.thumbnail] : p.images.length > 0 ? [p.images[0]] : [],
            isNew: p.isNew,
            createdAt: p.createdAt,
            isLive: p.isLive,
            vendor: p.vendor,
        })),
        total,
    };
}
// Local copy of productController.computeIsLive — the controller exports it
// today, but importing a controller from a service inverts the dependency
// direction. Keep both in sync (covered by tests/unit/computeIsLive.test.ts).
function computeIsLiveFromSchedule(schedule, defaultIsLive) {
    if (!schedule)
        return defaultIsLive;
    const now = Date.now();
    const goLive = schedule.goLiveAt ? new Date(schedule.goLiveAt).getTime() : 0;
    const takeDown = schedule.takeDownAt ? new Date(schedule.takeDownAt).getTime() : 0;
    const grace = (schedule.graceMinutes ?? 0) * 60 * 1000;
    if (!goLive || !takeDown)
        return defaultIsLive;
    return now >= goLive && now <= takeDown + grace;
}

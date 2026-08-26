import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { redisProducts, redisSearch, redisTotalViews, ShopCartRedis } from "../lib/redis";
import { CACHE_KEYS } from "./redisCacheTiming";
import {
  isVendorOperating,
  resolveVendorTimezone,
} from "./vendorAvailability.service";
import { evaluateProductSchedule } from "./scheduleRules.service";

// Catalog sort values accepted by GET /api/product?sortBy=…
// "popularity" ranks by popularityScore; the rest map to stored fields.
// Omitted/empty sortBy preserves the historical live-first browse order.
export const CATALOG_SORT_VALUES = [
  "popularity",
  "priceAsc",
  "priceDesc",
  "newest",
] as const;
export type CatalogSortValue = (typeof CATALOG_SORT_VALUES)[number];

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


// ─────────────────────────────────────────────────────────────────────────────
// Shared home-feed query cores (Phase 3A)
//
// The listing logic below was extracted verbatim from
// productController.getAllProducts / getMostPopularProducts so that both the
// original endpoints and the new GET /api/home/feed composition share one
// implementation. The controllers keep their own Redis caching and response
// envelopes; these functions only do the DB work + response-shape mapping.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductListItem {
  id: string;
  name: string;
  price: number;
  category: string;
  images: string[];
  popularityPercent: number;
  isLive: boolean;
  goLiveAt: Date | null;
  liveUntil: Date | null;
  /** Vendor Live: vendor is currently operating / accepting orders. */
  vendorOperating?: boolean;
  /** Authoritative marketplace availability (vendor + schedule + archive). */
  orderable?: boolean;
  vendor: { id: string; name: string; brandName: string | null; avatarUrl: string | null };
}

export interface ProductPageResult {
  products: ProductListItem[];
  total: number;
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
        AND (s."startDate" IS NULL OR cal.ldate >= (s."startDate" AT TIME ZONE 'UTC')::date)
        AND (s."endDate"   IS NULL OR cal.ldate <= (s."endDate"   AT TIME ZONE 'UTC')::date)
        AND EXISTS (
          SELECT 1 FROM "ProductScheduleWindow" w
          WHERE w."scheduleId" = s."id"
            AND w."enabled" = true
            AND (
              -- Same-day window: [startMinute, endMinute) on its own weekday.
              (
                w."endMinute" > w."startMinute"
                AND w."dayOfWeek" = cal.ldow
                AND w."startMinute" <= cal.lmin
                AND cal.lmin < w."endMinute"
              )
              -- Overnight window, evening side: own weekday at/after start.
              OR (
                w."endMinute" <= w."startMinute"
                AND w."dayOfWeek" = cal.ldow
                AND cal.lmin >= w."startMinute"
              )
              -- Overnight window, post-midnight tail:
              -- matches YESTERDAY's row before its earlier endMinute.
              OR (
                w."endMinute" <= w."startMinute"
                AND w."dayOfWeek" = (cal.ldow + 6) % 7
                AND cal.lmin < w."endMinute"
              )
            )
        )
      )`;

/**
 * Vendor-local calendar for the weekly predicate, computed once per row via
 * a lateral join. Kept beside WEEKLY_SCHEDULE_ACTIVE_SQL so the SQL and the
 * TS evaluator (scheduleRules.service) stay semantically identical.
 */
const LOCAL_CALENDAR_SQL = `
    JOIN LATERAL (
      SELECT
        EXTRACT(dow FROM t)::int AS ldow,
        EXTRACT(hour FROM t)::int * 60 + EXTRACT(minute FROM t)::int AS lmin,
        t::date AS ldate
      FROM (
        SELECT (NOW() AT TIME ZONE COALESCE(v."timezone", NULLIF(v."operatingHours" ->> 'timezone', ''), 'UTC')) AS t
      ) tz
    ) cal ON true`;

/**
 * Marketplace-liveness predicate for raw SQL listings. Semantics:
 *   - product with a WEEKLY schedule → evaluated live from its windows
 *   - otherwise → stored Product.isLive mirror (+ for fetchLiveProducts,
 *     the legacy absolute-window clause passed via extraLiveClause)
 */
function weeklyAwareLivePredicate(extraLegacyClause?: string): string {
  const legacy = extraLegacyClause ? `\n        ${extraLegacyClause}` : "";
  return `
      (
        (s."id" IS NULL OR s."type" = 'ONE_TIME')
        AND p."isLive" = true${legacy}
      )
      OR${WEEKLY_SCHEDULE_ACTIVE_SQL}`;
}

export async function fetchProductPage(opts: {
  skip: number;
  take: number;
  category?: string;
  vendorId?: string;
  /** Marketplace surfaces set this; plain browse (GET /product) does not. */
  vendorMustBeOperating?: boolean;
  /** Catalog sorting: popularity | priceAsc | priceDesc | newest. */
  sortBy?: string;
  minPrice?: number;
  maxPrice?: number;
  /** Only currently-orderable marketplace products (authoritative rules). */
  availableOnly?: boolean;
}): Promise<ProductPageResult> {
  const {
    skip,
    take,
    category,
    vendorId,
    vendorMustBeOperating,
    sortBy,
    minPrice,
    maxPrice,
    availableOnly,
  } = opts;

  // Availability filtering cannot be expressed by the Prisma query builder
  // (per-row grace arithmetic + weekly windows), so this flag routes to the
  // dedicated raw-SQL implementation below. It reuses the SAME fragments as
  // every other live listing — no second evaluator.
  if (availableOnly) {
    return fetchAvailableOnlyProducts({ skip, take, category, vendorId, sortBy });
  }

  const where: Prisma.ProductWhereInput = { archived: false };
  if (category) where.category = category as Prisma.EnumCategoryFilter;
  if (vendorId) where.vendorId = vendorId;
  if (opts.minPrice != null || opts.maxPrice != null) {
    where.price = {
      ...(opts.minPrice != null ? { gte: opts.minPrice } : {}),
      ...(opts.maxPrice != null ? { lte: opts.maxPrice } : {}),
    } as Prisma.FloatFilter;
  }
  if (vendorMustBeOperating) {
    where.vendor = {
      isLive: true,
      AND: [
        {
          OR: [
            { deliveryPreferences: { equals: Prisma.AnyNull } },
            { NOT: { deliveryPreferences: { path: ["acceptingOrders"], equals: false } } },
          ],
        },
      ],
    };
  }

  // Catalog sorting. Default (omitted sortBy) preserves the historical
  // live-first / newest-first browse ordering exactly.
  let orderBy: Prisma.ProductOrderByWithRelationInput[];
  switch (opts.sortBy) {
    case "popularity":
      orderBy = [{ popularityScore: "desc" }, { createdAt: "desc" }];
      break;
    case "priceAsc":
      orderBy = [{ price: "asc" }, { createdAt: "desc" }];
      break;
    case "priceDesc":
      orderBy = [{ price: "desc" }, { createdAt: "desc" }];
      break;
    case "newest":
      orderBy = [{ createdAt: "desc" }];
      break;
    default:
      orderBy = [{ isLive: "desc" }, { createdAt: "desc" }];
  }

  const [dbProducts, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      orderBy,
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
    prisma.product.count({ where }),
  ]);

  const now = new Date();
  const products: ProductListItem[] = dbProducts.map((p) => {
    const vendorOperating = isVendorOperating(p.vendor);
    // Authoritative marketplace-availability result from the existing
    // evaluator + Vendor Live state — exposed as `orderable` so discovery
    // clients never recompute availability locally.
    const orderable =
      !p.archived &&
      vendorOperating &&
      evaluateProductSchedule(
        p.productSchedule as any,
        now,
        resolveVendorTimezone(
          p.vendor.timezone,
          p.vendor.operatingHours as unknown,
        ),
        p.isLive,
      );

    return {
      id: p.id,
      name: p.name,
      price: p.price,
      category: p.category as string,
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

/**
 * availableOnly=true listing: currently-orderable marketplace products.
 *
 * Orderability = NOT archived AND vendor operating AND schedule active, where
 * the schedule evaluation mirrors evaluateProductSchedule exactly:
 *   - complete ONE_TIME window: goLiveAt <= NOW() <= takeDownAt + grace
 *   - WEEKLY: enabled + date range + an active window today/yesterday-tail
 *   - missing/incomplete schedule defers to the stored isLive mirror
 * Vendor Live filtering reuses VENDOR_OPERATING_SQL. Sorted identically to
 * the Prisma path so Explore sorting behaves consistently across modes.
 */
async function fetchAvailableOnlyProducts(opts: {
  skip: number;
  take: number;
  category?: string;
  vendorId?: string;
  sortBy?: string;
}): Promise<ProductPageResult> {
  const { skip, take, category, vendorId } = opts;

  const conditions: string[] = [
    `p."archived" = false`,
    `( -- authoritative availability (Vendor Live + schedules)
        v."isLive" = true
        AND COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') <> 'false'
        AND (
          (s."id" IS NULL AND p."isLive" = true)
          OR (
            s."type" = 'ONE_TIME'
            AND s."goLiveAt" IS NOT NULL
            AND s."takeDownAt" IS NOT NULL
            AND NOW() >= s."goLiveAt"
            AND NOW() <= s."takeDownAt" + (COALESCE(s."graceMinutes", 0) * INTERVAL '1 minute')
          )
          OR (
            (s."type" = 'ONE_TIME')
            AND (s."goLiveAt" IS NULL OR s."takeDownAt" IS NULL)
            AND p."isLive" = true
          )
          OR (
            s."type" = 'WEEKLY'
            AND s."enabled" = true
            AND (s."startDate" IS NULL OR cal.ldate >= (s."startDate" AT TIME ZONE 'UTC')::date)
            AND (s."endDate"   IS NULL OR cal.ldate <= (s."endDate"   AT TIME ZONE 'UTC')::date)
            AND EXISTS (
              SELECT 1 FROM "ProductScheduleWindow" w
              WHERE w."scheduleId" = s."id"
                AND w."enabled" = true
                AND (
                  (w."endMinute" > w."startMinute"
                    AND w."dayOfWeek" = cal.ldow
                    AND w."startMinute" <= cal.lmin
                    AND cal.lmin < w."endMinute")
                  OR (
                    w."endMinute" <= w."startMinute"
                    AND w."dayOfWeek" = cal.ldow
                    AND cal.lmin >= w."startMinute"
                  )
                  OR (
                    w."endMinute" <= w."startMinute"
                    AND w."dayOfWeek" = (cal.ldow + 6) % 7
                    AND cal.lmin < w."endMinute"
                  )
                )
            )
          )
        )
      )`,
  ];
  const params: unknown[] = [];
  if (category) {
    conditions.push(`p."category"::text = $${params.length + 1}`);
    params.push(category);
  }
  if (vendorId) {
    conditions.push(`p."vendorId" = $${params.length + 1}`);
    params.push(vendorId);
  }

  let orderBySql = `p."isLive" DESC, p."createdAt" DESC`;
  if (opts.sortBy === "popularity") orderBySql = `p."popularityScore" DESC, p."createdAt" DESC`;
  else if (opts.sortBy === "priceAsc") orderBySql = `p.price ASC`;
  else if (opts.sortBy === "priceDesc") orderBySql = `p.price DESC`;
  else if (opts.sortBy === "newest") orderBySql = `p."createdAt" DESC`;

  const whereSql = conditions.join("\n      AND ");

  const rows: any[] = await prisma.$queryRawUnsafe(
    `
    SELECT p.id, p.name, p.price, p.images, p.thumbnail,
           p."popularityPercent", p."isLive", p."archived",
           s."type" AS "scheduleType",
           s."goLiveAt", s."takeDownAt", s."graceMinutes",
           v."id" AS "vendor_id", v."name" AS "vendor_name",
           v."brandName" AS "vendor_brandName", v."avatarUrl" AS "vendor_avatarUrl",
           v."timezone" AS "vendor_timezone", v."operatingHours" AS "vendor_operatingHours"
    FROM "Product" p
    ${VENDOR_OPERATING_SQL}
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
    WHERE ${whereSql}
    ORDER BY ${orderBySql}
    LIMIT ${take} OFFSET ${skip};
    `,
    ...params,
  );

  const totalResult: { count: number }[] = await prisma.$queryRawUnsafe(
    `
    SELECT COUNT(*)::int AS count
    FROM "Product" p
    LEFT JOIN "User" v ON v."id" = p."vendorId"
      AND COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') <> 'false'
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
    WHERE v."isLive" = true
      AND p."archived" = false
      ${conditions.length ? `AND ${whereSql}` : ""}
    ;
    `,
    ...params,
  );

  const now = new Date();
  const products: ProductListItem[] = rows.map((r) => {
    const schedule =
      r.scheduleType != null || r.goLiveAt || r.takeDownAt
        ? {
            type: r.scheduleType ?? undefined,
            goLiveAt: r.goLiveAt ?? undefined,
            takeDownAt: r.takeDownAt ?? undefined,
            graceMinutes: r.graceMinutes ?? undefined,
          }
        : null;
    return {
      id: r.id,
      name: r.name,
      price: r.price,
      category: r.category as string,
      images: r.thumbnail ? [r.thumbnail] : (r.images?.length ?? 0) > 0 ? [r.images[0]] : [],
      popularityPercent: r.popularityPercent ?? 0,
      isLive: true,
      goLiveAt: r.goLiveAt ?? null,
      liveUntil: r.takeDownAt ?? null,
      vendorOperating: true,
      orderable: true,
      vendor: {
        id: r.vendor_id,
        name: r.vendor_name,
        brandName: r.vendor_brandName,
        avatarUrl: r.vendor_avatarUrl,
      },
    };
  });

  return { products, total: totalResult[0]?.count ?? products.length };
}

export async function fetchMostPopularProducts(opts: {
  skip: number;
  take: number;
}): Promise<ProductPageResult> {
  const { skip, take } = opts;

  // Filtered by isLive directly in SQL (both the page query and the count
  // query), and — since the Vendor Live migration — restricted to products
  // whose vendor is currently operating. isLive is recomputed from the
  // schedule for display accuracy — see getMostPopularProducts for the
  // full rationale.
  const rawProducts: any[] = await prisma.$queryRawUnsafe(
    `
    SELECT p.id, p.name, p.price, p.images, p."averageRating", p."reviewCount",
           p."popularityScore", p."popularityPercent", p."totalViews", p.category,
           p."isLive", p."archived",
           s."goLiveAt", s."takeDownAt", s."graceMinutes", s."type" AS "scheduleType",
           v."isLive"::text AS "vendorIsLive",
           COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') AS "acceptingOrders"
    FROM "Product" p
    ${VENDOR_OPERATING_SQL}
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id${LOCAL_CALENDAR_SQL}
    WHERE p."archived" = false
      AND ${weeklyAwareLivePredicate()}
    ORDER BY p."popularityScore" DESC
    LIMIT $1 OFFSET $2;
    `,
    take,
    skip,
  );

  const products = rawProducts.map((p) => {
    if (p.scheduleType === "WEEKLY")
      return {
        ...p,
        isLive: true,
        vendorOperating:
          p.vendorIsLive === "true" && p.acceptingOrders !== "false",
        orderable: true,
      };
    const schedule =
      p.goLiveAt || p.takeDownAt || p.graceMinutes
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
      vendorOperating:
        p.vendorIsLive === "true" && p.acceptingOrders !== "false",
      orderable:
        p.archived === false &&
        computeIsLiveFromSchedule(schedule, p.isLive),
    };
  });

  const totalResult: { count: number }[] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
     FROM "Product" p
     ${VENDOR_OPERATING_SQL}
     LEFT JOIN "ProductSchedule" s ON s."productId" = p.id${LOCAL_CALENDAR_SQL}
     WHERE p."archived" = false
       AND ${weeklyAwareLivePredicate()};`,
  );
  const total = totalResult[0]?.count ?? 0;

  return { products: products as ProductListItem[], total };
}

export interface NewProductItem {  id: string;
  name: string;
  price: number;
  category: string;
  images: string[];
  isNew: boolean;
  createdAt: Date;
  isLive: boolean;
  vendor: { id: string; name: string; brandName: string | null; avatarUrl: string | null };
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
export async function fetchLiveProducts(opts: {
  take: number;
  category?: string;
}): Promise<ProductPageResult> {
  const { take, category } = opts;

  const categoryFilter =
    category != null && category !== ""
      ? `AND p."category"::text = $2`
      : "";

  const params: unknown[] = [take];
  if (category != null && category !== "") params.push(category);

  const rawProducts: any[] = await prisma.$queryRawUnsafe(
    `
    SELECT p.id, p.name, p.price, p.images, p."averageRating", p."reviewCount",
           p."popularityScore", p."popularityPercent", p."totalViews", p.category,
           p."isLive", p."archived",
           s."goLiveAt", s."takeDownAt", s."graceMinutes", s."type" AS "scheduleType",
           v."isLive"::text AS "vendorIsLive",
           COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') AS "acceptingOrders"
    FROM "Product" p
    ${VENDOR_OPERATING_SQL}
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id${LOCAL_CALENDAR_SQL}
    WHERE p."archived" = false
      AND ${weeklyAwareLivePredicate(
        `
        OR (
          s."goLiveAt" IS NOT NULL
          AND s."takeDownAt" IS NOT NULL
          AND s."goLiveAt" <= NOW()
          AND s."takeDownAt" + (COALESCE(s."graceMinutes", 0) * INTERVAL '1 minute') >= NOW()
        )`,
      )}
      ${categoryFilter}
    ORDER BY p."popularityScore" DESC
    LIMIT $1;
    `,
    ...params,
  );

  const countParams: unknown[] = [];
  let countCategoryFilter = "";
  if (category != null && category !== "") {
    countCategoryFilter = `AND p."category"::text = $1`;
    countParams.push(category);
  }

  const totalResult: { count: number }[] = await prisma.$queryRawUnsafe(
    `
    SELECT COUNT(*)::int AS count
    FROM "Product" p
    ${VENDOR_OPERATING_SQL}
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id${LOCAL_CALENDAR_SQL}
    WHERE p."archived" = false
      AND ${weeklyAwareLivePredicate(
        `
        OR (
          s."goLiveAt" IS NOT NULL
          AND s."takeDownAt" IS NOT NULL
          AND s."goLiveAt" <= NOW()
          AND s."takeDownAt" + (COALESCE(s."graceMinutes", 0) * INTERVAL '1 minute') >= NOW()
        )`,
      )}
      ${countCategoryFilter}
    ;
    `,
    ...countParams,
  );

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
      const schedule =
        p.goLiveAt || p.takeDownAt || p.graceMinutes
          ? {
              goLiveAt: p.goLiveAt ?? undefined,
              takeDownAt: p.takeDownAt ?? undefined,
              graceMinutes: p.graceMinutes ?? undefined,
            }
          : null;
      return {
        ...p,
        isLive: computeIsLiveFromSchedule(schedule, p.isLive),
        vendorOperating:
          p.vendorIsLive === "true" && p.acceptingOrders !== "false",
        // Live-listing rows are marketplace-available by construction.
        orderable: true,
      };
    })
    .filter((p) => p.isLive);

  return { products: products as ProductListItem[], total: totalResult[0]?.count ?? products.length };
}

export async function fetchNewProducts(opts: {
  take: number;
  category?: string;
}): Promise<{ items: NewProductItem[]; total: number }> {
  const { take, category } = opts;

  const where: Prisma.ProductWhereInput = { archived: false, isNew: true };
  if (category) where.category = category as any;

  const [items, total] = await Promise.all([
    prisma.product.findMany({
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
    prisma.product.count({ where }),
  ]);

  return {
    items: items.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      category: p.category as string,
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
function computeIsLiveFromSchedule(
  schedule:
    | { goLiveAt?: Date | string | null; takeDownAt?: Date | string | null; graceMinutes?: number | null }
    | null
    | undefined,
  defaultIsLive: boolean,
): boolean {
  if (!schedule) return defaultIsLive;

  const now = Date.now();
  const goLive = schedule.goLiveAt ? new Date(schedule.goLiveAt).getTime() : 0;
  const takeDown = schedule.takeDownAt ? new Date(schedule.takeDownAt).getTime() : 0;
  const grace = (schedule.graceMinutes ?? 0) * 60 * 1000;

  if (!goLive || !takeDown) return defaultIsLive;
  return now >= goLive && now <= takeDown + grace;
}

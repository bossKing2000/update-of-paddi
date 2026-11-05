import {
  redisProducts,
  redisNotifications,
  redisSearch,
  redisTotalViews,
  redisUsersSessions,
  ShopCartRedis,
} from "../lib/redis";
import { scanKeys } from "../lib/redisScan";
import { vendorDashboardCacheKey } from "./vendorOrderVisibility";
import { RedisClientType } from "redis";
import { logger } from "../lib/logger";
import { CACHE_KEYS } from "./redisCacheTiming";

/**
 * Where a cache-clear step failed. `database` is the Redis DB index that
 * failed (from the client's options); `scope` names the deletion step
 * ("fixed-keys", "vendor-page-sweep", or "pattern-sweep").
 */
export interface CacheClearFailure {
  database: string;
  scope: string;
}

/**
 * The outcome of a `clearProductCache` call. `ok` is true only if every
 * attempted deletion across every Redis instance succeeded.
 *
 * The helper NEVER throws: callers running post-commit must not fail because
 * the cache is down. Inspect `ok`/`failures` instead of catching — a
 * rejection would mean this contract itself broke.
 */
export interface CacheClearResult {
  ok: boolean;
  failures: CacheClearFailure[];
}

function dbLabel(client: RedisClientType): string {
  return String(client.options?.database ?? "unknown");
}

/**
 * The discovery cache namespaces whose RESULTS depend on which products are
 * visible, and on tag membership (a tag filter selects products by tag).
 *
 * Shared so the discovery sweep and the tag sweep cannot drift apart.
 *
 * `search:` and `suggestions:` are written to the **redisSearch** instance
 * (productController.ts writes them via `redisSearch.set`), while the rest are
 * written to redisProducts. A sweep that must reach every one of them has to
 * run against BOTH instances.
 */
export const MARKETPLACE_DISCOVERY_CACHE_PATTERNS = [
  "home:feed:*",
  "products:mostPopular:*",
  "products:all:*",
  "products:new:*",
  "products:category:*",
  "search:*",
  "suggestions:*",
] as const;

/**
 * The product-detail cache keys for one product.
 *
 * Exported so any invalidation path that must drop a product's cached payload
 * deletes exactly the keys the writers use, rather than re-deriving them (a
 * re-derived list would silently drift and leave a stale payload behind).
 */
export const productDetailCacheKeys = (productId: string): string[] => [
  `product:${productId}:detail`,
  `product:${productId}`,
  `api:product:${productId}`,
  `api:/api/product/${productId}`,
];

/**
 * Deletes every key matching the given glob patterns.
 *
 * Unlike `scanAndDelete` (which matches PREFIXES, e.g. "search:"), this uses
 * SCAN's MATCH semantics, so a pattern may be a glob such as "search:*".
 *
 * FAILURE ISOLATION: a failure scanning or deleting one pattern must not
 * abandon the remaining patterns. Each pattern is therefore attempted
 * independently, and a failure is handed to `onError` (or re-thrown when no
 * handler is supplied, preserving the previous behaviour for callers that
 * wanted an exception).
 */
async function scanAndDeleteByPattern(
  client: RedisClientType,
  patterns: readonly string[],
  onError?: (err: unknown, pattern: string) => void,
): Promise<void> {
  for (const pattern of patterns) {
    try {
      const keys = await scanKeys(client, pattern);
      if (keys.length) await client.del(keys);
    } catch (err) {
      if (!onError) throw err;
      onError(err, pattern);
    }
  }
}

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
 * The cache namespaces whose CONTENT includes a product's `averageRating` /
 * `reviewCount` (or whose ORDERING depends on them).
 *
 * This is the B-5 set: a review write changes the product's rating, so every
 * cached copy of that rating — and every cached list whose order or content
 * depends on it — must be dropped, or a customer sees the old rating for
 * hours (the product-list TTL is five hours, the search TTL three).
 *
 * Per client, because the namespaces live in different logical databases:
 *   redisProducts : products:all:*, products:category:*, products:mostPopular:*,
 *                   products:new:*, home:feed:*
 *   redisSearch   : search:*
 *
 * `suggestions:*` is deliberately NOT here: a search suggestion carries
 * product/dish/category/tag NAMES, never a rating, so a review write cannot
 * make a suggestion stale. Sweeping it would be pure cost.
 */
export const PRODUCT_RATING_CACHE_PATTERNS = {
  redisProducts: [
    "products:all:*",
    "products:category:*",
    "products:mostPopular:*",
    "products:new:*",
    "home:feed:*",
  ],
  redisSearch: ["search:*"],
} as const;

/**
 * Drops every cached copy of one product's rating statistics.
 *
 * SCOPE (deliberately narrow — never a Redis flush):
 *   1. the product's own detail cache keys (exact keys, via the shared
 *      `productDetailCacheKeys` helper so this cannot drift from the
 *      writers);
 *   2. the rating-bearing catalog LIST namespaces (pattern sweep, SCAN-based
 *      so it never blocks Redis);
 *   3. the affected vendor's dashboard caches, because both embed rating
 *      aggregates:
 *      - `vendor:<id>:dashboardSummary:v2` carries `averageRating` and
 *        `reviewCount` (vendorDashboard.service.ts);
 *      - `vendor:<id>:products:page:<n>:limit=<n>` carries `averageRating`
 *        and `reviewCount` on every product card
 *        (vendorDashboard.service.ts getAllVendorProducts).
 *
 * NEVER THROWS, by the same contract as `clearProductCache`: the review row
 * is already committed, so a Redis outage must not turn a successful review
 * write into a failed HTTP response. The outcome is reported through the
 * returned result, and the caller logs it — a stale-until-TTL window is
 * never silent.
 */
export const invalidateProductRatingCaches = async (
  productId: string,
): Promise<CacheClearResult> => {
  const failures: CacheClearFailure[] = [];
  const fail = (err: unknown, client: RedisClientType, scope: string) => {
    failures.push({ database: dbLabel(client), scope });
    logger.warn(
      { err, database: dbLabel(client), scope, productId },
      "Product rating cache invalidation partially failed",
    );
  };

  try {
    const redisInstances: RedisClientType[] = [
      redisProducts,
      redisNotifications,
      redisSearch,
      redisTotalViews,
      redisUsersSessions,
      ShopCartRedis,
    ];

    // 1. The product's own detail payload — exact keys.
    const detailKeys = productDetailCacheKeys(productId);
    for (const client of redisInstances) {
      try {
        await client.del(detailKeys);
      } catch (err) {
        fail(err, client, "product-detail-keys");
      }
    }

    // 2. The rating-bearing list namespaces — pattern sweep.
    for (const [client, patterns] of [
      [redisProducts, PRODUCT_RATING_CACHE_PATTERNS.redisProducts],
      [redisSearch, PRODUCT_RATING_CACHE_PATTERNS.redisSearch],
    ] as Array<[RedisClientType, readonly string[]]>) {
      await scanAndDeleteByPattern(client, patterns, (err, pattern) =>
        fail(err, client, `pattern:${pattern}`),
      );
    }

    // 3. The affected vendor's dashboard caches. Both embed rating
    //    aggregates, so a review change must not leave them stale.
    //    Scoped to the affected vendor only — never a flush.
    try {
      const { default: prisma } = await import("../lib/prisma");
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { vendorId: true },
      });
      if (product?.vendorId) {
        // 3a. Dashboard summary — exact key via the shared builder so this
        //     cannot drift from the writer in vendorDashboard.service.ts.
        const dashboardKey = vendorDashboardCacheKey(product.vendorId);
        try {
          await redisProducts.del(dashboardKey);
        } catch (err) {
          fail(err, redisProducts, "dashboard-summary-key");
        }

        // 3b. Paginated vendor product list — SCAN sweep so it never blocks
        //     Redis, scoped to this vendor's page-cache pattern.
        try {
          await scanAndDelete(redisProducts, [
            `vendor:${product.vendorId}:products:page:`,
          ]);
        } catch (err) {
          fail(err, redisProducts, "vendor-page-sweep");
        }
      }
    } catch (err) {
      logger.warn({ err, productId }, "Could not resolve vendor id for dashboard cache invalidation");
      failures.push({ database: "database", scope: "vendor-lookup" });
    }

    return { ok: failures.length === 0, failures };
  } catch (err) {
    logger.warn(
      { err, productId },
      "Product rating cache invalidation failed unexpectedly",
    );
    return { ok: false, failures };
  }
};

/**
 * Clears cache for product details, vendor lists, global lists, and pattern-matched keys.
 *
 * Best-effort and non-throwing by contract: every Redis operation is
 * individually caught so one downed instance cannot block the others, and
 * the returned result — not an exception — tells the caller what failed.
 * Failures are logged here once with database + scope context via the
 * structured logger (previously console.warn, invisible to aggregators);
 * callers add their own domain context (product/order ids) when they
 * observe `ok === false`, so each layer logs what only it knows.
 */
export const clearProductCache = async (
  productId?: string,
  vendorId?: string
): Promise<CacheClearResult> => {
  const failures: CacheClearFailure[] = [];
  const fail = (err: unknown, client: RedisClientType, scope: string) => {
    failures.push({ database: dbLabel(client), scope });
    logger.warn(
      { err, database: dbLabel(client), scope, productId, vendorId },
      "Product cache invalidation partially failed",
    );
  };
  try {
    const keysToDelete: string[] = [];

    // ----- Product related keys -----
    if (productId) {
      keysToDelete.push(...productDetailCacheKeys(productId));
    }

    // ----- Vendor related keys -----
    if (vendorId) {
      keysToDelete.push(
      //   `vendor:${vendorId}:products`,
      //   `vendor:${vendorId}:products:available`,
      //   `vendor:${vendorId}:dashboardSummary`,
      //   `products:live`,
      //   // Order-related vendor caches
      //  `vendor:${vendorId}:orders`,
      //  `vendor:${vendorId}:orders:today`,
      //  `vendor:${vendorId}:orders:week`,
      //  `vendor:${vendorId}:analytics`,
      //  `vendor:${vendorId}:recentActivity`,
    `vendor:${vendorId}:products`,
    `vendor:${vendorId}:products:available`,
    // Built by the shared helper rather than hard-coded: the dashboard summary
    // key is versioned (`:v2`), and a literal here would silently stop
    // matching the writer in vendorDashboard.service.ts.
    vendorDashboardCacheKey(vendorId),
    `vendor:${vendorId}:orders`,
    `vendor:${vendorId}:orders:today`,
    `vendor:${vendorId}:orders:week`,
    `vendor:${vendorId}:analytics`,
    `vendor:${vendorId}:recentActivity`,
    `products:live`,

      );
        // Paginated vendor product lists
      try {
        await scanAndDelete(redisProducts, [
          `vendor:${vendorId}:products:page:`,
          `vendor:${vendorId}:orders:page:`,
        ]);
      } catch (err) {
        fail(err, redisProducts, "vendor-page-sweep");
      }
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
        try {
          await client.del(keysToDelete);
        } catch (err) {
          fail(err, client, "fixed-keys");
        }
      }
    }

    // ----- Pattern-based deletion -----
    // "suggestions:" covers the search-suggestion namespace
    // (suggestions:{query}, 30m TTL): suggestion entries carry product and
    // dish-type names, so any product mutation that reaches this helper
    // must sweep them alongside the other discovery namespaces.
    const patterns = [
      "products:",
      "category:",
      "search:",
      "suggestions:",
      "api:products:",
      "api:search:",
    ];

    for (const client of redisInstances) {
      try {
        await scanAndDelete(client, patterns);
      } catch (err) {
        fail(err, client, "pattern-sweep");
      }
    }

    console.log(
      `[CACHE] Cleared productId=${productId ?? "ALL"} vendorId=${vendorId ?? "ALL"}`
    );
    return { ok: failures.length === 0, failures };
  } catch (err) {
    // Practically unreachable (everything above is individually guarded),
    // but the never-throw contract must hold even here.
    logger.warn(
      { err, productId, vendorId },
      "Product cache invalidation failed unexpectedly",
    );
    return { ok: false, failures };
  }
};

/**
 * Drops the cached product-detail entries of ONE vendor's products.
 *
 * WHY THIS EXISTS
 * ---------------
 * A product-detail entry carries a CACHE-PRIVATE availability snapshot
 * (`__vendorAvailability`), and `getProductById` recomputes `vendorOperating`
 * / `orderable` from that snapshot when it serves a cache HIT
 * (src/controllers/productController.ts:605-619, 651-669). The snapshot is
 * captured when the entry is written, so an entry written while the vendor was
 * ACTIVE keeps reporting the vendor as operating after the account is
 * suspended — for the whole entry TTL (CACHE_TTLS.PRODUCT_DETAIL).
 *
 * `isVendorOperating` derives orderability from `vendor.isLive` and
 * `vendor.vendorStatus`, so an administrative status transition changes the
 * correct answer for every one of that vendor's products. This helper makes
 * the next read recompute it from the live vendor row.
 *
 * BOUNDS
 * ------
 * - Only the affected vendor's products are touched, and only their
 *   product-detail aliases. No other vendor's data is invalidated, and no
 *   discovery namespace is swept: this helper deletes EXACT keys.
 * - The key list comes from `productDetailCacheKeys` — the same list every
 *   writer and every invalidator uses — so the deleted set cannot drift from
 *   the written set.
 * - It NEVER throws. A cache outage must not fail the administrative write;
 *   inspect `ok` / `failures` instead.
 */
export const clearVendorProductDetailCaches = async (
  vendorId: string,
): Promise<CacheClearResult> => {
  const failures: CacheClearFailure[] = [];
  const fail = (err: unknown, client: RedisClientType, scope: string) => {
    failures.push({ database: dbLabel(client), scope });
    logger.warn(
      { err, vendorId, scope },
      "Vendor product-detail cache invalidation partially failed",
    );
  };
  try {
    const { prisma } = await import("../lib/prisma");
    const products = await prisma.product.findMany({
      where: { vendorId },
      select: { id: true },
    });
    if (products.length === 0) return { ok: true, failures };

    const keysToDelete = products.flatMap((product) =>
      productDetailCacheKeys(product.id),
    );
    // The same instances `clearProductCache` targets, so a legacy writer on
    // any of them is cleared too.
    const redisInstances: RedisClientType[] = [
      redisProducts,
      redisNotifications,
      redisSearch,
      redisTotalViews,
      redisUsersSessions,
      ShopCartRedis,
    ];
    for (const client of redisInstances) {
      try {
        await client.del(keysToDelete);
      } catch (err) {
        fail(err, client, "product-detail-keys");
      }
    }

    console.log(
      `[CACHE] Cleared product-detail entries for vendorId=${vendorId} (${products.length} product(s))`,
    );
    return { ok: failures.length === 0, failures };
  } catch (err) {
    logger.warn(
      { err, vendorId },
      "Vendor product-detail cache invalidation failed unexpectedly",
    );
    return { ok: false, failures };
  }
};

/**
 * Invalidates every marketplace-DISCOVERY cache that depends on vendor
 * operating state or product schedule state. Used by the vendor-live toggle
 * and by schedule mutations. (Cart/checkout/payment never trust caches, so
 * only discovery surfaces need this sweep.)
 *
 * Phase 2 M4: covers every discovery namespace whose rows carry
 * vendor-eligibility or orderability state — the new rail, category pages,
 * search pages and suggestions alongside the original three. Product detail
 * keys are intentionally excluded: getProductById recomputes availability
 * on every cache hit, and suspend/admin flows force isLive=false, which
 * that recompute observes.
 *
 * WHICH REDIS INSTANCES. The seven namespaces are NOT all held by the same
 * client, and the previous version of this helper swept only `redisProducts`:
 *
 *   redisProducts : products:all:*, products:new:*, products:mostPopular:*,
 *                    products:category:*, home:feed:*
 *   redisSearch   : search:*, suggestions:*
 *
 * `search:*` and `suggestions:*` are written to the **redisSearch** instance
 * (productController.ts writes them with `redisSearch.set`), so a sweep of
 * redisProducts alone never reached them and those two namespaces stayed stale
 * for their full TTL (3 h and 30 m) after a vendor-live, promotion, schedule
 * or taxonomy change. Both clients are swept here.
 *
 * NEVER THROWS, by the same contract as `clearProductCache` / `clearTagCache`:
 * a Redis outage must not turn a committed database mutation into a failed
 * HTTP response. Failures are returned in the result and logged with
 * database + pattern context. Callers that treat invalidation as best-effort
 * (promotions) keep that policy; callers that previously let the exception
 * escape now see a reported failure instead.
 */
export const invalidateMarketplaceDiscoveryCaches = async (): Promise<CacheClearResult> => {
  const failures: CacheClearFailure[] = [];
  const fail = (err: unknown, client: RedisClientType, scope: string) => {
    failures.push({ database: dbLabel(client), scope });
    logger.warn(
      { err, database: dbLabel(client), scope },
      "Discovery cache invalidation partially failed",
    );
  };

  // Every pattern is attempted on every client: a failure on one pattern must
  // not abandon the remaining patterns, and a failure on one client must not
  // abandon the other client.
  for (const client of [redisProducts, redisSearch]) {
    await scanAndDeleteByPattern(client, MARKETPLACE_DISCOVERY_CACHE_PATTERNS, (err, pattern) =>
      fail(err, client, `pattern:${pattern}`),
    );
  }

  return { ok: failures.length === 0, failures };
};

/**
 * Phase 2B.6 — invalidates every cache whose CONTENT depends on a Tag.
 *
 * A tag mutation changes three things, and before this helper none of the
 * tag-specific ones were covered:
 *
 *   1. THE TAG LIST ITSELF — `tags:all`, read and written by
 *      GET /api/product/tags (catalogController.ts) with a 60-minute TTL. The
 *      discovery sweep does not include that namespace, so a renamed or
 *      deactivated tag kept being served until the TTL expired.
 *   2. PRODUCT PAYLOADS THAT EMBED TAG OBJECTS — `updateProduct` writes
 *      `product:{id}:detail` from a re-read that includes
 *      `tags: { include: { tag: true } }` (productController.ts), so a cached
 *      detail payload can carry a stale tag name for the 5-hour
 *      PRODUCT_DETAIL TTL. The discovery sweep deliberately excludes
 *      product-detail keys.
 *   3. THE DISCOVERY NAMESPACES THAT FILTER BY TAG — a deactivated tag
 *      changes which products match a tag filter, so browse, category pages,
 *      most-popular, new and the home feed must be re-read.
 *
 * `search:*` and `suggestions:*` are swept against **redisSearch as well as
 * redisProducts**, because those keys are written to the redisSearch instance
 * and the discovery sweep only scans redisProducts.
 *
 * NEVER THROWS, by the same contract as `clearProductCache`: a Redis outage
 * must not turn a committed database mutation into a failed API response. The
 * failures are returned in the result and logged with database + scope + tag
 * context. When a deletion fails the affected entry stays stale until its TTL
 * expires; the database row itself is already correct.
 */
export const clearTagCache = async (tagId: string): Promise<CacheClearResult> => {
  const failures: CacheClearFailure[] = [];
  const fail = (err: unknown, client: RedisClientType, scope: string) => {
    failures.push({ database: dbLabel(client), scope });
    logger.warn(
      { err, database: dbLabel(client), scope, tagId },
      "Tag cache invalidation partially failed",
    );
  };

  const redisInstances = [
    redisProducts,
    redisNotifications,
    redisSearch,
    redisTotalViews,
    redisUsersSessions,
    ShopCartRedis,
  ];

  try {
    // 1. The tag list itself.
    for (const client of redisInstances) {
      try {
        await client.del([CACHE_KEYS.TAGS_ALL]);
      } catch (err) {
        fail(err, client, "tag-list");
      }
    }

    // 2. Namespaces whose results depend on tag membership or tag names.
    //    A failure on one pattern must not abandon the remaining patterns for
    //    that client, and the failure record names the pattern that failed.
    for (const client of [redisProducts, redisSearch]) {
      try {
        await scanAndDeleteByPattern(
          client,
          MARKETPLACE_DISCOVERY_CACHE_PATTERNS,
          (err, pattern) => fail(err, client, `pattern:${pattern}`),
        );
      } catch (err) {
        // Safety net: only reachable if the failure reporter itself throws.
        fail(err, client, "pattern-sweep");
      }
    }

    // 3. Product-detail payloads that embed tag objects.
    let productIds: string[] = [];
    try {
      const { prisma } = await import("../lib/prisma");
      const rows = await prisma.productTag.findMany({
        where: { tagId },
        select: { productId: true },
      });
      productIds = rows.map((r) => r.productId);
    } catch (err) {
      logger.warn({ err, tagId }, "Could not list products for tag cache invalidation");
      failures.push({ database: "database", scope: "product-lookup" });
    }
    if (productIds.length) {
      const detailKeys = productIds.flatMap((id) => productDetailCacheKeys(id));
      for (const client of redisInstances) {
        try {
          await client.del(detailKeys);
        } catch (err) {
          fail(err, client, "product-detail-keys");
        }
      }
    }

    return { ok: failures.length === 0, failures };
  } catch (err) {
    logger.warn({ err, tagId }, "Tag cache invalidation failed unexpectedly");
    return { ok: false, failures };
  }
};

/**
 * Phase 2B.6a: Invalidate caches when a Category changes.
 * Call this when a Category's name, slug, icon, sortOrder, or isActive changes.
 */
export const clearCategoryCache = async (categoryId?: string): Promise<void> => {
  try {
    const keysToDelete: string[] = [];

    // Category-specific keys
    if (categoryId) {
      keysToDelete.push(`category:${categoryId}`, `category:${categoryId}:detail`);
    }

    // Global category caches
    keysToDelete.push("categories:all", "categories:active", "categories:all");

    // Products in this category need cache refresh
    if (categoryId) {
      const { prisma } = await import("../lib/prisma");
      const productIds = await prisma.product.findMany({
        where: { categoryId },
        select: { id: true },
      });
      for (const p of productIds) {
        await clearProductCache(p.id);
      }
    }

    // Global product caches
    keysToDelete.push("products:all", "products:featured", "products:live");

    // Search cache
    const redisInstances = [redisProducts, redisSearch];
    for (const client of [redisProducts, redisSearch]) {
      await scanAndDelete(client, ["products:", "category:", "search:", "api:products:", "api:search:"]).catch((err) => {
        console.warn(`[CACHE] Category clear scanAndDelete failed on DB ${client.options?.database ?? "unknown"}:`, err);
      });
    }

    for (const client of [redisProducts, redisSearch, redisNotifications, redisTotalViews, redisUsersSessions, ShopCartRedis]) {
      if (keysToDelete.length > 0) {
        await client.del(keysToDelete).catch((err) => {
          console.warn(`[CACHE] Category clear del failed on DB ${client.options?.database ?? "unknown"}:`, err);
        });
      }
    }

    console.log(`[CACHE] Cleared categoryId=${categoryId ?? "ALL"}`);
  } catch (err) {
    console.error("[CACHE] Category cache clear error:", err);
  }
};

/**
 * Phase 2B.6a: Invalidate caches when a DishType changes.
 * Call this when a DishType's name, description, imageUrl, sortOrder, isActive,
 * or most importantly categoryId changes.
 */
export const clearDishTypeCache = async (dishTypeId?: string): Promise<void> => {
  try {
    const keysToDelete: string[] = [];

    // DishType-specific keys
    if (dishTypeId) {
      keysToDelete.push(`dishType:${dishTypeId}`, `dishType:${dishTypeId}:detail`);
    }

    // Global dishType caches
    keysToDelete.push("dishTypes:all", "dishTypes:active", "dishtypes:all");

    // Products using this DishType need cache refresh
    if (dishTypeId) {
      const { prisma } = await import("../lib/prisma");
      const productIds = await prisma.product.findMany({
        where: { dishTypeId },
        select: { id: true },
      });
      for (const p of productIds) {
        await clearProductCache(p.id);
      }
    }

    // Global product caches
    keysToDelete.push("products:all", "products:featured", "products:live");

    // Search cache
    const redisInstances = [redisProducts, redisSearch];
    for (const client of [redisProducts, redisSearch]) {
      await scanAndDelete(client, ["products:", "dishType:", "search:", "api:products:", "api:search:"]).catch((err) => {
        console.warn(`[CACHE] DishType clear scanAndDelete failed on DB ${client.options?.database ?? "unknown"}:`, err);
      });
    }

    for (const client of [redisProducts, redisSearch, redisNotifications, redisTotalViews, redisUsersSessions, ShopCartRedis]) {
      if (keysToDelete.length > 0) {
        await client.del(keysToDelete).catch((err) => {
          console.warn(`[CACHE] DishType clear del failed on DB ${client.options?.database ?? "unknown"}:`, err);
        });
      }
    }

    console.log(`[CACHE] Cleared dishTypeId=${dishTypeId ?? "ALL"}`);
  } catch (err) {
    console.error("[CACHE] DishType cache clear error:", err);
  }
};

/**
 * Phase 2B.6a: Invalidate all Products using a specific DishType when its categoryId changes.
 * This should be called after a DishType's categoryId is changed.
 */
export const invalidateProductsByDishTypeCategoryChange = async (dishTypeId: string): Promise<void> => {
  try {
    const { prisma } = await import("../lib/prisma");
    const productIds = await prisma.product.findMany({
      where: { dishTypeId },
      select: { id: true },
    });

    for (const p of productIds) {
      await clearProductCache(p.id);
    }

    // Also clear search cache since categoryId affects search results
    await scanAndDelete(redisProducts, ["products:", "search:", "api:products:", "api:search:"]).catch((err) => {
      console.warn(`[CACHE] Product-by-DishType scanAndDelete failed:`, err);
    });
    await scanAndDelete(redisSearch, ["products:", "search:", "api:products:", "api:search:"]).catch((err) => {
      console.warn(`[CACHE] Search scanAndDelete failed:`, err);
    });

    console.log(`[CACHE] Invalidated ${productIds.length} products for dishTypeId=${dishTypeId} category change`);
  } catch (err) {
    console.error("[CACHE] Invalidate products by dishType category change error:", err);
  }
};

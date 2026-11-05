import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { redisProducts, redisSearch, redisTotalViews, ShopCartRedis } from "../lib/redis";
import { scanKeys } from "../lib/redisScan";
import { CACHE_KEYS, CACHE_TTLS } from "./redisCacheTiming";
import {
  isVendorOperating,
  isProductCurrentlyAvailable,
} from "./vendorAvailability.service";
import {
  toPublicVendor,
  type PublicVendor,
} from "./publicVendor.service";
import { invalidateProductRatingCaches } from "./clearCaches";
import { logger } from "../lib/logger";
import type { EffectivePromotion } from "./promotionPricing.service";

// Catalog sort values accepted by GET /api/product?sortBy=…
// "popularity" ranks by popularityScore; the rest map to stored fields.
// Omitted/empty sortBy preserves the historical live-first browse order.
export const CATALOG_SORT_VALUES = [
  "popularity",
  "priceAsc",
  "priceDesc",
  "newest",
  "rating",
] as const;
export type CatalogSortValue = (typeof CATALOG_SORT_VALUES)[number];

export interface WhatsInThePotItem {
  dishType: { id: string; name: string; description: string | null; imageUrl: string | null };
  /** Currently orderable products of this dish type (dynamic — never hardcoded). */
  count: number;
}

export interface PopularDishType {
  id: string;
  name: string;
}

/**
 * "What's in the Pot?" — dish types that have at least one orderable
 * product RIGHT NOW (not archived + vendor live + accepting + in stock).
 * Ranked by count desc. A dish with nothing orderable never appears.
 */
export async function fetchWhatsInThePot(): Promise<WhatsInThePotItem[]> {
  try {
    const cached = await redisProducts.get(CACHE_KEYS.WHATS_IN_THE_POT);
    if (cached) return JSON.parse(cached) as WhatsInThePotItem[];
  } catch {
    // Cache is best-effort; fall through to the database.
  }

  const groups = await prisma.product.groupBy({
    by: ["dishTypeId"],
    where: {
      archived: false,
      vendor: vendorOperatingWhere,
      OR: [{ trackInventory: false }, { stock: { gt: 0 } }],
    },
    _count: { _all: true },
  });

  const counts = new Map(groups.map((g) => [g.dishTypeId, g._count._all]));
  const items = (await getActiveDishTypes())
    .filter((d) => (counts.get(d.id) ?? 0) > 0)
    .map((d) => ({
      dishType: { id: d.id, name: d.name, description: d.description, imageUrl: d.imageUrl },
      count: counts.get(d.id) ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.dishType.name.localeCompare(b.dishType.name));

  try {
    await redisProducts.set(CACHE_KEYS.WHATS_IN_THE_POT, JSON.stringify(items), {
      EX: CACHE_TTLS.WHATS_IN_THE_POT,
    });
  } catch {
    // Best-effort.
  }
  return items;
}

/**
 * Fetches the top 3 most popular dish types based on the count of
 * currently-orderable popular products (by popularityScore).
 * This determines the Popular Picks tabs on the Home screen.
 *
 * Ranking rule:
 * 1. Consider only currently-orderable products (not archived, vendor live,
 *    accepting orders, in stock if tracked).
 * 2. Rank by product popularityScore descending (same as fetchMostPopularProducts).
 * 3. Aggregate at dish-type level: each product contributes 1 count to its dish type.
 * 4. Return top 3 dish types by total count.
 * 5. If fewer than 3 eligible dish types exist, return all available.
 * 6. If none exist, return empty list.
 */
export async function fetchPopularDishTypes(): Promise<PopularDishType[]> {
  const where: Prisma.ProductWhereInput = {
    archived: false,
    vendor: vendorOperatingWhere,
    OR: [{ trackInventory: false }, { stock: { gt: 0 } }],
  };

  // Get a larger set of popular products to aggregate at dish-type level
  const products = await prisma.product.findMany({
    where,
    orderBy: { popularityScore: "desc" },
    take: 100,
    select: {
      dishTypeId: true,
      dishType: { select: { id: true, name: true } },
    },
  });

  // Aggregate by dish type
  const counts = new Map<string, { count: number; name: string }>();
  for (const p of products) {
    if (!p.dishType) continue;
    const existing = counts.get(p.dishTypeId);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(p.dishTypeId, { count: 1, name: p.dishType.name });
    }
  }

  // Sort by count desc, then by name for determinism
  const sorted = Array.from(counts.entries())
    .map(([id, { count, name }]) => ({ id, name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(({ id, name }) => ({ id, name }));

  return sorted;
}

/**
 * Recomputes a product's denormalized rating stats from its reviews.
 * Called after every product-review create/update/delete so the stored
 * `averageRating`/`reviewCount` columns stay truthful for ranking and
 * `minRating` filtering. Fire-and-forget safe: throws are the caller's
 * choice (controllers await it so listings never serve stale stats).
 *
 * CACHE INVALIDATION (B-5)
 * -----------------------
 * The stored columns are not the only copy of a product's rating: the
 * product-detail cache and every catalog-list cache embed the same numbers,
 * and both live for hours. Refreshing the row therefore also drops the
 * cached copies, so a new review cannot leave a stale rating visible for
 * the remaining TTL.
 *
 * The invalidation is TARGETED (one product's detail keys plus the
 * rating-bearing list namespaces) — it never flushes Redis — and it NEVER
 * throws: a Redis outage must not turn a committed review write into a
 * failed HTTP response. A failed invalidation is reported through the
 * structured logger, so the stale-until-TTL window is never silent.
 */
export async function refreshProductRatingStats(productId: string): Promise<void> {
  const agg = await prisma.productReview.aggregate({
    where: { productId },
    _avg: { rating: true },
    _count: { _all: true },
  });
  await prisma.product.update({
    where: { id: productId },
    data: {
      averageRating: agg._avg.rating ?? 0,
      reviewCount: agg._count._all,
    },
  });

  const result = await invalidateProductRatingCaches(productId);
  if (!result.ok) {
    logger.warn(
      { productId, failures: result.failures },
      "Product rating cache invalidation partially failed — cached rating stats may stay stale until their TTL expires",
    );
  }
}


/**
 * Remove a product from all customer cart cache snapshots.
 *
 * Cart snapshots are written by `cartController` to `ShopCartRedis`
 * (logical DB 5) under `cart:user:<version>:<userId>`; the legacy
 * unversioned `cart:user:<id>` keys share the same `cart:user:` prefix.
 * Scanning any other Redis client (previously `redisProducts`) reads the
 * wrong logical database and leaves real cart snapshots stale.
 *
 * Only keys whose serialized snapshot actually contains the product id are
 * deleted, and no database cart row is touched. This is best-effort: a Redis
 * failure must never fail an already-completed catalog deletion, and the next
 * cart read rebuilds from PostgreSQL.
 */
export const clearProductFromCarts = async (productId: string): Promise<void> => {
  try {
    const cartKeys = await scanKeys(ShopCartRedis, "cart:user:*");
    const cartKeysToDelete: string[] = [];

    for (const key of cartKeys) {
      const value = await ShopCartRedis.get(key).catch(() => "");
      if (value && value.includes(productId)) {
        cartKeysToDelete.push(key);
      }
    }

    if (cartKeysToDelete.length > 0) {
      await ShopCartRedis.del(cartKeysToDelete);
      console.log(
        `[CACHE] Cleared ${cartKeysToDelete.length} cart caches containing product ${productId}`,
      );
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

export interface DishTypeListItem {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
}

export interface ProductListItem {
  id: string;
  name: string;
  price: number;
  dishType: { id: string; name: string };
  images: string[];
  popularityPercent: number;
  averageRating: number;
  reviewCount: number;
  /** How much food one unit represents (e.g. "Family Pack — serves 4–5"). */
  portionLabel: string | null;
  trackInventory: boolean;
  /** Remaining portions; null when inventory is not tracked. */
  stock: number | null;
  /** Tracked and zero remaining — visible but not orderable. */
  soldOut: boolean;
  /** Vendor is live on the marketplace AND accepting orders. */
  vendorOperating: boolean;
  /** Marketplace availability (vendor operating + not archived + stock). */
  orderable: boolean;
  /**
   * Public vendor identity ONLY (never a raw vendor row): the moderation
   * state and the internal delivery settings are deliberately absent, and
   * the vendor's operating state is exposed through `vendorOperating`
   * instead. See src/services/publicVendor.service.ts.
   */
  vendor: PublicVendor;
  /**
   * Effective automatic promotion resolved by the canonical promotion
   * resolver (promotionPricing.service). Attached as a post-pass by
   * controllers/feed via attachPromotions — never computed inline here so
   * every surface shares one implementation. Absent (undefined) when the
   * caller did not resolve promotions.
   */
  promotion?: EffectivePromotion | null;
}

/**
 * The row shape every product-card builder consumes.
 *
 * Deliberately permissive: the same mapper serves the Prisma list queries
 * and the raw-SQL search rows, whose column naming differs. Every field is
 * optional-tolerant so a partially populated row degrades to a safe default
 * instead of throwing inside a response path.
 */
export interface ProductCardRow {
  id: string;
  name: string;
  price: number;
  dishType?: { id: string; name: string } | null;
  thumbnail?: string | null;
  images?: string[] | null;
  popularityPercent?: number | null;
  averageRating?: number | null;
  reviewCount?: number | null;
  portionLabel?: string | null;
  trackInventory?: boolean | null;
  stock?: number | null;
  archived?: boolean | null;
  vendor?: {
    id?: string | null;
    name?: string | null;
    brandName?: string | null;
    brandLogo?: string | null;
    avatarUrl?: string | null;
    isLive?: boolean | null;
    vendorStatus?: string | null;
    deliveryPreferences?: unknown;
  } | null;
}

/**
 * THE canonical product-card mapper (B-1 / B-3).
 *
 * Browse, category browse, search, the home feed rails and the detail
 * endpoint all derive their customer-facing product fields from here, so the
 * same card renders identically wherever it is shown.
 *
 * Availability is computed from the canonical rules
 * (src/services/vendorAvailability.service.ts) — a client never re-derives
 * it — and the vendor is projected through the public projection, so no
 * internal vendor field can reach an anonymous caller.
 */
export function buildProductCard(row: ProductCardRow): ProductListItem {
  const vendor = row.vendor ?? {};
  const vendorOperating = isVendorOperating({
    isLive: vendor.isLive === true,
    vendorStatus: vendor.vendorStatus ?? null,
    deliveryPreferences: vendor.deliveryPreferences,
  });
  const orderable =
    vendorOperating &&
    isProductCurrentlyAvailable({
      archived: row.archived === true,
      trackInventory: row.trackInventory === true,
      stock: row.stock ?? null,
    });

  const images = Array.isArray(row.images) ? row.images : [];
  const trackInventory = row.trackInventory === true;

  return {
    id: row.id,
    name: row.name,
    price: row.price,
    dishType: row.dishType ?? { id: "", name: "" },
    // Card semantics: the thumbnail when there is one, otherwise the first
    // image. A customer-facing card shows one picture, not the whole gallery.
    images: row.thumbnail
      ? [row.thumbnail]
      : images.length > 0
        ? [images[0]]
        : [],
    popularityPercent: row.popularityPercent ?? 0,
    averageRating: row.averageRating ?? 0,
    reviewCount: row.reviewCount ?? 0,
    portionLabel: row.portionLabel ?? null,
    trackInventory,
    stock: trackInventory ? row.stock ?? null : null,
    soldOut: trackInventory && (row.stock ?? 0) <= 0,
    vendorOperating,
    orderable,
    vendor: toPublicVendor(vendor),
  };
}

/** Active dish types, cached briefly — vendors and discovery read this often. */
export async function getActiveDishTypes(): Promise<DishTypeListItem[]> {
  try {
    const cached = await redisProducts.get(CACHE_KEYS.DISH_TYPES_ALL);
    if (cached) return JSON.parse(cached) as DishTypeListItem[];
  } catch {
    // Cache is best-effort; fall through to the database.
  }

  const rows = await prisma.dishType.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, description: true, imageUrl: true, sortOrder: true },
  });
  try {
    await redisProducts.set(CACHE_KEYS.DISH_TYPES_ALL, JSON.stringify(rows), {
      EX: CACHE_TTLS.DISH_TYPES_ALL,
    });
  } catch {
    // Best-effort.
  }
  return rows;
}

/** Throws a ValidationError unless the id is an active dish type. */
export async function assertActiveDishType(dishTypeId: string): Promise<void> {
  const ids = new Set((await getActiveDishTypes()).map((d) => d.id));
  if (!ids.has(dishTypeId)) {
    const { ValidationError } = await import("../errors/AppError");
    throw new ValidationError(
      `Invalid dish type. Choose one of: ${[...ids].join(", ")}`,
    );
  }
}

export interface ProductPageResult {
  products: ProductListItem[];
  total: number;
}

// Marketplace discovery rule (Stage 1): a product is visible/orderable
// while it is not archived AND its vendor is live + accepting orders.
// `deliveryPreferences.acceptingOrders` defaults to "accepting" when the
// JSON is absent. All listings below express this via the Prisma
// `vendorOperatingWhere` filter — no raw SQL, no scheduling.

export async function fetchProductPage(opts: {
  skip: number;
  take: number;
  dishType?: string;
  vendorId?: string;
  /** Phase 2 M1: category-scoped browsing (server-resolved Category id). */
  categoryId?: string;
  /**
   * Phase 2 M2: optional tag filter (server-resolved active tag ids).
   * Any-match semantics: a product qualifies when it carries AT LEAST
   * ONE of the given tags. Empty/omitted = no tag filtering.
   */
  tagIds?: string[];
  /** Marketplace surfaces set this; plain browse (GET /product) does not. */
  vendorMustBeOperating?: boolean;
  /** Catalog sorting: popularity | priceAsc | priceDesc | newest | rating. */
  sortBy?: string;
  minPrice?: number;
  maxPrice?: number;
  /** Minimum stored average rating (0–5). */
  minRating?: number;
  /** Only currently-orderable marketplace products (authoritative rules). */
  availableOnly?: boolean;
}): Promise<ProductPageResult> {
  const {
    skip,
    take,
    dishType,
    vendorId,
    categoryId,
    tagIds,
    vendorMustBeOperating,
    sortBy,
    minPrice,
    maxPrice,
    minRating,
    availableOnly,
  } = opts;

  const where: Prisma.ProductWhereInput = { archived: false };
  if (dishType) where.dishTypeId = dishType;
  if (vendorId) where.vendorId = vendorId;
  if (categoryId) where.categoryId = categoryId;
  if (tagIds && tagIds.length > 0) {
    // Any-match over the canonical join table — no denormalized copy.
    where.tags = { some: { tagId: { in: tagIds } } };
  }
  if (opts.minPrice != null || opts.maxPrice != null) {
    where.price = {
      ...(opts.minPrice != null ? { gte: opts.minPrice } : {}),
      ...(opts.maxPrice != null ? { lte: opts.maxPrice } : {}),
    } as Prisma.FloatFilter;
  }
  if (minRating != null && minRating > 0) {
    where.averageRating = { gte: minRating };
  }
  if (vendorMustBeOperating || availableOnly) {
    where.vendor = {
      isLive: true,
      // Phase 1C: orderable listings require an ACTIVE vendor.
      vendorStatus: "ACTIVE",
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
  if (availableOnly) {
    // availableOnly means currently orderable: sold-out products are
    // excluded at query level (plain browse keeps them discoverable with
    // orderable=false so customers see alternatives).
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { OR: [{ trackInventory: false }, { stock: { gt: 0 } }] },
    ];
  }

  // Catalog sorting. Default (omitted sortBy) is newest-first.
  // Every branch ends with the unique id tiebreaker so offset pagination
  // is deterministic when primary keys tie (identical timestamps/scores).
  let orderBy: Prisma.ProductOrderByWithRelationInput[];
  switch (opts.sortBy) {
    case "popularity":
      orderBy = [{ popularityScore: "desc" }, { createdAt: "desc" }, { id: "asc" }];
      break;
    case "priceAsc":
      orderBy = [{ price: "asc" }, { createdAt: "desc" }, { id: "asc" }];
      break;
    case "priceDesc":
      orderBy = [{ price: "desc" }, { createdAt: "desc" }, { id: "asc" }];
      break;
    case "rating":
      orderBy = [{ averageRating: "desc" }, { reviewCount: "desc" }, { createdAt: "desc" }, { id: "asc" }];
      break;
    case "newest":
      orderBy = [{ createdAt: "desc" }, { id: "asc" }];
      break;
    default:
      orderBy = [{ createdAt: "desc" }, { id: "asc" }];
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
        dishType: { select: { id: true, name: true } },
        thumbnail: true,
        images: true,
        popularityPercent: true,
        averageRating: true,
        reviewCount: true,
        portionLabel: true,
        archived: true,
        trackInventory: true,
        stock: true,
        vendor: {
          // Public identity + the operating signals the availability rules
          // need. The vendor is projected through toPublicVendor before it
          // leaves the server, so the moderation state and the internal
          // delivery settings never reach an anonymous caller (B-1).
          select: {
            id: true,
            name: true,
            brandName: true,
            brandLogo: true,
            avatarUrl: true,
            isLive: true,
            vendorStatus: true,
            deliveryPreferences: true,
          },
        },
      },
    }),
    prisma.product.count({ where }),
  ]);

  // Availability: vendor operating + product available (not archived,
  // in stock). Exposed as `orderable` so discovery clients never
  // recompute availability locally.
  const products: ProductListItem[] = dbProducts.map((p) => buildProductCard(p));

  return { products, total };
}

const vendorOperatingWhere: Prisma.ProductWhereInput["vendor"] = {
  isLive: true,
  // Phase 1C: orderable listings require an ACTIVE vendor.
  vendorStatus: "ACTIVE",
  AND: [
    {
      OR: [
        { deliveryPreferences: { equals: Prisma.AnyNull } },
        { NOT: { deliveryPreferences: { path: ["acceptingOrders"], equals: false } } },
      ],
    },
  ],
};

const productListSelect = {
  id: true,
  name: true,
  price: true,
  dishType: { select: { id: true, name: true } },
  thumbnail: true,
  images: true,
  popularityPercent: true,
  averageRating: true,
  reviewCount: true,
  portionLabel: true,
  trackInventory: true,
  stock: true,
  archived: true,
  vendor: {
    // Public identity + the operating signals the availability rules need.
    // The row is projected through toPublicVendor before it is served (B-1).
    select: {
      id: true,
      name: true,
      brandName: true,
      brandLogo: true,
      avatarUrl: true,
      isLive: true,
      vendorStatus: true,
      deliveryPreferences: true,
    },
  },
} as const;

/**
 * Maps a selected product row onto the canonical product card.
 *
 * A thin wrapper over the shared `buildProductCard` mapper so the browse,
 * search and feed surfaces cannot drift apart.
 */
function toProductListItem(p: {
  id: string;
  name: string;
  price: number;
  dishType: { id: string; name: string };
  thumbnail: string | null;
  images: string[];
  popularityPercent: number;
  averageRating: number | null;
  reviewCount: number;
  portionLabel: string | null;
  archived: boolean;
  trackInventory: boolean;
  stock: number | null;
  vendor: {
    id: string;
    name: string;
    brandName: string | null;
    brandLogo: string | null;
    avatarUrl: string | null;
    isLive: boolean;
    vendorStatus: string | null;
    deliveryPreferences: unknown;
  };
}): ProductListItem {
  return buildProductCard(p);
}

export async function fetchMostPopularProducts(opts: {
  skip: number;
  take: number;
}): Promise<ProductPageResult> {
  const { skip, take } = opts;

  // Stage 1: most popular = highest popularityScore among currently-orderable
  // marketplace products (not archived + vendor live + accepting orders).
  const where: Prisma.ProductWhereInput = {
    archived: false,
    vendor: vendorOperatingWhere,
  };

  const [dbProducts, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      orderBy: [{ popularityScore: "desc" }, { id: "asc" }],
      select: productListSelect,
    }),
    prisma.product.count({ where }),
  ]);

  return { products: dbProducts.map(toProductListItem), total };
}

export interface NewProductItem {
  id: string;
  name: string;
  price: number;
  dishType: { id: string; name: string };
  images: string[];
  isNew: boolean;
  createdAt: Date;
  trackInventory: boolean;
  stock: number | null;
  archived: boolean;
  vendorOperating: boolean;
  orderable: boolean;
  /** Public vendor identity only (see publicVendor.service). */
  vendor: PublicVendor;
  /** Effective automatic promotion (see ProductListItem.promotion). */
  promotion?: EffectivePromotion | null;
}

// Currently-orderable marketplace listing behind the home feed's
// "liveProducts" section and GET /product/p/most-style discovery.
// Stage 1: orderable = not archived + vendor live + accepting orders.
// There is no schedule anymore, so every row returned is orderable by
// construction (vendorOperating/orderable are still exposed for clients).
export async function fetchLiveProducts(opts: {
  take: number;
  dishType?: string;
}): Promise<ProductPageResult> {
  const { take, dishType } = opts;

  const where: Prisma.ProductWhereInput = {
    archived: false,
    vendor: vendorOperatingWhere,
  };
  if (dishType) where.dishTypeId = dishType;

  const [dbProducts, total] = await Promise.all([
    prisma.product.findMany({
      where,
      take,
      orderBy: [{ popularityScore: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      select: productListSelect,
    }),
    prisma.product.count({ where }),
  ]);

  return { products: dbProducts.map(toProductListItem), total };
}

export async function fetchNewProducts(opts: {
  take: number;
  /** Offset for the paginated "new" rail (B-4). Defaults to 0. */
  skip?: number;
  dishType?: string;
}): Promise<{ items: NewProductItem[]; total: number }> {
  const { take, skip = 0, dishType } = opts;

  // Phase 2 M4: the "new" rail never shows ineligible vendors
  // ("listings are paused"). Status-only on purpose: a temporarily
  // offline ACTIVE vendor's new dishes stay discoverable with
  // orderable=false, matching browse semantics.
  const where: Prisma.ProductWhereInput = {
    archived: false,
    isNew: true,
    vendor: { vendorStatus: "ACTIVE" },
  };
  if (dishType) where.dishTypeId = dishType;

  const [dbProducts, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: {
        ...productListSelect,
        isNew: true,
        createdAt: true,
      },
    }),
    prisma.product.count({ where }),
  ]);

  const items = dbProducts.map((p) => {
    const base = toProductListItem(p);
    return {
      ...base,
      archived: p.archived,
      isNew: p.isNew,
      createdAt: p.createdAt,
    };
  });

  return { items, total };
}


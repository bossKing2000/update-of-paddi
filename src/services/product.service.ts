import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { redisProducts, redisSearch, redisTotalViews, ShopCartRedis } from "../lib/redis";
import { CACHE_KEYS, CACHE_TTLS } from "./redisCacheTiming";
import {
  isVendorOperating,
  isProductCurrentlyAvailable,
} from "./vendorAvailability.service";
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
 * Recomputes a product's denormalized rating stats from its reviews.
 * Called after every product-review create/update/delete so the stored
 * `averageRating`/`reviewCount` columns stay truthful for ranking and
 * `minRating` filtering. Fire-and-forget safe: throws are the caller's
 * choice (controllers await it so listings never serve stale stats).
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
  vendor: { id: string; name: string; brandName: string | null; avatarUrl: string | null };
  /**
   * Effective automatic promotion resolved by the canonical promotion
   * resolver (promotionPricing.service). Attached as a post-pass by
   * controllers/feed via attachPromotions — never computed inline here so
   * every surface shares one implementation. Absent (undefined) when the
   * caller did not resolve promotions.
   */
  promotion?: EffectivePromotion | null;
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
    case "rating":
      orderBy = [{ averageRating: "desc" }, { reviewCount: "desc" }, { createdAt: "desc" }];
      break;
    case "newest":
      orderBy = [{ createdAt: "desc" }];
      break;
    default:
      orderBy = [{ createdAt: "desc" }];
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
          select: {
            id: true,
            name: true,
            brandName: true,
            avatarUrl: true,
            isLive: true,
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
  const products: ProductListItem[] = dbProducts.map((p) => {
    const vendorOperating = isVendorOperating(p.vendor);
    const availability = {
      archived: p.archived,
      trackInventory: p.trackInventory,
      stock: p.stock,
    };
    const orderable =
      vendorOperating && isProductCurrentlyAvailable(availability);
    const soldOut =
      p.trackInventory === true && (p.stock ?? 0) <= 0;

    return {
      id: p.id,
      name: p.name,
      price: p.price,
      dishType: p.dishType,
      images: p.thumbnail ? [p.thumbnail] : p.images.length > 0 ? [p.images[0]] : [],
      popularityPercent: p.popularityPercent,
      averageRating: p.averageRating ?? 0,
      reviewCount: p.reviewCount,
      portionLabel: p.portionLabel,
      trackInventory: p.trackInventory,
      stock: p.trackInventory ? p.stock : null,
      soldOut,
      vendorOperating,
      orderable,
      vendor: p.vendor,
    };
  });

  return { products, total };
}

const vendorOperatingWhere: Prisma.ProductWhereInput["vendor"] = {
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

const productListSelect = {
  id: true,
  name: true,
  price: true,
  dishType: { select: { id: true, name: true } },
  thumbnail: true,
  images: true,
  popularityPercent: true,
  popularityScore: true,
  averageRating: true,
  reviewCount: true,
  portionLabel: true,
  trackInventory: true,
  stock: true,
  totalViews: true,
  archived: true,
  vendor: {
    select: {
      id: true,
      name: true,
      brandName: true,
      avatarUrl: true,
      isLive: true,
      deliveryPreferences: true,
    },
  },
} as const;

function toProductListItem(
  p: {
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
      avatarUrl: string | null;
      isLive: boolean;
      deliveryPreferences: unknown;
    };
  },
): ProductListItem {
  const vendorOperating = isVendorOperating(p.vendor);
  const orderable =
    vendorOperating &&
    isProductCurrentlyAvailable({
      archived: p.archived,
      trackInventory: p.trackInventory,
      stock: p.stock,
    });
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    dishType: p.dishType,
    images: p.thumbnail ? [p.thumbnail] : p.images.length > 0 ? [p.images[0]] : [],
    popularityPercent: p.popularityPercent,
    averageRating: p.averageRating ?? 0,
    reviewCount: p.reviewCount,
    portionLabel: p.portionLabel,
    trackInventory: p.trackInventory,
    stock: p.trackInventory ? p.stock : null,
    soldOut: p.trackInventory === true && (p.stock ?? 0) <= 0,
    vendorOperating,
    orderable,
    vendor: {
      id: p.vendor.id,
      name: p.vendor.name,
      brandName: p.vendor.brandName,
      avatarUrl: p.vendor.avatarUrl,
    },
  };
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
      orderBy: { popularityScore: "desc" },
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
  vendor: { id: string; name: string; brandName: string | null; avatarUrl: string | null };
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
      orderBy: [{ popularityScore: "desc" }, { createdAt: "desc" }],
      select: productListSelect,
    }),
    prisma.product.count({ where }),
  ]);

  return { products: dbProducts.map(toProductListItem), total };
}

export async function fetchNewProducts(opts: {
  take: number;
  dishType?: string;
}): Promise<{ items: NewProductItem[]; total: number }> {
  const { take, dishType } = opts;

  const where: Prisma.ProductWhereInput = { archived: false, isNew: true };
  if (dishType) where.dishTypeId = dishType;

const [dbProducts, total] = await Promise.all([
    prisma.product.findMany({
      where,
      take,
      orderBy: { createdAt: "desc" },
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


import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { redisProducts, redisSearch, redisTotalViews, ShopCartRedis } from "../lib/redis";
import { CACHE_KEYS } from "./redisCacheTiming";
import {
  isVendorOperating,
} from "./vendorAvailability.service";

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
  /** Vendor is live on the marketplace AND accepting orders. */
  vendorOperating?: boolean;
  /** Marketplace availability (Stage 1: vendor operating + not archived). */
  orderable?: boolean;
  vendor: { id: string; name: string; brandName: string | null; avatarUrl: string | null };
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

  const where: Prisma.ProductWhereInput = { archived: false };
  if (category) where.category = category as Prisma.EnumCategoryFilter;
  if (vendorId) where.vendorId = vendorId;
  if (opts.minPrice != null || opts.maxPrice != null) {
    where.price = {
      ...(opts.minPrice != null ? { gte: opts.minPrice } : {}),
      ...(opts.maxPrice != null ? { lte: opts.maxPrice } : {}),
    } as Prisma.FloatFilter;
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
        category: true,
        thumbnail: true,
        images: true,
        popularityPercent: true,
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
      },
    }),
    prisma.product.count({ where }),
  ]);

  // Stage 1 availability: vendor operating + not archived (no scheduling,
  // no stock yet). Exposed as `orderable` so discovery clients never
  // recompute availability locally.
  const products: ProductListItem[] = dbProducts.map((p) => {
    const vendorOperating = isVendorOperating(p.vendor);
    const orderable = !p.archived && vendorOperating;

    return {
      id: p.id,
      name: p.name,
      price: p.price,
      category: p.category as string,
      images: p.thumbnail ? [p.thumbnail] : p.images.length > 0 ? [p.images[0]] : [],
      popularityPercent: p.popularityPercent,
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
  category: true,
  thumbnail: true,
  images: true,
  popularityPercent: true,
  popularityScore: true,
  averageRating: true,
  reviewCount: true,
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
    category: unknown;
    thumbnail: string | null;
    images: string[];
    popularityPercent: number;
    archived: boolean;
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
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    category: p.category as string,
    images: p.thumbnail ? [p.thumbnail] : p.images.length > 0 ? [p.images[0]] : [],
    popularityPercent: p.popularityPercent,
    vendorOperating,
    orderable: !p.archived && vendorOperating,
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
  category: string;
  images: string[];
  isNew: boolean;
  createdAt: Date;
  vendor: { id: string; name: string; brandName: string | null; avatarUrl: string | null };
}

// Currently-orderable marketplace listing behind the home feed's
// "liveProducts" section and GET /product/p/most-style discovery.
// Stage 1: orderable = not archived + vendor live + accepting orders.
// There is no schedule anymore, so every row returned is orderable by
// construction (vendorOperating/orderable are still exposed for clients).
export async function fetchLiveProducts(opts: {
  take: number;
  category?: string;
}): Promise<ProductPageResult> {
  const { take, category } = opts;

  const where: Prisma.ProductWhereInput = {
    archived: false,
    vendor: vendorOperatingWhere,
  };
  if (category) where.category = category as Prisma.EnumCategoryFilter;

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
      vendor: p.vendor,
    })),
    total,
  };
}

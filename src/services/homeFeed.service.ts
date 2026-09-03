import { Category } from "@prisma/client";
import prisma from "../lib/prisma";
import { redisProducts } from "../lib/redis";
import { CACHE_KEYS, CACHE_TTLS } from "./redisCacheTiming";
import {
  fetchMostPopularProducts,
  fetchNewProducts,
  fetchProductPage,
  fetchLiveProducts,
} from "./product.service";
import { findNearbyVendors } from "../controllers/vendorControllerMapping";
import { getActivePromotionsForCustomer } from "./promoService";
import { logger } from "../lib/logger";
import { ValidationError } from "../errors/AppError";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/home/feed — composed homepage feed (Phase 3A)
//
// Thin composition layer: every section delegates to the same query logic
// the individual endpoints use (product listing, most-popular, nearby
// vendors, active promotions). Sections run in parallel and fail in
// isolation — one failing section degrades to an empty/flagged value while
// the rest of the feed still renders. The whole payload is cached briefly
// under an isolated `home:feed:*` namespace.
// ─────────────────────────────────────────────────────────────────────────────

export const HOME_FEED_DEFAULT_LIMIT = 20;
export const HOME_FEED_MAX_LIMIT = 50;

export interface HomeFeedViewer {
  id: string;
  role: string;
}

export interface NormalizedHomeFeedQuery {
  lat: number | null;
  lng: number | null;
  category: string; // "ALL" or a valid Category enum value
  limit: number;
}

/**
 * Parses/clamps raw query values. Coordinate problems are handled
 * gracefully (treated as "no location") because location only enhances the
 * feed. An invalid category throws — mirroring GET /product, where an
 * unknown category is a client error rather than silently-empty data.
 */
export function parseHomeFeedQuery(raw: {
  lat?: unknown;
  lng?: unknown;
  category?: unknown;
  limit?: unknown;
}): NormalizedHomeFeedQuery {
  // Limit: clamp instead of reject — consistent with GET /product.
  const parsedLimit = parseInt(String(raw.limit ?? ""), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), HOME_FEED_MAX_LIMIT)
    : HOME_FEED_DEFAULT_LIMIT;

  // Coordinates: valid only when BOTH are supplied and in range.
  const lat = raw.lat != null && String(raw.lat).trim() !== "" ? Number(raw.lat) : NaN;
  const lng = raw.lng != null && String(raw.lng).trim() !== "" ? Number(raw.lng) : NaN;
  const coordsValid =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  let category = "ALL";
  if (raw.category != null && String(raw.category).trim() !== "") {
    const candidate = String(raw.category).toUpperCase();
    if (candidate === "ALL") {
      category = "ALL";
    } else if (Object.values(Category).includes(candidate as Category)) {
      category = candidate;
    } else {
      throw new ValidationError(
        `Invalid category. Valid options: ${Object.values(Category).join(", ")}`,
      );
    }
  }

  return {
    lat: coordsValid ? roundCoord(lat) : null,
    lng: coordsValid ? roundCoord(lng) : null,
    category,
    limit,
  };
}

/** Round to 3 decimals (~110m) so GPS jitter doesn't explode the key space. */
export function roundCoord(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function buildHomeFeedCacheKey(opts: {
  viewer: HomeFeedViewer | null;
  query: NormalizedHomeFeedQuery;
}): string {
  const scope = opts.viewer ? `role:${opts.viewer.role}` : "anon";
  return CACHE_KEYS.HOME_FEED(
    scope,
    opts.viewer ? opts.viewer.id : "anon",
    opts.query.lat,
    opts.query.lng,
    opts.query.category,
    opts.query.limit,
  );
}

/**
 * Runs one feed section in isolation. A rejected section logs a warning and
 * resolves to its fallback so a single failing query can never turn the
 * whole homepage into a 500.
 */
async function safeSection<T>(
  name: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(
      { section: name, err: err instanceof Error ? err.message : String(err) },
      "home feed section failed",
    );
    return fallback;
  }
}

export async function getHomeFeed(viewer: HomeFeedViewer | null, query: NormalizedHomeFeedQuery) {
  const cacheKey = buildHomeFeedCacheKey({ viewer, query });

  // Cache failures must not take the feed down — degrade to no-cache.
  try {
    const cached = await redisProducts.get(cacheKey);
    if (cached) {
      return { payload: JSON.parse(cached), cache: "HIT" as const };
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "home feed cache read failed",
    );
  }

  const isAuthenticated = viewer != null;

  // All sections are independent — fan out in parallel with per-section
  // fault isolation.
  const [
    categories,
    popularResult,
    liveResult,
    newProducts,
    catalogResult,
    vendors,
    promotions,
    unreadNotifications,
  ] = await Promise.all([
    safeSection("categories", async () => {
      const cachedCategories = await redisProducts.get(CACHE_KEYS.CATEGORIES_ALL);
      if (cachedCategories) return JSON.parse(cachedCategories) as string[];
      return Object.values(Category) as string[];
    }, [] as string[]),

    safeSection(
      "popularProducts",
      () => fetchMostPopularProducts({ skip: 0, take: query.limit }),
      { products: [], total: 0 },
    ),

    // Currently-orderable marketplace dishes (not archived + vendor live
    // + accepting orders). Popular section above keeps the existing
    // /product/p/most semantics.
    safeSection(
      "liveProducts",
      () =>
        fetchLiveProducts({
          take: Math.min(query.limit, 12),
          category: query.category !== "ALL" ? query.category : undefined,
        }),
      { products: [], total: 0 },
    ),

    safeSection(
      "newProducts",
      () =>
        fetchNewProducts({
          take: query.limit,
          category: query.category !== "ALL" ? query.category : undefined,
        }),
      { items: [], total: 0 },
    ),

    safeSection(
      "catalog",
      () =>
        fetchProductPage({
          skip: 0,
          take: Math.min(query.limit, 20),
          category: query.category !== "ALL" ? query.category : undefined,
          // Marketplace discovery surface: only vendors currently operating.
          // Plain GET /product keeps browse semantics (viewable offline).
          vendorMustBeOperating: true,
        }),
      { products: [], total: 0 },
    ),

    // Reuses the exact nearby-vendor implementation behind
    // GET /api/auth/nearby — same shapes (brandName/brandLogo/distanceKm/
    // isOpen/averageRating/reviewCount), nothing invented.
    query.lat != null && query.lng != null
      ? safeSection("nearbyVendors", () => findNearbyVendors(query.lat!, query.lng!, 5), [])
      : Promise.resolve([]),

    isAuthenticated && viewer!.role === "CUSTOMER"
      ? safeSection(
          "promotions",
          () => getActivePromotionsForCustomer(viewer!.id),
          [],
        )
      : Promise.resolve([]),

    isAuthenticated
      ? safeSection(
          "unreadNotifications",
          () =>
            prisma.notification.count({
              where: { userId: viewer!.id, read: false },
            }),
          0,
        )
      : Promise.resolve(0),
  ]);

  // Live products are the currently-orderable marketplace dishes
  // (Stage 1: no scheduling). Popular products keep the exact
  // GET /product/p/most semantics.

  const payload = {
    generatedAt: new Date().toISOString(),

    categories,

    liveProducts: {
      items: liveResult.products,
      total: liveResult.total,
    },

    popularProducts: popularResult.products,

    newProducts: {
      items: newProducts.items,
      total: newProducts.total,
    },

    catalog: {
      items: catalogResult.products,
      total: catalogResult.total,
    },

    nearbyVendors: {
      items: vendors,
      total: Array.isArray(vendors) ? vendors.length : 0,
      hasLocation: query.lat != null && query.lng != null,
    },

    promotions: {
      items: promotions,
      total: Array.isArray(promotions) ? promotions.length : 0,
    },

    unreadNotifications,
  };

  try {
    await redisProducts.set(cacheKey, JSON.stringify(payload), {
      EX: CACHE_TTLS.HOME_FEED,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "home feed cache write failed",
    );
  }

  return { payload, cache: "MISS" as const };
}

import prisma from "../lib/prisma";
import { redisProducts } from "../lib/redis";
import { CACHE_KEYS, CACHE_TTLS } from "./redisCacheTiming";
import {
  fetchMostPopularProducts,
  fetchNewProducts,
  fetchProductPage,
  fetchLiveProducts,
  fetchWhatsInThePot,
  getActiveDishTypes,
  assertActiveDishType,
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
  dishType: string; // "ALL" or an active DishType id (e.g. "JOLLOF")
  limit: number;
}

/**
 * Parses/clamps raw query values. Coordinate problems are handled
 * gracefully (treated as "no location") because location only enhances the
 * feed. An invalid dishType throws — mirroring GET /product, where an
 * unknown dish type is a client error rather than silently-empty data.
 * Dish-type existence is verified against the cached active list.
 */
export async function parseHomeFeedQuery(raw: {
  lat?: unknown;
  lng?: unknown;
  dishType?: unknown;
  category?: unknown; // legacy meal-time param — ignored
  limit?: unknown;
}): Promise<NormalizedHomeFeedQuery> {
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

  let dishType = "ALL";
  if (raw.dishType != null && String(raw.dishType).trim() !== "") {
    const candidate = String(raw.dishType).trim().toUpperCase();
    if (candidate === "ALL") {
      dishType = "ALL";
    } else {
      await assertActiveDishType(candidate);
      dishType = candidate;
    }
  }

  return {
    lat: coordsValid ? roundCoord(lat) : null,
    lng: coordsValid ? roundCoord(lng) : null,
    dishType,
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
    opts.query.dishType,
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
    dishTypes,
    whatsInThePot,
    popularResult,
    liveResult,
    newProducts,
    jollofResult,
    pepeSoupResult,
    catalogResult,
    vendors,
    promotions,
    unreadNotifications,
    potPointsBalance,
  ] = await Promise.all([
    safeSection("dishTypes", () => getActiveDishTypes(), []),
    safeSection("whatsInThePot", () => fetchWhatsInThePot(), []),

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
          dishType: query.dishType !== "ALL" ? query.dishType : undefined,
        }),
      { products: [], total: 0 },
    ),

    safeSection(
      "newProducts",
      () =>
        fetchNewProducts({
          take: query.limit,
          dishType: query.dishType !== "ALL" ? query.dishType : undefined,
        }),
      { items: [], total: 0 },
    ),

    // Dish-spotlight rails: orderable dishes of one dish type, ranked by
    // the same popularityScore ordering as live discovery (no new ranking
    // logic — same query core, dishType filter only). JOLLOF and
    // PEPPER_SOUP are stable DishType ids from the curated vocabulary.
    safeSection(
      "jollofProducts",
      () => fetchLiveProducts({ take: 10, dishType: "JOLLOF" }),
      { products: [], total: 0 },
    ),
    safeSection(
      "pepeSoupProducts",
      () => fetchLiveProducts({ take: 10, dishType: "PEPPER_SOUP" }),
      { products: [], total: 0 },
    ),

    safeSection(
      "catalog",
      () =>
        fetchProductPage({
          skip: 0,
          take: Math.min(query.limit, 20),
          dishType: query.dishType !== "ALL" ? query.dishType : undefined,
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

    // Real Pot Points balance for the header wallet + banner. Guests get
    // 0; failures degrade to 0 so loyalty can never break the feed.
    isAuthenticated
      ? safeSection("potPointsBalance", () =>
          prisma.user
            .findUnique({
              where: { id: viewer!.id },
              select: { potPointsBalance: true },
            })
            .then((u) => u?.potPointsBalance ?? 0),
        0,
        )
      : Promise.resolve(0),
  ]);

  // Live products are the currently-orderable marketplace dishes
  // (Stage 1: no scheduling). Popular products keep the exact
  // GET /product/p/most semantics.

  const payload = {
    generatedAt: new Date().toISOString(),

    // Rich dish-type vocabulary ("What's in the Pot?").
    dishTypes,
    // Deprecated: dish-type ids as plain strings (old `categories` clients
    // expect List<String>; ids are strings so old UIs keep rendering).
    categories: (dishTypes as { id: string }[]).map((d) => d.id),

    // "What's in the Pot?" — dish types with something orderable now.
    whatsInThePot,

    liveProducts: {
      items: liveResult.products,
      total: liveResult.total,
    },

    popularProducts: popularResult.products,

    newProducts: {
      items: newProducts.items,
      total: newProducts.total,
    },

    // Ranked, orderable Jollof / Pepper Soup rails (same popularity
    // ordering as live discovery; empty when nothing orderable).
    jollofProducts: {
      items: jollofResult.products,
      total: jollofResult.total,
    },
    pepeSoupProducts: {
      items: pepeSoupResult.products,
      total: pepeSoupResult.total,
    },

    // Real loyalty balance for the header wallet + banner (0 for guests).
    potPointsBalance,

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

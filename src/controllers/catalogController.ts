import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { ensureString } from "../utils/paramUtils";
import { redisProducts } from "../lib/redis";
import {
  fetchProductPage,
  assertActiveDishType,
  CATALOG_SORT_VALUES,
  type CatalogSortValue,
  type ProductListItem,
} from "../services/product.service";
import { CACHE_KEYS, CACHE_TTLS } from "../services/redisCacheTiming";
import { sendSuccess } from "../utils/apiResponse";
import { NotFoundError, ValidationError } from "../errors/AppError";
import {
  attachPromotions,
  loadActiveProductPromos,
} from "../services/promotionPricing.service";
import {
  parseTagQueryParam,
  resolveActiveTagIds,
} from "../services/productTag.service";
import { projectPublicVendorList } from "../services/publicVendor.service";
import {
  parseCatalogPagination,
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MAX_LIMIT,
} from "../validations/catalogPagination";

// Phase 2 M1 — public taxonomy read API.
//
// Three endpoints, all public (same posture as GET /api/product):
//   GET /api/product/tags
//   GET /api/product/categories
//   GET /api/product/categories/:slug/products
//
// Only active canonical rows are ever served. Category identity is always
// resolved server-side from the slug; a client-supplied category id is
// never accepted, so category membership cannot be spoofed.

/**
 * Normalizes a category slug the same way dish-type ids are normalized
 * elsewhere in the catalog (trimmed, case-folded). Slugs are stored
 * lowercase and URL-safe (e.g. "rice-dishes").
 */
export function normalizeCategorySlug(raw: unknown): string {
  return ensureString(raw).trim().toLowerCase();
}

/**
 * Resolves an ACTIVE category by slug. Unknown slugs AND inactive slugs
 * both resolve to a standard 404 so inactive taxonomy can never be
 * probed or enumerated through public responses.
 */
export async function resolveActiveCategory(slug: string) {
  const category = await prisma.category.findUnique({ where: { slug } });
  if (!category || category.isActive !== true) throw new NotFoundError("Category");
  return category;
}

// GET /product/tags — active canonical tags only.
export const getTags = async (_req: Request, res: Response) => {
  const cached = await redisProducts.get(CACHE_KEYS.TAGS_ALL);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return sendSuccess(res, { tags: JSON.parse(cached) }, "Tags fetched successfully");
  }

  const tags = await prisma.tag.findMany({
    where: { isActive: true },
    // Tags carry no sortOrder — name, then id, keeps the order deterministic.
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, type: true },
  });

  await redisProducts.set(CACHE_KEYS.TAGS_ALL, JSON.stringify(tags), {
    EX: CACHE_TTLS.TAGS_ALL,
  });
  res.setHeader("X-Cache", "MISS");
  return sendSuccess(res, { tags }, "Tags fetched successfully");
};

// GET /product/categories — active categories in sortOrder with counts.
//
// Count semantic (M1): productCount counts products with archived = false,
// REGARDLESS of current vendor availability (offline, paused, suspended,
// or sold-out products still count). Rationale: the count describes the
// category's catalog size, matching what category browsing shows under
// plain-browse semantics (unavailable items stay discoverable with
// orderable=false). Orderable-only counts belong to marketplace surfaces
// (home feed / whats-in-the-pot), not to taxonomy browsing.
export const getCategories = async (_req: Request, res: Response) => {
  const cached = await redisProducts.get(CACHE_KEYS.CATEGORIES_ALL);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return sendSuccess(res, { categories: JSON.parse(cached) }, "Categories fetched successfully");
  }

  const [categories, groups] = await Promise.all([
    prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, slug: true, icon: true, sortOrder: true },
    }),
    prisma.product.groupBy({
      by: ["categoryId"],
      where: { archived: false },
      _count: { _all: true },
    }),
  ]);

  const counts = new Map(groups.map((g) => [g.categoryId, g._count._all]));
  const result = categories.map((c) => ({
    ...c,
    productCount: counts.get(c.id) ?? 0,
  }));

  await redisProducts.set(CACHE_KEYS.CATEGORIES_ALL, JSON.stringify(result), {
    EX: CACHE_TTLS.CATEGORIES_ALL,
  });
  res.setHeader("X-Cache", "MISS");
  return sendSuccess(res, { categories: result }, "Categories fetched successfully");
};

// GET /product/categories/:slug/products — category-scoped browse.
//
// Same filter/sort/pagination contract as GET /api/product (page/limit,
// dishType, vendorId, min/max price, minRating, availableOnly, sortBy).
// The categoryId predicate is always the server-resolved id of the active
// category, so results can never include another category's products.
export const getCategoryProducts = async (req: Request, res: Response) => {
  const slug = normalizeCategorySlug(req.params.slug);
  if (!slug) throw new ValidationError("Category slug is required");
  const category = await resolveActiveCategory(slug);

  // B-4: shared pagination parser — the same rules as GET /api/product.
  // A malformed, zero or negative page/limit is rejected with the standard
  // 400 / VALIDATION_ERROR envelope instead of reaching Prisma as
  // `skip: NaN` / `take: NaN`. Above-maximum limits are clamped to 20, the
  // established contract of this route.
  const { page, limit, skip } = parseCatalogPagination(req.query, {
    defaultLimit: CATALOG_DEFAULT_LIMIT,
    maxLimit: CATALOG_MAX_LIMIT,
  });

  const dishTypeQueryRaw = String(req.query.dishType ?? "").trim();
  const vendorIdQuery = req.query.vendorId as string | undefined;

  const dishTypeQuery = dishTypeQueryRaw === "" ? "ALL" : dishTypeQueryRaw.toUpperCase();
  if (dishTypeQuery !== "ALL") {
    await assertActiveDishType(dishTypeQuery);
  }

  let minPrice: number | undefined;
  if (req.query.minPrice != null && String(req.query.minPrice).trim() !== "") {
    minPrice = Number(req.query.minPrice);
    if (!Number.isFinite(minPrice) || minPrice < 0) {
      throw new ValidationError("minPrice must be a non-negative number");
    }
  }
  let maxPrice: number | undefined;
  if (req.query.maxPrice != null && String(req.query.maxPrice).trim() !== "") {
    maxPrice = Number(req.query.maxPrice);
    if (!Number.isFinite(maxPrice) || maxPrice < 0) {
      throw new ValidationError("maxPrice must be a non-negative number");
    }
  }
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw new ValidationError("minPrice cannot be greater than maxPrice");
  }

  let minRating: number | undefined;
  if (req.query.minRating != null && String(req.query.minRating).trim() !== "") {
    minRating = Number(req.query.minRating);
    if (!Number.isFinite(minRating) || minRating < 0 || minRating > 5) {
      throw new ValidationError("minRating must be a number between 0 and 5");
    }
  }

  const sortBy = String(req.query.sortBy ?? "").trim();
  if (sortBy !== "" && !CATALOG_SORT_VALUES.includes(sortBy as CatalogSortValue)) {
    throw new ValidationError(
      `Invalid sortBy. Valid options: ${CATALOG_SORT_VALUES.join(", ")}`,
    );
  }

  const availableOnlyRaw = String(req.query.availableOnly ?? "").toLowerCase();
  if (availableOnlyRaw !== "" && availableOnlyRaw !== "true" && availableOnlyRaw !== "false") {
    throw new ValidationError("availableOnly must be 'true' or 'false'");
  }
  const availableOnly = availableOnlyRaw === "true";

  // Phase 2 M2: optional canonical tag filter (any-match), same semantics
  // and validation as GET /api/product.
  const tagFilter = parseTagQueryParam(req.query.tags ?? req.query.tag);
  const resolvedTagFilter = tagFilter ? await resolveActiveTagIds(tagFilter) : undefined;

  // Deterministic cache key: slug plus every parameter that can change the
  // result set, mirroring getAllProducts so two different requests NEVER
  // share a cache entry.
  const filterKey = [
    `dishtype=${dishTypeQuery}`,
    vendorIdQuery ? `vendor=${vendorIdQuery}` : "vendor=none",
    `sort=${sortBy || "default"}`,
    minPrice != null ? `min=${minPrice}` : "min=none",
    maxPrice != null ? `max=${maxPrice}` : "max=none",
    minRating != null ? `mr=${minRating}` : "mr=none",
    `av=${availableOnly ? 1 : 0}`,
    resolvedTagFilter ? `tag=${[...resolvedTagFilter].sort().join(",")}` : "tag=none",
  ].join(":");
  const cacheKey = CACHE_KEYS.CATEGORY_PRODUCTS(slug, page, limit, filterKey);

  const cached = await redisProducts.get(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    const { data, pagination } = JSON.parse(cached);
    // B-1: re-project the vendor of every cached item. A cache entry written
    // before the public vendor projection existed still carries the raw
    // vendor object for the remaining TTL (five hours), and a cache hit must
    // never be able to re-introduce a removed field.
    const projected = projectPublicVendorList(
      (data ?? []) as ProductListItem[],
    );
    // Promotions resolve fresh on every request (even cache hits) so a
    // cached page can never serve a stale discount.
    const promos = await loadActiveProductPromos();
    return sendSuccess(
      res,
      attachPromotions(projected, promos),
      "Category products fetched successfully",
      200,
      pagination,
    );
  }

  const dbResult = await fetchProductPage({
    skip,
    take: limit,
    dishType: dishTypeQuery !== "ALL" ? dishTypeQuery : undefined,
    vendorId: vendorIdQuery,
    categoryId: category.id,
    tagIds: resolvedTagFilter,
    sortBy: sortBy || undefined,
    minPrice,
    maxPrice,
    minRating,
    availableOnly,
  });

  const pagination = {
    total: dbResult.total,
    page,
    limit,
    totalPages: Math.ceil(dbResult.total / limit),
  };

  await redisProducts.set(
    cacheKey,
    JSON.stringify({ data: dbResult.products, pagination }),
    { EX: CACHE_TTLS.CATEGORY_PRODUCTS },
  );
  res.setHeader("X-Cache", "MISS");

  const freshPromos = await loadActiveProductPromos();
  return sendSuccess(
    res,
    attachPromotions(dbResult.products, freshPromos),
    "Category products fetched successfully",
    200,
    pagination,
  );
};

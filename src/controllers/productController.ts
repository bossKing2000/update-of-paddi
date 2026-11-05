import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { ensureString } from "../utils/paramUtils";
import { AuthRequest } from "../middlewares/auth.middleware";
import {
  archiveProductSchema,
  createProductSchema,
  updateProductSchema,
} from "../validations/ProductCRUDSchema";
import { Prisma } from "@prisma/client";
import { redisProducts, redisSearch } from "../lib/redis";
import { scanKeys } from "../lib/redisScan";
import {
  isForeignKeyConflictFor,
  PRODUCT_DELETE_FK_CONSTRAINTS,
} from "../lib/prismaFkConflict";
import {
  clearProductFromCarts,
  trackProductView,
  fetchProductPage,
  fetchMostPopularProducts,
  fetchNewProducts,
  getActiveDishTypes,
  assertActiveDishType,
  buildProductCard,
  CATALOG_SORT_VALUES,
  type CatalogSortValue,
  type ProductListItem,
} from "../services/product.service";
import {
  toPublicVendor,
  projectPublicVendorList,
  type PublicVendor,
} from "../services/publicVendor.service";
import {
  isVendorOperating,
  isVendorAcceptingOrders,
  isProductCurrentlyAvailable,
} from "../services/vendorAvailability.service";
import { CACHE_KEYS, CACHE_TTLS } from "../services/redisCacheTiming";
import { productIndexQueue } from "../jobs/workers jobs/redis-baseQueue";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from "../errors/AppError";
import { VendorDashboardService } from "./vendorDashboard.service";
import { clearProductCache } from "../services/clearCaches";
import {
  assertNoDuplicateNames,
  toNestedUniqueConflict,
} from "../services/optionGroupNameRules";
import { deriveLegacyOptionMigrationState } from "../services/optionMigrationState";
import { correctQuery } from "../AI/localSearchCorrect";
import { logger } from "../lib/logger";
import config from "../config/config";
import { v2 as cloudinary } from "cloudinary";
import type { EffectivePromotion } from "../services/promotionPricing.service";
import {
  attachPromotions,
  loadActiveProductPromos,
} from "../services/promotionPricing.service";
import {
  parseTagQueryParam,
  resolveActiveTagIds,
} from "../services/productTag.service";
import {
  parseCatalogPagination,
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MAX_LIMIT,
  RAIL_DEFAULT_LIMIT,
  RAIL_MAX_LIMIT,
} from "../validations/catalogPagination";

cloudinary.config(config.cloudinaryUrl);

function extractPublicId(url: string): string | null {
  const match = url.match(
    /\/upload\/(?:v\d+\/)?(.+?)\.(?:jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv|webm)/i,
  );
  return match ? match[1] : null;
}

async function cleanupCloudinaryAssets(
  images: string[],
  video: string | null,
): Promise<void> {
  try {
    for (const imageUrl of images) {
      const publicId = extractPublicId(imageUrl);
      if (publicId) await cloudinary.uploader.destroy(publicId);
    }
    if (video) {
      const videoPublicId = extractPublicId(video);
      if (videoPublicId)
        await cloudinary.uploader.destroy(videoPublicId, {
          resource_type: "video",
        });
    }
  } catch (error) {
    logger.warn({ err: error }, "Cloudinary cleanup failed (non-critical)");
  }
}

function extractImagePaths(files: any): string[] {
  if (!files || typeof files !== "object" || !("images" in files)) return [];
  const imageFiles = (files as { [fieldname: string]: Express.Multer.File[] })[
    "images"
  ];
  return imageFiles.map((file) => file.path);
}

function extractVideoPaths(files: any): string[] {
  if (!files || typeof files !== "object" || !("video" in files)) return [];
  const videoFiles = (files as { [fieldname: string]: Express.Multer.File[] })[
    "video"
  ];
  return videoFiles.map((file) => file.path);
}

// Phase 2 M2: tag ids travel as JSON in multipart/form-data
// ('["SPICY","VEGAN"]'); a bare single id ("SPICY") is accepted as a
// one-element list. Anything else flows to zod shape validation.
function normalizeTagIdsInput(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return [raw];
    }
  }
  return raw;
}

// Stage 1 availability: a product is orderable while its vendor is live +
// accepting orders and the product itself is not archived. There is no
// product scheduling anymore (no ProductSchedule, no isLive/liveUntil
// mirrors), so listings and detail endpoints expose `vendorOperating` and
// `orderable` computed from those two signals only.

// GET /product/dish-types
// Curated Bottom Pot food vocabulary ("What's in the Pot?"). Vendors must
// choose from these — dish types are never free-typed, so duplicates like
// "Ofada"/"ofada"/"OFADA" cannot occur.
export const getDishTypes = async (_req: Request, res: Response) => {
  const dishTypes = await getActiveDishTypes();
  return sendSuccess(res, { dishTypes }, "Dish types fetched");
};

/**
 * Create a new product (vendor only)
 */
export const createProduct = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "VENDOR")
    throw new ForbiddenError("Only vendors can create products.");

  if (typeof req.body.options === "string") {
    try {
      req.body.options = JSON.parse(req.body.options);
    } catch {
      throw new ValidationError("Invalid JSON in options field.");
    }
  }

  if (typeof req.body.optionGroups === "string") {
    try {
      req.body.optionGroups = JSON.parse(req.body.optionGroups);
    } catch {
      throw new ValidationError("Invalid JSON in optionGroups field.");
    }
  }

  if (req.body.tagIds !== undefined) {
    req.body.tagIds = normalizeTagIdsInput(req.body.tagIds);
  }

  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Validation failed",
      parsed.error.flatten().fieldErrors,
    );

  const imageUrls = extractImagePaths(req.files);
  const videoUrls = extractVideoPaths(req.files);
  if (imageUrls.length < 1 || imageUrls.length > 6)
    throw new ValidationError("Please upload between 1 and 6 images.");
  if (videoUrls.length > 1)
    throw new ValidationError("Please upload at most 1 video.");

  const {
    name,
    description,
    price,
    dishTypeId,
    portionLabel,
    trackInventory = false,
    stock,
    archived,
    options = [],
    tagIds,
    optionGroups,
  } = parsed.data;

  // Phase 2B.2 legacy write freeze: legacy ProductOption rows are
  // preserved read-only. New add-ons belong to OptionGroup/OptionGroupItem
  // (future Product API) — accepting `options` here would create rows with
  // no group counterpart, diverging the two systems. Reject explicitly
  // instead of silently mutating or silently ignoring.
  if (options.length > 0)
    throw new ValidationError(
      "Legacy add-on editing is disabled. Add-ons are managed through option groups.",
    );

  // Phase 2B.2 review F-1: nested `optionGroups.create` writes bypassed
  // `optionGroup.service.assertUniqueGroupName`, so the same duplicate-name rule
  // behaved differently per endpoint. A brand-new product has no persisted
  // groups, so only the within-request set needs checking — but both group names
  // and each group's item names are validated here so a product can never be
  // born containing two identically-named groups (or add-ons).
  if (optionGroups !== undefined) {
    assertNoDuplicateNames(
      optionGroups.map((g) => ({ name: g.name })),
      [],
      "option group",
    );
    for (const g of optionGroups) {
      assertNoDuplicateNames(
        g.items.map((i) => ({ ...i, id: i.id })),
        [],
        "add-on",
      );
    }
  }

  // Dish type must be a real, active vocabulary entry.
  await assertActiveDishType(dishTypeId);

  // Phase 2B.1 compat: categoryId is server-derived from the authoritative
  // chain dishTypeId -> DishType.categoryId (never client-controlled).
  const dishType = await prisma.dishType.findUnique({
    where: { id: dishTypeId },
    select: { categoryId: true },
  });
  if (!dishType) throw new ValidationError("Invalid dish type.");

  // Stock semantics: tracked products need an explicit starting count;
  // untracked products ignore any stock value sent.
  if (trackInventory && stock == null)
    throw new ValidationError("Stock is required when inventory tracking is enabled.");

  // Phase 2 M2: canonical tags only — every id must exist and be active.
  // Omitted tagIds leaves the product untagged (existing behavior).
  const resolvedTagIds =
    tagIds !== undefined ? await resolveActiveTagIds(tagIds) : undefined;

  // No two add-ons on one product may share a name (case-insensitive) —
  // customers must be able to tell extras apart at a glance.
  const optionNames = options.map((o) => o.name.trim().toLowerCase());
  if (new Set(optionNames).size !== optionNames.length)
    throw new ValidationError("Add-on names must be unique per product.");

  let product;
  try {
    product = await prisma.product.create({
    data: {
      name: name.trim(),
      description: description.trim(),
      price,
      dishTypeId,
      categoryId: dishType.categoryId,
      portionLabel: portionLabel?.trim() || null,
      trackInventory,
      stock: trackInventory ? stock ?? 0 : null,
      archived: archived ?? false,
      images: imageUrls,
      video: videoUrls.slice(0, 1),
      thumbnail: imageUrls[0],
      vendorId: req.user.id,
      options: {
        create: options.map((o) => ({
          name: o.name.trim(),
          price: o.price,
        })),
      },
      // Structured add-on groups + items, created atomically with the product
      // in the same write. Omitted = no groups.
      ...(optionGroups !== undefined && {
        optionGroups: {
          create: optionGroups.map((g) => ({
            name: g.name.trim(),
            required: g.required,
            minSelections: g.minSelections,
            maxSelections: g.maxSelections,
            sortOrder: g.sortOrder,
            items: {
              create: g.items.map((item) => ({
                name: item.name.trim(),
                priceAdd: item.priceAdd,
                isActive: item.isActive,
                sortOrder: item.sortOrder,
              })),
            },
          })),
        },
      }),
      // Nested create keeps product + associations in one atomic write.
      ...(resolvedTagIds !== undefined && {
        tags: { create: resolvedTagIds.map((tagId) => ({ tagId })) },
      }),
    },
    include: {
      options: true,
      dishType: true,
      tags: { include: { tag: true } },
      // Structured add-ons exposed alongside legacy options (compatibility
      // period — both representations are served, no dual-write).
      optionGroups: {
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        include: {
          items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
        },
      },
},
  });
  } catch (err) {
    // Review F-1: map only the unique-constraint violation. Every other
    // database error propagates unchanged so a genuine failure is never
    // disguised as a duplicate-name conflict.
    throw toNestedUniqueConflict(err);
  }

  productIndexQueue
    .add("indexProduct", { productId: product.id })
    .catch((err) => logger.warn({ err }, "Failed to queue product indexing"));

  // Broad invalidation (SCAN-based, safe at scale — see clearProductCache)
  // instead of trying to precisely rebuild just the pages a new product
  // might land on. A new product's rank among newest-first could put it on
  // any page depending on catalog size, so guessing which single page to
  // pre-warm isn't reliable anyway — next read just repopulates whichever
  // page is actually requested.
  await clearProductCache(product.id, req.user.id);
  const suggestionKeys = await scanKeys(redisSearch, "suggestions:*");
  if (suggestionKeys.length) await redisSearch.del(suggestionKeys);

  // Review F-2 (additive): a product created through this endpoint cannot be
  // migrated yet (migration targets products that already carry legacy
  // add-ons), but computing it keeps the field's presence uniform across the
  // create / update / detail responses instead of appearing only sometimes.
  return sendCreated(
    res,
    {
      product: {
        ...product,
        optionGroupsMigrated: deriveLegacyOptionMigrationState(
          product.options ?? [],
          product.optionGroups ?? [],
        ).fullyMigrated,
      },
    },
    "Product created successfully.",
  );
};

interface ProductResponse {
  id: string;
  name: string;
  price: number;
  images: string[];
  dishType: { id: string; name: string };
  popularityPercent?: number | null;
  averageRating: number;
  reviewCount: number;
  portionLabel: string | null;
  trackInventory: boolean;
  stock: number | null;
  soldOut: boolean;
  vendorOperating?: boolean;
  orderable?: boolean;
  /** Effective automatic promotion (canonical resolver, attached per request). */
  promotion?: EffectivePromotion | null;
  vendor?: {
    id: string;
    name: string;
    brandName: string | null;
    avatarUrl: string | null;
  };
}

// GET /product
// Previously fetched every matching product from the DB with no LIMIT/
// OFFSET at all, cached the entire unpaginated set as one Redis value,
// and paginated via JS .slice() after the fact — every request for page 1
// loaded the whole catalog into memory just to return 20 items. Now does
// real DB-level pagination and sorting, and caches per-page using the
// same CACHE_KEYS.PRODUCTS_ALL(page, limit) format used elsewhere in this
// file, so cache invalidation and pre-warming actually target what this
// function reads.
export const getAllProducts = async (req: AuthRequest, res: Response) => {
  // B-4: one shared parser for page/limit. A malformed, zero or negative
  // value is rejected with the standard 400 / VALIDATION_ERROR envelope
  // instead of reaching Prisma as `skip: NaN` / `take: NaN`. A value above
  // the maximum is clamped to it (the established contract of this route).
  const { page, limit, skip } = parseCatalogPagination(req.query, {
    defaultLimit: CATALOG_DEFAULT_LIMIT,
    maxLimit: CATALOG_MAX_LIMIT,
  });

  const dishTypeQueryRaw = String(req.query.dishType ?? "").trim();
  const vendorIdQuery = req.query.vendorId as string | undefined;

  // dishType is an active DishType id (e.g. "JOLLOF") or "ALL".
  // The legacy `category` meal-time param is ignored (graceful: unfiltered).
  const dishTypeQuery = dishTypeQueryRaw === "" ? "ALL" : dishTypeQueryRaw.toUpperCase();
  if (dishTypeQuery !== "ALL") {
    await assertActiveDishType(dishTypeQuery);
  }

  // Explore filters (backward-compatible additions).
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

  // Phase 2 M2: optional canonical tag filter (any-match). Unknown or
  // inactive tag ids are rejected, mirroring the dishType filter.
  const tagFilter = parseTagQueryParam(req.query.tags ?? req.query.tag);
  const resolvedTagFilter = tagFilter ? await resolveActiveTagIds(tagFilter) : undefined;

  // Deterministic cache key: every parameter that can change the result set
  // is represented so two different requests NEVER share a cache entry.
  const filterKey = [
    `sort=${sortBy || "default"}`,
    minPrice != null ? `min=${minPrice}` : "min=none",
    maxPrice != null ? `max=${maxPrice}` : "max=none",
    minRating != null ? `mr=${minRating}` : "mr=none",
    `av=${availableOnly ? 1 : 0}`,
    resolvedTagFilter ? `tag=${[...resolvedTagFilter].sort().join(",")}` : "tag=none",
  ].join(":");

  const vendorPart = vendorIdQuery ? `vendor=${vendorIdQuery}:` : "";
  const dishTypePart = `dishtype=${dishTypeQuery}`;
  const cacheKey = `products:all:${vendorPart}${dishTypePart}:page=${page}:limit=${limit}:${filterKey}`;

  const cached = await redisProducts.get(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    const { data, pagination } = JSON.parse(cached);
    // B-1: a cache entry written before the public vendor projection
    // existed still carries the raw vendor object for the remaining TTL
    // (five hours). Re-project on read so a cache hit can never
    // re-introduce a field the projection removed.
    const projected = projectPublicVendorList(
      (data ?? []) as Array<{ vendor?: unknown }>,
    ) as ProductListItem[];
    // Promotions resolve fresh on every request (even cache hits) so a
    // cached page can never serve a stale discount. One cached promos read.
    const promos = await loadActiveProductPromos();
    return sendSuccess(
      res,
      attachPromotions(projected, promos),
      "Products fetched successfully",
      200,
      pagination,
    );
  }

  const [dbResult] = await Promise.all([
    fetchProductPage({
      skip,
      take: limit,
      dishType: dishTypeQuery !== "ALL" ? dishTypeQuery : undefined,
      vendorId: vendorIdQuery,
      tagIds: resolvedTagFilter,
      sortBy: sortBy || undefined,
      minPrice,
      maxPrice,
      minRating,
      availableOnly,
    }),
  ]);

  const products: ProductResponse[] = dbResult.products;

  const total = dbResult.total;

  const pagination = {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  await redisProducts.set(
    cacheKey,
    JSON.stringify({ data: products, pagination }),
    { EX: CACHE_TTLS.PRODUCTS_ALL },
  );
  res.setHeader("X-Cache", "MISS");

  // Cache stores the promotion-free page; the response carries the
  // freshly-resolved effective promotion per product.
  const promos = await loadActiveProductPromos();
  return sendSuccess(
    res,
    attachPromotions(products, promos),
    "Products fetched successfully",
    200,
    pagination,
  );
};

/**
 * F-2.15 — one customer-facing option-group shape for every cache path.
 *
 * Product detail must never expose disabled items. The update pre-warm path
 * already applied this rule, but the detail MISS path did not, so the same
 * product changed shape depending on which writer populated the cache. This
 * returns new group objects with new item arrays (the Prisma rows are not
 * mutated) and preserves group/item order plus every retained field.
 */
function toCustomerOptionGroups<
  TItem extends { isActive: boolean },
  TGroup extends { items: TItem[] },
>(
  groups: readonly TGroup[] | null | undefined,
): Array<Omit<TGroup, "items"> & { items: TItem[] }> {
  return (groups ?? []).map((group) => ({
    ...group,
    items: group.items.filter((item) => item.isActive !== false),
  }));
}

/**
 * The internal, CACHE-ONLY key that carries the vendor availability signals
 * the detail cache needs to recompute `vendorOperating` / `orderable` on a
 * cache hit.
 *
 * WHY IT EXISTS (B-1)
 * --------------------
 * The vendor's moderation state (`vendorStatus`) and internal settings
 * (`deliveryPreferences`) must never reach an anonymous caller, but the
 * detail cache historically recomputed availability from the cached vendor
 * object. Removing those fields from the vendor projection therefore
 * required keeping the two availability SIGNALS somewhere the cache can use
 * and the response cannot see.
 *
 * The key is stripped from every response (the read path destructures it
 * out before building the payload), so it is cache-private state, not part of
 * the public contract.
 */
const INTERNAL_VENDOR_AVAILABILITY_KEY = "__vendorAvailability";

interface InternalVendorAvailability {
  isLive: boolean;
  vendorStatus: string | null;
  acceptingOrders: boolean;
}

/**
 * Reads the vendor availability signals a cached detail payload carries.
 *
 * The current writer stores them in the cache-only snapshot key. A cache
 * entry written BEFORE that snapshot existed (or by any future writer)
 * falls back to the legacy vendor fields it carries; a missing or unknown
 * status stays fail-closed because isVendorOperating requires ACTIVE.
 */
function readCachedVendorAvailability(
  productData: Record<string, unknown>,
): InternalVendorAvailability {
  const internal = productData[INTERNAL_VENDOR_AVAILABILITY_KEY] as
    | InternalVendorAvailability
    | undefined;
  if (internal) return internal;

  const legacyVendor = (productData.vendor ?? {}) as Record<string, unknown>;
  return {
    isLive: legacyVendor.isLive === true,
    vendorStatus: (legacyVendor.vendorStatus as string | null) ?? null,
    acceptingOrders: isVendorAcceptingOrders(legacyVendor.deliveryPreferences),
  };
}

// GET /product/:id
export const getProductById = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);
  const cacheKey = CACHE_KEYS.PRODUCT_DETAIL(productId);

  trackProductView(productId).catch((err) =>
    logger.warn({ err, productId }, "Failed to track product view"),
  );

  const cached = await redisProducts.get(cacheKey);
  if (cached) {
    const productData = JSON.parse(cached);
    // F-2.15: entries written by this handler are filtered below, and the
    // update pre-warm path already filters. Normalize again on read so an
    // entry written before this fix (or by any future writer) cannot make
    // the public response depend on cache provenance. The parsed object is
    // local; the stored Redis value is not rewritten here.
    if (Array.isArray(productData.optionGroups)) {
      productData.optionGroups = toCustomerOptionGroups(productData.optionGroups);
    }

    // B-1: strip the cache-only availability snapshot and replace the vendor
    // with the public projection. A cache entry written before the
    // projection existed still carries the raw vendor object for the
    // remaining TTL, so the projection is re-applied on read.
    const {
      [INTERNAL_VENDOR_AVAILABILITY_KEY]: _internalSnapshot,
      ...publicProductData
    } = productData;

    const availability = readCachedVendorAvailability(productData);
    const vendorOperating = isVendorOperating({
      isLive: availability.isLive,
      vendorStatus: availability.vendorStatus,
      deliveryPreferences: { acceptingOrders: availability.acceptingOrders },
    });

    const publicData = {
      ...publicProductData,
      vendor: toPublicVendor(publicProductData.vendor),
      vendorOperating,
      orderable:
        vendorOperating &&
        isProductCurrentlyAvailable({
          archived: publicProductData.archived === true,
          trackInventory: publicProductData.trackInventory,
          stock: publicProductData.stock,
        }),
    };

    // Promotions likewise resolve fresh — never serve a cached discount.
    const promos = await loadActiveProductPromos();
    const [withPromo] = attachPromotions(
      [
        {
          ...publicData,
          vendorId: publicData.vendorId ?? productData.vendor?.id,
        },
      ],
      promos,
    );
    res.setHeader("X-Cache", "HIT");
    return sendSuccess(res, withPromo, "Product retrieved successfully.");
  }

  const [product, reviewStats] = await Promise.all([
    prisma.product.findFirst({
      where: { id: productId, archived: false },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        images: true,
        thumbnail: true,
        video: true,
        createdAt: true,
        updatedAt: true,
        totalViews: true,
        dishType: { select: { id: true, name: true, description: true } },
        portionLabel: true,
        trackInventory: true,
        stock: true,
        popularityScore: true,
        popularityPercent: true,
        isNew: true,
        archived: true,
        vendorId: true,
        vendor: {
          // Public detail: vendor identity + the two availability signals
          // the canonical availability rules need. Account-level fields
          // (email, username, role) must never leak through this
          // anonymous-readable endpoint, and the moderation state /
          // internal delivery settings must not reach the client either —
          // the row is projected through `toPublicVendor` below (B-1).
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
        // Review follow-up B-1. This select feeds TWO consumers with
        // deliberately different requirements:
        //
        //   1. `optionGroupsMigrated` (see productData below) — needs EVERY
        //      legacy option with its `isActive` flag, because an inactive
        //      legacy option must still be compared against the migrated item
        //      it corresponds to. Filtering inactive rows out here, or omitting
        //      `isActive`, made every product report `false` on detail while
        //      update reported `true`.
        //   2. The customer-facing payload — must stay active-only, with the
        //      original `{ id, name, price }` field set.
        //
        // So the query is widened and the display filtering is re-applied,
        // explicitly, where the response is built.
        options: {
          select: { id: true, name: true, price: true, isActive: true },
        },
        // Phase 2B.3: structured add-ons alongside legacy options
        // (compatibility period — both representations are served, no
        // dual-write). Select every item with its flag, then apply the
        // customer-facing active-only filter where `productData` is built.
        optionGroups: {
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: {
            id: true,
            name: true,
            required: true,
            minSelections: true,
            maxSelections: true,
            sortOrder: true,
            items: {
              orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
              select: { id: true, name: true, priceAdd: true, isActive: true, sortOrder: true },
            },
          },
        },
      },
    }),
    prisma.productReview.aggregate({
      where: { productId },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);

  if (!product) throw new NotFoundError("Product");

  // Fetch vendor review stats
  const vendorReviewStats = await prisma.vendorReview.aggregate({
    where: { vendorId: product.vendorId },
    _avg: { rating: true },
    _count: { rating: true },
  });

  const vendorOperating = isVendorOperating(product.vendor);
  const orderable =
    vendorOperating &&
    isProductCurrentlyAvailable({
      archived: product.archived,
      trackInventory: product.trackInventory,
      stock: product.stock,
    });

  const legacyOptions = product.options ?? [];
  const publicProductData = {
    ...product,
    // B-1: the public vendor projection (identity only). The moderation
    // state and the internal delivery settings are kept OUT of the response
    // and out of the cached payload's `vendor` object.
    vendor: toPublicVendor(product.vendor),
    // Customer-facing legacy options: active-only, original field set. Re-derived
    // from the widened select above so removing that `where` filter does not
    // change what a customer sees.
    options: legacyOptions.filter((o) => o.isActive).map(({ id, name, price }) => ({ id, name, price })),
    // Customer-facing option groups: active-only items. This object is also
    // the cache entry written below, so filtering here keeps the MISS
    // response, the cached representation, and the HIT response identical.
    optionGroups: toCustomerOptionGroups(product.optionGroups),
    // Review F-2 (additive): tells a consumer whether `options[]` and
    // `optionGroups[].items[]` describe the same add-ons, so the same add-on is
    // not rendered twice. `options[]` is deliberately NOT removed here — that
    // is a client-visible contract change and this repository cannot establish
    // which clients still read it. See the F-2 note in the review report.
    //
    // Computed from ALL legacy options (including inactive) with their real
    // `isActive` values, and from the UNFILTERED groups, because the flag
    // describes the underlying data state rather than the display filter
    // above. No cast: if either side of this call ever loses a field the state
    // calculation needs, TypeScript now fails here instead of silently
    // reporting `false` (review follow-up B-1).
    optionGroupsMigrated: deriveLegacyOptionMigrationState(
      legacyOptions,
      product.optionGroups ?? [],
    ).fullyMigrated,
    averageRating: reviewStats._avg.rating ?? 0,
    reviewCount: reviewStats._count._all ?? 0,
    vendorOperating,
    orderable,
    soldOut: product.trackInventory === true && (product.stock ?? 0) <= 0,
    vendorRating: vendorReviewStats._avg.rating ?? null,
    vendorReviewCount: vendorReviewStats._count.rating ?? 0,
  };

  // B-1: the availability signals the detail cache needs in order to
  // recompute `vendorOperating` / `orderable` on a cache hit, kept in a
  // CACHE-ONLY key that is stripped from every response.
  const cachedProductData = {
    ...publicProductData,
    [INTERNAL_VENDOR_AVAILABILITY_KEY]: {
      isLive: product.vendor.isLive,
      vendorStatus: product.vendor.vendorStatus ?? null,
      acceptingOrders: isVendorAcceptingOrders(product.vendor.deliveryPreferences),
    } satisfies InternalVendorAvailability,
  };

  await redisProducts.set(cacheKey, JSON.stringify(cachedProductData), {
    EX: CACHE_TTLS.PRODUCT_DETAIL,
  });
  res.setHeader("X-Cache", "MISS");

  // The cache entry stays promotion-free (5h TTL); the response carries
  // the freshly-resolved effective promotion.
  const freshPromos = await loadActiveProductPromos();
  const [withPromo] = attachPromotions([publicProductData], freshPromos);
  return sendSuccess(res, withPromo, "Product retrieved successfully.");
};

// PATCH /product/:id
export const updateProduct = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);

  if (!req.user || req.user.role !== "VENDOR")
    throw new ForbiddenError("Only vendors can update products");

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { options: true },
  });
  if (!product || product.vendorId !== req.user.id)
    throw new ForbiddenError("Unauthorized or product not found");

  const jsonFields = [
    "options",
    "optionGroups",
    "imageUpdates",
    "videoUpdates",
    "images",
    "video",
  ];
  jsonFields.forEach((field) => {
    if (typeof req.body[field] === "string") {
      try {
        req.body[field] = JSON.parse(req.body[field]);
      } catch (error) {
        logger.warn(
          { field },
          "Failed to parse field as JSON, leaving as-is for validation to catch",
        );
      }
    }
  });

  if (req.body.tagIds !== undefined) {
    req.body.tagIds = normalizeTagIdsInput(req.body.tagIds);
  }

  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Validation failed: check your input fields.",
      parsed.error.flatten().fieldErrors,
    );

  const uploadedImageUrls = extractImagePaths(req.files);
  const uploadedVideoUrls = extractVideoPaths(req.files);

  const {
    name,
    description,
    price,
    dishTypeId,
    portionLabel,
    trackInventory,
    stock,
    archived,
    options,
    tagIds,
    optionGroups,
    images: oldImagesFormat, // backward compatibility
    video: oldVideoFormat, // backward compatibility
    imageUpdates,
    videoUpdates,
  } = parsed.data;

  const isUsingOldFormat =
    oldImagesFormat !== undefined || oldVideoFormat !== undefined;
  const isUsingNewFormat =
    imageUpdates !== undefined || videoUpdates !== undefined;

  if (isUsingOldFormat && isUsingNewFormat) {
    throw new ValidationError(
      "Cannot use both old format (images/video arrays) and new format (imageUpdates/videoUpdates)",
    );
  }

  // Phase 2B.2 legacy write freeze: ProductOption rows are preserved
  // read-only (their deleteMany could cascade into historical
  // CartItemOption/OrderItemOption links). Any submitted `options` —
  // even an empty array, which previously meant "delete all" — is
  // rejected explicitly instead of mutating or silently ignoring.
  if (options !== undefined)
    throw new ValidationError(
      "Legacy add-on editing is disabled. Existing add-ons are preserved as-is.",
    );

  // ── Image handling: supports both a legacy "replace the whole array"
  // format and a newer "keep these, delete these" format, for backward
  // compatibility with whichever the client happens to send. ──
  let finalImages: string[] = [];
  let imagesToDeleteFromCloudinary: string[] = [];

  if (isUsingOldFormat) {
    const existingImages = oldImagesFormat || [];
    finalImages = [...existingImages, ...uploadedImageUrls].slice(0, 6);
    if (existingImages.length > 0 && product.images) {
      imagesToDeleteFromCloudinary = product.images.filter(
        (img) => !existingImages.includes(img),
      );
    }
  } else if (imageUpdates) {
    const { keep = [], delete: toDelete = [] } = imageUpdates;
    const currentImages = product.images || [];

    const invalidKeep = keep.filter((url) => !currentImages.includes(url));
    if (invalidKeep.length > 0) {
      throw new ValidationError(
        `Some images to keep don't exist in product: ${invalidKeep.slice(0, 3).join(", ")}${invalidKeep.length > 3 ? "..." : ""}`,
      );
    }

    const invalidDelete = toDelete.filter(
      (url) => !currentImages.includes(url),
    );
    if (invalidDelete.length > 0) {
      throw new ValidationError(
        `Some images to delete don't exist in product: ${invalidDelete.slice(0, 3).join(", ")}${invalidDelete.length > 3 ? "..." : ""}`,
      );
    }

    if (keep.length + uploadedImageUrls.length > 6) {
      throw new ValidationError(
        `Maximum 6 images allowed. You have ${keep.length} kept + ${uploadedImageUrls.length} new = ${keep.length + uploadedImageUrls.length}`,
      );
    }

    imagesToDeleteFromCloudinary = toDelete;
    finalImages = [...keep, ...uploadedImageUrls].slice(0, 6);
  } else {
    const existingImages = product.images || [];
    finalImages = [...existingImages, ...uploadedImageUrls].slice(0, 6);
  }

  if (finalImages.length > 6)
    throw new ValidationError("Maximum 6 images allowed");

  // ── Video handling: same dual-format support as images. ──
  let finalVideo: string[] = [];
  let videoToDeleteFromCloudinary: string | null = null;

  if (isUsingOldFormat) {
    if (uploadedVideoUrls.length > 0) {
      finalVideo = uploadedVideoUrls.slice(0, 1);
      if (product.video && product.video.length > 0)
        videoToDeleteFromCloudinary = product.video[0];
    } else {
      finalVideo = oldVideoFormat || [];
    }
  } else if (videoUpdates) {
    const { keep, delete: shouldDelete } = videoUpdates;
    const currentVideo = product.video || [];

    if (shouldDelete && currentVideo.length > 0) {
      videoToDeleteFromCloudinary = currentVideo[0];
      finalVideo = uploadedVideoUrls.slice(0, 1);
    } else if (keep) {
      if (!currentVideo.includes(keep))
        throw new ValidationError("Video to keep doesn't exist in product");
      finalVideo = [keep];
    } else if (uploadedVideoUrls.length > 0) {
      finalVideo = uploadedVideoUrls.slice(0, 1);
      if (currentVideo.length > 0)
        videoToDeleteFromCloudinary = currentVideo[0];
    } else {
      finalVideo = currentVideo;
    }
  } else {
    if (uploadedVideoUrls.length > 0) {
      finalVideo = uploadedVideoUrls.slice(0, 1);
      if (product.video && product.video.length > 0)
        videoToDeleteFromCloudinary = product.video[0];
    } else {
      finalVideo = product.video || [];
    }
  }

  if (finalVideo.length > 1)
    throw new ValidationError("Maximum 1 video allowed");
  if (uploadedVideoUrls.length > 1)
    throw new ValidationError("Maximum 1 video can be uploaded at a time");

  if (dishTypeId !== undefined) await assertActiveDishType(dishTypeId);

  // Keep inventory coherent: enabling tracking without a count starts at
  // the current stock (default 0); disabling tracking clears the count.
  let resolvedTrackInventory = trackInventory;
  let resolvedStock = stock;
  if (trackInventory === true && stock == null) {
    resolvedStock = product.stock ?? 0;
  }
  if (trackInventory === false) {
    resolvedStock = null;
  }

  // Phase 2B.6a: keep categoryId in sync with dishTypeId when it changes.
  // The authoritative relationship is dishTypeId -> DishType.categoryId.
  let resolvedCategoryId: string | undefined;
  if (dishTypeId !== undefined && dishTypeId !== product.dishTypeId) {
    const newDishType = await prisma.dishType.findUnique({
      where: { id: dishTypeId },
      select: { categoryId: true },
    });
    if (!newDishType) throw new ValidationError("Invalid dish type.");
    resolvedCategoryId = newDishType.categoryId;
  }

  // Phase 2 M2: omitted tagIds leaves associations unchanged; an explicit
  // [] clears them; a new array replaces the set wholesale (in-tx below).
  const resolvedTagIds =
    tagIds !== undefined ? await resolveActiveTagIds(tagIds) : undefined;

  // Phase 2B.1: validate that every referenced group/item id belongs to this
  // product (object-level authorization, OWASP API1:2023). Nested writes are
  // scoped to the parent product at the database level, but we fail fast with
  // a controlled error instead of relying on a raw constraint violation.
  let validGroupIds: Set<string> | undefined;
  let validItemIds: Set<string> | undefined;
  if (optionGroups !== undefined) {
    const existingGroups = await prisma.optionGroup.findMany({
      where: { productId: product.id },
      include: { items: true },
    });
    validGroupIds = new Set(existingGroups.map((g) => g.id));
    validItemIds = new Set(
      existingGroups.flatMap((g) => g.items.map((i) => i.id)),
    );
    for (const g of optionGroups) {
      if (g.id !== undefined && !validGroupIds.has(g.id)) {
        throw new NotFoundError("Option group");
      }
      for (const item of g.items) {
        if (item.id !== undefined && !validItemIds.has(item.id)) {
          throw new NotFoundError("Option group item");
        }
      }
    }

    // Review F-1: apply the shared duplicate-name rule to the SAME fetch that
    // authorized the ids. Rows the request renames (entries carrying an `id`)
    // are excluded from the "already taken" set, so a group may keep its own
    // name while two persisted groups renamed to the same new name collide.
    assertNoDuplicateNames(
      optionGroups.map((g) => ({ id: g.id, name: g.name })),
      existingGroups.map((g) => ({ id: g.id, name: g.name })),
      "option group",
    );

    // Item names, scoped per group. Groups being updated keep their current
    // items available for rename; newly created groups have no items yet.
    const itemsByGroup = new Map(existingGroups.map((g) => [g.id, g.items]));
    for (const g of optionGroups) {
      const existingItems = (g.id !== undefined ? itemsByGroup.get(g.id) : undefined) ?? [];
      assertNoDuplicateNames(
        g.items.map((i) => ({ id: i.id, name: i.name })),
        existingItems.map((i) => ({ id: i.id, name: i.name })),
        "add-on",
      );
    }
  }

  const updateData: Prisma.ProductUpdateInput = {
    ...(name !== undefined && { name: name.trim() }),
    ...(description !== undefined && { description: description.trim() }),
    ...(price !== undefined && { price }),
    ...(dishTypeId !== undefined && { dishTypeId }),
    ...(resolvedCategoryId !== undefined && { categoryId: resolvedCategoryId }),
    ...(portionLabel !== undefined && { portionLabel: portionLabel?.trim() || null }),
    ...(resolvedTrackInventory !== undefined && { trackInventory: resolvedTrackInventory }),
    ...(resolvedStock !== undefined && { stock: resolvedStock }),
    ...(archived !== undefined && { archived }),
    images: finalImages,
    video: finalVideo,
    // Phase 2B.1: structured add-on groups + items. Omitted = preserve
    // existing groups. When supplied, entries with an `id` update that
    // existing group (scoped to this product, pre-validated above), entries
    // without an `id` are created, and groups/items not mentioned are
    // preserved — groups/items are never deleted here (use the standalone
    // option-group endpoints to delete). One transaction: a child-write
    // failure rolls the whole product update back.
    ...(optionGroups !== undefined && {
      optionGroups: {
        create: optionGroups
          .filter((g) => !g.id)
          .map((g) => ({
            name: g.name.trim(),
            required: g.required,
            minSelections: g.minSelections,
            maxSelections: g.maxSelections,
            sortOrder: g.sortOrder,
            items: {
              create: g.items.map((item) => ({
                name: item.name.trim(),
                priceAdd: item.priceAdd,
                isActive: item.isActive,
                sortOrder: item.sortOrder,
              })),
            },
          })),
        update: optionGroups
          .filter((g) => g.id)
          .map((g) => ({
            where: { id: g.id },
            data: {
              name: g.name.trim(),
              required: g.required,
              minSelections: g.minSelections,
              maxSelections: g.maxSelections,
              sortOrder: g.sortOrder,
              items: {
                update: g.items
                  .filter((i) => i.id)
                  .map((i) => ({
                    where: { id: i.id },
                    data: {
                      name: i.name.trim(),
                      priceAdd: i.priceAdd,
                      ...(i.isActive !== undefined && { isActive: i.isActive }),
                      sortOrder: i.sortOrder,
                    },
                  })),
                create: g.items
                  .filter((i) => !i.id)
                  .map((item) => ({
                    name: item.name.trim(),
                    priceAdd: item.priceAdd,
                    isActive: item.isActive,
                    sortOrder: item.sortOrder,
                  })),
              },
            },
          })),
      },
    }),
  };

  if (finalImages.length > 0) {
    updateData.thumbnail = finalImages[0];
  } else if (isUsingOldFormat || isUsingNewFormat) {
    updateData.thumbnail = null;
  }

  // Cloudinary cleanup runs in the background — doesn't block the response,
  // and a failure here shouldn't fail the product update itself.
  if (imagesToDeleteFromCloudinary.length > 0 || videoToDeleteFromCloudinary) {
    setTimeout(() => {
      cleanupCloudinaryAssets(
        imagesToDeleteFromCloudinary,
        videoToDeleteFromCloudinary,
      ).catch((err) =>
        logger.warn({ err, productId }, "Background Cloudinary cleanup failed"),
      );
    }, 1000);
  }

  // Phase 2B.2: legacy option sync removed (see freeze guard above) —
  // the transaction now covers the product update plus, when tagIds were
  // supplied, the wholesale tag replacement. One transaction means a tag
  // persistence failure rolls the product update back too — associations
  // can never be left partially updated.
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
    const updatedProduct = await tx.product.update({
      where: { id: product.id },
      data: updateData,
      include: {
        options: true,
        // Structured add-ons exposed alongside legacy options (compatibility
        // period — both representations are served, no dual-write).
        optionGroups: {
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          include: {
            items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
          },
        },
      },
    });

    if (resolvedTagIds !== undefined) {
      await tx.productTag.deleteMany({ where: { productId: product.id } });
      if (resolvedTagIds.length > 0) {
        await tx.productTag.createMany({
          data: resolvedTagIds.map((tagId) => ({ productId: product.id, tagId })),
        });
      }
    }

    return updatedProduct;
  });
  } catch (err) {
    // Review F-1: only the unique-constraint violation becomes a conflict.
    // Anything else (including P2003/P2025) propagates untouched, and the
    // surrounding transaction still guarantees no partial product/group/item
    // write survives a failure.
    throw toNestedUniqueConflict(err);
  }

  productIndexQueue
    .add("indexProduct", { productId: product.id })
    .catch((err) => logger.warn({ err }, "Failed to queue product indexing"));

  await clearProductCache(product.id, req.user!.id);
  await clearProductFromCarts(product.id);

  // Re-read so the response (and cache) reflect the saved row with its
  // preserved legacy options.
  const fresh = await prisma.product.findUnique({
    where: { id: product.id },
    include: {
      options: true,
      dishType: true,
      tags: { include: { tag: true } },
      // Structured add-ons exposed alongside legacy options.
      optionGroups: {
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        include: {
          items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
        },
      },
    },
  });

  // Review F-2 (additive): computed from the UNFILTERED rows, because the flag
  // describes the underlying data state, not the display filter applied below.
  // Computed once so the cached payload and the live response can never disagree.
  const optionGroupsMigrated = deriveLegacyOptionMigrationState(
    fresh?.options ?? [],
    fresh?.optionGroups ?? [],
  ).fullyMigrated;

  // Do NOT pre-warm the detail cache here. This handler writes no vendor
  // relation and no review aggregates into a replacement entry, so a pre-warm
  // would write a payload the reader cannot treat as authoritative:
  // `getProductById` derives vendor identity, `vendorOperating` and
  // `orderable` from the vendor row / availability snapshot, and treats a
  // missing snapshot as fail-closed. That made an active vendor's product
  // read as unavailable for the full detail TTL after an edit.
  //
  // `clearProductCache` above already drops every product-detail alias
  // (`productDetailCacheKeys(productId)`) plus the vendor-scoped namespaces.
  // The next GET repopulates the detail key through the complete MISS path.
  //
  // NOTE: this is NOT identical to `archiveProduct`. `archiveProduct`
  // deletes only `CACHE_KEYS.PRODUCT_DETAIL(productId)` (one key, on
  // redisProducts only). `clearProductCache` here deletes all four aliases
  // returned by `productDetailCacheKeys(productId)` across every Redis
  // instance, and additionally sweeps the vendor page-cache pattern and the
  // dashboard summary key. The two writers intentionally differ because
  // `updateProduct` returns a full product row while `archiveProduct`
  // returns only the `archived` flag — a partial pre-warm would be safe for
  // neither, so neither pre-warms.
  const dashboardService = new VendorDashboardService(req.user!.id);
  await dashboardService.invalidateCache();

  return sendSuccess(
    res,
    { ...fresh, optionGroupsMigrated, images: finalImages, video: finalVideo },
    "Product updated successfully",
  );
};

// PATCH /product/:id/archive
export const archiveProduct = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);

  if (!req.user || req.user.role !== "VENDOR")
    throw new ForbiddenError("Only vendors can archive products");

  const parsed = archiveProductSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("archived must be a boolean");
  const { archived } = parsed.data;

  const product = await prisma.product.findUnique({
    where: { id: productId },
  });
  if (!product || product.vendorId !== req.user.id)
    throw new ForbiddenError("Unauthorized or product not found");

  const updated = await prisma.product.update({
    where: { id: productId },
    data: { archived },
  });

  productIndexQueue
    .add("indexProduct", { productId })
    .catch((err) => logger.warn({ err }, "Failed to queue product indexing"));
  await clearProductCache(productId, req.user.id);
  await clearProductFromCarts(productId);

  // Do NOT pre-warm the detail cache here: this update response carries no
  // options/dishType relations, and a partial cache entry would serve a
  // detail payload missing its add-ons. The next GET repopulates fully.
  await redisProducts.del(CACHE_KEYS.PRODUCT_DETAIL(productId)).catch(() => {});

  const dashboardService = new VendorDashboardService(req.user.id);
  await dashboardService.invalidateCache();

  return sendSuccess(
    res,
    updated,
    `Product successfully ${archived ? "archived" : "unarchived"}`,
  );
};

// DELETE /product/:id
// Previously this always hard-deleted the row — but OrderItem.product has
// onDelete: Cascade, meaning deleting a product silently deleted the
// OrderItem rows referencing it from every customer's past orders too,
// corrupting order history, totals, and receipts retroactively for orders
// that had already completed, sometimes long ago. Now: if the product has
// ever been ordered, deletion is refused in favor of archiving (which
// already exists as the correct way to stop selling something while
// keeping history intact). Only products with zero order history — never
// actually sold — can be hard-deleted.
export const deleteProduct = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);

  if (!req.user || req.user.role !== "VENDOR")
    throw new ForbiddenError("Only vendors can delete products");

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.vendorId !== req.user.id)
    throw new ForbiddenError("Unauthorized or product not found");

  const hasOrderHistory = await prisma.orderItem.findFirst({
    where: { productId },
    select: { id: true },
  });
  if (hasOrderHistory) {
    throw new ConflictError(
      "This product has order history and can't be deleted — archive it instead to stop selling it while keeping past orders intact.",
    );
  }

  // A live cart line is customer-owned state. Refuse the delete rather than
  // letting the database cascade (previously) or restrict (now) decide.
  const hasCartLines = await prisma.cartItem.findFirst({
    where: { productId },
    select: { id: true },
  });
  if (hasCartLines) {
    throw new ConflictError(
      "This product is in a customer's cart and can't be deleted — archive it instead so customer carts are not changed.",
    );
  }

  try {
    await prisma.product.delete({ where: { id: product.id } });
  } catch (err) {
    // A cart line can land between the check above and the delete. The
    // database RESTRICT constraint is the authority; Prisma 6 surfaces it
    // as a PrismaClientUnknownRequestError carrying PostgreSQL SQLSTATE
    // 23001, so only the expected product constraints map to 409 and every
    // other failure surfaces normally.
    if (isForeignKeyConflictFor(err, PRODUCT_DELETE_FK_CONSTRAINTS)) {
      throw new ConflictError(
        "This product is still referenced by existing orders or customer carts and can't be deleted — archive it instead.",
      );
    }
    throw err;
  }
  await clearProductCache(product.id, req.user.id);
  await clearProductFromCarts(product.id);

  // Orphaned media: the row is gone, so remove its Cloudinary assets in
  // the background — a failure must not fail the deletion itself.
  if ((product.images?.length ?? 0) > 0 || (product.video?.length ?? 0) > 0) {
    setTimeout(() => {
      cleanupCloudinaryAssets(
        product.images ?? [],
        product.video?.[0] ?? null,
      ).catch((err) =>
        logger.warn({ err, productId }, "Background Cloudinary cleanup failed"),
      );
    }, 1000);
  }

  return sendSuccess(res, {}, "Product deleted successfully");
};

// GET /product/p/suggestions
export const getSearchSuggestions = async (req: Request, res: Response) => {
  const q = (req.query.q as string)?.trim();
  if (!q || q.length < 2)
    throw new ValidationError("Please enter at least 2 characters");

  const query = q.toLowerCase();
  const keywords = query.split(/\s+/).filter(Boolean);
  const isSingleWord = keywords.length === 1;

  const cacheKey = CACHE_KEYS.SUGGESTIONS(query);
  const cached = await redisSearch.get(cacheKey);
  if (cached) {
    return sendSuccess(
      res,
      { query, results: JSON.parse(cached), fromCache: true },
      "Suggestions retrieved successfully",
    );
  }

  const nameMatch = (word: string) => ({
    name: { contains: word, mode: "insensitive" as const },
  });
  const dishMatch = (word: string) => ({
    dishType: { name: { contains: word, mode: "insensitive" as const } },
  });
  // Phase 2 M4: autocomplete matches the same vocabulary as search
  // (category + assigned active tags), so "spicy" suggests dishes tagged
  // Spicy even when the word is nowhere in the name.
  const categoryMatch = (word: string) => ({
    category: { name: { contains: word, mode: "insensitive" as const } },
  });
  const tagMatch = (word: string) => ({
    tags: {
      some: {
        tag: {
          isActive: true,
          OR: [
            { name: { contains: word, mode: "insensitive" as const } },
            { id: { contains: word, mode: "insensitive" as const } },
          ],
        },
      },
    },
  });
  const matchWord = (word: string) => ({
    OR: [nameMatch(word), dishMatch(word), categoryMatch(word), tagMatch(word)],
  });
  // Phase 2 M4: suspended or otherwise ineligible vendors never surface in
  // autocomplete ("listings are paused"), while temporarily offline ACTIVE
  // vendors stay discoverable — the same discoverability/orderability split
  // as browse. Deliberately status-only (no isLive): pausing sales must not
  // erase a vendor from the search box.
  const eligibleVendor: Prisma.ProductWhereInput = {
    vendor: { vendorStatus: "ACTIVE" },
  };

  const results = isSingleWord
    ? await prisma.product.findMany({
        where: {
          archived: false,
          ...eligibleVendor,
          OR: [nameMatch(query), dishMatch(query), categoryMatch(query), tagMatch(query)],
        },
        select: {
          id: true,
          name: true,
          dishType: { select: { id: true, name: true } },
          category: { select: { name: true } },
          tags: { select: { tag: { select: { name: true } } } },
        },
        take: 12,
      })
    : await prisma.product.findMany({
        where: { archived: false, ...eligibleVendor, AND: keywords.map(matchWord) },
        select: {
          id: true,
          name: true,
          dishType: { select: { id: true, name: true } },
          category: { select: { name: true } },
          tags: { select: { tag: { select: { name: true } } } },
        },
        take: 12,
      });

  // Ranking: exact prefix matches first, then vocabulary matches
  // (dish-type/category/tag), then general name matches. Category/tag
  // fields are ranking-only — stripped before responding so the contract
  // stays {id, name, dishType}.
  const vocabHit = (p: { dishType: { name: string }; category?: { name: string } | null; tags?: { tag: { name: string } }[] }, needle: string) =>
    p.dishType.name.toLowerCase().includes(needle) ||
    (p.category?.name ?? "").toLowerCase().includes(needle) ||
    (p.tags ?? []).some((t) => t.tag.name.toLowerCase().includes(needle));
  results.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aScore =
      (aName.startsWith(query) ? 3 : 0) +
      (vocabHit(a, query) ? 2 : 0) +
      (keywords.every((w) => aName.includes(w)) ? 1 : 0);
    const bScore =
      (bName.startsWith(query) ? 3 : 0) +
      (vocabHit(b, query) ? 2 : 0) +
      (keywords.every((w) => bName.includes(w)) ? 1 : 0);
    return bScore - aScore;
  });

  const suggestions = results.map(({ category: _c, tags: _t, ...rest }) => rest);
  await redisSearch.set(cacheKey, JSON.stringify(suggestions), {
    EX: CACHE_TTLS.SUGGESTIONS,
  });

  return sendSuccess(
    res,
    { query, results: suggestions, fromCache: false },
    "Suggestions retrieved successfully",
  );
};

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  vendorId: string;
  images: string[];
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  rank?: number;
  exact_match?: boolean;
  sim_score?: number;
}

/**
 * Version marker stored INSIDE the cached search payload (B-3).
 *
 * It is not part of the cache KEY — the key format is unchanged — but it lets
 * the read path recognise an entry that was written before the canonical card
 * shape existed and refuse to serve it.
 */
const SEARCH_CARD_VERSION_KEY = "__cardVersion";
const SEARCH_CARD_VERSION = 2;

/**
 * A raw search row as it comes back from the hand-written SQL.
 *
 * The vendor columns are ALIASED in the query (`vendor_brandName`, …) so
 * they can be told apart from the product columns and projected through the
 * public vendor projection before they are served.
 */
interface ProductSearchRow {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  vendorId: string;
  images?: string[] | null;
  thumbnail?: string | null;
  archived?: boolean | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  dishTypeId?: string | null;
  dishType?: { id: string; name: string } | null;
  portionLabel?: string | null;
  trackInventory?: boolean | null;
  stock?: number | null;
  popularityPercent?: number | null;
  averageRating?: number | null;
  reviewCount?: number | null;
  vendor_id?: string | null;
  vendor_name?: string | null;
  vendor_brandName?: string | null;
  vendor_brandLogo?: string | null;
  vendor_avatarUrl?: string | null;
  vendor_isLive?: boolean | null;
  vendor_vendorStatus?: string | null;
  vendor_deliveryPreferences?: unknown;
  rank?: number | null;
  exact_match?: boolean | null;
  sim_score?: number | null;
  dish_match?: boolean | null;
  category_match?: boolean | null;
  tag_match?: boolean | null;
}

/**
 * The canonical product-card fields plus the search-specific fields this
 * endpoint has always returned. Used as the declared result type of the
 * search mapper.
 */
export type ProductSearchResult = ProductListItem & {  description: string | null;
  vendorId: string;
  archived: boolean;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  dishTypeId: string | null;
  rank: number | null;
  exact_match: boolean | null;
  sim_score: number | null;
  dish_match: boolean | null;
  category_match: boolean | null;
  tag_match: boolean | null;
};

/**
 * Maps one raw search row onto the canonical product card (B-3).
 *
 * The availability flags are computed by the canonical rules from the
 * vendor's operating signals, exactly as they are for a browse result, and
 * the vendor is projected through the public projection (B-1) so the
 * moderation state and internal delivery settings never reach the client.
 */
function toSearchResult(row: ProductSearchRow): ProductSearchResult {
  const card = buildProductCard({
    id: row.id,
    name: row.name,
    price: row.price,
    dishType: row.dishType ?? null,
    thumbnail: row.thumbnail ?? null,
    images: row.images ?? null,
    popularityPercent: row.popularityPercent ?? null,
    averageRating: row.averageRating ?? null,
    reviewCount: row.reviewCount ?? null,
    portionLabel: row.portionLabel ?? null,
    trackInventory: row.trackInventory ?? null,
    stock: row.stock ?? null,
    archived: row.archived ?? null,
    vendor: {
      id: row.vendor_id ?? row.vendorId,
      name: row.vendor_name ?? null,
      brandName: row.vendor_brandName ?? null,
      brandLogo: row.vendor_brandLogo ?? null,
      avatarUrl: row.vendor_avatarUrl ?? null,
      isLive: row.vendor_isLive ?? null,
      vendorStatus: row.vendor_vendorStatus ?? null,
      deliveryPreferences: row.vendor_deliveryPreferences,
    },
  });

  return {
    ...card,
    description: row.description ?? null,
    vendorId: row.vendorId,
    archived: row.archived === true,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    dishTypeId: row.dishTypeId ?? null,
    rank: row.rank ?? null,
    exact_match: row.exact_match ?? null,
    sim_score: row.sim_score ?? null,
    dish_match: row.dish_match ?? null,
    category_match: row.category_match ?? null,
    tag_match: row.tag_match ?? null,
  };
}

// GET /product/p/search
// Full-text search (Postgres tsvector) with a trigram-similarity fuzzy
// fallback when full-text comes up short, plus AI-assisted typo
// correction on the query itself. This logic is delicate and specific to
// the Postgres extensions in use — left structurally as-is (verified
// correct: the $1/$2/etc placeholders are genuinely parameterized, not
// string-interpolated, so despite the "Unsafe" naming there's no SQL
// injection risk here — only the query *shape* bypasses Prisma's query
// builder, not the values).
export const searchProducts = async (req: Request, res: Response) => {
  const q = (req.query.q as string)?.trim();
  if (!q) throw new ValidationError("Query parameter 'q' is required");

  // B-4: shared pagination parser. Malformed, zero or negative values are
  // rejected with the standard 400 / VALIDATION_ERROR envelope so they can
  // never reach SQL as NaN/negative LIMIT/OFFSET or pollute Redis keys.
  // Above-maximum limits keep the established clamping contract (20).
  const { page, limit, skip: offset } = parseCatalogPagination(req.query, {
    defaultLimit: CATALOG_DEFAULT_LIMIT,
    maxLimit: CATALOG_MAX_LIMIT,
  });
  const fuzzyThreshold = 0.1;
  const sortBy = (req.query.sortBy as string) || "relevance";
  const SEARCH_SORT_VALUES = ["relevance", "priceAsc", "priceDesc", "popularity", "newest", "rating"] as const;
  if (!(SEARCH_SORT_VALUES as readonly string[]).includes(sortBy)) {
    throw new ValidationError(
      `Invalid sortBy. Valid options: ${SEARCH_SORT_VALUES.join(", ")}`,
    );
  }

  // Explore filters (backward-compatible additions).
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

  const dishTypeQueryRaw = String(req.query.dishType ?? "").trim();
  const dishTypeQuery =
    dishTypeQueryRaw === "" ? "ALL" : dishTypeQueryRaw.toUpperCase();
  if (dishTypeQuery !== "ALL") {
    await assertActiveDishType(dishTypeQuery);
  }

  const availableOnlyRaw = String(req.query.availableOnly ?? "").toLowerCase();
  if (
    availableOnlyRaw !== "" &&
    availableOnlyRaw !== "true" &&
    availableOnlyRaw !== "false"
  ) {
    throw new ValidationError("availableOnly must be 'true' or 'false'");
  }

  // Phase 2 M2: optional canonical tag filter (any-match), same semantics
  // and validation as the browse filter.
  const tagFilter = parseTagQueryParam(req.query.tags ?? req.query.tag);
  const resolvedTagFilter = tagFilter ? await resolveActiveTagIds(tagFilter) : undefined;

  const corrected = correctQuery(q);

  // Cache key includes every new filter so different combinations never
  // share an entry.
  const filterKey = [
    dishTypeQuery,
    minPrice != null ? `mp${minPrice}` : "",
    maxPrice != null ? `xp${maxPrice}` : "",
    minRating != null ? `mr${minRating}` : "",
    availableOnlyRaw === "true" ? "av1" : "",
    resolvedTagFilter ? `tg${[...resolvedTagFilter].sort().join(",")}` : "",
  ]
    .filter(Boolean)
    .join("-");

  const cacheKey =
    CACHE_KEYS.SEARCH(corrected, sortBy, undefined, page, limit) +
    (filterKey ? `:f=${filterKey}` : "");

  // ── Dynamic discovery filters (dish type / price / availability) ──
  // Everything is parameterized ($n placeholders) — no string
  // interpolation of client input into SQL. The vendor is always joined
  // (PK lookup) so results can RANK orderable dishes first; availableOnly
  // additionally FILTERS to them.
  const vendorJoin = ` LEFT JOIN "User" v ON v."id" = p."vendorId"`;
  const vendorFilterSql =
    availableOnlyRaw === "true"
      // availableOnly promises orderability, so it applies the full
      // orderability vendor rule (Phase 1C: ACTIVE status required — a
      // suspended vendor's dishes must not pass an "orderable only" filter
      // while carrying orderable=false).
      ? ` AND v."isLive" = true AND v."vendorStatus" = 'ACTIVE' AND COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') <> 'false' AND (NOT p."trackInventory" OR COALESCE(p.stock, 0) > 0)`
      : "";
  // Dish-type names participate in matching via this join, so "jollof"
  // finds "Smoky Party Rice" when its dishType is JOLLOF.
  const dishJoin = ` JOIN "DishType" d ON d."id" = p."dishTypeId"`;
  // Phase 2 M4: category names participate the same way ("rice" finds
  // dishes in "Rice Dishes"). LEFT JOIN — a product with no category must
  // never drop out of search.
  const categoryJoin = ` LEFT JOIN "Category" c ON c."id" = p."categoryId"`;
  // Phase 2 M4: assigned-tag matching. EXISTS (never a JOIN) so tagless
  // products keep matching by name/description/dish/category. Only active
  // tags participate; matching covers the display name and the stable id
  // ("vegan" matches both).
  // Phase 2.6: likeRef parameterizes the LIKE operand (default $2, the LIKE
  // param in full-text page + count queries) so fuzzy queries — whose $2 is
  // the similarity threshold — reuse the byte-identical predicate via
  // ('%' || $1 || '%'), which carries the same value with the same
  // wildcard semantics.
  const tagNameMatchSql = (likeRef = "$2") =>
    `(t."name" ILIKE ${likeRef} OR t."id" ILIKE ${likeRef})`;
  const tagMatchExistsSql = (likeRef = "$2") =>
    `EXISTS (SELECT 1 FROM "ProductTag" pt JOIN "Tag" t ON t."id" = pt."tagId" WHERE pt."productId" = p.id AND t."isActive" = true AND ${tagNameMatchSql(likeRef)})`;
  // The full-text relevance predicate, shared by the page query, the count
  // query, and (negated) the fuzzy queries. $1 is always the corrected
  // query text.
  const ftPredicateSql = (likeRef = "$2") =>
    `(p.tsvector_col @@ websearch_to_tsquery('english', $1) OR p.name ILIKE ${likeRef} OR p.description ILIKE ${likeRef} OR d."name" ILIKE ${likeRef} OR c."name" ILIKE ${likeRef} OR ${tagMatchExistsSql(likeRef)})`;
  // Filter clauses in stable order; each query numbers its placeholders
  // from its own base-param count (page queries carry limit/offset, the
  // count query does not).
  const filterClauses: ((n: number) => string)[] = [];
  const filterParams: unknown[] = [];
  if (dishTypeQuery !== "ALL") {
    filterParams.push(dishTypeQuery);
    filterClauses.push((n) => ` AND p."dishTypeId" = $${n}`);
  }
  if (minPrice != null) {
    filterParams.push(minPrice);
    filterClauses.push((n) => ` AND p.price >= $${n}`);
  }
  if (maxPrice != null) {
    filterParams.push(maxPrice);
    filterClauses.push((n) => ` AND p.price <= $${n}`);
  }
  if (minRating != null && minRating > 0) {
    filterParams.push(minRating);
    filterClauses.push((n) => ` AND p."averageRating" >= $${n}`);
  }
  if (resolvedTagFilter) {
    // Any-match over the canonical join table, parameterized as a single
    // text array (ONE placeholder regardless of tag count, so the
    // positional numbering of every other clause is unaffected).
    filterParams.push(resolvedTagFilter);
    filterClauses.push(
      (n) =>
        ` AND EXISTS (SELECT 1 FROM "ProductTag" pt WHERE pt."productId" = p.id AND pt."tagId" = ANY($${n}))`,
    );
  }
  const filterSql = (baseCount: number) =>
    filterClauses.map((fn, i) => fn(baseCount + i + 1)).join("");
  // Page queries: $1 query, $2 like/threshold, $3 limit, $4 offset.
  const extraWhereSql = filterSql(4);
  // Count query: $1 corrected, $2 like.
  const countWhereSql = filterSql(2);
  const cached = await redisSearch.get(cacheKey);
  if (cached) {
    const data = JSON.parse(cached);
    // B-3: a search entry cached BEFORE the canonical card shape existed does
    // not carry the card fields (rating, portion, stock, availability, vendor
    // identity). Serving it would make search results thinner than browse
    // results for the remaining TTL, so a shape-mismatched entry is ignored
    // and the page is re-read from the database.
    if (data?.[SEARCH_CARD_VERSION_KEY] !== SEARCH_CARD_VERSION) {
      // fall through to the database read below
    } else {
      const promos = await loadActiveProductPromos();
      return sendSuccess(
        res,
        {
          corrected,
          results: attachPromotions(data.results, promos),
          pagination: data.pagination,
          fromCache: true,
        },
        "Products fetched successfully",
      );
    }
  }

  let secondaryOrder = `"createdAt" DESC`;
  switch (sortBy) {
    case "priceAsc":
      secondaryOrder = `price ASC`;
      break;
    case "priceDesc":
      secondaryOrder = `price DESC`;
      break;
    case "popularity":
      secondaryOrder = `"popularityScore" DESC`;
      break;
    case "rating":
      secondaryOrder = `"averageRating" DESC`;
      break;
    case "newest":
      secondaryOrder = `"createdAt" DESC`;
      break;
  }

  // Base params $1..$4; filter params continue at $5+.
  const baseParams: unknown[] = [corrected, `%${corrected}%`, limit, offset];

  // Orderability for ranking: ACTIVE vendor + live + accepting + not
  // archived + in stock. Relevance still wins — availability only breaks
  // ties below dish/name matches (a closer-but-irrelevant dish must never
  // outrank).
  const orderableExpr = `(v."vendorStatus" = 'ACTIVE' AND v."isLive" = true AND COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') <> 'false' AND p.archived = false AND (NOT p."trackInventory" OR COALESCE(p.stock, 0) > 0))`;

  // B-3: the search page selects the SAME customer-facing fields the
  // canonical product list selects, so one card renders identically in
  // browse and in search. The vendor columns are read here but projected
  // through `toPublicVendor` before they are served (B-1) — the moderation
  // state and the internal delivery settings never leave the server.
  const searchCardColumnsSql = `
      p.id, p.name, p.description, p.price, p."vendorId", p.images, p.thumbnail,
      p.archived, p."createdAt", p."updatedAt", p."dishTypeId",
      p."portionLabel", p."trackInventory", p.stock,
      p."popularityPercent", p."averageRating", p."reviewCount",
      jsonb_build_object('id', d."id", 'name', d."name") AS "dishType",
      v.id AS "vendor_id", v.name AS "vendor_name",
      v."brandName" AS "vendor_brandName", v."brandLogo" AS "vendor_brandLogo",
      v."avatarUrl" AS "vendor_avatarUrl", v."isLive" AS "vendor_isLive",
      v."vendorStatus" AS "vendor_vendorStatus",
      v."deliveryPreferences" AS "vendor_deliveryPreferences"`;

  const fullTextResults = await prisma.$queryRawUnsafe<any[]>(
    `
    SELECT
      ${searchCardColumnsSql},
      ts_rank_cd(setweight(to_tsvector('english', p.name), 'A') || setweight(to_tsvector('english', p.description), 'B'), websearch_to_tsquery('english', $1)) AS rank,
      (p.name ILIKE $2 OR p.description ILIKE $2) AS exact_match,
      (d."name" ILIKE $2) AS dish_match,
      (c."name" ILIKE $2) AS category_match,
      (${tagMatchExistsSql()}) AS tag_match,
      ${orderableExpr} AS orderable
    FROM "Product" p${dishJoin}${categoryJoin}${vendorJoin}
    WHERE p.archived = false${vendorFilterSql}
      AND ${ftPredicateSql()}${extraWhereSql}
    ORDER BY exact_match DESC, dish_match DESC, category_match DESC, tag_match DESC, orderable DESC, rank DESC, ${secondaryOrder}, p."id" ASC
    LIMIT $3 OFFSET $4;
  `,
    ...baseParams,
    ...filterParams,
  );

  // Phase 2.6: exact union pagination. The full-text total is counted
  // first; the fuzzy pool then excludes full-text hits at SQL level
  // (AND NOT the shared predicate), so the two pools are disjoint by
  // construction: total = ftTotal + fuzzyOnlyTotal exactly, merged pages
  // never exceed `limit`, and each pool's OFFSET advances only its own
  // rows (fuzzyOffset = max(0, offset - ftTotal)).
  const ftTotalResult = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    `
    SELECT COUNT(*)::bigint AS total FROM "Product" p${dishJoin}${categoryJoin}${vendorJoin}
    WHERE p.archived = false${vendorFilterSql} AND ${ftPredicateSql()}${countWhereSql};
  `,
    corrected,
    `%${corrected}%`,
    ...filterParams,
  );
  const ftTotal = Number(ftTotalResult[0]?.total || 0);

  const remaining = limit - fullTextResults.length;
  let fuzzyResults: any[] = [];
  let fuzzyOnlyTotal = 0;
  if (remaining > 0) {
    await prisma.$executeRawUnsafe(
      `SET pg_trgm.similarity_threshold = ${fuzzyThreshold};`,
    );

    // Phase 2 M4: the fuzzy pool covers the same vocabulary as full-text
    // (name + description + dish + category + assigned tag names) so a
    // typo of a category or tag ("vegn") still finds the dish.
    const fuzzyHaystackSql = `p.name || ' ' || p.description || ' ' || d."name" || ' ' || COALESCE(c."name", '') || ' ' || COALESCE((SELECT string_agg(t."name", ' ') FROM "ProductTag" pt JOIN "Tag" t ON t."id" = pt."tagId" WHERE pt."productId" = p.id AND t."isActive" = true), '')`;
    // LIKE operand for fuzzy queries: ('%' || $1 || '%') carries the same
    // value as the full-text $2 LIKE param ($2 here is the threshold).
    const fuzzyLikeRef = `('%' || $1 || '%')`;
    const fuzzyOnlySql = `similarity(${fuzzyHaystackSql}, $1) > $2 AND NOT (${ftPredicateSql(fuzzyLikeRef)})`;
    const fuzzyOffset = Math.max(0, offset - ftTotal);
    const [fuzzyRows, fuzzyCountResult] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(
        `
      SELECT
        ${searchCardColumnsSql},
        similarity(${fuzzyHaystackSql}, $1) AS sim_score,
        ${orderableExpr} AS orderable
      FROM "Product" p${dishJoin}${categoryJoin}${vendorJoin}
      WHERE p.archived = false${vendorFilterSql} AND ${fuzzyOnlySql}${extraWhereSql}
      ORDER BY orderable DESC, sim_score DESC, ${secondaryOrder}, p."id" ASC
      LIMIT $3 OFFSET $4;
    `,
        corrected,
        fuzzyThreshold,
        remaining,
        fuzzyOffset,
        ...filterParams,
      ),
      prisma.$queryRawUnsafe<{ total: bigint }[]>(
        `
      SELECT COUNT(*)::bigint AS total FROM "Product" p${dishJoin}${categoryJoin}${vendorJoin}
      WHERE p.archived = false${vendorFilterSql} AND ${fuzzyOnlySql}${countWhereSql};
    `,
        corrected,
        fuzzyThreshold,
        ...filterParams,
      ),
    ]);
    fuzzyResults = fuzzyRows;
    fuzzyOnlyTotal = Number(fuzzyCountResult[0]?.total || 0);
  }

  // Pools are disjoint by construction (fuzzy excludes full-text hits at
  // SQL level); the id-dedupe below is a no-op safety net against any
  // future predicate drift, and the slice caps the page at `limit`.
  const seen = new Set<string>();
  const deduped = [...fullTextResults, ...fuzzyResults].filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  }).slice(0, limit);

  // B-3: map the raw SQL rows onto the canonical product-card shape, so a
  // search result carries exactly the customer-facing fields a browse
  // result carries (plus the search-specific fields this endpoint has always
  // returned: description, vendorId, archived, timestamps, dishTypeId and
  // the relevance metadata).
  const results = deduped.map(toSearchResult);

  const total = ftTotal + fuzzyOnlyTotal;
  const searchPromos = await loadActiveProductPromos();
  // The cache entry stays promotion-free (3h TTL); promotions resolve fresh.
  const responseData = {
    corrected,
    results,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };

  await redisSearch.set(
    cacheKey,
    JSON.stringify({
      ...responseData,
      [SEARCH_CARD_VERSION_KEY]: SEARCH_CARD_VERSION,
    }),
    {
      EX: CACHE_TTLS.SEARCH,
    },
  );
  return sendSuccess(
    res,
    { ...responseData, results: attachPromotions(results, searchPromos) },
    "Products fetched successfully",
  );
};

// GET /product/p/new
export const getNewProducts = async (req: Request, res: Response) => {
  // B-4: shared pagination parser. A malformed, zero or negative page/limit
  // is rejected with the standard 400 / VALIDATION_ERROR envelope instead of
  // reaching Prisma as an invalid `take`. Above-maximum limits are clamped
  // to the rail maximum (50), the established contract of this route.
  const { page, limit, skip } = parseCatalogPagination(req.query, {
    defaultLimit: RAIL_DEFAULT_LIMIT,
    maxLimit: RAIL_MAX_LIMIT,
  });
  const dishTypeQueryRaw = String(req.query.dishType ?? "").trim();
  const dishTypeQuery = dishTypeQueryRaw === "" ? "ALL" : dishTypeQueryRaw.toUpperCase();
  if (dishTypeQuery !== "ALL") {
    await assertActiveDishType(dishTypeQuery);
  }

  const cacheKey = `products:new:page=${page}:limit=${limit}:dishtype=${dishTypeQuery}`;
  const cached = await redisProducts.get(cacheKey);
  if (cached) {
    const cachedData = JSON.parse(cached);
    res.setHeader("X-Cache", "HIT");
    const promos = await loadActiveProductPromos();
    return sendSuccess(
      res,
      attachPromotions(
        projectPublicVendorList(cachedData.data ?? []) as ProductListItem[],
        promos,
      ),
      "New products fetched successfully",
      200,
      cachedData.pagination,
    );
  }

  const { items, total } = await fetchNewProducts({
    take: limit,
    skip,
    dishType: dishTypeQuery !== "ALL" ? dishTypeQuery : undefined,
  });

  res.setHeader("X-Cache", "MISS");
  const pagination = { total, page, limit, totalPages: Math.ceil(total / limit) };
  await redisProducts.set(cacheKey, JSON.stringify({ data: items, pagination }), {
    EX: CACHE_TTLS.PRODUCTS_MOST_POPULAR,
  });

  const newPromos = await loadActiveProductPromos();
  return sendSuccess(res, attachPromotions(items, newPromos), "New products fetched successfully", 200, pagination);
};

// GET /product/p/most
export const getMostPopularProducts = async (req: Request, res: Response) => {
  // B-4: shared pagination parser. A malformed, zero or negative page/limit
  // is rejected with the standard 400 / VALIDATION_ERROR envelope instead of
  // reaching Prisma as `skip: NaN` / `take: NaN`. Above-maximum limits are
  // clamped to the rail maximum (50), the established contract of this route.
  const { page, limit, skip } = parseCatalogPagination(req.query, {
    defaultLimit: RAIL_DEFAULT_LIMIT,
    maxLimit: RAIL_MAX_LIMIT,
  });

  const cacheKey = CACHE_KEYS.PRODUCTS_MOST_POPULAR(page, limit);
  const cached = await redisProducts.get(cacheKey);

  if (cached) {
    const cachedData = JSON.parse(cached);
    res.setHeader("X-Cache", "HIT");
    const promos = await loadActiveProductPromos();
    return sendSuccess(
      res,
      attachPromotions(
        projectPublicVendorList(cachedData.data ?? []) as ProductListItem[],
        promos,
      ),
      "Most popular products fetched successfully",
      200,
      cachedData.pagination,
    );
  }

  // Most-popular marketplace products (not archived + vendor live +
  // accepting orders), ranked by popularityScore — see
  // fetchMostPopularProducts in product.service.ts, which owns this query
  // so GET /api/home/feed can reuse it verbatim.
  const { products, total: totalCount } = await fetchMostPopularProducts({
    skip,
    take: limit,
  });

  res.setHeader("X-Cache", "MISS");
  const pagination = {
    total: totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
  };

  await redisProducts.set(
    cacheKey,
    JSON.stringify({ data: products, pagination }),
    { EX: CACHE_TTLS.PRODUCTS_MOST_POPULAR },
  );

  const mostPromos = await loadActiveProductPromos();
  return sendSuccess(
    res,
    attachPromotions(products, mostPromos),
    "Most popular products fetched successfully",
    200,
    pagination,
  );
};

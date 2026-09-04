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
  clearProductFromCarts,
  trackProductView,
  fetchProductPage,
  fetchMostPopularProducts,
  fetchNewProducts,
  getActiveDishTypes,
  assertActiveDishType,
  CATALOG_SORT_VALUES,
  type CatalogSortValue,
} from "../services/product.service";
import {
  isVendorOperating,
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
import { correctQuery } from "../AI/localSearchCorrect";
import { logger } from "../lib/logger";
import config from "../config/config";
import { v2 as cloudinary } from "cloudinary";

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

// GET /product/categories — deprecated alias of /product/dish-types.
// Kept so old clients keep working; returns the same dish-type list.
export const getCategories = async (req: Request, res: Response) => {
  return getDishTypes(req, res);
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
  } = parsed.data;

  // Dish type must be a real, active vocabulary entry.
  await assertActiveDishType(dishTypeId);

  // Stock semantics: tracked products need an explicit starting count;
  // untracked products ignore any stock value sent.
  if (trackInventory && stock == null)
    throw new ValidationError("Stock is required when inventory tracking is enabled.");

  // No two add-ons on one product may share a name (case-insensitive) —
  // customers must be able to tell extras apart at a glance.
  const optionNames = options.map((o) => o.name.trim().toLowerCase());
  if (new Set(optionNames).size !== optionNames.length)
    throw new ValidationError("Add-on names must be unique per product.");

  const product = await prisma.product.create({
    data: {
      name: name.trim(),
      description: description.trim(),
      price,
      dishTypeId,
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
    },
    include: { options: true, dishType: true },
  });

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

  return sendCreated(res, { product }, "Product created successfully.");
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
  const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) || "20", 10), 1),
    20,
  );
  const skip = (page - 1) * limit;

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

  // Deterministic cache key: every parameter that can change the result set
  // is represented so two different requests NEVER share a cache entry.
  const filterKey = [
    `sort=${sortBy || "default"}`,
    minPrice != null ? `min=${minPrice}` : "min=none",
    maxPrice != null ? `max=${maxPrice}` : "max=none",
    minRating != null ? `mr=${minRating}` : "mr=none",
    `av=${availableOnly ? 1 : 0}`,
  ].join(":");

  const vendorPart = vendorIdQuery ? `vendor=${vendorIdQuery}:` : "";
  const dishTypePart = `dishtype=${dishTypeQuery}`;
  const cacheKey = `products:all:${vendorPart}${dishTypePart}:page=${page}:limit=${limit}:${filterKey}`;

  const cached = await redisProducts.get(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    const { data, pagination } = JSON.parse(cached);
    return sendSuccess(
      res,
      data,
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

  return sendSuccess(
    res,
    products,
    "Products fetched successfully",
    200,
    pagination,
  );
};

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
    // CRITICAL: Recompute dynamic availability fields on cache hit
    // (vendor live + accepting orders AND product not archived + in stock).
    if (productData.vendor) {
      const vendorOperating = isVendorOperating({
        isLive: productData.vendor.isLive ?? false,
        deliveryPreferences: productData.vendor.deliveryPreferences,
      });
      productData.vendorOperating = vendorOperating;
      productData.orderable =
        vendorOperating &&
        isProductCurrentlyAvailable({
          archived: productData.archived === true,
          trackInventory: productData.trackInventory,
          stock: productData.stock,
        });
    }
    res.setHeader("X-Cache", "HIT");
    return sendSuccess(res, productData, "Product retrieved successfully.");
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
          select: {
            id: true,
            username: true,
            email: true,
            name: true,
            avatarUrl: true,
            role: true,
            bio: true,
            brandName: true,
            brandLogo: true,
            isLive: true,
            deliveryPreferences: true,
          },
        },
        options: {
          where: { isActive: true },
          select: { id: true, name: true, price: true },
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

  const productData = {
    ...product,
    averageRating: reviewStats._avg.rating ?? 0,
    reviewCount: reviewStats._count._all ?? 0,
    vendorOperating,
    orderable,
    soldOut: product.trackInventory === true && (product.stock ?? 0) <= 0,
    vendorRating: vendorReviewStats._avg.rating ?? null,
    vendorReviewCount: vendorReviewStats._count.rating ?? 0,
    // vendor fields (brandName, brandLogo, isLive, deliveryPreferences)
    // are already included via spread from product.vendor select
  };

  await redisProducts.set(cacheKey, JSON.stringify(productData), {
    EX: CACHE_TTLS.PRODUCT_DETAIL,
  });
  res.setHeader("X-Cache", "MISS");

  return sendSuccess(res, productData, "Product retrieved successfully.");
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

  const updateData: Prisma.ProductUpdateInput = {
    ...(name !== undefined && { name: name.trim() }),
    ...(description !== undefined && { description: description.trim() }),
    ...(price !== undefined && { price }),
    ...(dishTypeId !== undefined && { dishTypeId }),
    ...(portionLabel !== undefined && { portionLabel: portionLabel?.trim() || null }),
    ...(resolvedTrackInventory !== undefined && { trackInventory: resolvedTrackInventory }),
    ...(resolvedStock !== undefined && { stock: resolvedStock }),
    ...(archived !== undefined && { archived }),
    images: finalImages,
    video: finalVideo,
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

  const updated = await prisma.$transaction(async (tx) => {
    const updatedProduct = await tx.product.update({
      where: { id: product.id },
      data: updateData,
      include: { options: true },
    });

    if (Array.isArray(options)) {
      // Add-on names must be unique per product (case-insensitive) so
      // customers can tell extras apart.
      const incomingNames = options.map((opt) => opt.name.trim().toLowerCase());
      if (new Set(incomingNames).size !== incomingNames.length)
        throw new ValidationError("Add-on names must be unique per product.");

      const existingOptionIds = product.options.map((opt) => opt.id);
      const incomingOptionIds = options
        .filter((opt) => opt.id)
        .map((opt) => opt.id!);

      // Ownership: an option id may only reference this vendor's product —
      // otherwise Vendor A could rename Vendor B's add-ons.
      if (incomingOptionIds.length > 0) {
        const ownedCount = await tx.productOption.count({
          where: { id: { in: incomingOptionIds }, productId: product.id },
        });
        if (ownedCount !== incomingOptionIds.length)
          throw new ForbiddenError("One or more add-ons do not belong to this product");
      }

      const toDelete = existingOptionIds.filter(
        (id) => !incomingOptionIds.includes(id),
      );

      if (toDelete.length > 0)
        await tx.productOption.deleteMany({
          where: { id: { in: toDelete }, productId: product.id },
        });

      for (const opt of options) {
        if (opt.id) {
          await tx.productOption.update({
            where: { id: opt.id },
            data: {
              name: opt.name.trim(),
              price: opt.price,
              ...(opt.isActive !== undefined && { isActive: opt.isActive }),
            },
          });
        } else {
          await tx.productOption.create({
            data: {
              productId: product.id,
              name: opt.name.trim(),
              price: opt.price,
              isActive: opt.isActive ?? true,
            },
          });
        }
      }
    }

    return updatedProduct;
  });

  productIndexQueue
    .add("indexProduct", { productId: product.id })
    .catch((err) => logger.warn({ err }, "Failed to queue product indexing"));

  await clearProductCache(product.id, req.user!.id);
  await clearProductFromCarts(product.id);

  // Re-read: the transaction's update ran BEFORE the add-on sync above,
  // so `updated` carries pre-sync options. The response (and cache) must
  // reflect what was actually saved.
  const fresh = await prisma.product.findUnique({
    where: { id: product.id },
    include: { options: true, dishType: true },
  });

  const cacheValue = JSON.stringify({
    ...fresh,
    // Customer detail only exposes enabled add-ons — never leak disabled
    // ones through the pre-warmed cache entry.
    options: (fresh?.options ?? []).filter((o) => o.isActive !== false),
    images: finalImages,
    video: finalVideo,
  });
  await redisProducts.set(CACHE_KEYS.PRODUCT_DETAIL(product.id), cacheValue, {
    EX: CACHE_TTLS.PRODUCT_DETAIL,
  });

  const dashboardService = new VendorDashboardService(req.user!.id);
  await dashboardService.invalidateCache();

  return sendSuccess(
    res,
    { ...fresh, images: finalImages, video: finalVideo },
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

  await prisma.product.delete({ where: { id: product.id } });
  await clearProductCache(product.id, req.user.id);
  await clearProductFromCarts(product.id);

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
  const matchWord = (word: string) => ({ OR: [nameMatch(word), dishMatch(word)] });

  const results = isSingleWord
    ? await prisma.product.findMany({
        where: { archived: false, OR: [nameMatch(query), dishMatch(query)] },
        select: {
          id: true,
          name: true,
          dishType: { select: { id: true, name: true } },
        },
        take: 12,
      })
    : await prisma.product.findMany({
        where: { archived: false, AND: keywords.map(matchWord) },
        select: {
          id: true,
          name: true,
          dishType: { select: { id: true, name: true } },
        },
        take: 12,
      });

  // Ranking: exact prefix matches first, then dish-type matches, then
  // general name matches.
  results.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aDish = a.dishType.name.toLowerCase();
    const bDish = b.dishType.name.toLowerCase();
    const aScore =
      (aName.startsWith(query) ? 3 : 0) +
      (aDish.includes(query) ? 2 : 0) +
      (keywords.every((w) => aName.includes(w)) ? 1 : 0);
    const bScore =
      (bName.startsWith(query) ? 3 : 0) +
      (bDish.includes(query) ? 2 : 0) +
      (keywords.every((w) => bName.includes(w)) ? 1 : 0);
    return bScore - aScore;
  });

  const suggestions = results.map((p) => ({
    id: p.id,
    name: p.name,
    dishType: p.dishType,
  }));
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

  const page = parseInt((req.query.page as string) || "1", 10);
  const limit = Math.min(parseInt((req.query.limit as string) || "20", 10), 20);
  const offset = (page - 1) * limit;
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

  const corrected = correctQuery(q);

  // Cache key includes every new filter so different combinations never
  // share an entry.
  const filterKey = [
    dishTypeQuery,
    minPrice != null ? `mp${minPrice}` : "",
    maxPrice != null ? `xp${maxPrice}` : "",
    minRating != null ? `mr${minRating}` : "",
    availableOnlyRaw === "true" ? "av1" : "",
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
      ? ` AND v."isLive" = true AND COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') <> 'false'`
      : "";
  // Dish-type names participate in matching via this join, so "jollof"
  // finds "Smoky Party Rice" when its dishType is JOLLOF.
  const dishJoin = ` JOIN "DishType" d ON d."id" = p."dishTypeId"`;
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
  const filterSql = (baseCount: number) =>
    filterClauses.map((fn, i) => fn(baseCount + i + 1)).join("");
  // Page queries: $1 query, $2 like/threshold, $3 limit, $4 offset.
  const extraWhereSql = filterSql(4);
  // Count query: $1 corrected, $2 like.
  const countWhereSql = filterSql(2);
  const cached = await redisSearch.get(cacheKey);
  if (cached) {
    const data = JSON.parse(cached);
    return sendSuccess(
      res,
      {
        corrected,
        results: data.results,
        pagination: data.pagination,
        fromCache: true,
      },
      "Products fetched successfully",
    );
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

  // Orderability for ranking: vendor live + accepting + not archived +
  // in stock. Relevance still wins — availability only breaks ties below
  // dish/name matches (a closer-but-irrelevant dish must never outrank).
  const orderableExpr = `(v."isLive" = true AND COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') <> 'false' AND p.archived = false AND (NOT p."trackInventory" OR COALESCE(p.stock, 0) > 0))`;

  const fullTextResults = await prisma.$queryRawUnsafe<any[]>(
    `
    SELECT
      p.id, p.name, p.description, p.price, p."vendorId", p.images, p.archived, p."createdAt", p."updatedAt",
      p."dishTypeId", jsonb_build_object('id', d."id", 'name', d."name") AS "dishType",
      ts_rank_cd(setweight(to_tsvector('english', p.name), 'A') || setweight(to_tsvector('english', p.description), 'B'), websearch_to_tsquery('english', $1)) AS rank,
      (p.name ILIKE $2 OR p.description ILIKE $2) AS exact_match,
      (d."name" ILIKE $2) AS dish_match,
      ${orderableExpr} AS orderable
    FROM "Product" p${dishJoin}${vendorJoin}
    WHERE p.archived = false${vendorFilterSql}
      AND (p.tsvector_col @@ websearch_to_tsquery('english', $1) OR p.name ILIKE $2 OR p.description ILIKE $2 OR d."name" ILIKE $2)${extraWhereSql}
    ORDER BY exact_match DESC, dish_match DESC, orderable DESC, rank DESC, ${secondaryOrder}
    LIMIT $3 OFFSET $4;
  `,
    ...baseParams,
    ...filterParams,
  );

  let fuzzyResults: any[] = [];
  if (fullTextResults.length < limit) {
    await prisma.$executeRawUnsafe(
      `SET pg_trgm.similarity_threshold = ${fuzzyThreshold};`,
    );

    fuzzyResults = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        p.id, p.name, p.description, p.price, p."vendorId", p.images, p.archived, p."createdAt", p."updatedAt",
        p."dishTypeId", jsonb_build_object('id', d."id", 'name', d."name") AS "dishType",
        similarity(p.name || ' ' || p.description || ' ' || d."name", $1) AS sim_score,
        ${orderableExpr} AS orderable
      FROM "Product" p${dishJoin}${vendorJoin}
      WHERE p.archived = false${vendorFilterSql} AND similarity(p.name || ' ' || p.description || ' ' || d."name", $1) > $2${extraWhereSql}
      ORDER BY orderable DESC, sim_score DESC, ${secondaryOrder}
      LIMIT $3 OFFSET $4;
    `,
      corrected,
      fuzzyThreshold,
      limit,
      offset,
      ...filterParams,
    );
  }

  const seen = new Set<string>();
  const results = [...fullTextResults, ...fuzzyResults].filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const totalResult = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    `
    SELECT COUNT(*)::bigint AS total FROM "Product" p${dishJoin}${vendorJoin}
    WHERE p.archived = false${vendorFilterSql} AND (p.tsvector_col @@ websearch_to_tsquery('english', $1) OR p.name ILIKE $2 OR p.description ILIKE $2 OR d."name" ILIKE $2)${countWhereSql};
  `,
    corrected,
    `%${corrected}%`,
    ...filterParams,
  );

  const total = Number(totalResult[0]?.total || 0);
  const responseData = {
    corrected,
    results,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };

  await redisSearch.set(cacheKey, JSON.stringify(responseData), {
    EX: CACHE_TTLS.SEARCH,
  });
  return sendSuccess(res, responseData, "Products fetched successfully");
};

// GET /product/p/new
export const getNewProducts = async (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "20", 10), 50);
  const dishTypeQueryRaw = String(req.query.dishType ?? "").trim();
  const dishTypeQuery = dishTypeQueryRaw === "" ? "ALL" : dishTypeQueryRaw.toUpperCase();
  if (dishTypeQuery !== "ALL") {
    await assertActiveDishType(dishTypeQuery);
  }

  const cacheKey = `products:new:limit=${limit}:dishtype=${dishTypeQuery}`;
  const cached = await redisProducts.get(cacheKey);
  if (cached) {
    const cachedData = JSON.parse(cached);
    res.setHeader("X-Cache", "HIT");
    return sendSuccess(
      res,
      cachedData.data,
      "New products fetched successfully",
      200,
      cachedData.pagination,
    );
  }

  const { items, total } = await fetchNewProducts({
    take: limit,
    dishType: dishTypeQuery !== "ALL" ? dishTypeQuery : undefined,
  });

  res.setHeader("X-Cache", "MISS");
  const pagination = { total, page: 1, limit, totalPages: Math.ceil(total / limit) };
  await redisProducts.set(cacheKey, JSON.stringify({ data: items, pagination }), {
    EX: CACHE_TTLS.PRODUCTS_MOST_POPULAR,
  });

  return sendSuccess(res, items, "New products fetched successfully", 200, pagination);
};

// GET /product/p/most
export const getMostPopularProducts = async (req: Request, res: Response) => {
  const page = parseInt((req.query.page as string) || "1", 10);
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 50);
  const skip = (page - 1) * limit;

  const cacheKey = CACHE_KEYS.PRODUCTS_MOST_POPULAR(page, limit);
  const cached = await redisProducts.get(cacheKey);

  if (cached) {
    const cachedData = JSON.parse(cached);
    res.setHeader("X-Cache", "HIT");
    return sendSuccess(
      res,
      cachedData.data,
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

  return sendSuccess(
    res,
    products,
    "Most popular products fetched successfully",
    200,
    pagination,
  );
};

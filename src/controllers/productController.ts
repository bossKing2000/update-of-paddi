import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { ensureString } from "../utils/paramUtils";
import { AuthRequest } from "../middlewares/auth.middleware";
import {
  archiveProductSchema,
  createProductSchema,
  updateProductSchema,
} from "../validations/ProductCRUDSchema";
import { Category, Prisma } from "@prisma/client";
import { redisProducts, redisSearch } from "../lib/redis";
import { scanKeys } from "../lib/redisScan";
import {
  clearProductFromCarts,
  trackProductView,
  fetchProductPage,
  fetchMostPopularProducts,
  CATALOG_SORT_VALUES,
  type CatalogSortValue,
} from "../services/product.service";
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

/**
 * Single source of truth for computing whether a product is currently
 * purchasable, given its schedule. Previously this exact logic was
 * copy-pasted three separate times across this file (here, inside
 * getAllProducts, and inside getProductById) with slightly different
 * signatures each time — a maintenance risk, since a future change to the
 * grace-period rules would need to be remembered in three places to stay
 * consistent. Every function below now calls this one.
 */
export const computeIsLive = (
  schedule:
    | {
        goLiveAt?: Date | string | null;
        takeDownAt?: Date | string | null;
        graceMinutes?: number | null;
      }
    | null
    | undefined,
  defaultIsLive: boolean,
): boolean => {
  if (!schedule) return defaultIsLive;

  const now = Date.now();
  const goLive = schedule.goLiveAt ? new Date(schedule.goLiveAt).getTime() : 0;
  const takeDown = schedule.takeDownAt
    ? new Date(schedule.takeDownAt).getTime()
    : 0;
  const grace = (schedule.graceMinutes ?? 0) * 60 * 1000;

  if (!goLive || !takeDown) return defaultIsLive;
  return now >= goLive && now <= takeDown + grace;
};

// GET /product/categories
// Previously didn't exist at all — the cache key/TTL for it (CACHE_KEYS.
// CATEGORIES_ALL) were already defined and unused. The Flutter app had no
// way to fetch valid category options except hardcoding the enum client-side.
export const getCategories = async (_req: Request, res: Response) => {
  const cached = await redisProducts.get(CACHE_KEYS.CATEGORIES_ALL);
  if (cached) {
    return sendSuccess(
      res,
      { categories: JSON.parse(cached) },
      "Categories fetched (cache)",
    );
  }

  const categories = Object.values(Category);
  await redisProducts.set(
    CACHE_KEYS.CATEGORIES_ALL,
    JSON.stringify(categories),
    { EX: CACHE_TTLS.CATEGORIES_ALL },
  );
  return sendSuccess(res, { categories }, "Categories fetched");
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

  const {
    name,
    description,
    price,
    category,
    archived,
    options = [],
  } = parsed.data;

  const product = await prisma.product.create({
    data: {
      name,
      description,
      price,
      archived: archived ?? false,
      category,
      images: imageUrls,
      video: videoUrls,
      thumbnail: imageUrls[0],
      vendorId: req.user.id,
      options: { create: options },
    },
    include: { options: true },
  });

  productIndexQueue
    .add("indexProduct", { productId: product.id })
    .catch((err) => logger.warn({ err }, "Failed to queue product indexing"));

  // Broad invalidation (SCAN-based, safe at scale — see clearProductCache)
  // instead of trying to precisely rebuild just the pages a new product
  // might land on. A new product's rank among "isLive first, then
  // newest" could put it on any page depending on catalog size, so
  // guessing which single page to pre-warm isn't reliable anyway — next
  // read just repopulates whichever page is actually requested.
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
  category: Category;
  isLive: boolean;
  goLiveAt: Date | null;
  liveUntil: Date | null;
  popularityPercent?: number | null;
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

  const categoryQuery = (req.query.category as string)?.toUpperCase();
  const vendorIdQuery = req.query.vendorId as string | undefined;

  if (categoryQuery && categoryQuery !== "ALL") {
    if (!Object.values(Category).includes(categoryQuery as Category)) {
      throw new ValidationError(
        `Invalid category. Valid options: ${Object.values(Category).join(", ")}`,
      );
    }
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

  const filterKey = [
    sortBy || "",
    minPrice != null ? `mp${minPrice}` : "",
    maxPrice != null ? `xp${maxPrice}` : "",
    availableOnly ? "av1" : "",
  ]
    .filter(Boolean)
    .join("-");

  const cacheKey = vendorIdQuery
    ? `products:vendor:${vendorIdQuery}:category=${categoryQuery ?? "ALL"}:page=${page}:limit=${limit}${filterKey ? `:f=${filterKey}` : ""}`
    : `${CACHE_KEYS.PRODUCTS_ALL(page, limit)}${filterKey ? `:f=${filterKey}` : ""}`;

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
      category: categoryQuery && categoryQuery !== "ALL" ? categoryQuery : undefined,
      vendorId: vendorIdQuery,
      sortBy: sortBy || undefined,
      minPrice,
      maxPrice,
      availableOnly,
    }),
  ]);

  const products: ProductResponse[] = dbResult.products.map((p) => ({
    ...p,
    category: p.category as ProductResponse["category"],
  }));

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
    productData.isLive = computeIsLive(
      productData.productSchedule,
      productData.isLive,
    );
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
        video: true,
        createdAt: true,
        updatedAt: true,
        totalViews: true,
        category: true,
        isLive: true,
        liveUntil: true,
        popularityScore: true,
        vendor: {
          select: {
            id: true,
            username: true,
            email: true,
            name: true,
            avatarUrl: true,
            role: true,
            bio: true,
          },
        },
        options: true,
        productSchedule: {
          select: {
            goLiveAt: true,
            takeDownAt: true,
            graceMinutes: true,
            isLive: true,
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

  const productData = {
    ...product,
    averageRating: reviewStats._avg.rating ?? 0,
    reviewCount: reviewStats._count._all ?? 0,
    isLive: computeIsLive(product.productSchedule, product.isLive),
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
    include: { options: true, productSchedule: true },
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
    category,
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

  const updateData: Prisma.ProductUpdateInput = {
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(price !== undefined && { price }),
    ...(category !== undefined && { category }),
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
      include: { options: true, productSchedule: true },
    });

    if (Array.isArray(options)) {
      const existingOptionIds = product.options.map((opt) => opt.id);
      const incomingOptionIds = options
        .filter((opt) => opt.id)
        .map((opt) => opt.id!);
      const toDelete = existingOptionIds.filter(
        (id) => !incomingOptionIds.includes(id),
      );

      if (toDelete.length > 0)
        await tx.productOption.deleteMany({ where: { id: { in: toDelete } } });

      for (const opt of options) {
        if (opt.id) {
          await tx.productOption.update({
            where: { id: opt.id },
            data: { name: opt.name, price: opt.price },
          });
        } else {
          await tx.productOption.create({
            data: { productId: product.id, name: opt.name, price: opt.price },
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

  const computedIsLive = computeIsLive(updated.productSchedule, updated.isLive);
  const cacheValue = JSON.stringify({
    ...updated,
    images: finalImages,
    video: finalVideo,
    isLive: computedIsLive,
  });
  await redisProducts.set(CACHE_KEYS.PRODUCT_DETAIL(product.id), cacheValue, {
    EX: CACHE_TTLS.PRODUCT_DETAIL,
  });

  const dashboardService = new VendorDashboardService(req.user!.id);
  await dashboardService.invalidateCache();

  return sendSuccess(
    res,
    { ...updated, images: finalImages, video: finalVideo },
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
    include: { productSchedule: true },
  });
  if (!product || product.vendorId !== req.user.id)
    throw new ForbiddenError("Unauthorized or product not found");

  const updated = await prisma.product.update({
    where: { id: productId },
    data: { archived },
    include: { productSchedule: true },
  });

  productIndexQueue
    .add("indexProduct", { productId })
    .catch((err) => logger.warn({ err }, "Failed to queue product indexing"));
  await clearProductCache(productId, req.user.id);
  await clearProductFromCarts(productId);

  const computedIsLive = computeIsLive(updated.productSchedule, updated.isLive);
  await redisProducts.set(
    CACHE_KEYS.PRODUCT_DETAIL(productId),
    JSON.stringify({ ...updated, isLive: computedIsLive }),
    { EX: CACHE_TTLS.PRODUCT_DETAIL },
  );

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

  const results = isSingleWord
    ? await prisma.product.findMany({
        where: {
          archived: false,
          name: { contains: query, mode: "insensitive" },
        },
        select: { id: true, name: true, category: true, isLive: true },
        take: 12,
      })
    : await prisma.product.findMany({
        where: {
          archived: false,
          AND: keywords.map((word) => ({
            name: { contains: word, mode: "insensitive" as const },
          })),
        },
        select: { id: true, name: true, category: true, isLive: true },
        take: 12,
      });

  // Ranking: live products first, then exact prefix matches, then general matches
  results.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aScore =
      (a.isLive ? 3 : 0) +
      (aName.startsWith(query) ? 2 : 0) +
      (keywords.every((w) => aName.includes(w)) ? 1 : 0);
    const bScore =
      (b.isLive ? 3 : 0) +
      (bName.startsWith(query) ? 2 : 0) +
      (keywords.every((w) => bName.includes(w)) ? 1 : 0);
    return bScore - aScore;
  });

  const suggestions = results.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    isLive: p.isLive,
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
  isLive: boolean;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  computedIsLive: boolean;
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

  const categoryQuery = (req.query.category as string)?.toUpperCase();
  if (categoryQuery && categoryQuery !== "ALL") {
    if (!Object.values(Category).includes(categoryQuery as Category)) {
      throw new ValidationError(
        `Invalid category. Valid options: ${Object.values(Category).join(", ")}`,
      );
    }
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
    categoryQuery ?? "",
    minPrice != null ? `mp${minPrice}` : "",
    maxPrice != null ? `xp${maxPrice}` : "",
    availableOnlyRaw === "true" ? "av1" : "",
  ]
    .filter(Boolean)
    .join("-");

  const cacheKey =
    CACHE_KEYS.SEARCH(corrected, sortBy, undefined, page, limit) +
    (filterKey ? `:f=${filterKey}` : "");

  // ── Dynamic discovery filters (category / price / availability) ──
  // Category is whitelist-validated against the enum; prices are validated
  // numbers. Both are safe to interpolate after validation.
  const vendorJoin =
    availableOnlyRaw === "true"
      ? ` JOIN "User" v ON v."id" = p."vendorId" AND v."isLive" = true AND COALESCE(v."deliveryPreferences" ->> 'acceptingOrders', 'true') <> 'false'`
      : "";
  const extraWhereSql =
    (categoryQuery && categoryQuery !== "ALL"
      ? ` AND p."category"::text = '${categoryQuery}'`
      : "") +
    (minPrice != null ? ` AND p.price >= ${minPrice}` : "") +
    (maxPrice != null ? ` AND p.price <= ${maxPrice}` : "");
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
    case "newest":
      secondaryOrder = `"createdAt" DESC`;
      break;
  }

  const fullTextResults = await prisma.$queryRawUnsafe<any[]>(
    `
    SELECT
      p.id, p.name, p.description, p.price, p."vendorId", p.images, p."isLive", p.archived, p."createdAt", p."updatedAt",
      CASE
        WHEN s."goLiveAt" IS NOT NULL AND s."takeDownAt" IS NOT NULL
          THEN (now() >= s."goLiveAt" AND now() <= s."takeDownAt" + (s."graceMinutes" * interval '1 minute'))
        ELSE p."isLive"
      END AS "computedIsLive",
      ts_rank_cd(setweight(to_tsvector('english', p.name), 'A') || setweight(to_tsvector('english', p.description), 'B'), websearch_to_tsquery('english', $1)) AS rank,
      (p.name ILIKE $2 OR p.description ILIKE $2) AS exact_match
    FROM "Product" p${vendorJoin}
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
    WHERE p.archived = false
      AND (p.tsvector_col @@ websearch_to_tsquery('english', $1) OR p.name ILIKE $2 OR p.description ILIKE $2)${extraWhereSql}
    ORDER BY exact_match DESC, "computedIsLive" DESC, rank DESC, ${secondaryOrder}
    LIMIT $3 OFFSET $4;
  `,
    corrected,
    `%${corrected}%`,
    limit,
    offset,
  );

  let fuzzyResults: any[] = [];
  if (fullTextResults.length < limit) {
    await prisma.$executeRawUnsafe(
      `SET pg_trgm.similarity_threshold = ${fuzzyThreshold};`,
    );

    fuzzyResults = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        p.id, p.name, p.description, p.price, p."vendorId", p.images, p."isLive", p.archived, p."createdAt", p."updatedAt",
        CASE
          WHEN s."goLiveAt" IS NOT NULL AND s."takeDownAt" IS NOT NULL
            THEN (now() >= s."goLiveAt" AND now() <= s."takeDownAt" + (s."graceMinutes" * interval '1 minute'))
          ELSE p."isLive"
        END AS "computedIsLive",
        similarity(p.name || ' ' || p.description, $1) AS sim_score
      FROM "Product" p${vendorJoin}
      LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
      WHERE p.archived = false AND similarity(p.name || ' ' || p.description, $1) > $2${extraWhereSql}
      ORDER BY "computedIsLive" DESC, sim_score DESC, ${secondaryOrder}
      LIMIT $3 OFFSET $4;
    `,
      corrected,
      fuzzyThreshold,
      limit,
      offset,
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
    SELECT COUNT(*)::bigint AS total FROM "Product" p${vendorJoin}
    WHERE p.archived = false AND (p.tsvector_col @@ websearch_to_tsquery('english', $1) OR p.name ILIKE $2 OR p.description ILIKE $2)${extraWhereSql};
  `,
    corrected,
    `%${corrected}%`,
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

  // Filtered by isLive directly in SQL (both the page query and the count
  // query) rather than fetching a page of "archived = false" rows and
  // filtering out non-live ones in JS afterward. isLive is kept reasonably
  // fresh by fixLiveStatusJob (runs every 5 minutes) — see
  // fetchMostPopularProducts in product.service.ts, which now owns this
  // query so GET /api/home/feed can reuse it verbatim.
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

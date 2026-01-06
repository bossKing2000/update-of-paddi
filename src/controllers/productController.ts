import {Request, Response } from "express";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import {archiveProductSchema, createProductSchema, updateProductSchema} from "../validations/ProductCRUDSchema";
import {Category} from "@prisma/client";
import {redisProducts, redisSearch } from "../lib/redis";
import {clearProductFromCarts, trackProductView } from "../services/product.service";
import { CACHE_KEYS, CACHE_TTLS } from "../services/redisCacheTiming";
import { productIndexQueue } from "../jobs/workers jobs/redis-baseQueue";
import { errorResponse, successResponse } from "../validators/codeMessage";
import { VendorDashboardService } from "./vendorDashboard.service";
import { clearProductCache } from "../services/clearCaches";
import { correctQuery } from "../AI/localSearchCorrect";
import config from "../config/config";
import { v2 as cloudinary } from 'cloudinary';


// Initialize Cloudinary from URL
cloudinary.config(config.cloudinaryUrl);

// Helper function to extract Cloudinary public ID
function extractPublicId(url: string): string | null {
  // Example: https://res.cloudinary.com/drxzx8cpu/image/upload/v1766331615/food-paddi/1766331608176-product_image_1766331606606_0.jpg.jpg
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)\.(?:jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv|webm)/i);
  return match ? match[1] : null;
}

// Cloudinary cleanup function (async, non-blocking)
async function cleanupCloudinaryAssets(images: string[], video: string | null): Promise<void> {
  try {
    // Delete images
    for (const imageUrl of images) {
      const publicId = extractPublicId(imageUrl);
      if (publicId) {
        await cloudinary.uploader.destroy(publicId);
        console.log(`🗑️ Deleted image from Cloudinary: ${publicId}`);
      }
    }
    
    // Delete video
    if (video) {
      const videoPublicId = extractPublicId(video);
      if (videoPublicId) {
        await cloudinary.uploader.destroy(videoPublicId, { resource_type: 'video' });
        console.log(`🗑️ Deleted video from Cloudinary: ${videoPublicId}`);
      }
    }
  } catch (error) {
    console.error('Cloudinary cleanup failed:', error);
    // Don't throw - cleanup failures shouldn't fail the main update
  }
}

// Helper functions for file extraction
function extractImagePaths(files: any): string[] {
  if (!files || typeof files !== "object" || !("images" in files)) return [];
  const imageFiles = (files as { [fieldname: string]: Express.Multer.File[] })["images"];
  return imageFiles.map((file) => file.path);
}

function extractVideoPaths(files: any): string[] {
  if (!files || typeof files !== "object" || !("video" in files)) return [];
  const videoFiles = (files as { [fieldname: string]: Express.Multer.File[] })["video"];
  return videoFiles.map((file) => file.path);
}

// Helper: compute live status for products (only define once!)
export const computeIsLive = (
  schedule: { goLiveAt?: Date | string; takeDownAt?: Date | string; graceMinutes?: number } | null | undefined,
  defaultIsLive: boolean
) => {
  if (!schedule) return defaultIsLive;

  const now = Date.now();
  const goLive = schedule.goLiveAt ? new Date(schedule.goLiveAt).getTime() : 0;
  const takeDown = schedule.takeDownAt ? new Date(schedule.takeDownAt).getTime() : 0;
  const grace = (schedule?.graceMinutes ?? 0) * 60 * 1000;

  if (!goLive || !takeDown) return defaultIsLive;

  return now >= goLive && now <= takeDown + grace;
};

/**
 * Create a new product (vendor only)
 * - Validates input
 * - Saves to DB
 * - Rebuilds relevant cached product pages and category caches
 */
export const createProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // ── Authorization ────────────────────────────────────────────────
    if (!req.user || req.user.role !== "VENDOR") {
      res.status(403).json(errorResponse("UNAUTHORIZED", "Only vendors can create products."));
      return;
    }

    // ── Parse options field if sent as JSON string ───────────────────
    if (typeof req.body.options === "string") {
      try {
        req.body.options = JSON.parse(req.body.options);
      } catch {
        res.status(400).json(errorResponse("INVALID_INPUT", "Invalid JSON in options field."));
        return;
      }
    }

    // ── Validate request body with Zod ───────────────────────────────
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(
        errorResponse("VALIDATION_FAILED", JSON.stringify(parsed.error.issues, null, 2))
      );
      return;
    }

    // ── Extract file uploads ─────────────────────────────────────────
    const imageUrls = extractImagePaths(req.files);
    const videoUrls = extractVideoPaths(req.files);

    if (imageUrls.length < 1 || imageUrls.length > 6) {
      res.status(400).json(
        errorResponse("INVALID_IMAGE_COUNT", "Please upload between 1 and 6 images.")
      );
      return;
    }

    const {
      name,
      description,
      price,
      category,
      archived,      
      options = [],
    } = parsed.data;

    // ── Create product in DB ─────────────────────────────────────────
    const product = await prisma.product.create({
      data: {
        name,
        description,
        price,
        archived: archived ?? false,
        category,
        images: imageUrls,
        video: videoUrls,
        vendorId: req.user.id,
        options: { create: options },
      },
      include: { options: true },
    });


        // ── AUTO-SET THUMBNAIL (ADD THIS) ────────────────────────────────
    // If images exist but thumbnail is null/empty, set it to first image
    if (imageUrls.length > 0) {
      await prisma.product.update({
        where: { id: product.id },
        data: { thumbnail: imageUrls[0] },
      });
      console.log(`📸 Auto-set thumbnail for new product: ${product.id}`);
    }


    // ── SMART CACHE UPDATE ───────────────────────────────────────────
    const firstPageKey = CACHE_KEYS.PRODUCTS_ALL(1, 20);
    const categoryKey = `products:category:${category.toUpperCase()}:page=1:limit=20`;

    // Helper to rebuild cache for first page + category
    const rebuildCache = async (key: string, whereClause?: any) => {
      const total = await prisma.product.count({ where: whereClause });
      const products = await prisma.product.findMany({
        where: whereClause,
        take: 20,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          price: true,
          images: true,
          averageRating: true,
          reviewCount: true,
          popularityScore: true,
          popularityPercent: true,
          totalViews: true,
          category: true,
        },
      });

      await redisProducts.set(
        key,
        JSON.stringify({
          data: products,
          pagination: {
            total,
            page: 1,
            limit: 20,
            totalPages: Math.ceil(total / 20),
          },
        }),
        { EX: CACHE_TTLS.PRODUCTS_ALL }
      );
    };

    await Promise.all([
      rebuildCache(firstPageKey),
      rebuildCache(categoryKey, { category }),
      clearProductCache(product.id), // invalidate detail cache if any exists
    ]);

    // ── Invalidate search suggestions cache ──────────────────────────
    const suggestionKeys = await redisSearch.keys("suggestions:*");
    if (suggestionKeys.length) await redisSearch.del(suggestionKeys);

    // ── Send success response ────────────────────────────────────────
    res
      .status(201)
      .json(successResponse("PRODUCT_CREATED", "Product created successfully.", product));
  } catch (err) {
    console.error("Create product error:", err);
    res.status(500).json(errorResponse("SERVER_ERROR", "Server error."));
  }
};


interface ProductResponse {
  id: string;
  name: string;
  price: number;
  images: string[]; // max 1 image
  category: Category;
  isLive: boolean;
  goLiveAt: Date | null;
  liveUntil: Date | null;
  popularityPercent?: number;
}


export const getAllProducts = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    /* -------------------- PAGINATION -------------------- */
    const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || "20", 10), 1),
      20
    );
    const skip = (page - 1) * limit;

    /* -------------------- CATEGORY FILTER -------------------- */
    const categoryQuery = (req.query.category as string)?.toUpperCase();
    const where: any = { archived: false };

    if (categoryQuery && categoryQuery !== "ALL") {
      if (!Object.values(Category).includes(categoryQuery as Category)) {
        res.status(400).json(
          errorResponse(
            "INVALID_CATEGORY",
            `Invalid category. Valid options: ${Object.values(Category).join(", ")}`
          )
        );
        return;
      }
      where.category = categoryQuery as Category;
    }

    /* -------------------- LIVE STATUS COMPUTATION -------------------- */
    const computeIsLive = (
      goLiveAt: Date | null,
      liveUntil: Date | null,
      graceMinutes: number | null,
      fallback: boolean
    ): boolean => {
      if (!goLiveAt || !liveUntil) return fallback;

      const now = Date.now();
      const grace = (graceMinutes ?? 0) * 60 * 1000;

      return (
        now >= new Date(goLiveAt).getTime() &&
        now <= new Date(liveUntil).getTime() + grace
      );
    };

    /* -------------------- CACHE KEY -------------------- */
    const cacheKey =
      categoryQuery && categoryQuery !== "ALL"
        ? `products:category:${categoryQuery}:all`
        : "products:all:all";

    let allProducts: ProductResponse[];
    let totalCount: number;

    /* -------------------- STEP 1: CACHE / DB -------------------- */
    const cached = await redisProducts.get(cacheKey);

    if (cached) {
      const parsed = JSON.parse(cached);
      allProducts = parsed.products;
      totalCount = parsed.total;
      res.setHeader("X-Cache", "HIT");
    } else {
      const dbProducts = await prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          price: true,
          category: true,
          thumbnail: true,
          images: true,
          popularityPercent: true,
          isLive: true,
          productSchedule: {
            select: {
              goLiveAt: true,
              takeDownAt: true,
              graceMinutes: true,
            },
          },
        },
      });

      allProducts = dbProducts.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        category: p.category,
        images: p.thumbnail
          ? [p.thumbnail]
          : p.images.length > 0
          ? [p.images[0]]
          : [],
        popularityPercent: p.popularityPercent,
        isLive: computeIsLive(
          p.productSchedule?.goLiveAt ?? null,
          p.productSchedule?.takeDownAt ?? null,
          p.productSchedule?.graceMinutes ?? null,
          p.isLive
        ),
        goLiveAt: p.productSchedule?.goLiveAt || null,
        liveUntil: p.productSchedule?.takeDownAt || null,
      }));

      totalCount = allProducts.length;

      await redisProducts.set(
        cacheKey,
        JSON.stringify({ products: allProducts, total: totalCount }),
        { EX: CACHE_TTLS.PRODUCTS_ALL }
      );

      res.setHeader("X-Cache", "MISS");
    }

    /* -------------------- STEP 2: SORT (LIVE FIRST) -------------------- */
    allProducts.sort((a, b) => Number(b.isLive) - Number(a.isLive));

    /* -------------------- STEP 3: PAGINATE -------------------- */
    const paginated = allProducts.slice(skip, skip + limit);

    /* -------------------- PAGINATION META -------------------- */
    const pagination = {
      total: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
    };

    /* -------------------- RESPONSE -------------------- */
    res.json(
      successResponse(
        "PRODUCT_LIST",
        "Products fetched successfully",
        paginated,
        pagination
      )
    );
  } catch (err) {
    console.error("❌ getAllProducts error:", err);
    await clearProductCache();
    res
      .status(500)
      .json(errorResponse("SERVER_ERROR", "Internal server error"));
  }
};


export const getProductById = async (req: AuthRequest, res: Response): Promise<void> => {
    const productId = req.params.id; // ← move outside try
  try {
    const productId = req.params.id;
    const cacheKey = CACHE_KEYS.PRODUCT_DETAIL(productId);
    const ttl = CACHE_TTLS.PRODUCT_DETAIL;

    // 🔹 Helper: compute live status dynamically
    const computeIsLive = (schedule: any, defaultIsLive: boolean) => {
      if (!schedule) return defaultIsLive;

      const now = Date.now();

      // Convert string dates back to Date if needed
      const goLive = schedule.goLiveAt ? new Date(schedule.goLiveAt).getTime() : 0;
      const takeDown = schedule.takeDownAt ? new Date(schedule.takeDownAt).getTime() : 0;
      const grace = (schedule.graceMinutes ?? 0) * 60 * 1000;

      if (!goLive || !takeDown) return defaultIsLive;

      return now >= goLive && now <= takeDown + grace;
    };

    // 🔹 Track total views asynchronously; non-blocking
    trackProductView(productId).catch(console.error);

    // 🔹 Try to serve from cache first
    let cached = await redisProducts.get(cacheKey);
    let productData;

    if (cached) {
      productData = JSON.parse(cached);

      // 🔹 Recompute isLive dynamically for cached data
      productData.isLive = computeIsLive(productData.productSchedule, productData.isLive);

      res.setHeader("X-Cache", "HIT");
      res.status(200).json(
        successResponse("PRODUCT_FETCHED", "Product retrieved successfully.", productData)
      );
      return;
    }

    // 🔹 Fetch product and review stats in parallel
    const [product, reviewStats] = await Promise.all([
      prisma.product.findFirst({
        where: { id: productId, archived: false }, // hide archived products
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
          isLive: true, // default live flag
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

    // 🔹 Handle product not found or archived
    if (!product) {
      res.status(404).json(errorResponse("NOT_FOUND", "Product not found."));
      return;
    }

    // 🔹 Compute live state dynamically
    const computedIsLive = computeIsLive(product.productSchedule, product.isLive);

    // 🔹 Build product data object for response
    productData = {
      ...product,
      averageRating: reviewStats._avg.rating ?? 0,
      reviewCount: reviewStats._count._all ?? 0,
      isLive: computedIsLive,
    };

    // 🔹 Cache the result in Redis
    await redisProducts.set(cacheKey, JSON.stringify(productData), { EX: ttl });
    res.setHeader("X-Cache", "MISS");

    // 🔹 Send success response
    res.status(200).json(
      successResponse("PRODUCT_FETCHED", "Product retrieved successfully.", productData)
    );
  } catch (err) {
    console.error("Get product by ID error:", err);

    // 🔹 Clear related product cache if a server error occurs
    await clearProductCache(productId);

    res.status(500).json(errorResponse("SERVER_ERROR", "Server error."));
  }
};

// ==========================================================
// ✅ PRODUCTION-READY UPDATE PRODUCT CONTROLLER
// ==========================================================
export const updateProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  const productId = req.params.id;

  try {
    // 1. AUTHENTICATION & AUTHORIZATION
    if (!req.user || req.user.role !== "VENDOR") {
      res.status(403).json(errorResponse("UNAUTHORIZED", "Only vendors can update products"));
      return;
    }

    // 2. GET CURRENT PRODUCT
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { options: true, productSchedule: true },
    });

    if (!product || product.vendorId !== req.user.id) {
      res.status(403).json(errorResponse("FORBIDDEN", "Unauthorized or product not found"));
      return;
    }

    // 3. PARSE JSON FIELDS (for backward compatibility)
    const jsonFields = ['options', 'imageUpdates', 'videoUpdates', 'images', 'video'];
    jsonFields.forEach(field => {
      if (typeof req.body[field] === "string") {
        try {
          req.body[field] = JSON.parse(req.body[field]);
        } catch (error) {
          console.warn(`Failed to parse ${field} as JSON:`, error);
          // Keep as is, validation will catch invalid format
        }
      }
    });

    // 4. VALIDATE INPUT
    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      console.error('Validation error:', parsed.error);
      res.status(400).json(errorResponse("VALIDATION_ERROR", "Validation failed: check your input fields."));
      return;
    }

    // 5. EXTRACT UPLOADED FILES
    const uploadedImageUrls = extractImagePaths(req.files);
    const uploadedVideoUrls = extractVideoPaths(req.files);

    const { 
      name, 
      description, 
      price, 
      category, 
      archived,
      options, 
      images: oldImagesFormat, // For backward compatibility
      video: oldVideoFormat,   // For backward compatibility
      imageUpdates, 
      videoUpdates 
    } = parsed.data;

    // Debug logging
    console.log('🔍 DEBUG - Update details:');
    console.log('  isUsingOldFormat:', oldImagesFormat !== undefined || oldVideoFormat !== undefined);
    console.log('  isUsingNewFormat:', imageUpdates !== undefined || videoUpdates !== undefined);
    console.log('  oldImagesFormat:', oldImagesFormat);
    console.log('  uploadedImageUrls:', uploadedImageUrls);
    console.log('  oldVideoFormat:', oldVideoFormat);
    console.log('  uploadedVideoUrls:', uploadedVideoUrls);

    // 6. DETERMINE UPDATE FORMAT (old vs new)
    const isUsingOldFormat = oldImagesFormat !== undefined || oldVideoFormat !== undefined;
    const isUsingNewFormat = imageUpdates !== undefined || videoUpdates !== undefined;

    if (isUsingOldFormat && isUsingNewFormat) {
      res.status(400).json(errorResponse(
        "CONFLICTING_FORMATS", 
        "Cannot use both old format (images/video arrays) and new format (imageUpdates/videoUpdates)"
      ));
      return;
    }

    // ============================================
    // ✅ SMART IMAGE HANDLING - FIXED
    // ============================================
    let finalImages: string[] = [];
    let imagesToDeleteFromCloudinary: string[] = [];

    if (isUsingOldFormat) {
      // 📌 BACKWARD COMPATIBILITY: Old format (images array)
      // Merge existing images with newly uploaded images
      const existingImages = oldImagesFormat || [];
      finalImages = [
        ...existingImages,
        ...uploadedImageUrls
      ].slice(0, 6); // Max 6 images
      
      console.log(`📸 Old format: ${existingImages.length} existing + ${uploadedImageUrls.length} new = ${finalImages.length} total images`);
      
      // Mark images for deletion if they're being replaced
      if (existingImages.length > 0 && product.images) {
        // Only mark for deletion if images are being removed from the array
        imagesToDeleteFromCloudinary = product.images.filter(img => !existingImages.includes(img));
      }
    } else if (imageUpdates) {
      // 📌 NEW FORMAT: Smart image updates
      const { keep = [], delete: toDelete = [] } = imageUpdates;
      const currentImages = product.images || [];

      // Validate "keep" images exist in current product
      const invalidKeep = keep.filter(url => !currentImages.includes(url));
      if (invalidKeep.length > 0) {
        res.status(400).json(errorResponse(
          "INVALID_IMAGES", 
          `Some images to keep don't exist in product: ${invalidKeep.slice(0, 3).join(', ')}${invalidKeep.length > 3 ? '...' : ''}`
        ));
        return;
      }

      // Validate "delete" images exist in current product
      const invalidDelete = toDelete.filter(url => !currentImages.includes(url));
      if (invalidDelete.length > 0) {
        res.status(400).json(errorResponse(
          "INVALID_IMAGES", 
          `Some images to delete don't exist in product: ${invalidDelete.slice(0, 3).join(', ')}${invalidDelete.length > 3 ? '...' : ''}`
        ));
        return;
      }

      // Validate keep + uploaded images <= 6
      if (keep.length + uploadedImageUrls.length > 6) {
        res.status(400).json(errorResponse(
          "TOO_MANY_IMAGES", 
          `Maximum 6 images allowed. You have ${keep.length} kept + ${uploadedImageUrls.length} new = ${keep.length + uploadedImageUrls.length}`
        ));
        return;
      }

      // Mark images for Cloudinary deletion
      imagesToDeleteFromCloudinary = toDelete;

      // Build final images array (kept + newly uploaded)
      finalImages = [...keep, ...uploadedImageUrls].slice(0, 6);
      
      console.log(`📸 New format: ${keep.length} kept + ${uploadedImageUrls.length} new = ${finalImages.length} total images`);
    } else {
      // 📌 NO SPECIFIED FORMAT: Keep existing images, add new ones if uploaded
      const existingImages = product.images || [];
      finalImages = [
        ...existingImages,
        ...uploadedImageUrls
      ].slice(0, 6);
      
      console.log(`📸 No format specified: ${existingImages.length} existing + ${uploadedImageUrls.length} new = ${finalImages.length} total images`);
    }

    // Validate total images don't exceed limit
    if (finalImages.length > 6) {
      res.status(400).json(errorResponse("TOO_MANY_IMAGES", "Maximum 6 images allowed"));
      return;
    }

    // ============================================
    // ✅ SMART VIDEO HANDLING - FIXED
    // ============================================
    let finalVideo: string[] = [];
    let videoToDeleteFromCloudinary: string | null = null;

    if (isUsingOldFormat) {
      // 📌 BACKWARD COMPATIBILITY: Old format
      // Use uploaded videos if any, otherwise keep existing
      if (uploadedVideoUrls.length > 0) {
        finalVideo = uploadedVideoUrls.slice(0, 1); // Max 1 video
        // Mark old video for deletion if exists
        if (product.video && product.video.length > 0) {
          videoToDeleteFromCloudinary = product.video[0];
        }
        console.log(`🎬 Old format: Using uploaded video`);
      } else {
        finalVideo = oldVideoFormat || [];
        console.log(`🎬 Old format: Keeping existing video (${finalVideo.length})`);
      }
    } else if (videoUpdates) {
      // 📌 NEW FORMAT: Smart video updates
      const { keep, delete: shouldDelete } = videoUpdates;
      const currentVideo = product.video || [];

      if (shouldDelete && currentVideo.length > 0) {
        // Mark existing video for deletion
        videoToDeleteFromCloudinary = currentVideo[0];
        finalVideo = uploadedVideoUrls.slice(0, 1); // Use new video if uploaded
        console.log(`🎬 New format: Deleting old video, using uploaded`);
      } else if (keep) {
        // Keep specific video
        if (!currentVideo.includes(keep)) {
          res.status(400).json(errorResponse(
            "INVALID_VIDEO", 
            "Video to keep doesn't exist in product"
          ));
          return;
        }
        finalVideo = [keep];
        console.log(`🎬 New format: Keeping specified video`);
      } else if (uploadedVideoUrls.length > 0) {
        // Use new uploaded video
        finalVideo = uploadedVideoUrls.slice(0, 1);
        // Mark old video for deletion if exists
        if (currentVideo.length > 0) {
          videoToDeleteFromCloudinary = currentVideo[0];
        }
        console.log(`🎬 New format: Using uploaded video`);
      } else {
        // No video changes
        finalVideo = currentVideo;
        console.log(`🎬 New format: No video changes`);
      }
    } else {
      // 📌 NO SPECIFIED FORMAT: Use uploaded video if any, otherwise keep existing
      if (uploadedVideoUrls.length > 0) {
        finalVideo = uploadedVideoUrls.slice(0, 1);
        if (product.video && product.video.length > 0) {
          videoToDeleteFromCloudinary = product.video[0];
        }
        console.log(`🎬 No format: Using uploaded video`);
      } else {
        finalVideo = product.video || [];
        console.log(`🎬 No format: Keeping existing video`);
      }
    }

    // Validate video count
    if (finalVideo.length > 1) {
      res.status(400).json(errorResponse("TOO_MANY_VIDEOS", "Maximum 1 video allowed"));
      return;
    }

    // Validate uploaded videos
    if (uploadedVideoUrls.length > 1) {
      res.status(400).json(errorResponse("TOO_MANY_VIDEOS", "Maximum 1 video can be uploaded at a time"));
      return;
    }

    // ============================================
    // ✅ BUILD UPDATE DATA
    // ============================================
    const updateData: any = {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(price !== undefined && { price }),
      ...(category !== undefined && { category }),
      ...(archived !== undefined && { archived }), // ✅ ADD THIS

    };

    // Always update images/video arrays if we have data
    updateData.images = finalImages;
    updateData.video = finalVideo;

    // Auto-update thumbnail
    if (finalImages.length > 0) {
      updateData.thumbnail = finalImages[0];
      console.log(`📸 Auto-updated thumbnail for product: ${productId}`);
    } else if (isUsingOldFormat || isUsingNewFormat) {
      // If images were explicitly cleared
      updateData.thumbnail = null;
      console.log(`📸 Cleared thumbnail for product: ${productId}`);
    }

    // Log final results
    console.log(`✅ Final update for product ${productId}:`);
    console.log(`  Images: ${finalImages.length} total`);
    console.log(`  Videos: ${finalVideo.length} total`);
    console.log(`  Images to delete from Cloudinary: ${imagesToDeleteFromCloudinary.length}`);
    console.log(`  Video to delete from Cloudinary: ${videoToDeleteFromCloudinary ? 'Yes' : 'No'}`);

    // ============================================
    // ✅ CLOUDINARY CLEANUP (ASYNC - Non-blocking)
    // ============================================
    if (imagesToDeleteFromCloudinary.length > 0 || videoToDeleteFromCloudinary) {
      // Run cleanup in background without blocking response
      setTimeout(async () => {
        try {
          await cleanupCloudinaryAssets(imagesToDeleteFromCloudinary, videoToDeleteFromCloudinary);
        } catch (error) {
          console.error('Background Cloudinary cleanup failed:', error);
        }
      }, 1000); // 1 second delay to ensure response is sent first
    }

    // ============================================
    // ✅ DATABASE UPDATE (Transaction)
    // ============================================
    const updated = await prisma.$transaction(async (tx) => {
      // Update product
      const updatedProduct = await tx.product.update({
        where: { id: product.id },
        data: updateData,
        include: { options: true, productSchedule: true },
      });

      // Handle options if provided
      if (Array.isArray(options)) {
        const existingOptionIds = product.options.map((opt) => opt.id);
        const incomingOptionIds = options.filter((opt) => opt.id).map((opt) => opt.id!);
        const toDelete = existingOptionIds.filter((id) => !incomingOptionIds.includes(id));

        if (toDelete.length > 0) {
          await tx.productOption.deleteMany({ where: { id: { in: toDelete } } });
        }
        
        for (const opt of options) {
          if (opt.id) {
            await tx.productOption.update({
              where: { id: opt.id },
              data: { name: opt.name, price: opt.price }
            });
          } else {
            await tx.productOption.create({
              data: { productId: product.id, name: opt.name, price: opt.price }
            });
          }
        }
      }

      return updatedProduct;
    });

    // ============================================
    // ✅ CACHE INVALIDATION
    // ============================================
    // Queue product indexing
    productIndexQueue.add("indexProduct", { productId: product.id }).catch(console.error);
    
    // Clear product caches
    await clearProductCache(product.id, req.user!.id);
    await clearProductFromCarts(product.id);

    // Update Redis cache with computed live status
    const scheduleSafe = updated.productSchedule
      ? {
          goLiveAt: updated.productSchedule.goLiveAt ?? undefined,
          takeDownAt: updated.productSchedule.takeDownAt ?? undefined,
          graceMinutes: updated.productSchedule.graceMinutes ?? undefined,
        }
      : null;
    const computedIsLive = computeIsLive(scheduleSafe, updated.isLive);

    const cacheKey = CACHE_KEYS.PRODUCT_DETAIL(product.id);
    
    // Update Redis - check which method your redis client uses
    const cacheValue = JSON.stringify({ 
      ...updated, 
      images: finalImages,
      video: finalVideo,
      isLive: computedIsLive 
    });
    
    // Try different Redis set methods
    try {
      // Method 1: setEx (node-redis v4+)
      await redisProducts.setEx(cacheKey, 3600, cacheValue);
    } catch (error) {
      try {
        // Method 2: set with EX option
        await redisProducts.set(cacheKey, cacheValue, { EX: 3600 });
      } catch (error2) {
        try {
          // Method 3: Just set without expiry
          await redisProducts.set(cacheKey, cacheValue);
          console.warn('Redis set with expiry failed, using basic set');
        } catch (error3) {
          console.error('All Redis set methods failed:', error3);
        }
      }
    }

    // Invalidate vendor dashboard cache
    const service = new VendorDashboardService(req.user!.id);
    await service.invalidateCache();

    // Pre-warm pagination caches (async)
    setTimeout(async () => {
      try {
        const totalCount = await prisma.product.count({ where: { vendorId: req.user!.id } });
        const limit = 20;
        const totalPages = Math.ceil(totalCount / limit);
        
        // Warm up first 3 pages
        const pagesToWarm = Math.min(3, totalPages);
        await Promise.all(
          Array.from({ length: pagesToWarm }, (_, i) => 
            service.getAllVendorProducts(i * limit, limit)
          )
        );
      } catch (error) {
        console.error('Failed to warm up caches:', error);
      }
    }, 500); // 500ms delay

    // ============================================
    // ✅ SUCCESS RESPONSE
    // ============================================
    res.status(200).json(successResponse(
      "PRODUCT_UPDATED", 
      "Product updated successfully", 
      {
        ...updated,
        images: finalImages,
        video: finalVideo,
      }
    ));

  } catch (err) {
    console.error("Update product error:", err);
    await clearProductCache(productId);
    res.status(500).json(errorResponse("SERVER_ERROR", "Something went wrong"));
  }
};


// ==========================================================
// ✅ Archive Product Controller
// ==========================================================
export const archiveProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  const productId = req.params.id;

  try {
    if (!req.user || req.user.role !== "VENDOR") {
      res.status(403).json(errorResponse("UNAUTHORIZED", "Only vendors can archive products"));
      return;
    }

    const parsed = archiveProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorResponse("VALIDATION_ERROR", "archived must be a boolean"));
      return;
    }

    const { archived } = parsed.data;

    const product = await prisma.product.findUnique({ where: { id: productId }, include: { productSchedule: true } });
    if (!product || product.vendorId !== req.user.id) {
      res.status(403).json(errorResponse("FORBIDDEN", "Unauthorized or product not found"));
      return;
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data: { archived },
      include: { productSchedule: true },
    });

    productIndexQueue.add("indexProduct", { productId }).catch(console.error);
    await clearProductCache(productId, req.user.id);
    await clearProductFromCarts(productId);

    const scheduleSafe = updated.productSchedule
      ? {
          goLiveAt: updated.productSchedule.goLiveAt ?? undefined,
          takeDownAt: updated.productSchedule.takeDownAt ?? undefined,
          graceMinutes: updated.productSchedule.graceMinutes ?? undefined,
        }
      : null;
    const computedIsLive = computeIsLive(scheduleSafe, updated.isLive);

    const cacheKey = CACHE_KEYS.PRODUCT_DETAIL(productId);
    await redisProducts.set(cacheKey, JSON.stringify({ ...updated, isLive: computedIsLive }));

    const service = new VendorDashboardService(req.user.id);
    await service.invalidateCache();

    const totalCount = await prisma.product.count({ where: { vendorId: req.user.id } });
    const limit = 20;
    const totalPages = Math.ceil(totalCount / limit);
    await Promise.all(Array.from({ length: totalPages }, (_, i) => service.getAllVendorProducts(i * limit, limit)));

    res.status(200).json(
      successResponse("PRODUCT_ARCHIVED", `Product successfully ${archived ? "archived" : "unarchived"}`, updated)
    );
  } catch (err) {
    console.error("Archive product error:", err);
    await clearProductCache(productId);
    res.status(500).json(errorResponse("SERVER_ERROR", "Something went wrong"));
  }
};

// ==========================================================
// ✅ Delete Product Controller
// ==========================================================
export const deleteProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  const productId = req.params.id;

  try {
    if (!req.user || req.user.role !== "VENDOR") {
      res.status(403).json(errorResponse("UNAUTHORIZED", "Only vendors can delete products"));
      return;
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.vendorId !== req.user.id) {
      res.status(403).json(errorResponse("FORBIDDEN", "Unauthorized or product not found"));
      return;
    }

    await prisma.product.delete({ where: { id: product.id } });

    await clearProductCache(product.id);
    await clearProductFromCarts(product.id);

    res.json(successResponse("PRODUCT_DELETED", "Product deleted successfully"));
  } catch (err) {
    console.error("Delete product error:", err);
    await clearProductCache(productId);
    res.status(500).json(errorResponse("SERVER_ERROR", "Something went wrong"));
  }
};




// ✅ Get search suggestions

export const getSearchSuggestions = async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string)?.trim();

    // 1️⃣ Validate
    if (!q || q.length < 2) {
      return res.status(400).json(
        errorResponse("INVALID_QUERY", "Please enter at least 2 characters")
      );
    }

    const query = q.toLowerCase();
    const keywords = query.split(/\s+/).filter(Boolean);
    const isSingleWord = keywords.length === 1;

    const cacheKey = CACHE_KEYS.SUGGESTIONS(query);
    const ttl = CACHE_TTLS.SUGGESTIONS; // e.g. 30–60s

    // 2️⃣ Cache
    const cached = await redisSearch.get(cacheKey);
    if (cached) {
      return res.json(
        successResponse("SUGGESTIONS_FETCHED", "Suggestions retrieved successfully", {
          query,
          results: JSON.parse(cached),
          fromCache: true,
        })
      );
    }

    let results: any[] = [];

    // 3️⃣ DB QUERY (NO isLive FILTER)
    if (isSingleWord) {
      results = await prisma.product.findMany({
        where: {
          archived: false,
          name: {
            contains: query,
            mode: "insensitive",
          },
        },
        select: {
          id: true,
          name: true,
          category: true,
          isLive: true, // used ONLY for ranking
        },
        take: 12,
      });
    } else {
      results = await prisma.product.findMany({
        where: {
          archived: false,
          AND: keywords.map((word) => ({
            name: {
              contains: word,
              mode: "insensitive",
            },
          })),
        },
        select: {
          id: true,
          name: true,
          category: true,
          isLive: true,
        },
        take: 12,
      });
    }

    // 4️⃣ RANKING (Live > startsWith > contains)
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

    // 5️⃣ Shape response
    const suggestions = results.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      isLive: p.isLive,
    }));

    // 6️⃣ Cache
    await redisSearch.set(cacheKey, JSON.stringify(suggestions), { EX: ttl });

    return res.json(
      successResponse("SUGGESTIONS_FETCHED", "Suggestions retrieved successfully", {
        query,
        results: suggestions,
        fromCache: false,
      })
    );
  } catch (err) {
    console.error("❌ Suggestions error:", err);
    return res
      .status(500)
      .json(errorResponse("SERVER_ERROR", "Failed to get suggestions"));
  }
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
export const searchProducts = async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string)?.trim();
    if (!q) {
      return res
        .status(400)
        .json(errorResponse("INVALID_QUERY", "Query parameter 'q' is required"));
    }

    const page = parseInt((req.query.page as string) || "1", 10);
    const limit = Math.min(parseInt((req.query.limit as string) || "20", 10), 20);
    const offset = (page - 1) * limit;
    const fuzzyThreshold = 0.1;
    const sortBy = (req.query.sortBy as string) || "relevance";

    const corrected = correctQuery(q);

    // ---------------- CACHE ----------------
    const cacheKey = CACHE_KEYS.SEARCH(corrected, sortBy, undefined, page, limit);
    const cached = await redisSearch.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      return res.json(
        successResponse("SEARCH_SUCCESS", "Products fetched successfully", {
          corrected,
          results: data.results,
          pagination: data.pagination,
          fromCache: true,
        })
      );
    }

    // ---------------- SORTING ----------------
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

    // ---------------- FULL-TEXT SEARCH ----------------
    const fullTextResults = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        p.id,
        p.name,
        p.description,
        p.price,
        p."vendorId",
        p.images,
        p."isLive",
        p.archived,
        p."createdAt",
        p."updatedAt",
        CASE
          WHEN s."goLiveAt" IS NOT NULL AND s."takeDownAt" IS NOT NULL
            THEN (
              now() >= s."goLiveAt"
              AND now() <= s."takeDownAt" + (s."graceMinutes" * interval '1 minute')
            )
          ELSE p."isLive"
        END AS "computedIsLive",
        ts_rank_cd(
          setweight(to_tsvector('english', p.name), 'A') ||
          setweight(to_tsvector('english', p.description), 'B'),
          websearch_to_tsquery('english', $1)
        ) AS rank,
        (p.name ILIKE $2 OR p.description ILIKE $2) AS exact_match
      FROM "Product" p
      LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
      WHERE p.archived = false
        AND (
          p.tsvector_col @@ websearch_to_tsquery('english', $1)
          OR p.name ILIKE $2
          OR p.description ILIKE $2
        )
      ORDER BY
        exact_match DESC,
        "computedIsLive" DESC,
        rank DESC,
        ${secondaryOrder}
      LIMIT $3 OFFSET $4;
    `, corrected, `%${corrected}%`, limit, offset);

    // ---------------- FUZZY SEARCH (ONLY IF NEEDED) ----------------
    let fuzzyResults: any[] = [];

    if (fullTextResults.length < limit) {
      await prisma.$executeRawUnsafe(
        `SET pg_trgm.similarity_threshold = ${fuzzyThreshold};`
      );

      fuzzyResults = await prisma.$queryRawUnsafe<any[]>(`
        SELECT
          p.id,
          p.name,
          p.description,
          p.price,
          p."vendorId",
          p.images,
          p."isLive",
          p.archived,
          p."createdAt",
          p."updatedAt",
          CASE
            WHEN s."goLiveAt" IS NOT NULL AND s."takeDownAt" IS NOT NULL
              THEN (
                now() >= s."goLiveAt"
                AND now() <= s."takeDownAt" + (s."graceMinutes" * interval '1 minute')
              )
            ELSE p."isLive"
          END AS "computedIsLive",
          similarity(p.name || ' ' || p.description, $1) AS sim_score
        FROM "Product" p
        LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
        WHERE p.archived = false
          AND similarity(p.name || ' ' || p.description, $1) > $2
        ORDER BY
          "computedIsLive" DESC,
          sim_score DESC,
          ${secondaryOrder}
        LIMIT $3 OFFSET $4;
      `, corrected, fuzzyThreshold, limit, offset);
    }

    // ---------------- MERGE RESULTS ----------------
    const seen = new Set<string>();
    const results = [...fullTextResults, ...fuzzyResults].filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    // ---------------- TOTAL COUNT ----------------
    const totalResult = await prisma.$queryRawUnsafe<{ total: bigint }[]>(`
      SELECT COUNT(*)::bigint AS total
      FROM "Product" p
      WHERE p.archived = false
        AND (
          p.tsvector_col @@ websearch_to_tsquery('english', $1)
          OR p.name ILIKE $2
          OR p.description ILIKE $2
        );
    `, corrected, `%${corrected}%`);

    const total = Number(totalResult[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    const responseData = {
      corrected,
      results,
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    };

    // ---------------- CACHE ----------------
    await redisSearch.set(
      cacheKey,
      JSON.stringify(responseData),
      { EX: CACHE_TTLS.SEARCH }
    );

    return res.json(
      successResponse("SEARCH_SUCCESS", "Products fetched successfully", responseData)
    );

  } catch (err) {
    console.error("❌ Search error:", err);
    return res.status(500).json(
      errorResponse("SERVER_ERROR", "Internal server error")
    );
  }
};


/**
 * Get most popular products
 * - Ranks by popularityScore (desc)
 * - Supports pagination
 * - Adds popularityPercent (relative to max score)
 * - Uses Redis cache
 */

export const getMostPopularProducts = async (req: Request, res: Response) => {
  try {
    const page = parseInt((req.query.page as string) || "1", 10);
    const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 50);
    const skip = (page - 1) * limit;

    const cacheKey = CACHE_KEYS.PRODUCTS_MOST_POPULAR(page, limit);
    const ttl = CACHE_TTLS.PRODUCTS_MOST_POPULAR;

    const cached = await redisProducts.get(cacheKey);

    let products: any[] = [];
    let totalCount = 0;

    if (cached) {
      const cachedData = JSON.parse(cached);
      products = cachedData.data;
      totalCount = cachedData.pagination.total;
      res.setHeader("X-Cache", "HIT");
    } else {
      // Query DB for products with schedule
      const rawProducts: any[] = await prisma.$queryRawUnsafe(
        `
        SELECT p.id, p.name, p.price, p.images, p."averageRating", p."reviewCount",
               p."popularityScore", p."popularityPercent", p."totalViews", p.category,
               p."isLive", p."archived", p."productScheduleId",
               s."goLiveAt", s."takeDownAt", s."graceMinutes"
        FROM "Product" p
        LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
        WHERE p."archived" = false
        ORDER BY p."popularityScore" DESC
        LIMIT $1 OFFSET $2;
        `,
        limit,
        skip
      );

      // Compute isLive using helper
      products = rawProducts
        .map((p) => {
          const schedule = p.goLiveAt || p.takeDownAt || p.graceMinutes
            ? {
                goLiveAt: p.goLiveAt ?? undefined,
                takeDownAt: p.takeDownAt ?? undefined,
                graceMinutes: p.graceMinutes ?? undefined,
              }
            : null;

          return { ...p, isLive: computeIsLive(schedule, p.isLive) };
        })
        .filter((p) => p.isLive);

      // Proper totalCount for pagination
      const totalResult: { count: number }[] = await prisma.$queryRawUnsafe(
        `
        SELECT COUNT(*)::int AS count
        FROM "Product" p
        LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
        WHERE p."archived" = false;
        `
      );
      totalCount = totalResult[0]?.count ?? 0;

      res.setHeader("X-Cache", "MISS");

      // Cache results
      await redisProducts.set(
        cacheKey,
        JSON.stringify({
          data: products,
          pagination: { total: totalCount, page, limit, totalPages: Math.ceil(totalCount / limit) },
        }),
        { EX: ttl }
      );
    }

    const pagination = {
      total: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
    };

    return res.json(
      successResponse(
        "POPULAR_PRODUCTS_FETCHED",
        "Most popular products fetched successfully",
        products,
        pagination
      )
    );
  } catch (err) {
    console.error("Get most popular products error:", err);
    return res
      .status(500)
      .json(errorResponse("SERVER_ERROR", "Failed to fetch most popular products"));
  }
};


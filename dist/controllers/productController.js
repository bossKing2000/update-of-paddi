"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMostPopularProducts = exports.searchProducts = exports.getSearchSuggestions = exports.deleteProduct = exports.archiveProduct = exports.updateProduct = exports.getProductById = exports.getAllProducts = exports.createProduct = exports.getCategories = exports.computeIsLive = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const paramUtils_1 = require("../utils/paramUtils");
const ProductCRUDSchema_1 = require("../validations/ProductCRUDSchema");
const client_1 = require("@prisma/client");
const redis_1 = require("../lib/redis");
const redisScan_1 = require("../lib/redisScan");
const product_service_1 = require("../services/product.service");
const redisCacheTiming_1 = require("../services/redisCacheTiming");
const redis_baseQueue_1 = require("../jobs/workers jobs/redis-baseQueue");
const apiResponse_1 = require("../utils/apiResponse");
const AppError_1 = require("../errors/AppError");
const vendorDashboard_service_1 = require("./vendorDashboard.service");
const clearCaches_1 = require("../services/clearCaches");
const localSearchCorrect_1 = require("../AI/localSearchCorrect");
const logger_1 = require("../lib/logger");
const config_1 = __importDefault(require("../config/config"));
const cloudinary_1 = require("cloudinary");
cloudinary_1.v2.config(config_1.default.cloudinaryUrl);
function extractPublicId(url) {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)\.(?:jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv|webm)/i);
    return match ? match[1] : null;
}
async function cleanupCloudinaryAssets(images, video) {
    try {
        for (const imageUrl of images) {
            const publicId = extractPublicId(imageUrl);
            if (publicId)
                await cloudinary_1.v2.uploader.destroy(publicId);
        }
        if (video) {
            const videoPublicId = extractPublicId(video);
            if (videoPublicId)
                await cloudinary_1.v2.uploader.destroy(videoPublicId, {
                    resource_type: "video",
                });
        }
    }
    catch (error) {
        logger_1.logger.warn({ err: error }, "Cloudinary cleanup failed (non-critical)");
    }
}
function extractImagePaths(files) {
    if (!files || typeof files !== "object" || !("images" in files))
        return [];
    const imageFiles = files["images"];
    return imageFiles.map((file) => file.path);
}
function extractVideoPaths(files) {
    if (!files || typeof files !== "object" || !("video" in files))
        return [];
    const videoFiles = files["video"];
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
const computeIsLive = (schedule, defaultIsLive) => {
    if (!schedule)
        return defaultIsLive;
    const now = Date.now();
    const goLive = schedule.goLiveAt ? new Date(schedule.goLiveAt).getTime() : 0;
    const takeDown = schedule.takeDownAt
        ? new Date(schedule.takeDownAt).getTime()
        : 0;
    const grace = (schedule.graceMinutes ?? 0) * 60 * 1000;
    if (!goLive || !takeDown)
        return defaultIsLive;
    return now >= goLive && now <= takeDown + grace;
};
exports.computeIsLive = computeIsLive;
// GET /product/categories
// Previously didn't exist at all — the cache key/TTL for it (CACHE_KEYS.
// CATEGORIES_ALL) were already defined and unused. The Flutter app had no
// way to fetch valid category options except hardcoding the enum client-side.
const getCategories = async (_req, res) => {
    const cached = await redis_1.redisProducts.get(redisCacheTiming_1.CACHE_KEYS.CATEGORIES_ALL);
    if (cached) {
        return (0, apiResponse_1.sendSuccess)(res, { categories: JSON.parse(cached) }, "Categories fetched (cache)");
    }
    const categories = Object.values(client_1.Category);
    await redis_1.redisProducts.set(redisCacheTiming_1.CACHE_KEYS.CATEGORIES_ALL, JSON.stringify(categories), { EX: redisCacheTiming_1.CACHE_TTLS.CATEGORIES_ALL });
    return (0, apiResponse_1.sendSuccess)(res, { categories }, "Categories fetched");
};
exports.getCategories = getCategories;
/**
 * Create a new product (vendor only)
 */
const createProduct = async (req, res) => {
    if (!req.user || req.user.role !== "VENDOR")
        throw new AppError_1.ForbiddenError("Only vendors can create products.");
    if (typeof req.body.options === "string") {
        try {
            req.body.options = JSON.parse(req.body.options);
        }
        catch {
            throw new AppError_1.ValidationError("Invalid JSON in options field.");
        }
    }
    const parsed = ProductCRUDSchema_1.createProductSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
    const imageUrls = extractImagePaths(req.files);
    const videoUrls = extractVideoPaths(req.files);
    if (imageUrls.length < 1 || imageUrls.length > 6)
        throw new AppError_1.ValidationError("Please upload between 1 and 6 images.");
    const { name, description, price, category, archived, options = [], } = parsed.data;
    const product = await prisma_1.default.product.create({
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
    redis_baseQueue_1.productIndexQueue
        .add("indexProduct", { productId: product.id })
        .catch((err) => logger_1.logger.warn({ err }, "Failed to queue product indexing"));
    // Broad invalidation (SCAN-based, safe at scale — see clearProductCache)
    // instead of trying to precisely rebuild just the pages a new product
    // might land on. A new product's rank among "isLive first, then
    // newest" could put it on any page depending on catalog size, so
    // guessing which single page to pre-warm isn't reliable anyway — next
    // read just repopulates whichever page is actually requested.
    await (0, clearCaches_1.clearProductCache)(product.id, req.user.id);
    const suggestionKeys = await (0, redisScan_1.scanKeys)(redis_1.redisSearch, "suggestions:*");
    if (suggestionKeys.length)
        await redis_1.redisSearch.del(suggestionKeys);
    return (0, apiResponse_1.sendCreated)(res, { product }, "Product created successfully.");
};
exports.createProduct = createProduct;
// GET /product
// Previously fetched every matching product from the DB with no LIMIT/
// OFFSET at all, cached the entire unpaginated set as one Redis value,
// and paginated via JS .slice() after the fact — every request for page 1
// loaded the whole catalog into memory just to return 20 items. Now does
// real DB-level pagination and sorting, and caches per-page using the
// same CACHE_KEYS.PRODUCTS_ALL(page, limit) format used elsewhere in this
// file, so cache invalidation and pre-warming actually target what this
// function reads.
const getAllProducts = async (req, res) => {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 20);
    const skip = (page - 1) * limit;
    const categoryQuery = req.query.category?.toUpperCase();
    const vendorIdQuery = req.query.vendorId;
    const where = { archived: false };
    if (categoryQuery && categoryQuery !== "ALL") {
        if (!Object.values(client_1.Category).includes(categoryQuery)) {
            throw new AppError_1.ValidationError(`Invalid category. Valid options: ${Object.values(client_1.Category).join(", ")}`);
        }
        where.category = categoryQuery;
    }
    if (vendorIdQuery)
        where.vendorId = vendorIdQuery;
    const cacheKey = vendorIdQuery
        ? `products:vendor:${vendorIdQuery}:category=${categoryQuery ?? "ALL"}:page=${page}:limit=${limit}`
        : categoryQuery && categoryQuery !== "ALL"
            ? `products:category:${categoryQuery}:page=${page}:limit=${limit}`
            : redisCacheTiming_1.CACHE_KEYS.PRODUCTS_ALL(page, limit);
    const cached = await redis_1.redisProducts.get(cacheKey);
    if (cached) {
        res.setHeader("X-Cache", "HIT");
        const { data, pagination } = JSON.parse(cached);
        return (0, apiResponse_1.sendSuccess)(res, data, "Products fetched successfully", 200, pagination);
    }
    const [dbProducts, total] = await Promise.all([
        prisma_1.default.product.findMany({
            where,
            skip,
            take: limit,
            // isLive first, then newest — done at the DB level instead of
            // fetching everything and sorting in JS.
            orderBy: [{ isLive: "desc" }, { createdAt: "desc" }],
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
                    select: { goLiveAt: true, takeDownAt: true, graceMinutes: true },
                },
                vendor: {
                    select: { id: true, name: true, brandName: true, avatarUrl: true },
                },
            },
        }),
        prisma_1.default.product.count({ where }),
    ]);
    const products = dbProducts.map((p) => ({
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
        isLive: (0, exports.computeIsLive)(p.productSchedule, p.isLive),
        goLiveAt: p.productSchedule?.goLiveAt || null,
        liveUntil: p.productSchedule?.takeDownAt || null,
        vendor: p.vendor,
    }));
    const pagination = {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
    };
    await redis_1.redisProducts.set(cacheKey, JSON.stringify({ data: products, pagination }), { EX: redisCacheTiming_1.CACHE_TTLS.PRODUCTS_ALL });
    res.setHeader("X-Cache", "MISS");
    return (0, apiResponse_1.sendSuccess)(res, products, "Products fetched successfully", 200, pagination);
};
exports.getAllProducts = getAllProducts;
// GET /product/:id
const getProductById = async (req, res) => {
    const productId = (0, paramUtils_1.ensureString)(req.params.id);
    const cacheKey = redisCacheTiming_1.CACHE_KEYS.PRODUCT_DETAIL(productId);
    (0, product_service_1.trackProductView)(productId).catch((err) => logger_1.logger.warn({ err, productId }, "Failed to track product view"));
    const cached = await redis_1.redisProducts.get(cacheKey);
    if (cached) {
        const productData = JSON.parse(cached);
        productData.isLive = (0, exports.computeIsLive)(productData.productSchedule, productData.isLive);
        res.setHeader("X-Cache", "HIT");
        return (0, apiResponse_1.sendSuccess)(res, productData, "Product retrieved successfully.");
    }
    const [product, reviewStats] = await Promise.all([
        prisma_1.default.product.findFirst({
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
        prisma_1.default.productReview.aggregate({
            where: { productId },
            _avg: { rating: true },
            _count: { _all: true },
        }),
    ]);
    if (!product)
        throw new AppError_1.NotFoundError("Product");
    const productData = {
        ...product,
        averageRating: reviewStats._avg.rating ?? 0,
        reviewCount: reviewStats._count._all ?? 0,
        isLive: (0, exports.computeIsLive)(product.productSchedule, product.isLive),
    };
    await redis_1.redisProducts.set(cacheKey, JSON.stringify(productData), {
        EX: redisCacheTiming_1.CACHE_TTLS.PRODUCT_DETAIL,
    });
    res.setHeader("X-Cache", "MISS");
    return (0, apiResponse_1.sendSuccess)(res, productData, "Product retrieved successfully.");
};
exports.getProductById = getProductById;
// PATCH /product/:id
const updateProduct = async (req, res) => {
    const productId = (0, paramUtils_1.ensureString)(req.params.id);
    if (!req.user || req.user.role !== "VENDOR")
        throw new AppError_1.ForbiddenError("Only vendors can update products");
    const product = await prisma_1.default.product.findUnique({
        where: { id: productId },
        include: { options: true, productSchedule: true },
    });
    if (!product || product.vendorId !== req.user.id)
        throw new AppError_1.ForbiddenError("Unauthorized or product not found");
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
            }
            catch (error) {
                logger_1.logger.warn({ field }, "Failed to parse field as JSON, leaving as-is for validation to catch");
            }
        }
    });
    const parsed = ProductCRUDSchema_1.updateProductSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Validation failed: check your input fields.", parsed.error.flatten().fieldErrors);
    const uploadedImageUrls = extractImagePaths(req.files);
    const uploadedVideoUrls = extractVideoPaths(req.files);
    const { name, description, price, category, archived, options, images: oldImagesFormat, // backward compatibility
    video: oldVideoFormat, // backward compatibility
    imageUpdates, videoUpdates, } = parsed.data;
    const isUsingOldFormat = oldImagesFormat !== undefined || oldVideoFormat !== undefined;
    const isUsingNewFormat = imageUpdates !== undefined || videoUpdates !== undefined;
    if (isUsingOldFormat && isUsingNewFormat) {
        throw new AppError_1.ValidationError("Cannot use both old format (images/video arrays) and new format (imageUpdates/videoUpdates)");
    }
    // ── Image handling: supports both a legacy "replace the whole array"
    // format and a newer "keep these, delete these" format, for backward
    // compatibility with whichever the client happens to send. ──
    let finalImages = [];
    let imagesToDeleteFromCloudinary = [];
    if (isUsingOldFormat) {
        const existingImages = oldImagesFormat || [];
        finalImages = [...existingImages, ...uploadedImageUrls].slice(0, 6);
        if (existingImages.length > 0 && product.images) {
            imagesToDeleteFromCloudinary = product.images.filter((img) => !existingImages.includes(img));
        }
    }
    else if (imageUpdates) {
        const { keep = [], delete: toDelete = [] } = imageUpdates;
        const currentImages = product.images || [];
        const invalidKeep = keep.filter((url) => !currentImages.includes(url));
        if (invalidKeep.length > 0) {
            throw new AppError_1.ValidationError(`Some images to keep don't exist in product: ${invalidKeep.slice(0, 3).join(", ")}${invalidKeep.length > 3 ? "..." : ""}`);
        }
        const invalidDelete = toDelete.filter((url) => !currentImages.includes(url));
        if (invalidDelete.length > 0) {
            throw new AppError_1.ValidationError(`Some images to delete don't exist in product: ${invalidDelete.slice(0, 3).join(", ")}${invalidDelete.length > 3 ? "..." : ""}`);
        }
        if (keep.length + uploadedImageUrls.length > 6) {
            throw new AppError_1.ValidationError(`Maximum 6 images allowed. You have ${keep.length} kept + ${uploadedImageUrls.length} new = ${keep.length + uploadedImageUrls.length}`);
        }
        imagesToDeleteFromCloudinary = toDelete;
        finalImages = [...keep, ...uploadedImageUrls].slice(0, 6);
    }
    else {
        const existingImages = product.images || [];
        finalImages = [...existingImages, ...uploadedImageUrls].slice(0, 6);
    }
    if (finalImages.length > 6)
        throw new AppError_1.ValidationError("Maximum 6 images allowed");
    // ── Video handling: same dual-format support as images. ──
    let finalVideo = [];
    let videoToDeleteFromCloudinary = null;
    if (isUsingOldFormat) {
        if (uploadedVideoUrls.length > 0) {
            finalVideo = uploadedVideoUrls.slice(0, 1);
            if (product.video && product.video.length > 0)
                videoToDeleteFromCloudinary = product.video[0];
        }
        else {
            finalVideo = oldVideoFormat || [];
        }
    }
    else if (videoUpdates) {
        const { keep, delete: shouldDelete } = videoUpdates;
        const currentVideo = product.video || [];
        if (shouldDelete && currentVideo.length > 0) {
            videoToDeleteFromCloudinary = currentVideo[0];
            finalVideo = uploadedVideoUrls.slice(0, 1);
        }
        else if (keep) {
            if (!currentVideo.includes(keep))
                throw new AppError_1.ValidationError("Video to keep doesn't exist in product");
            finalVideo = [keep];
        }
        else if (uploadedVideoUrls.length > 0) {
            finalVideo = uploadedVideoUrls.slice(0, 1);
            if (currentVideo.length > 0)
                videoToDeleteFromCloudinary = currentVideo[0];
        }
        else {
            finalVideo = currentVideo;
        }
    }
    else {
        if (uploadedVideoUrls.length > 0) {
            finalVideo = uploadedVideoUrls.slice(0, 1);
            if (product.video && product.video.length > 0)
                videoToDeleteFromCloudinary = product.video[0];
        }
        else {
            finalVideo = product.video || [];
        }
    }
    if (finalVideo.length > 1)
        throw new AppError_1.ValidationError("Maximum 1 video allowed");
    if (uploadedVideoUrls.length > 1)
        throw new AppError_1.ValidationError("Maximum 1 video can be uploaded at a time");
    const updateData = {
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
    }
    else if (isUsingOldFormat || isUsingNewFormat) {
        updateData.thumbnail = null;
    }
    // Cloudinary cleanup runs in the background — doesn't block the response,
    // and a failure here shouldn't fail the product update itself.
    if (imagesToDeleteFromCloudinary.length > 0 || videoToDeleteFromCloudinary) {
        setTimeout(() => {
            cleanupCloudinaryAssets(imagesToDeleteFromCloudinary, videoToDeleteFromCloudinary).catch((err) => logger_1.logger.warn({ err, productId }, "Background Cloudinary cleanup failed"));
        }, 1000);
    }
    const updated = await prisma_1.default.$transaction(async (tx) => {
        const updatedProduct = await tx.product.update({
            where: { id: product.id },
            data: updateData,
            include: { options: true, productSchedule: true },
        });
        if (Array.isArray(options)) {
            const existingOptionIds = product.options.map((opt) => opt.id);
            const incomingOptionIds = options
                .filter((opt) => opt.id)
                .map((opt) => opt.id);
            const toDelete = existingOptionIds.filter((id) => !incomingOptionIds.includes(id));
            if (toDelete.length > 0)
                await tx.productOption.deleteMany({ where: { id: { in: toDelete } } });
            for (const opt of options) {
                if (opt.id) {
                    await tx.productOption.update({
                        where: { id: opt.id },
                        data: { name: opt.name, price: opt.price },
                    });
                }
                else {
                    await tx.productOption.create({
                        data: { productId: product.id, name: opt.name, price: opt.price },
                    });
                }
            }
        }
        return updatedProduct;
    });
    redis_baseQueue_1.productIndexQueue
        .add("indexProduct", { productId: product.id })
        .catch((err) => logger_1.logger.warn({ err }, "Failed to queue product indexing"));
    await (0, clearCaches_1.clearProductCache)(product.id, req.user.id);
    await (0, product_service_1.clearProductFromCarts)(product.id);
    const computedIsLive = (0, exports.computeIsLive)(updated.productSchedule, updated.isLive);
    const cacheValue = JSON.stringify({
        ...updated,
        images: finalImages,
        video: finalVideo,
        isLive: computedIsLive,
    });
    await redis_1.redisProducts.set(redisCacheTiming_1.CACHE_KEYS.PRODUCT_DETAIL(product.id), cacheValue, {
        EX: redisCacheTiming_1.CACHE_TTLS.PRODUCT_DETAIL,
    });
    const dashboardService = new vendorDashboard_service_1.VendorDashboardService(req.user.id);
    await dashboardService.invalidateCache();
    return (0, apiResponse_1.sendSuccess)(res, { ...updated, images: finalImages, video: finalVideo }, "Product updated successfully");
};
exports.updateProduct = updateProduct;
// PATCH /product/:id/archive
const archiveProduct = async (req, res) => {
    const productId = (0, paramUtils_1.ensureString)(req.params.id);
    if (!req.user || req.user.role !== "VENDOR")
        throw new AppError_1.ForbiddenError("Only vendors can archive products");
    const parsed = ProductCRUDSchema_1.archiveProductSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("archived must be a boolean");
    const { archived } = parsed.data;
    const product = await prisma_1.default.product.findUnique({
        where: { id: productId },
        include: { productSchedule: true },
    });
    if (!product || product.vendorId !== req.user.id)
        throw new AppError_1.ForbiddenError("Unauthorized or product not found");
    const updated = await prisma_1.default.product.update({
        where: { id: productId },
        data: { archived },
        include: { productSchedule: true },
    });
    redis_baseQueue_1.productIndexQueue
        .add("indexProduct", { productId })
        .catch((err) => logger_1.logger.warn({ err }, "Failed to queue product indexing"));
    await (0, clearCaches_1.clearProductCache)(productId, req.user.id);
    await (0, product_service_1.clearProductFromCarts)(productId);
    const computedIsLive = (0, exports.computeIsLive)(updated.productSchedule, updated.isLive);
    await redis_1.redisProducts.set(redisCacheTiming_1.CACHE_KEYS.PRODUCT_DETAIL(productId), JSON.stringify({ ...updated, isLive: computedIsLive }), { EX: redisCacheTiming_1.CACHE_TTLS.PRODUCT_DETAIL });
    const dashboardService = new vendorDashboard_service_1.VendorDashboardService(req.user.id);
    await dashboardService.invalidateCache();
    return (0, apiResponse_1.sendSuccess)(res, updated, `Product successfully ${archived ? "archived" : "unarchived"}`);
};
exports.archiveProduct = archiveProduct;
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
const deleteProduct = async (req, res) => {
    const productId = (0, paramUtils_1.ensureString)(req.params.id);
    if (!req.user || req.user.role !== "VENDOR")
        throw new AppError_1.ForbiddenError("Only vendors can delete products");
    const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
    if (!product || product.vendorId !== req.user.id)
        throw new AppError_1.ForbiddenError("Unauthorized or product not found");
    const hasOrderHistory = await prisma_1.default.orderItem.findFirst({
        where: { productId },
        select: { id: true },
    });
    if (hasOrderHistory) {
        throw new AppError_1.ConflictError("This product has order history and can't be deleted — archive it instead to stop selling it while keeping past orders intact.");
    }
    await prisma_1.default.product.delete({ where: { id: product.id } });
    await (0, clearCaches_1.clearProductCache)(product.id, req.user.id);
    await (0, product_service_1.clearProductFromCarts)(product.id);
    return (0, apiResponse_1.sendSuccess)(res, {}, "Product deleted successfully");
};
exports.deleteProduct = deleteProduct;
// GET /product/p/suggestions
const getSearchSuggestions = async (req, res) => {
    const q = req.query.q?.trim();
    if (!q || q.length < 2)
        throw new AppError_1.ValidationError("Please enter at least 2 characters");
    const query = q.toLowerCase();
    const keywords = query.split(/\s+/).filter(Boolean);
    const isSingleWord = keywords.length === 1;
    const cacheKey = redisCacheTiming_1.CACHE_KEYS.SUGGESTIONS(query);
    const cached = await redis_1.redisSearch.get(cacheKey);
    if (cached) {
        return (0, apiResponse_1.sendSuccess)(res, { query, results: JSON.parse(cached), fromCache: true }, "Suggestions retrieved successfully");
    }
    const results = isSingleWord
        ? await prisma_1.default.product.findMany({
            where: {
                archived: false,
                name: { contains: query, mode: "insensitive" },
            },
            select: { id: true, name: true, category: true, isLive: true },
            take: 12,
        })
        : await prisma_1.default.product.findMany({
            where: {
                archived: false,
                AND: keywords.map((word) => ({
                    name: { contains: word, mode: "insensitive" },
                })),
            },
            select: { id: true, name: true, category: true, isLive: true },
            take: 12,
        });
    // Ranking: live products first, then exact prefix matches, then general matches
    results.sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const aScore = (a.isLive ? 3 : 0) +
            (aName.startsWith(query) ? 2 : 0) +
            (keywords.every((w) => aName.includes(w)) ? 1 : 0);
        const bScore = (b.isLive ? 3 : 0) +
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
    await redis_1.redisSearch.set(cacheKey, JSON.stringify(suggestions), {
        EX: redisCacheTiming_1.CACHE_TTLS.SUGGESTIONS,
    });
    return (0, apiResponse_1.sendSuccess)(res, { query, results: suggestions, fromCache: false }, "Suggestions retrieved successfully");
};
exports.getSearchSuggestions = getSearchSuggestions;
// GET /product/p/search
// Full-text search (Postgres tsvector) with a trigram-similarity fuzzy
// fallback when full-text comes up short, plus AI-assisted typo
// correction on the query itself. This logic is delicate and specific to
// the Postgres extensions in use — left structurally as-is (verified
// correct: the $1/$2/etc placeholders are genuinely parameterized, not
// string-interpolated, so despite the "Unsafe" naming there's no SQL
// injection risk here — only the query *shape* bypasses Prisma's query
// builder, not the values).
const searchProducts = async (req, res) => {
    const q = req.query.q?.trim();
    if (!q)
        throw new AppError_1.ValidationError("Query parameter 'q' is required");
    const page = parseInt(req.query.page || "1", 10);
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 20);
    const offset = (page - 1) * limit;
    const fuzzyThreshold = 0.1;
    const sortBy = req.query.sortBy || "relevance";
    const corrected = (0, localSearchCorrect_1.correctQuery)(q);
    const cacheKey = redisCacheTiming_1.CACHE_KEYS.SEARCH(corrected, sortBy, undefined, page, limit);
    const cached = await redis_1.redisSearch.get(cacheKey);
    if (cached) {
        const data = JSON.parse(cached);
        return (0, apiResponse_1.sendSuccess)(res, {
            corrected,
            results: data.results,
            pagination: data.pagination,
            fromCache: true,
        }, "Products fetched successfully");
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
    const fullTextResults = await prisma_1.default.$queryRawUnsafe(`
    SELECT
      p.id, p.name, p.description, p.price, p."vendorId", p.images, p."isLive", p.archived, p."createdAt", p."updatedAt",
      CASE
        WHEN s."goLiveAt" IS NOT NULL AND s."takeDownAt" IS NOT NULL
          THEN (now() >= s."goLiveAt" AND now() <= s."takeDownAt" + (s."graceMinutes" * interval '1 minute'))
        ELSE p."isLive"
      END AS "computedIsLive",
      ts_rank_cd(setweight(to_tsvector('english', p.name), 'A') || setweight(to_tsvector('english', p.description), 'B'), websearch_to_tsquery('english', $1)) AS rank,
      (p.name ILIKE $2 OR p.description ILIKE $2) AS exact_match
    FROM "Product" p
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
    WHERE p.archived = false
      AND (p.tsvector_col @@ websearch_to_tsquery('english', $1) OR p.name ILIKE $2 OR p.description ILIKE $2)
    ORDER BY exact_match DESC, "computedIsLive" DESC, rank DESC, ${secondaryOrder}
    LIMIT $3 OFFSET $4;
  `, corrected, `%${corrected}%`, limit, offset);
    let fuzzyResults = [];
    if (fullTextResults.length < limit) {
        await prisma_1.default.$executeRawUnsafe(`SET pg_trgm.similarity_threshold = ${fuzzyThreshold};`);
        fuzzyResults = await prisma_1.default.$queryRawUnsafe(`
      SELECT
        p.id, p.name, p.description, p.price, p."vendorId", p.images, p."isLive", p.archived, p."createdAt", p."updatedAt",
        CASE
          WHEN s."goLiveAt" IS NOT NULL AND s."takeDownAt" IS NOT NULL
            THEN (now() >= s."goLiveAt" AND now() <= s."takeDownAt" + (s."graceMinutes" * interval '1 minute'))
          ELSE p."isLive"
        END AS "computedIsLive",
        similarity(p.name || ' ' || p.description, $1) AS sim_score
      FROM "Product" p
      LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
      WHERE p.archived = false AND similarity(p.name || ' ' || p.description, $1) > $2
      ORDER BY "computedIsLive" DESC, sim_score DESC, ${secondaryOrder}
      LIMIT $3 OFFSET $4;
    `, corrected, fuzzyThreshold, limit, offset);
    }
    const seen = new Set();
    const results = [...fullTextResults, ...fuzzyResults].filter((p) => {
        if (seen.has(p.id))
            return false;
        seen.add(p.id);
        return true;
    });
    const totalResult = await prisma_1.default.$queryRawUnsafe(`
    SELECT COUNT(*)::bigint AS total FROM "Product" p
    WHERE p.archived = false AND (p.tsvector_col @@ websearch_to_tsquery('english', $1) OR p.name ILIKE $2 OR p.description ILIKE $2);
  `, corrected, `%${corrected}%`);
    const total = Number(totalResult[0]?.total || 0);
    const responseData = {
        corrected,
        results,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
    await redis_1.redisSearch.set(cacheKey, JSON.stringify(responseData), {
        EX: redisCacheTiming_1.CACHE_TTLS.SEARCH,
    });
    return (0, apiResponse_1.sendSuccess)(res, responseData, "Products fetched successfully");
};
exports.searchProducts = searchProducts;
// GET /product/p/most
const getMostPopularProducts = async (req, res) => {
    const page = parseInt(req.query.page || "1", 10);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 50);
    const skip = (page - 1) * limit;
    const cacheKey = redisCacheTiming_1.CACHE_KEYS.PRODUCTS_MOST_POPULAR(page, limit);
    const cached = await redis_1.redisProducts.get(cacheKey);
    if (cached) {
        const cachedData = JSON.parse(cached);
        res.setHeader("X-Cache", "HIT");
        return (0, apiResponse_1.sendSuccess)(res, cachedData.data, "Most popular products fetched successfully", 200, cachedData.pagination);
    }
    // Filtered by isLive directly in SQL (both the page query and the count
    // query) rather than fetching a page of "archived = false" rows and
    // filtering out non-live ones in JS afterward. The previous approach
    // applied LIMIT/OFFSET *before* filtering, so a page could return
    // anywhere from 0 to `limit` items after the JS filter while `total`/
    // `totalPages` were still computed from the unfiltered count — pagination
    // that didn't actually match what was returned. isLive is kept
    // reasonably fresh by fixLiveStatusJob (runs every 5 minutes), which is
    // an acceptable trade-off for a popularity listing (unlike checkout,
    // where exact real-time accuracy matters far more).
    const rawProducts = await prisma_1.default.$queryRawUnsafe(`
    SELECT p.id, p.name, p.price, p.images, p."averageRating", p."reviewCount",
           p."popularityScore", p."popularityPercent", p."totalViews", p.category,
           p."isLive", p."archived",
           s."goLiveAt", s."takeDownAt", s."graceMinutes"
    FROM "Product" p
    LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
    WHERE p."archived" = false AND p."isLive" = true
    ORDER BY p."popularityScore" DESC
    LIMIT $1 OFFSET $2;
    `, limit, skip);
    // isLive is still recomputed from the schedule for *display* accuracy
    // (in case the stored column is a few minutes stale) — just not used to
    // filter/exclude rows, since that's what broke pagination.
    const products = rawProducts.map((p) => {
        const schedule = p.goLiveAt || p.takeDownAt || p.graceMinutes
            ? {
                goLiveAt: p.goLiveAt ?? undefined,
                takeDownAt: p.takeDownAt ?? undefined,
                graceMinutes: p.graceMinutes ?? undefined,
            }
            : null;
        return { ...p, isLive: (0, exports.computeIsLive)(schedule, p.isLive) };
    });
    const totalResult = await prisma_1.default.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "Product" p WHERE p."archived" = false AND p."isLive" = true;`);
    const totalCount = totalResult[0]?.count ?? 0;
    res.setHeader("X-Cache", "MISS");
    const pagination = {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
    };
    await redis_1.redisProducts.set(cacheKey, JSON.stringify({ data: products, pagination }), { EX: redisCacheTiming_1.CACHE_TTLS.PRODUCTS_MOST_POPULAR });
    return (0, apiResponse_1.sendSuccess)(res, products, "Most popular products fetched successfully", 200, pagination);
};
exports.getMostPopularProducts = getMostPopularProducts;

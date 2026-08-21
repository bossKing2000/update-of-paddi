"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVendorReviewById = exports.getVendorReviewSummary = exports.getVendorReviews = exports.reviewVendor = exports.reportReview = exports.voteReview = exports.deleteReplyToReview = exports.replyToReview = exports.getProductReviewSummary = exports.getProductReviews = exports.deleteReview = exports.updateReview = exports.reviewProduct = void 0;
exports.getRatingLabel = getRatingLabel;
exports.ratingBreakdown = ratingBreakdown;
const prisma_1 = __importDefault(require("../lib/prisma"));
const paramUtils_1 = require("../utils/paramUtils");
const ProductCRUDSchema_1 = require("../validations/ProductCRUDSchema");
const client_1 = require("@prisma/client");
const recordActivityBundle_1 = require("../utils/activityUtils/recordActivityBundle");
const apiResponse_1 = require("../utils/apiResponse");
const AppError_1 = require("../errors/AppError");
function getRatingLabel(rating) {
    if (rating >= 4.5)
        return "Excellent";
    if (rating >= 4)
        return "Very Good";
    if (rating >= 3)
        return "Good";
    if (rating >= 2)
        return "Fair";
    return "Poor";
}
function extractImagePaths(files) {
    if (!files || typeof files !== "object" || !("images" in files))
        return [];
    const imageFiles = files["images"];
    return imageFiles.map((file) => file.path);
}
function ratingBreakdown(counts) {
    return [5, 4, 3, 2, 1].map((star) => {
        const found = counts.find((c) => c.rating === star);
        return {
            stars: star,
            count: found ? found._count.rating : 0,
            label: getRatingLabel(star),
        };
    });
}
// ======= PRODUCT REVIEWS =======
// POST /reviews/product
const reviewProduct = async (req, res) => {
    if (!req.user || req.user.role !== "CUSTOMER")
        throw new AppError_1.ForbiddenError("Only customers can review products");
    const parsed = ProductCRUDSchema_1.reviewProductSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid review", parsed.error.flatten().fieldErrors);
    const existing = await prisma_1.default.productReview.findFirst({
        where: { productId: parsed.data.productId, customerId: req.user.id },
    });
    if (existing)
        throw new AppError_1.ConflictError("You already reviewed this product");
    // `verifiedPurchase` existed on the schema but was never set or checked
    // anywhere — any CUSTOMER-role account could review any product without
    // ever having ordered it, and even a genuine buyer's review was never
    // actually marked verified. Requiring a completed order containing this
    // product closes an obvious fake-review / competitor-sabotage vector on
    // a marketplace with many independent vendors.
    const hasCompletedOrder = await prisma_1.default.orderItem.findFirst({
        where: {
            productId: parsed.data.productId,
            order: { customerId: req.user.id, status: client_1.OrderStatus.COMPLETED },
        },
        select: { id: true },
    });
    if (!hasCompletedOrder)
        throw new AppError_1.ForbiddenError("You can only review products from a completed order");
    const imageUrls = extractImagePaths(req.files);
    const review = await prisma_1.default.productReview.create({
        data: {
            ...parsed.data,
            customerId: req.user.id,
            images: imageUrls,
            verifiedPurchase: true,
        },
    });
    const product = await prisma_1.default.product.findUnique({
        where: { id: parsed.data.productId },
        select: { vendorId: true, name: true },
    });
    const customer = await prisma_1.default.user.findUnique({
        where: { id: req.user.id },
        select: { name: true },
    });
    // Previously nothing notified the vendor when one of their products got
    // reviewed at all (reviewVendor did this for vendor-profile reviews;
    // product reviews had no equivalent).
    if (product) {
        await (0, recordActivityBundle_1.recordActivityBundle)({
            req,
            actorId: req.user.id,
            actions: [
                {
                    type: client_1.ActivityType.REVIEW_POSTED,
                    title: "New Product Review",
                    message: `${customer?.name || "A customer"} left a ${parsed.data.rating}-star review on "${product.name}".`,
                    targetId: product.vendorId,
                    socketEvent: "REVIEW",
                    metadata: {
                        reviewId: review.id,
                        productId: parsed.data.productId,
                        rating: parsed.data.rating,
                    },
                    relation: "vendor",
                },
            ],
            audit: {
                action: "PRODUCT_REVIEW_POSTED",
                metadata: {
                    productId: parsed.data.productId,
                    reviewId: review.id,
                    actorId: req.user.id,
                },
            },
            notifyRealtime: true,
            notifyPush: true,
        });
    }
    return (0, apiResponse_1.sendCreated)(res, { review }, "Review submitted");
};
exports.reviewProduct = reviewProduct;
// PATCH /reviews/product/:id
const updateReview = async (req, res) => {
    if (!req.user || req.user.role !== "CUSTOMER")
        throw new AppError_1.ForbiddenError("Only customers can update reviews");
    const reviewId = (0, paramUtils_1.ensureString)(req.params.id);
    const review = await prisma_1.default.productReview.findUnique({
        where: { id: reviewId },
    });
    if (!review || review.customerId !== req.user.id)
        throw new AppError_1.ForbiddenError("Unauthorized or review not found");
    const parsed = ProductCRUDSchema_1.reviewProductSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid review", parsed.error.flatten().fieldErrors);
    // A review's product must never change after creation — reviewProductSchema
    // requires productId (since it's also used at creation time), but
    // spreading it directly into the update meant a customer editing their
    // own review could pass a *different* productId and silently reassign
    // their review — with its vote/report history intact — onto an
    // unrelated product, polluting that product's rating.
    const { productId: _ignoredProductId, ...updatableFields } = parsed.data;
    const imageUrls = extractImagePaths(req.files);
    const updated = await prisma_1.default.productReview.update({
        where: { id: reviewId },
        data: {
            ...updatableFields,
            images: imageUrls.length > 0 ? imageUrls : review.images,
        },
    });
    return (0, apiResponse_1.sendSuccess)(res, { updated }, "Review updated");
};
exports.updateReview = updateReview;
// DELETE /reviews/product/:id
const deleteReview = async (req, res) => {
    if (!req.user || req.user.role !== "CUSTOMER")
        throw new AppError_1.ForbiddenError("Only customers can delete reviews");
    const reviewId = (0, paramUtils_1.ensureString)(req.params.id);
    const review = await prisma_1.default.productReview.findUnique({
        where: { id: reviewId },
    });
    if (!review || review.customerId !== req.user.id)
        throw new AppError_1.ForbiddenError("Unauthorized or review not found");
    // Votes/reports/vendor reply are all onDelete: Cascade — cleaned up
    // automatically, no manual deletion needed here.
    await prisma_1.default.productReview.delete({ where: { id: reviewId } });
    return (0, apiResponse_1.sendSuccess)(res, {}, "Review deleted");
};
exports.deleteReview = deleteReview;
// GET /reviews/product/:productId
const getProductReviews = async (req, res) => {
    const productId = (0, paramUtils_1.ensureString)(req.params.productId);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
        prisma_1.default.productReview.findMany({
            where: { productId },
            include: {
                customer: { select: { id: true, name: true, avatarUrl: true } },
                reply: true,
                votes: true,
            },
            orderBy: { createdAt: "desc" },
            skip,
            take: limit,
        }),
        prisma_1.default.productReview.count({ where: { productId } }),
    ]);
    return (0, apiResponse_1.sendSuccess)(res, { reviews }, "Reviews retrieved", 200, {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
    });
};
exports.getProductReviews = getProductReviews;
// GET /reviews/product/:productId/summary
const getProductReviewSummary = async (req, res) => {
    const productId = (0, paramUtils_1.ensureString)(req.params.productId);
    const parseResult = ProductCRUDSchema_1.reviewSummaryQuerySchema.safeParse(req.query);
    if (!parseResult.success)
        throw new AppError_1.ValidationError("Invalid query", parseResult.error.flatten().fieldErrors);
    const [breakdown, average] = await Promise.all([
        prisma_1.default.productReview.groupBy({
            by: ["rating"],
            where: { productId },
            _count: { rating: true },
            orderBy: { rating: "desc" },
        }),
        prisma_1.default.productReview.aggregate({
            where: { productId },
            _avg: { rating: true },
            _count: { rating: true },
        }),
    ]);
    return (0, apiResponse_1.sendSuccess)(res, {
        averageRating: Number(average._avg.rating?.toFixed(2)) || 0,
        totalReviews: average._count.rating,
        breakdown: ratingBreakdown(breakdown),
    }, "Review summary retrieved");
};
exports.getProductReviewSummary = getProductReviewSummary;
// ===== VENDOR REPLIES =====
// POST /reviews/product/:id/reply
const replyToReview = async (req, res) => {
    if (!req.user || req.user.role !== "VENDOR")
        throw new AppError_1.ForbiddenError("Only vendors can reply to reviews");
    const parsed = ProductCRUDSchema_1.replyToReviewSchema.safeParse({
        reviewId: (0, paramUtils_1.ensureString)(req.params.id),
        ...req.body,
    });
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid reply", parsed.error.flatten().fieldErrors);
    const review = await prisma_1.default.productReview.findUnique({
        where: { id: parsed.data.reviewId },
        include: { product: true },
    });
    if (!review || review.product.vendorId !== req.user.id)
        throw new AppError_1.ForbiddenError("You do not own this product");
    const isNewReply = !(await prisma_1.default.vendorReply.findUnique({
        where: { reviewId: parsed.data.reviewId },
    }));
    const reply = await prisma_1.default.vendorReply.upsert({
        where: { reviewId: parsed.data.reviewId },
        update: { message: parsed.data.message },
        create: {
            reviewId: parsed.data.reviewId,
            vendorId: req.user.id,
            message: parsed.data.message,
        },
    });
    // Previously nothing told the customer their review got a reply at all
    // — they'd only find out by happening to revisit the product page.
    if (isNewReply) {
        await (0, recordActivityBundle_1.recordActivityBundle)({
            req,
            actorId: req.user.id,
            actions: [
                {
                    type: client_1.ActivityType.GENERAL,
                    title: "Vendor replied to your review",
                    message: `The vendor replied to your review on "${review.product.name}".`,
                    targetId: review.customerId,
                    socketEvent: "REVIEW",
                    metadata: { reviewId: review.id, productId: review.productId },
                },
            ],
            audit: {
                action: "REVIEW_REPLIED",
                metadata: { reviewId: review.id, vendorId: req.user.id },
            },
            notifyRealtime: true,
            notifyPush: true,
        });
    }
    return (0, apiResponse_1.sendSuccess)(res, { reply }, "Reply added");
};
exports.replyToReview = replyToReview;
// DELETE /reviews/product/:id/reply
const deleteReplyToReview = async (req, res) => {
    if (!req.user || req.user.role !== "VENDOR")
        throw new AppError_1.ForbiddenError("Only vendors can delete replies");
    const reviewId = (0, paramUtils_1.ensureString)(req.params.id);
    const reply = await prisma_1.default.vendorReply.findUnique({
        where: { reviewId },
        include: { review: { include: { product: true } } },
    });
    if (!reply || reply.vendorId !== req.user.id)
        throw new AppError_1.ForbiddenError("Unauthorized or reply not found");
    await prisma_1.default.vendorReply.delete({ where: { reviewId } });
    return (0, apiResponse_1.sendSuccess)(res, {}, "Reply deleted successfully");
};
exports.deleteReplyToReview = deleteReplyToReview;
// ===== REVIEW VOTES & REPORTS =====
// POST /reviews/product/:id/vote
const voteReview = async (req, res) => {
    if (!req.user)
        throw new AppError_1.ForbiddenError("Authentication required");
    const parsed = ProductCRUDSchema_1.reviewVoteSchema.safeParse({
        reviewId: (0, paramUtils_1.ensureString)(req.params.id),
        ...req.body,
    });
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid vote", parsed.error.flatten().fieldErrors);
    const review = await prisma_1.default.productReview.findUnique({
        where: { id: parsed.data.reviewId },
        select: { customerId: true },
    });
    if (!review)
        throw new AppError_1.NotFoundError("Review");
    if (review.customerId === req.user.id)
        throw new AppError_1.ValidationError("You can't vote on your own review");
    await prisma_1.default.reviewVote.upsert({
        where: {
            reviewId_userId: { reviewId: parsed.data.reviewId, userId: req.user.id },
        },
        update: { isHelpful: parsed.data.isHelpful },
        create: {
            reviewId: parsed.data.reviewId,
            userId: req.user.id,
            isHelpful: parsed.data.isHelpful,
        },
    });
    return (0, apiResponse_1.sendSuccess)(res, {}, "Voted successfully");
};
exports.voteReview = voteReview;
// POST /reviews/product/:id/report
const reportReview = async (req, res) => {
    if (!req.user)
        throw new AppError_1.ForbiddenError("Authentication required");
    const parsed = ProductCRUDSchema_1.reportReviewSchema.safeParse({
        reviewId: (0, paramUtils_1.ensureString)(req.params.id),
        ...req.body,
    });
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid report", parsed.error.flatten().fieldErrors);
    const review = await prisma_1.default.productReview.findUnique({
        where: { id: parsed.data.reviewId },
        select: { id: true },
    });
    if (!review)
        throw new AppError_1.NotFoundError("Review");
    const existing = await prisma_1.default.reviewReport.findFirst({
        where: { reviewId: parsed.data.reviewId, userId: req.user.id },
    });
    if (existing)
        throw new AppError_1.ConflictError("You already reported this review");
    await prisma_1.default.reviewReport.create({
        data: {
            reviewId: parsed.data.reviewId,
            userId: req.user.id,
            reason: parsed.data.reason,
        },
    });
    return (0, apiResponse_1.sendSuccess)(res, {}, "Report submitted");
};
exports.reportReview = reportReview;
// ===== VENDOR REVIEWS =====
// POST /reviews/vendor/:vendorId
const reviewVendor = async (req, res) => {
    if (!req.user || req.user.role !== "CUSTOMER")
        throw new AppError_1.ForbiddenError("Only customers can review vendors");
    const parsed = ProductCRUDSchema_1.createVendorReviewSchema.safeParse({
        vendorId: (0, paramUtils_1.ensureString)(req.params.vendorId),
        ...req.body,
    });
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid review", parsed.error.flatten().fieldErrors);
    const existing = await prisma_1.default.vendorReview.findFirst({
        where: { vendorId: parsed.data.vendorId, customerId: req.user.id },
    });
    if (existing)
        throw new AppError_1.ConflictError("You already reviewed this vendor");
    // Same verified-purchase requirement as product reviews — previously
    // anyone with a CUSTOMER account could review any vendor without ever
    // having ordered from them.
    const hasCompletedOrder = await prisma_1.default.order.findFirst({
        where: {
            vendorId: parsed.data.vendorId,
            customerId: req.user.id,
            status: client_1.OrderStatus.COMPLETED,
        },
        select: { id: true },
    });
    if (!hasCompletedOrder)
        throw new AppError_1.ForbiddenError("You can only review vendors you've ordered from (completed order required)");
    const review = await prisma_1.default.vendorReview.create({
        data: { ...parsed.data, customerId: req.user.id },
    });
    const customer = await prisma_1.default.user.findUnique({
        where: { id: req.user.id },
        select: { name: true },
    });
    await (0, recordActivityBundle_1.recordActivityBundle)({
        req,
        actorId: req.user.id,
        actions: [
            {
                type: client_1.ActivityType.REVIEW_POSTED,
                title: "New Vendor Review",
                message: `${customer?.name || "A customer"} submitted a review for you.`,
                targetId: parsed.data.vendorId,
                socketEvent: "REVIEW",
                metadata: { reviewId: review.id, customerId: req.user.id },
                relation: "vendor",
            },
        ],
        audit: {
            action: "REVIEW_POSTED",
            metadata: {
                vendorId: parsed.data.vendorId,
                reviewId: review.id,
                actorId: req.user.id,
            },
        },
        notifyRealtime: true,
        notifyPush: true,
    });
    return (0, apiResponse_1.sendCreated)(res, { review }, "Vendor review submitted");
};
exports.reviewVendor = reviewVendor;
// GET /reviews/vendor/:vendorId
const getVendorReviews = async (req, res) => {
    const vendorId = (0, paramUtils_1.ensureString)(req.params.vendorId);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
        prisma_1.default.vendorReview.findMany({
            where: { vendorId },
            include: {
                customer: { select: { id: true, name: true, avatarUrl: true } },
            },
            orderBy: { createdAt: "desc" },
            skip,
            take: limit,
        }),
        prisma_1.default.vendorReview.count({ where: { vendorId } }),
    ]);
    return (0, apiResponse_1.sendSuccess)(res, { reviews }, "Vendor reviews retrieved", 200, {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
    });
};
exports.getVendorReviews = getVendorReviews;
// GET /reviews/vendor/:vendorId/summary
const getVendorReviewSummary = async (req, res) => {
    const vendorId = (0, paramUtils_1.ensureString)(req.params.vendorId);
    const [breakdown, average] = await Promise.all([
        prisma_1.default.vendorReview.groupBy({
            by: ["rating"],
            where: { vendorId },
            _count: { rating: true },
            orderBy: { rating: "desc" },
        }),
        prisma_1.default.vendorReview.aggregate({
            where: { vendorId },
            _avg: { rating: true },
            _count: { rating: true },
        }),
    ]);
    return (0, apiResponse_1.sendSuccess)(res, {
        averageRating: Number(average._avg.rating?.toFixed(2)) || 0,
        totalReviews: average._count.rating,
        breakdown: ratingBreakdown(breakdown),
    }, "Vendor review summary retrieved");
};
exports.getVendorReviewSummary = getVendorReviewSummary;
// GET /reviews/vendor/single/:reviewId
const getVendorReviewById = async (req, res) => {
    const reviewId = (0, paramUtils_1.ensureString)(req.params.reviewId);
    const review = await prisma_1.default.vendorReview.findUnique({
        where: { id: reviewId },
        include: {
            customer: { select: { id: true, name: true, avatarUrl: true } },
        },
    });
    if (!review)
        throw new AppError_1.NotFoundError("Review");
    return (0, apiResponse_1.sendSuccess)(res, { review }, "Review retrieved");
};
exports.getVendorReviewById = getVendorReviewById;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVendorReviewById = exports.getVendorReviewSummary = exports.getVendorReviews = exports.reviewVendor = exports.reportReview = exports.voteReview = exports.deleteReplyToReview = exports.replyToReview = exports.getProductReviewSummary = exports.getProductReviews = exports.deleteReview = exports.updateReview = exports.reviewProduct = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const ProductCRUDSchema_1 = require("../validations/ProductCRUDSchema");
const recordActivityBundle_1 = require("../utils/activityUtils/recordActivityBundle");
const client_1 = require("@prisma/client");
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
// ✅ Utility: Extract Cloudinary URLs from Multer files
function extractImagePaths(files) {
    if (!files || typeof files !== "object" || !("images" in files))
        return [];
    const imageFiles = files["images"];
    return imageFiles.map((file) => file.path); // Already Cloudinary URL
}
// ======= PRODUCT REVIEWS =======
// Create a product review
const reviewProduct = async (req, res) => {
    try {
        if (!req.user || req.user.role !== "CUSTOMER") {
            res.status(403).json({ message: "Only customers can review products" });
            return;
        }
        const parsed = ProductCRUDSchema_1.reviewProductSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.issues });
            return;
        }
        const existing = await prisma_1.default.productReview.findFirst({
            where: { productId: parsed.data.productId, customerId: req.user.id },
        });
        if (existing) {
            res.status(400).json({ message: "You already reviewed this product" });
            return;
        }
        const imageUrls = extractImagePaths(req.files);
        const review = await prisma_1.default.productReview.create({
            data: {
                ...parsed.data,
                customerId: req.user.id,
                images: imageUrls,
            },
        });
        res.status(201).json({ message: "Review submitted", review });
    }
    catch (err) {
        console.error("Submit review error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.reviewProduct = reviewProduct;
// Update a product review
const updateReview = async (req, res) => {
    try {
        if (!req.user || req.user.role !== "CUSTOMER") {
            res.status(403).json({ message: "Only customers can update reviews" });
            return;
        }
        const review = await prisma_1.default.productReview.findUnique({
            where: { id: req.params.id },
        });
        if (!review || review.customerId !== req.user.id) {
            res.status(403).json({ message: "Unauthorized or review not found" });
            return;
        }
        const parsed = ProductCRUDSchema_1.reviewProductSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.issues });
            return;
        }
        const imageUrls = extractImagePaths(req.files);
        const updated = await prisma_1.default.productReview.update({
            where: { id: req.params.id },
            data: {
                ...parsed.data,
                images: imageUrls.length > 0 ? imageUrls : review.images,
            },
        });
        res.json({ message: "Review updated", updated });
    }
    catch (err) {
        console.error("Update review error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.updateReview = updateReview;
// Delete a product review
const deleteReview = async (req, res) => {
    try {
        if (!req.user || req.user.role !== "CUSTOMER") {
            res.status(403).json({ message: "Only customers can delete reviews" });
            return;
        }
        const review = await prisma_1.default.productReview.findUnique({
            where: { id: req.params.id },
        });
        if (!review || review.customerId !== req.user.id) {
            res.status(403).json({ message: "Unauthorized or review not found" });
            return;
        }
        await prisma_1.default.productReview.delete({ where: { id: req.params.id } });
        res.json({ message: "Review deleted" });
    }
    catch (err) {
        console.error("Delete review error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.deleteReview = deleteReview;
// Get product reviews (with optional pagination)
const getProductReviews = async (req, res) => {
    try {
        const productId = req.params.productId;
        const { page = "1", limit = "10" } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);
        const reviews = await prisma_1.default.productReview.findMany({
            where: { productId },
            include: {
                customer: { select: { id: true, name: true, avatarUrl: true } },
                reply: true,
                votes: true,
                reports: true,
            },
            orderBy: { createdAt: "desc" },
            skip,
            take,
        });
        const total = await prisma_1.default.productReview.count({ where: { productId } });
        res.json({ page: Number(page), limit: Number(limit), total, reviews });
    }
    catch (err) {
        console.error("Get reviews error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.getProductReviews = getProductReviews;
// Get product review summary
const getProductReviewSummary = async (req, res) => {
    try {
        const productId = req.params.productId;
        const parseResult = ProductCRUDSchema_1.reviewSummaryQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
            res.status(400).json({ error: parseResult.error.issues });
            return;
        }
        const { page = 1, limit = 10 } = parseResult.data;
        const breakdown = await prisma_1.default.productReview.groupBy({
            by: ["rating"],
            where: { productId },
            _count: { rating: true },
            orderBy: { rating: "desc" },
        });
        const average = await prisma_1.default.productReview.aggregate({
            where: { productId },
            _avg: { rating: true },
            _count: { rating: true },
        });
        const formattedBreakdown = [5, 4, 3, 2, 1].map((star) => {
            const found = breakdown.find((b) => b.rating === star);
            return { stars: star, count: found ? found._count.rating : 0, label: getRatingLabel(star) };
        });
        res.json({
            averageRating: Number(average._avg.rating?.toFixed(2)) || 0,
            totalReviews: average._count.rating,
            breakdown: formattedBreakdown,
        });
    }
    catch (err) {
        console.error("Review summary error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.getProductReviewSummary = getProductReviewSummary;
// ===== VENDOR REPLIES =====
// Vendor reply to product review
const replyToReview = async (req, res) => {
    try {
        if (!req.user || req.user.role !== "VENDOR") {
            res.status(403).json({ message: "Only vendors can reply to reviews" });
            return;
        }
        const parsed = ProductCRUDSchema_1.replyToReviewSchema.safeParse({ reviewId: req.params.id, ...req.body });
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.issues });
            return;
        }
        const review = await prisma_1.default.productReview.findUnique({
            where: { id: parsed.data.reviewId },
            include: { product: true },
        });
        if (!review || review.product.vendorId !== req.user.id) {
            res.status(403).json({ message: "You do not own this product" });
            return;
        }
        const reply = await prisma_1.default.vendorReply.upsert({
            where: { reviewId: parsed.data.reviewId },
            update: { message: parsed.data.message },
            create: {
                reviewId: parsed.data.reviewId,
                vendorId: req.user.id,
                message: parsed.data.message,
            },
        });
        res.json({ message: "Reply added", reply });
    }
    catch (err) {
        console.error("Reply error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.replyToReview = replyToReview;
// Delete vendor reply
const deleteReplyToReview = async (req, res) => {
    try {
        if (!req.user || req.user.role !== "VENDOR") {
            res.status(403).json({ message: "Only vendors can delete replies" });
            return;
        }
        const reply = await prisma_1.default.vendorReply.findUnique({
            where: { reviewId: req.params.id },
            include: { review: { include: { product: true } } },
        });
        if (!reply || reply.vendorId !== req.user.id) {
            res.status(403).json({ message: "Unauthorized or reply not found" });
            return;
        }
        await prisma_1.default.vendorReply.delete({ where: { reviewId: req.params.id } });
        res.json({ message: "Reply deleted successfully" });
    }
    catch (err) {
        console.error("Delete reply error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.deleteReplyToReview = deleteReplyToReview;
// ===== REVIEW VOTES & REPORTS =====
// Vote on a review
const voteReview = async (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ message: "Unauthorized" });
            return;
        }
        const parsed = ProductCRUDSchema_1.reviewVoteSchema.safeParse({ reviewId: req.params.id, ...req.body });
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.issues });
            return;
        }
        await prisma_1.default.reviewVote.upsert({
            where: { reviewId_userId: { reviewId: parsed.data.reviewId, userId: req.user.id } },
            update: { isHelpful: parsed.data.isHelpful },
            create: { reviewId: parsed.data.reviewId, userId: req.user.id, isHelpful: parsed.data.isHelpful },
        });
        res.json({ message: "Voted successfully" });
    }
    catch (err) {
        console.error("Vote error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.voteReview = voteReview;
// Report a review
const reportReview = async (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ message: "Unauthorized" });
            return;
        }
        const parsed = ProductCRUDSchema_1.reportReviewSchema.safeParse({ reviewId: req.params.id, ...req.body });
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.issues });
            return;
        }
        await prisma_1.default.reviewReport.create({
            data: { reviewId: parsed.data.reviewId, userId: req.user.id, reason: parsed.data.reason },
        });
        res.json({ message: "Report submitted" });
    }
    catch (err) {
        console.error("Report error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.reportReview = reportReview;
// ===== VENDOR REVIEWS =====
// Create a vendor review
// export const reviewVendor = async (req: AuthRequest, res: Response): Promise<void> => {
//   try {
//     if (!req.user || req.user.role !== "CUSTOMER") {
//       res.status(403).json({ message: "Only customers can review vendors" });
//       return;
//     }
//     const parsed = createVendorReviewSchema.safeParse(req.body);
//     if (!parsed.success) {
//       res.status(400).json({ error: (parsed.error as ZodError).issues });
//       return;
//     }
//     const existing = await prisma.vendorReview.findFirst({
//       where: { vendorId: parsed.data.vendorId, customerId: req.user.id },
//     });
//     if (existing) {
//       res.status(400).json({ message: "You already reviewed this vendor" });
//       return;
//     }
//     const review = await prisma.vendorReview.create({
//       data: { ...parsed.data, customerId: req.user.id },
//     });
//     res.status(201).json({ message: "Vendor review submitted", review });
//   } catch (err) {
//     console.error("Vendor review error:", err);
//     res.status(500).json({ error: "Server error" });
//   }
// };
const reviewVendor = async (req, res) => {
    try {
        if (!req.user || req.user.role !== "CUSTOMER") {
            res.status(403).json({ message: "Only customers can review vendors" });
            return;
        }
        const parsed = ProductCRUDSchema_1.createVendorReviewSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.issues });
            return;
        }
        const existing = await prisma_1.default.vendorReview.findFirst({
            where: { vendorId: parsed.data.vendorId, customerId: req.user.id },
        });
        if (existing) {
            res.status(400).json({ message: "You already reviewed this vendor" });
            return;
        }
        const review = await prisma_1.default.vendorReview.create({
            data: { ...parsed.data, customerId: req.user.id },
        });
        const customer = await prisma_1.default.user.findUnique({
            where: { id: req.user.id },
        });
        const notificationTitle = "New Vendor Review";
        const notificationMessage = `${customer?.name || "Someone"} submitted a review for you`;
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
        res.status(201).json({ message: "Vendor review submitted", review });
    }
    catch (err) {
        console.error("Vendor review error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.reviewVendor = reviewVendor;
// Get vendor reviews (with pagination)
const getVendorReviews = async (req, res) => {
    try {
        const vendorId = req.params.vendorId;
        const { page = "1", limit = "10" } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);
        const reviews = await prisma_1.default.vendorReview.findMany({
            where: { vendorId },
            include: { customer: { select: { id: true, name: true, avatarUrl: true } } },
            orderBy: { createdAt: "desc" },
            skip,
            take,
        });
        const total = await prisma_1.default.vendorReview.count({ where: { vendorId } });
        res.json({ page: Number(page), limit: Number(limit), total, reviews });
    }
    catch (err) {
        console.error("Get vendor reviews error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.getVendorReviews = getVendorReviews;
// Vendor review summary
const getVendorReviewSummary = async (req, res) => {
    try {
        const vendorId = req.params.vendorId;
        const breakdown = await prisma_1.default.vendorReview.groupBy({
            by: ["rating"],
            where: { vendorId },
            _count: { rating: true },
            orderBy: { rating: "desc" },
        });
        const average = await prisma_1.default.vendorReview.aggregate({
            where: { vendorId },
            _avg: { rating: true },
            _count: { rating: true },
        });
        const formattedBreakdown = [5, 4, 3, 2, 1].map((star) => {
            const found = breakdown.find((b) => b.rating === star);
            return { stars: star, count: found ? found._count.rating : 0, label: getRatingLabel(star) };
        });
        res.json({
            averageRating: Number(average._avg.rating?.toFixed(2)) || 0,
            totalReviews: average._count.rating,
            breakdown: formattedBreakdown,
        });
    }
    catch (err) {
        console.error("Vendor summary error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.getVendorReviewSummary = getVendorReviewSummary;
// Get single review by id
const getVendorReviewById = async (req, res) => {
    const reviewId = req.params.reviewId;
    const review = await prisma_1.default.vendorReview.findUnique({
        where: { id: reviewId },
        include: { customer: { select: { id: true, name: true, avatarUrl: true } } },
    });
    if (!review)
        return res.status(404).json({ error: "Review not found" });
    res.json({ review });
};
exports.getVendorReviewById = getVendorReviewById;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const reviewController_1 = require("../controllers/reviewController");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const multer_1 = require("../utils/multer");
const router = (0, express_1.Router)();
/**
 * =========================
 * Product Reviews
 * =========================
 */
// ⭐ Review summary should come first to avoid conflicts
router.get("/:productId/reviews/summary", reviewController_1.getProductReviewSummary);
// 📦 Get all reviews for a product
router.get("/:productId/reviews", reviewController_1.getProductReviews);
// ✍️ Submit a product review (images/videos optional)
router.post("/:productId/reviews", auth_middleware_1.authenticate, multer_1.upload.fields([{ name: "images", maxCount: 6 }]), // only images allowed
reviewController_1.reviewProduct);
// 📝 Update a review
router.patch("/:productId/reviews/:id", auth_middleware_1.authenticate, multer_1.upload.fields([{ name: "images", maxCount: 6 }]), // only images allowed
reviewController_1.updateReview);
// ❌ Delete a review
router.delete("/:productId/reviews/:id", auth_middleware_1.authenticate, reviewController_1.deleteReview);
// 👍 Vote a review helpful
router.post("/reviews/:id/vote", auth_middleware_1.authenticate, reviewController_1.voteReview);
// 🚩 Report a review for abuse
router.post("/reviews/:id/report", auth_middleware_1.authenticate, reviewController_1.reportReview);
// 💬 Vendor replies to a review (create or update)
// ✅ Updated to avoid conflict with product routes
router.post("/reviews/:id/reply", auth_middleware_1.authenticate, reviewController_1.replyToReview);
// ❌ Vendor deletes their reply to a review
router.delete("/reviews/:id/reply", auth_middleware_1.authenticate, reviewController_1.deleteReplyToReview);
/**
 * =========================
 * Vendor Reviews
 * =========================
 */
// ⭐ Get vendor review summary should come before list to avoid conflicts
router.get("/vendor/:vendorId/reviews/summary", reviewController_1.getVendorReviewSummary);
// 📦 Get all reviews for a vendor
router.get("/vendor/:vendorId/reviews", reviewController_1.getVendorReviews);
// ✍️ Submit a vendor review
router.post("/vendor/:vendorId/reviews", auth_middleware_1.authenticate, reviewController_1.reviewVendor);
exports.default = router;

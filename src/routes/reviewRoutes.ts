import { Router } from "express";
import {reviewProduct,updateReview,deleteReview,getProductReviews,voteReview,reportReview,replyToReview,deleteReplyToReview,getProductReviewSummary, getVendorReviews,reviewVendor,getVendorReviewSummary,} from "../controllers/reviewController";
import { authenticate } from "../middlewares/auth.middleware";
import { upload } from "../utils/multer";

const router = Router();

/**
 * =========================
 * Product Reviews
 * =========================
 */

// ⭐ Review summary should come first to avoid conflicts
router.get("/:productId/reviews/summary", getProductReviewSummary);

// 📦 Get all reviews for a product
router.get("/:productId/reviews", getProductReviews);

// ✍️ Submit a product review (images/videos optional)
router.post(
  "/:productId/reviews",
  authenticate,
  upload.fields([{ name: "images", maxCount: 6 }]), // only images allowed
  reviewProduct
);

// 📝 Update a review
router.patch(
  "/:productId/reviews/:id",
  authenticate,
  upload.fields([{ name: "images", maxCount: 6 }]), // only images allowed
  updateReview
);

// ❌ Delete a review
router.delete("/:productId/reviews/:id", authenticate, deleteReview);

// 👍 Vote a review helpful
router.post("/reviews/:id/vote", authenticate, voteReview);

// 🚩 Report a review for abuse
router.post("/reviews/:id/report", authenticate, reportReview);

// 💬 Vendor replies to a review (create or update)
// ✅ Updated to avoid conflict with product routes
router.post("/reviews/:id/reply", authenticate, replyToReview);

// ❌ Vendor deletes their reply to a review
router.delete("/reviews/:id/reply", authenticate, deleteReplyToReview);

/**
 * =========================
 * Vendor Reviews
 * =========================
 */

// ⭐ Get vendor review summary should come before list to avoid conflicts
router.get("/vendor/:vendorId/reviews/summary", getVendorReviewSummary);

// 📦 Get all reviews for a vendor
router.get("/vendor/:vendorId/reviews", getVendorReviews);

// ✍️ Submit a vendor review
router.post("/vendor/:vendorId/reviews", authenticate, reviewVendor);

export default router;

import { Router } from "express";
import {
  reviewProduct, updateReview, deleteReview, getProductReviews,
  voteReview, reportReview, replyToReview, deleteReplyToReview,
  getProductReviewSummary, getVendorReviews, reviewVendor,
  getVendorReviewSummary, getVendorReviewById,
} from "../controllers/reviewController";
import { authenticate } from "../middlewares/auth.middleware";
import { upload } from "../utils/multer";

const router = Router();
const imageUpload = upload.fields([{ name: "images", maxCount: 6 }]);

// ── Product Reviews ──
// Summary/list routes registered before the single-review-by-id style
// param routes so they can't be shadowed.
router.get("/:productId/reviews/summary", getProductReviewSummary);
router.get("/:productId/reviews", getProductReviews);
router.post("/:productId/reviews", authenticate, imageUpload, reviewProduct);
router.patch("/:productId/reviews/:id", authenticate, imageUpload, updateReview);
router.delete("/:productId/reviews/:id", authenticate, deleteReview);

router.post("/reviews/:id/vote", authenticate, voteReview);
router.post("/reviews/:id/report", authenticate, reportReview);
router.post("/reviews/:id/reply", authenticate, replyToReview);
router.delete("/reviews/:id/reply", authenticate, deleteReplyToReview);

// ── Vendor Reviews ──
router.get("/vendor/:vendorId/reviews/summary", getVendorReviewSummary);
router.get("/vendor/:vendorId/reviews", getVendorReviews);
router.post("/vendor/:vendorId/reviews", authenticate, reviewVendor);
// Was exported by the controller but never wired to any route at all.
router.get("/vendor/reviews/single/:reviewId", getVendorReviewById);

export default router;

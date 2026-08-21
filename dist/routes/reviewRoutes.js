"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const reviewController_1 = require("../controllers/reviewController");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const multer_1 = require("../utils/multer");
const router = (0, express_1.Router)();
const imageUpload = multer_1.upload.fields([{ name: "images", maxCount: 6 }]);
// ── Product Reviews ──
// Summary/list routes registered before the single-review-by-id style
// param routes so they can't be shadowed.
router.get("/:productId/reviews/summary", reviewController_1.getProductReviewSummary);
router.get("/:productId/reviews", reviewController_1.getProductReviews);
router.post("/:productId/reviews", auth_middleware_1.authenticate, imageUpload, reviewController_1.reviewProduct);
router.patch("/:productId/reviews/:id", auth_middleware_1.authenticate, imageUpload, reviewController_1.updateReview);
router.delete("/:productId/reviews/:id", auth_middleware_1.authenticate, reviewController_1.deleteReview);
router.post("/reviews/:id/vote", auth_middleware_1.authenticate, reviewController_1.voteReview);
router.post("/reviews/:id/report", auth_middleware_1.authenticate, reviewController_1.reportReview);
router.post("/reviews/:id/reply", auth_middleware_1.authenticate, reviewController_1.replyToReview);
router.delete("/reviews/:id/reply", auth_middleware_1.authenticate, reviewController_1.deleteReplyToReview);
// ── Vendor Reviews ──
router.get("/vendor/:vendorId/reviews/summary", reviewController_1.getVendorReviewSummary);
router.get("/vendor/:vendorId/reviews", reviewController_1.getVendorReviews);
router.post("/vendor/:vendorId/reviews", auth_middleware_1.authenticate, reviewController_1.reviewVendor);
// Was exported by the controller but never wired to any route at all.
router.get("/vendor/reviews/single/:reviewId", reviewController_1.getVendorReviewById);
exports.default = router;

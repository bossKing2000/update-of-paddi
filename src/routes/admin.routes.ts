import { Router } from "express";
import { authenticate, authorizeAdmin } from "../middlewares/auth.middleware";
import {
  getDashboardOverview,
  getAllUsers, getUserById, setUserRole, setKycStatus, blockUser, unblockUser,
  getAllVendors, getVendorById, setVendorCommissionRate,
  getAllOrders, getOrderById, adminUpdateOrderStatus, getTodaysOrders,
  getAllPayments, getRefundRequests, updateRefundStatus,
  getPendingPayouts, getAllPayouts, processPayout, markPayoutPaid,
  getReportedReviews, resolveReviewReport,
  setDeliveryPersonStatus,
  getAuditLogs,
  getAllPromotions, createPlatformPromotion, adminDeactivatePromotion, adminReactivatePromotion, adminUpdatePromotion, adminDeactivateAllPromotions,
  getGrowthAnalytics,
  getKpis,
  getAllProducts, getProductById, adminUpdateProduct, adminDeleteProduct,
  getAllReviews, adminModerateReview,
  getActivity,
} from "../controllers/admin.controller";

const router = Router();
router.use(authenticate);
router.use(authorizeAdmin);

router.get("/dashboard", getDashboardOverview);

router.get("/users", getAllUsers);
router.get("/users/:id", getUserById);
router.patch("/users/:id/role", setUserRole);
router.patch("/users/:id/kyc-status", setKycStatus);
router.patch("/users/:id/block", blockUser);
router.patch("/users/:id/unblock", unblockUser);

router.get("/vendors", getAllVendors);
router.get("/vendors/:id", getVendorById);
router.patch("/vendors/:id/commission-rate", setVendorCommissionRate);

router.get("/orders", getAllOrders);
router.get("/orders/today", getTodaysOrders);
router.get("/orders/:id", getOrderById);
router.patch("/orders/:id/status", adminUpdateOrderStatus);

router.get("/payments", getAllPayments);
router.get("/refund-requests", getRefundRequests);
router.get("/refunds", getRefundRequests); // Alias for frontend compatibility
router.patch("/refund-requests/:id", updateRefundStatus);
router.patch("/refunds/:id", updateRefundStatus); // Alias for frontend compatibility

router.get("/payouts/pending", getPendingPayouts);
router.get("/payouts", getAllPayouts);
router.post("/payouts/process", processPayout);
router.patch("/payouts/:id/mark-paid", markPayoutPaid);

router.get("/review-reports", getReportedReviews);
router.patch("/review-reports/:id", resolveReviewReport);

router.get("/reviews", getAllReviews);
router.patch("/reviews/:id", adminModerateReview);
router.delete("/reviews/:id", adminModerateReview); // DELETE maps to action=delete

router.patch("/delivery/:userId/status", setDeliveryPersonStatus);

router.get("/audit-logs", getAuditLogs);

router.get("/promotions", getAllPromotions);
router.post("/promotions", createPlatformPromotion);
// Static bulk path must precede any future "/promotions/:id" POST route.
router.post("/promotions/deactivate-all", adminDeactivateAllPromotions);
router.patch("/promotions/:id", adminUpdatePromotion);
router.patch("/promotions/:id/deactivate", adminDeactivatePromotion);
router.patch("/promotions/:id/reactivate", adminReactivatePromotion);

router.get("/growth", getGrowthAnalytics);
router.get("/kpis", getKpis);

router.get("/products", getAllProducts);
router.get("/products/:id", getProductById);
router.patch("/products/:id", adminUpdateProduct);
router.delete("/products/:id", adminDeleteProduct);

router.get("/activity", getActivity);

export default router;

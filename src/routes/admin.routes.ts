import { Router } from "express";
import { authenticate, authorizeAdmin } from "../middlewares/auth.middleware";
import {
  getDashboardOverview,
  getAllUsers, getUserById, setUserRole, setKycStatus, blockUser, unblockUser,
  getAllVendors, setVendorCommissionRate,
  getAllOrders, getOrderById, adminUpdateOrderStatus,
  getAllPayments, getRefundRequests, updateRefundStatus,
  getPendingPayouts, getAllPayouts, processPayout, markPayoutPaid,
  getReportedReviews, resolveReviewReport,
  setDeliveryPersonStatus,
  getAuditLogs,
  getAllPromotions, createPlatformPromotion, adminDeactivatePromotion,
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
router.patch("/vendors/:id/commission-rate", setVendorCommissionRate);

router.get("/orders", getAllOrders);
router.get("/orders/:id", getOrderById);
router.patch("/orders/:id/status", adminUpdateOrderStatus);

router.get("/payments", getAllPayments);
router.get("/refund-requests", getRefundRequests);
router.patch("/refund-requests/:id", updateRefundStatus);

router.get("/payouts/pending", getPendingPayouts);
router.get("/payouts", getAllPayouts);
router.post("/payouts/process", processPayout);
router.patch("/payouts/:id/mark-paid", markPayoutPaid);

router.get("/review-reports", getReportedReviews);
router.patch("/review-reports/:id", resolveReviewReport);

router.patch("/delivery/:userId/status", setDeliveryPersonStatus);

router.get("/audit-logs", getAuditLogs);

router.get("/promotions", getAllPromotions);
router.post("/promotions", createPlatformPromotion);
router.patch("/promotions/:id/deactivate", adminDeactivatePromotion);

export default router;

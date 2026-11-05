// src/routes/vendorDashboard.routes.ts
import { Router } from "express";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import { dashboardController } from "../controllers/vendorDashboard.controller";
import {
  createDishTypeSuggestion,
  getMyDishTypeSuggestions,
} from "../controllers/admin.controller";
import { getPayoutSummary, setBankDetails, getBankDetails, getBankList } from "../controllers/payoutController";
import { getVendorOnboarding } from "../controllers/vendorOnboardingController";
import { requireVendorNotSuspended } from "../middlewares/vendorStatus.middleware";

const router = Router();
router.use(authenticate);
router.use(authorizeVendor);

// Onboarding status (Phase 1C lifecycle)
router.get("/onboarding", getVendorOnboarding);

// Main dashboard endpoint (NEW - recommended)
router.get("/dashboard", dashboardController.getDashboardData);

// Analytics endpoint (NEW)
router.get("/analytics", dashboardController.getAnalytics);

// Individual endpoints for specific sections
router.get("/revenue-overview", dashboardController.getRevenueOverview);
router.get("/product-performance", dashboardController.getProductPerformance);
router.get("/recent-activity", dashboardController.getRecentActivity);
router.get("/product-live-control", dashboardController.getProductLiveControl);

// Product management
router.get("/products/all", dashboardController.getAllVendorProducts);

// Cache management
router.delete("/cache/clear", dashboardController.clearVendorCache);

// Payouts — previously didn't exist at all: no bank fields on User, no
// VendorPayout model, no way for a vendor to ever get paid out through
// the platform.
router.get("/payouts", getPayoutSummary);
router.get("/payouts/banks", getBankList);
router.get("/payouts/bank-details", getBankDetails);
router.put("/payouts/bank-details", setBankDetails);

// Phase 2A.2 vendor dish-type suggestions.
// Submission is a vendor WRITE surface, so it is additionally guarded by
// requireVendorNotSuspended (suspended vendors cannot submit). Listing own
// suggestions is a read and stays on authenticate + authorizeVendor only.
router.post("/suggestions", requireVendorNotSuspended, createDishTypeSuggestion);
router.get("/suggestions", getMyDishTypeSuggestions);

// ====== DEPRECATED ENDPOINTS (keep for backward compatibility) ======
router.get("/summary", dashboardController.getSummary);
router.get("/products/live", dashboardController.getLiveProducts);
router.get("/products/total", dashboardController.getTotalProducts);
router.get("/orders/recent", dashboardController.getRecentOrders);
router.get("/revenue", dashboardController.getRevenueChart);
router.get("/orders/average-value", dashboardController.getAverageOrderValue);
router.get("/customers/return-rate", dashboardController.getCustomerReturnRate);
router.get("/orders/peak-hours", dashboardController.getPeakHours);

export default router;
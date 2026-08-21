"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/vendorDashboard.routes.ts
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const vendorDashboard_controller_1 = require("../controllers/vendorDashboard.controller");
const payoutController_1 = require("../controllers/payoutController");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.authenticate);
router.use(auth_middleware_1.authorizeVendor);
// Main dashboard endpoint (NEW - recommended)
router.get("/dashboard", vendorDashboard_controller_1.dashboardController.getDashboardData);
// Analytics endpoint (NEW)
router.get("/analytics", vendorDashboard_controller_1.dashboardController.getAnalytics);
// Individual endpoints for specific sections
router.get("/revenue-overview", vendorDashboard_controller_1.dashboardController.getRevenueOverview);
router.get("/product-performance", vendorDashboard_controller_1.dashboardController.getProductPerformance);
router.get("/recent-activity", vendorDashboard_controller_1.dashboardController.getRecentActivity);
router.get("/product-live-control", vendorDashboard_controller_1.dashboardController.getProductLiveControl);
// Product management
router.get("/products/all", vendorDashboard_controller_1.dashboardController.getAllVendorProducts);
// Cache management
router.delete("/cache/clear", vendorDashboard_controller_1.dashboardController.clearVendorCache);
// Payouts — previously didn't exist at all: no bank fields on User, no
// VendorPayout model, no way for a vendor to ever get paid out through
// the platform.
router.get("/payouts", payoutController_1.getPayoutSummary);
router.get("/payouts/banks", payoutController_1.getBankList);
router.get("/payouts/bank-details", payoutController_1.getBankDetails);
router.put("/payouts/bank-details", payoutController_1.setBankDetails);
// ====== DEPRECATED ENDPOINTS (keep for backward compatibility) ======
router.get("/summary", vendorDashboard_controller_1.dashboardController.getSummary);
router.get("/products/live", vendorDashboard_controller_1.dashboardController.getLiveProducts);
router.get("/products/total", vendorDashboard_controller_1.dashboardController.getTotalProducts);
router.get("/orders/recent", vendorDashboard_controller_1.dashboardController.getRecentOrders);
router.get("/revenue", vendorDashboard_controller_1.dashboardController.getRevenueChart);
router.get("/orders/average-value", vendorDashboard_controller_1.dashboardController.getAverageOrderValue);
router.get("/customers/return-rate", vendorDashboard_controller_1.dashboardController.getCustomerReturnRate);
router.get("/orders/peak-hours", vendorDashboard_controller_1.dashboardController.getPeakHours);
exports.default = router;

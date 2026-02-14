"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/vendorDashboard.routes.ts
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const vendorDashboard_controller_1 = require("../controllers/vendorDashboard.controller");
const router = (0, express_1.Router)();
// Main dashboard endpoint (NEW - recommended)
router.get("/dashboard", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getDashboardData);
// Analytics endpoint (NEW)
router.get("/analytics", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getAnalytics);
// Individual endpoints for specific sections
router.get("/revenue-overview", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getRevenueOverview);
router.get("/product-performance", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getProductPerformance);
router.get("/recent-activity", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getRecentActivity);
router.get("/product-live-control", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getProductLiveControl);
// Product management
router.get("/products/all", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getAllVendorProducts);
// Cache management
router.delete("/cache/clear", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.clearVendorCache);
// ====== DEPRECATED ENDPOINTS (keep for backward compatibility) ======
router.get("/summary", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getSummary);
router.get("/products/live", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getLiveProducts);
router.get("/products/total", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getTotalProducts);
router.get("/orders/recent", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getRecentOrders);
router.get("/revenue", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getRevenueChart);
router.get("/orders/average-value", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getAverageOrderValue);
router.get("/customers/return-rate", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getCustomerReturnRate);
router.get("/orders/peak-hours", auth_middleware_1.authenticate, vendorDashboard_controller_1.dashboardController.getPeakHours);
exports.default = router;

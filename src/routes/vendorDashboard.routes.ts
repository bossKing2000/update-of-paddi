// // src/routes/vendorDashboard.routes.ts
// import { Router } from "express";
// import { authenticate } from "../middlewares/auth.middleware";
// import { dashboardController } from "../controllers/vendorDashboard.controller";
// import { autoInvalidateVendorCache } from "../middlewares/autoInvalidateVendorCache";

// const router = Router();

// router.get("/summary", authenticate, dashboardController.getSummary);
// router.get("/products/live", authenticate, dashboardController.getLiveProducts);
// router.get("/products/total", authenticate, dashboardController.getTotalProducts);
// router.get("/orders/recent", authenticate, dashboardController.getRecentOrders);
// router.get("/activity/recent", authenticate, dashboardController.getRecentActivity);
// router.delete("/cache/clear", authenticate, dashboardController.clearVendorCache); // New route

// router.get("/orders/average-value", authenticate, dashboardController.getAverageOrderValue);
// router.get("/customers/return-rate", authenticate, dashboardController.getCustomerReturnRate);
// router.get("/orders/peak-hours", authenticate, dashboardController.getPeakHours);
// router.get("/revenue", authenticate, dashboardController.getRevenueChart);
// router.get("/products/all", authenticate, dashboardController.getAllVendorProducts); // NEW ENDPOINT
// router.use("/api/vendor-dashboard/products", authenticate, autoInvalidateVendorCache);

// export default router;
// // 


// src/routes/vendorDashboard.routes.ts
import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { dashboardController } from "../controllers/vendorDashboard.controller";

const router = Router();

// Main dashboard endpoint (NEW - recommended)
router.get("/dashboard", authenticate, dashboardController.getDashboardData);

// Analytics endpoint (NEW)
router.get("/analytics", authenticate, dashboardController.getAnalytics);

// Individual endpoints for specific sections
router.get("/revenue-overview", authenticate, dashboardController.getRevenueOverview);
router.get("/product-performance", authenticate, dashboardController.getProductPerformance);
router.get("/recent-activity", authenticate, dashboardController.getRecentActivity);
router.get("/product-live-control", authenticate, dashboardController.getProductLiveControl);

// Product management
router.get("/products/all", authenticate, dashboardController.getAllVendorProducts);

// Cache management
router.delete("/cache/clear", authenticate, dashboardController.clearVendorCache);
 
// ====== DEPRECATED ENDPOINTS (keep for backward compatibility) ======
router.get("/summary", authenticate, dashboardController.getSummary);
router.get("/products/live", authenticate, dashboardController.getLiveProducts);
router.get("/products/total", authenticate, dashboardController.getTotalProducts);
router.get("/orders/recent", authenticate, dashboardController.getRecentOrders);
router.get("/revenue", authenticate, dashboardController.getRevenueChart);
router.get("/orders/average-value", authenticate, dashboardController.getAverageOrderValue);
router.get("/customers/return-rate", authenticate, dashboardController.getCustomerReturnRate);
router.get("/orders/peak-hours", authenticate, dashboardController.getPeakHours);

export default router;
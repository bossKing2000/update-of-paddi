"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const orderController_1 = require("../controllers/orderController");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.authenticate);
// 🔔 Notification endpoints
router.get("/notifications", orderController_1.getMyNotifications);
router.patch("/notifications/:notificationId/read", auth_middleware_1.authenticate, orderController_1.markNotificationAsRead);
router.patch("/notifications/read-all", auth_middleware_1.authenticate, orderController_1.markAllNotificationsAsRead); // New endpoint
// 📦 Order endpoints
// router.post("/", placeOrder);
router.get("/", orderController_1.getMyOrders);
router.get("/:orderId", orderController_1.getSingleOrder);
router.post("/", orderController_1.createNormalOrder); // <- NEW: normal order creation
// //🧑‍🍳 Vendor-specific endpoints rsespond to special orders
// router.patch("/vendor/orders/:orderId/special-requests", authorizeVendor, vendorRespondToSpecialRequest);
// //👤 Customer-specific endpoints approve vendor change on special order
// router.patch("/customer/order/:orderId/approve/special-request", customerApproveOrderForSpecialRequest);
// 🔄 Unified update endpoint for cancel,accept,cooking,delivering,completed
router.patch("/vendor/order/:orderId/update-status", orderController_1.updateOrderStatus);
// 📊 Analytics endpoints 
router.get("/vendor/stats", auth_middleware_1.authorizeVendor, orderController_1.getVendorOrderStats);
router.get("/customer/stats", orderController_1.getCustomerOrderStats);
router.get("/vendor/report", auth_middleware_1.authorizeVendor, orderController_1.getVendorReport);
exports.default = router;

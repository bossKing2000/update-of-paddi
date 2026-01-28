import { Router } from "express";
import { authenticate,authorizeVendor,} from "../middlewares/auth.middleware";
import {getMyOrders,getSingleOrder,updateOrderStatus,getVendorOrderStats,getCustomerOrderStats,getVendorReport,getMyNotifications,markNotificationAsRead,markAllNotificationsAsRead, createNormalOrder} from "../controllers/orderController";

const router = Router();
router.use(authenticate);

// 🔔 Notification endpoints
router.get("/notifications", getMyNotifications);
router.patch("/notifications/:notificationId/read", authenticate, markNotificationAsRead);
router.patch("/notifications/read-all", authenticate, markAllNotificationsAsRead); // New endpoint


// 📦 Order endpoints
// router.post("/", placeOrder);
router.get("/", getMyOrders);
router.get("/:orderId", getSingleOrder);
 
router.post("/", createNormalOrder); // <- NEW: normal order creation

// //🧑‍🍳 Vendor-specific endpoints rsespond to special orders
// router.patch("/vendor/orders/:orderId/special-requests", authorizeVendor, vendorRespondToSpecialRequest);

// //👤 Customer-specific endpoints approve vendor change on special order
// router.patch("/customer/order/:orderId/approve/special-request", customerApproveOrderForSpecialRequest);


 
// 🔄 Unified update endpoint for cancel,accept,cooking,delivering,completed
router.patch("/vendor/order/:orderId/update-status", updateOrderStatus);

// 📊 Analytics endpoints 
router.get("/vendor/stats", authorizeVendor, getVendorOrderStats);
router.get("/customer/stats", getCustomerOrderStats);
router.get("/vendor/report", authorizeVendor, getVendorReport);

export default router;
 
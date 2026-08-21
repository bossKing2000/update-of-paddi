"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const orderController_1 = require("../controllers/orderController");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.authenticate);
// Order endpoints
// NOTE: order creation now happens exclusively through cart checkout
// (POST /api/cart/checkout) or by accepting a special-order offer (below).
// There used to be a second, parallel "POST /" order-creation path here
// (createNormalOrder) that bypassed the cart entirely — no address
// requirement, no delivery fee, no idempotency, no product-options
// support, and it created its own Payment record independently of how
// checkout does it. Rather than maintain two divergent order-creation
// code paths with different safety guarantees, everything now goes
// through the one path that has all of it. A "buy now" UX on the
// frontend can just be composed as addToCart + checkout (two calls) and
// gets all of this for free.
router.get("/", orderController_1.getMyOrders);
// This static path must be registered before /:orderId so "special-requests"
// is not interpreted as an order ID by Express.
router.get("/special-requests", auth_middleware_1.authorizeCustomer, orderController_1.getMySpecialRequests);
router.get("/:orderId", orderController_1.getSingleOrder);
// Unified status-transition endpoint for cancel/cooking/ready/delivering/completed
router.patch("/vendor/order/:orderId/update-status", orderController_1.updateOrderStatus);
// Special orders — customer requests a custom quantity/version of a
// product, vendors bid with an offer, customer accepts one.
router.post("/special-requests", auth_middleware_1.authorizeCustomer, orderController_1.createSpecialRequest);
router.post("/special-requests/:requestId/offers", auth_middleware_1.authorizeVendor, orderController_1.createSpecialOffer);
router.patch("/special-offers/:offerId/accept", auth_middleware_1.authorizeCustomer, orderController_1.acceptSpecialOffer);
router.patch("/special-offers/:offerId/reject", auth_middleware_1.authorizeCustomer, orderController_1.rejectSpecialOffer);
router.patch("/special-requests/:requestId/reject", auth_middleware_1.authorizeCustomer, orderController_1.rejectSpecialRequest);
// Analytics endpoints
router.get("/vendor/stats", auth_middleware_1.authorizeVendor, orderController_1.getVendorOrderStats);
router.get("/customer/stats", orderController_1.getCustomerOrderStats);
router.get("/vendor/report", auth_middleware_1.authorizeVendor, orderController_1.getVendorReport);
exports.default = router;

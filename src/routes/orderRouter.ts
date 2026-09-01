import { Router } from "express";
import { authenticate, authorizeVendor, authorizeCustomer } from "../middlewares/auth.middleware";
import {
  getMyOrders,
  getSingleOrder,
  getOrderBatch,
  updateOrderStatus,
  getVendorOrderStats,
  getCustomerOrderStats,
  getVendorReport,
  createSpecialRequest,
  createSpecialOffer,
  acceptSpecialOffer,
  rejectSpecialRequest,
  getMySpecialRequests,
  rejectSpecialOffer,
} from "../controllers/orderController";

const router = Router();
router.use(authenticate);

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
router.get("/", getMyOrders);

// Batch endpoint - must be registered before /:orderId so "batch" is not interpreted as an order ID
router.get("/batch/:idempotencyKey", getOrderBatch);

router.get("/:orderId", getSingleOrder);

// Unified status-transition endpoint for cancel/cooking/ready/delivering/completed
router.patch("/vendor/order/:orderId/update-status", updateOrderStatus);

// Special orders — customer requests a custom quantity/version of a
// product, vendors bid with an offer, customer accepts one.
router.post("/special-requests", authorizeCustomer, createSpecialRequest);
router.post("/special-requests/:requestId/offers", authorizeVendor, createSpecialOffer);
router.patch("/special-offers/:offerId/accept", authorizeCustomer, acceptSpecialOffer);
router.patch("/special-offers/:offerId/reject", authorizeCustomer, rejectSpecialOffer);
router.patch("/special-requests/:requestId/reject", authorizeCustomer, rejectSpecialRequest);

// Analytics endpoints
router.get("/vendor/stats", authorizeVendor, getVendorOrderStats);
router.get("/customer/stats", getCustomerOrderStats);
router.get("/vendor/report", authorizeVendor, getVendorReport);

export default router;

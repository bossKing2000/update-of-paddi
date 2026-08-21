import express from "express";
import {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  checkoutCart,
  clearCart,
  getCartSummary,
} from "../controllers/cartController";
import { authenticate, authorizeCustomer } from "../middlewares/auth.middleware";

const router = express.Router();

// All routes require customer authentication
router.use(authenticate);
router.use(authorizeCustomer);

// Cart endpoints
router.get("/", getCart);
router.post("/add", addToCart);
router.patch("/items/:itemId", updateCartItem); // was PUT — PATCH is the correct verb for a partial update
router.delete("/items/:itemId", removeCartItem);
router.get("/summary", getCartSummary); // NEW — priced, vendor-grouped preview with delivery fee, used before checkout
router.post("/checkout", checkoutCart);
router.delete("/", clearCart);

export default router;

import express from "express";
import {getCart,addToCart,updateCartItem,removeCartItem,checkoutCart,clearCart} from "../controllers/cartController";
import { authenticate } from "../middlewares/auth.middleware";
import { authorizeCustomer } from "../middlewares/auth.middleware";

const router = express.Router();

// All routes require customer authentication
router.use(authenticate);
router.use(authorizeCustomer);

// Cart endpoints
router.get("/", getCart);
router.post("/add", addToCart);
router.put("/items/:itemId", updateCartItem);
router.delete("/items/:itemId", removeCartItem);
router.post("/checkout", checkoutCart);
router.delete("/", clearCart);

export default router;
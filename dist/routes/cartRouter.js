"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cartController_1 = require("../controllers/cartController");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const router = express_1.default.Router();
// All routes require customer authentication
router.use(auth_middleware_1.authenticate);
router.use(auth_middleware_1.authorizeCustomer);
// Cart endpoints
router.get("/", cartController_1.getCart);
router.post("/add", cartController_1.addToCart);
router.patch("/items/:itemId", cartController_1.updateCartItem); // was PUT — PATCH is the correct verb for a partial update
router.delete("/items/:itemId", cartController_1.removeCartItem);
router.get("/summary", cartController_1.getCartSummary); // NEW — priced, vendor-grouped preview with delivery fee, used before checkout
router.post("/checkout", cartController_1.checkoutCart);
router.delete("/", cartController_1.clearCart);
exports.default = router;

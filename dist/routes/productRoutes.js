"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const productController_1 = require("../controllers/productController");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const multer_1 = require("../utils/multer");
const router = (0, express_1.Router)();
router.get("/", productController_1.getAllProducts);
router.get("/:id", productController_1.getProductById);
router.post("/", auth_middleware_1.authenticate, auth_middleware_1.authorizeVendor, multer_1.upload.fields([{ name: 'images', maxCount: 6 }, { name: 'video', maxCount: 3 },]), productController_1.createProduct);
router.patch("/:id", auth_middleware_1.authenticate, auth_middleware_1.authorizeVendor, multer_1.upload.fields([{ name: 'images', maxCount: 6 }, { name: 'video', maxCount: 3 },]), productController_1.updateProduct);
router.delete("/:id", auth_middleware_1.authenticate, auth_middleware_1.authorizeVendor, productController_1.deleteProduct);
// Act has delete function
router.patch("/api/products/:id/archive", auth_middleware_1.authenticate, auth_middleware_1.authorizeVendor);
// Track product view (usually as middleware on product GET)
router.get('/products/:id/view', auth_middleware_1.authenticate, productController_1.getProductById);
// router.get("/products/trending", getTrendingProducts);
router.get('/p/suggestions', productController_1.getSearchSuggestions);
router.get("/p/search", productController_1.searchProducts);
router.get("/p/most", productController_1.getMostPopularProducts);
exports.default = router;

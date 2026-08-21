"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const productController_1 = require("../controllers/productController");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const multer_1 = require("../utils/multer");
const router = (0, express_1.Router)();
const uploadFields = multer_1.upload.fields([{ name: "images", maxCount: 6 }, { name: "video", maxCount: 3 }]);
// Public listing/search/detail endpoints — no auth required to browse.
router.get("/", productController_1.getAllProducts);
router.get("/categories", productController_1.getCategories); // was completely missing — cache infra for it existed and was unused
router.get("/p/suggestions", productController_1.getSearchSuggestions);
router.get("/p/search", productController_1.searchProducts);
router.get("/p/most", productController_1.getMostPopularProducts);
router.get("/:id", productController_1.getProductById); // also tracks the view internally
// Vendor-only management endpoints
router.post("/", auth_middleware_1.authenticate, auth_middleware_1.authorizeVendor, uploadFields, productController_1.createProduct);
router.patch("/:id", auth_middleware_1.authenticate, auth_middleware_1.authorizeVendor, uploadFields, productController_1.updateProduct);
// Was registered with no handler at all (just authenticate, authorizeVendor
// and nothing after) — any request would hang until timeout, never
// actually archiving anything. Also had a wrong, double-prefixed path
// ("/api/products/:id/archive" on a router already mounted at
// "/api/product") that wouldn't have matched real requests even if a
// handler had been attached.
router.patch("/:id/archive", auth_middleware_1.authenticate, auth_middleware_1.authorizeVendor, productController_1.archiveProduct);
router.delete("/:id", auth_middleware_1.authenticate, auth_middleware_1.authorizeVendor, productController_1.deleteProduct);
exports.default = router;

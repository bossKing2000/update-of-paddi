import { Router } from "express";
import {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  archiveProduct,
  deleteProduct,
  searchProducts,
  getSearchSuggestions,
  getMostPopularProducts,
  getNewProducts,
  getDishTypes,
} from "../controllers/productController";
import {
  getTags,
  getCategories,
  getCategoryProducts,
} from "../controllers/catalogController";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import { requireVendorNotSuspended } from "../middlewares/vendorStatus.middleware";
import {
  createProductOptionGroup,
  listProductOptionGroups,
  updateProductOptionGroup,
  deleteProductOptionGroup,
  createProductOptionGroupItem,
  updateProductOptionGroupItem,
  deleteProductOptionGroupItem,
} from "../controllers/optionGroupController";
import { upload } from "../utils/multer";

const router = Router();
// 6 images max, 1 video max — matches controller enforcement.
const uploadFields = upload.fields([{ name: "images", maxCount: 6 }, { name: "video", maxCount: 1 }]);

// Public listing/search/detail endpoints — no auth required to browse.
router.get("/", getAllProducts);
router.get("/dish-types", getDishTypes);
// Phase 2 M1 — public taxonomy reads (active rows only). The previous
// /categories alias returned dish types; it now returns real categories.
router.get("/categories", getCategories);
router.get("/categories/:slug/products", getCategoryProducts);
router.get("/tags", getTags);
router.get("/p/suggestions", getSearchSuggestions);
router.get("/p/search", searchProducts);
router.get("/p/most", getMostPopularProducts);
router.get("/p/new", getNewProducts);
router.get("/:id", getProductById); // also tracks the view internally

// Vendor-only management endpoints (SUSPENDED vendors cannot write)
router.post("/", authenticate, authorizeVendor, requireVendorNotSuspended, uploadFields, createProduct);
router.patch("/:id", authenticate, authorizeVendor, requireVendorNotSuspended, uploadFields, updateProduct);
// Was registered with no handler at all (just authenticate, authorizeVendor
// and nothing after) — any request would hang until timeout, never
// actually archiving anything. Also had a wrong, double-prefixed path
// ("/api/products/:id/archive" on a router already mounted at
// "/api/product") that wouldn't have matched real requests even if a
// handler had been attached.
router.patch("/:id/archive", authenticate, authorizeVendor, requireVendorNotSuspended, archiveProduct);
router.delete("/:id", authenticate, authorizeVendor, requireVendorNotSuspended, deleteProduct);

// Phase 2B.3 structured add-on management (vendor-only, suspension-gated).
// Reads stay on the product detail endpoint; these routes are writes.
router.post("/:productId/option-groups", authenticate, authorizeVendor, requireVendorNotSuspended, createProductOptionGroup);
router.get("/:productId/option-groups", authenticate, authorizeVendor, listProductOptionGroups);
router.patch("/option-groups/:groupId", authenticate, authorizeVendor, requireVendorNotSuspended, updateProductOptionGroup);
router.delete("/option-groups/:groupId", authenticate, authorizeVendor, requireVendorNotSuspended, deleteProductOptionGroup);
router.post("/option-groups/:groupId/items", authenticate, authorizeVendor, requireVendorNotSuspended, createProductOptionGroupItem);
router.patch("/option-items/:itemId", authenticate, authorizeVendor, requireVendorNotSuspended, updateProductOptionGroupItem);
router.delete("/option-items/:itemId", authenticate, authorizeVendor, requireVendorNotSuspended, deleteProductOptionGroupItem);

export default router;

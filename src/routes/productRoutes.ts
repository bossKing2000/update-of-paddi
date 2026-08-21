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
  getCategories,
} from "../controllers/productController";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import { upload } from "../utils/multer";

const router = Router();
const uploadFields = upload.fields([{ name: "images", maxCount: 6 }, { name: "video", maxCount: 3 }]);

// Public listing/search/detail endpoints — no auth required to browse.
router.get("/", getAllProducts);
router.get("/categories", getCategories); // was completely missing — cache infra for it existed and was unused
router.get("/p/suggestions", getSearchSuggestions);
router.get("/p/search", searchProducts);
router.get("/p/most", getMostPopularProducts);
router.get("/:id", getProductById); // also tracks the view internally

// Vendor-only management endpoints
router.post("/", authenticate, authorizeVendor, uploadFields, createProduct);
router.patch("/:id", authenticate, authorizeVendor, uploadFields, updateProduct);
// Was registered with no handler at all (just authenticate, authorizeVendor
// and nothing after) — any request would hang until timeout, never
// actually archiving anything. Also had a wrong, double-prefixed path
// ("/api/products/:id/archive" on a router already mounted at
// "/api/product") that wouldn't have matched real requests even if a
// handler had been attached.
router.patch("/:id/archive", authenticate, authorizeVendor, archiveProduct);
router.delete("/:id", authenticate, authorizeVendor, deleteProduct);

export default router;

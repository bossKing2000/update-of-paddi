import { Router } from "express";
import {createProduct,getAllProducts,getProductById,updateProduct,deleteProduct, searchProducts, getSearchSuggestions, getMostPopularProducts,} from "../controllers/productController";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import { upload } from "../utils/multer";

const router = Router();



router.get("/", getAllProducts);
router.get("/:id", getProductById);
  

router.post("/", authenticate, authorizeVendor, upload.fields([{ name: 'images', maxCount: 6 },{ name: 'video', maxCount: 3 },]), createProduct);
router.patch("/:id", authenticate, authorizeVendor, upload.fields([{ name: 'images', maxCount: 6 },{ name: 'video', maxCount: 3 },]), updateProduct);
router.delete("/:id", authenticate, authorizeVendor, deleteProduct);

// Act has delete function
router.patch("/api/products/:id/archive", authenticate,authorizeVendor)

// Track product view (usually as middleware on product GET)
router.get('/products/:id/view',authenticate,getProductById );

// router.get("/products/trending", getTrendingProducts);

router.get('/p/suggestions', getSearchSuggestions);

router.get("/p/search", searchProducts);

router.get("/p/most", getMostPopularProducts);



export default router;  
  
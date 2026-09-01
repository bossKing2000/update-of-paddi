// src/routes/vendorUpload.routes.ts
import { Router } from "express";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import { upload } from "../utils/multer";
import { uploadVendorLogo } from "../controllers/vendorUpload.controller";

const router = Router();
router.use(authenticate);
router.use(authorizeVendor);

// POST /api/vendor/upload/logo
// Upload vendor brand logo, returns Cloudinary URL
router.post("/logo", upload.single("logo"), uploadVendorLogo);

export default router;
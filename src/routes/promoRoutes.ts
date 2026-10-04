import { Router } from "express";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import { requireVendorNotSuspended } from "../middlewares/vendorStatus.middleware";
import { createPromo, getMyPromos, deactivatePromo, reactivatePromo, updatePromo } from "../controllers/promoController";

const router = Router();
router.use(authenticate);
router.use(authorizeVendor);

router.post("/", requireVendorNotSuspended, createPromo);
router.get("/mine", getMyPromos);
router.patch("/:id", requireVendorNotSuspended, updatePromo);
router.patch("/:id/deactivate", requireVendorNotSuspended, deactivatePromo);
router.patch("/:id/reactivate", requireVendorNotSuspended, reactivatePromo);

export default router;

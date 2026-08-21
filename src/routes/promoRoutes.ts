import { Router } from "express";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import { createPromo, getMyPromos, deactivatePromo, reactivatePromo, updatePromo } from "../controllers/promoController";

const router = Router();
router.use(authenticate);
router.use(authorizeVendor);

router.post("/", createPromo);
router.get("/mine", getMyPromos);
router.patch("/:id", updatePromo);
router.patch("/:id/deactivate", deactivatePromo);
router.patch("/:id/reactivate", reactivatePromo);

export default router;

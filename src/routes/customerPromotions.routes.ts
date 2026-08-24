import { Router } from "express";
import { authenticate, authorizeCustomer } from "../middlewares/auth.middleware";
import { getActivePromotions } from "../controllers/promoController";

const router = Router();
router.use(authenticate, authorizeCustomer);
router.get("/active", getActivePromotions);

export default router;

import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { getMyReferralCode, applyReferralCode, getMyReferralRewards } from "../controllers/referralController";

const router = Router();
router.use(authenticate);

router.get("/my-code", getMyReferralCode);
router.post("/apply", applyReferralCode);
router.get("/my-rewards", getMyReferralRewards);

export default router;

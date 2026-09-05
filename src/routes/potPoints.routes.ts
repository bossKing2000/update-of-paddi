import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { getMyPotPoints } from "../controllers/potPoints.controller";

const router = Router();
router.use(authenticate);

router.get("/pot-points", getMyPotPoints);

export default router;

import express from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { goLive, takeDown, extendGrace, fixLiveStatuses } from "../controllers/productScheduleController";

const router = express.Router();

// Vendor-protected endpoints
router.post("/:id/schedule/go-live", authenticate, goLive);
router.post("/:id/schedule/take-down",  takeDown);
router.post("/:id/schedule/extend-grace", authenticate, extendGrace);
router.get("/fix-live-statuses", fixLiveStatuses);
export default router;

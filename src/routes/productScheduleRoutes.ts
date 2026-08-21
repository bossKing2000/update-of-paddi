import express from "express";
import { authenticate, authorizeAdmin } from "../middlewares/auth.middleware";
import { goLive, takeDown, extendGrace, fixLiveStatuses } from "../controllers/productScheduleController";

const router = express.Router();

// Vendor-protected endpoints
router.post("/:id/schedule/go-live", authenticate, goLive);
// Was missing authenticate entirely — combined with the controller having
// no ownership check either, anyone unauthenticated could take down any
// vendor's product. Both holes are fixed now (auth here, ownership check
// in the controller).
router.post("/:id/schedule/take-down", authenticate, takeDown);
router.post("/:id/schedule/extend-grace", authenticate, extendGrace);

// Internal maintenance endpoint (also runs on a cron) — was completely
// unauthenticated before.
router.get("/fix-live-statuses", authenticate, authorizeAdmin, fixLiveStatuses);

export default router;

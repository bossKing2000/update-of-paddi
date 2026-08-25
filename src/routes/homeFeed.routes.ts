import { Router } from "express";
import { optionalAuth } from "../middlewares/auth.middleware";
import { getHomeFeedController } from "../controllers/homeFeed.controller";

const router = Router();

// Authentication enriches the feed but never gates it — guests welcome.
router.get("/feed", optionalAuth, getHomeFeedController);

export default router;

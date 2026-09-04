import { Router } from "express";
import { optionalAuth } from "../middlewares/auth.middleware";
import { getHomeFeedController, getWhatsInThePotController } from "../controllers/homeFeed.controller";

const router = Router();

// Authentication enriches the feed but never gates it — guests welcome.
router.get("/feed", optionalAuth, getHomeFeedController);

// "What's in the Pot?" — dish types with something orderable right now.
router.get("/whats-in-the-pot", getWhatsInThePotController);

export default router;

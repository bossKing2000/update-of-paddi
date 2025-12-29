import express from "express";
import { followVendor, unfollowVendor, isFollowingVendor,getVendorFollowers,getFollowedVendors,} from "../controllers/vendorFollowController";
import { authenticate } from "../middlewares/auth.middleware";

const router = express.Router();

// All routes require authentication
router.post("/follow", authenticate, followVendor);
router.post("/unfollow", authenticate, unfollowVendor);
router.get("/status/:vendorId", authenticate, isFollowingVendor);
router.get("/vendor/:vendorId/followers", authenticate, getVendorFollowers);
router.get("/following", authenticate, getFollowedVendors);

export default router;

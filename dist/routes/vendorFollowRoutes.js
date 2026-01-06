"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const vendorFollowController_1 = require("../controllers/vendorFollowController");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const router = express_1.default.Router();
// All routes require authentication
router.post("/follow", auth_middleware_1.authenticate, vendorFollowController_1.followVendor);
router.post("/unfollow", auth_middleware_1.authenticate, vendorFollowController_1.unfollowVendor);
router.get("/status/:vendorId", auth_middleware_1.authenticate, vendorFollowController_1.isFollowingVendor);
router.get("/vendor/:vendorId/followers", auth_middleware_1.authenticate, vendorFollowController_1.getVendorFollowers);
router.get("/following", auth_middleware_1.authenticate, vendorFollowController_1.getFollowedVendors);
exports.default = router;

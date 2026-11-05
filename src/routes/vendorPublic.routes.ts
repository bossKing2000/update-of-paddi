import { Router } from "express";
import { getPublicVendorProfile } from "../controllers/vendorProfileController";

/**
 * Public vendor surfaces — mounted at /api/vendors.
 *
 * DISTINCT FROM THE VENDOR DASHBOARD
 * -----------------------------------
 * `/api/vendor/*` (src/routes/vendorDashboard.routes.ts, /api/vendor/settings,
 * /api/vendor/support, /api/vendor/upload) is the vendor's OWN authenticated
 * surface. It is unchanged by this router.
 *
 * This router is the anonymous, read-only customer view of a vendor. It
 * exposes no moderation state, no internal settings, no money and no
 * account data — see src/services/vendorProfile.service.ts for the exact
 * visibility rules.
 */
const router = Router();

// GET /api/vendors/:vendorId
router.get("/:vendorId", getPublicVendorProfile);

export default router;

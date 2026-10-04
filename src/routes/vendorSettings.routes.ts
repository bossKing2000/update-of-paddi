import { Router } from "express";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import { requireVendorNotSuspended } from "../middlewares/vendorStatus.middleware";
import {
  getVendorSettings,
  updateVendorLive,
  updateDeliveryPreferences,
  updateServiceAreas,
} from "../controllers/vendorSettingsController";

const router = Router();
router.use(authenticate);
router.use(authorizeVendor);

router.get("/", getVendorSettings);
router.patch("/live", requireVendorNotSuspended, updateVendorLive);
router.patch("/delivery-preferences", requireVendorNotSuspended, updateDeliveryPreferences);
router.put("/service-areas", requireVendorNotSuspended, updateServiceAreas);

export default router;

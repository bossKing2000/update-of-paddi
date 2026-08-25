import { Router } from "express";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import {
  getVendorSettings,
  updateVendorLive,
  updateOperatingHours,
  updateDeliveryPreferences,
  updateServiceAreas,
} from "../controllers/vendorSettingsController";

const router = Router();
router.use(authenticate);
router.use(authorizeVendor);

router.get("/", getVendorSettings);
router.patch("/live", updateVendorLive);
router.patch("/operating-hours", updateOperatingHours);
router.patch("/delivery-preferences", updateDeliveryPreferences);
router.put("/service-areas", updateServiceAreas);

export default router;

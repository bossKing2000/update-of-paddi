import { Router } from "express";
import { authenticate, authorizeVendor } from "../middlewares/auth.middleware";
import { createVendorSupportTicket, getVendorSupportTickets } from "../controllers/vendorSupportController";

const router = Router();
router.use(authenticate, authorizeVendor);
router.post("/tickets", createVendorSupportTicket);
router.get("/tickets", getVendorSupportTickets);

export default router;

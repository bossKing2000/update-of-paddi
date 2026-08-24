import { Router } from "express";
import { authenticate, authorizeCustomer } from "../middlewares/auth.middleware";
import { createCustomerSupportTicket, getCustomerSupportTickets } from "../controllers/customerSupportController";

const router = Router();
router.use(authenticate, authorizeCustomer);
router.post("/tickets", createCustomerSupportTicket);
router.get("/tickets", getCustomerSupportTickets);

export default router;

import { Router } from "express";
import { authenticate, authorizeAdmin, authorizeDeliveryPerson } from "../middlewares/auth.middleware";
import { upload } from "../utils/multer";
import { createRiderSupportTicket, getAdminRiderWithdrawals, getDeliveryProof, getRiderBankList, getRiderPayoutSummary, getRiderStatus, getRiderSupportTickets, getRiderVehicle, processRiderWithdrawal, requestRiderWithdrawal, reviewDeliveryProof, reviewRiderSupportTicket, reviewRiderVehicle, setRiderBankDetails, submitDeliveryProof, uploadRiderVehicleDocument, upsertRiderVehicle } from "../controllers/riderOperationsController";

export const riderOperationsRoutes = Router();
riderOperationsRoutes.use(authenticate, authorizeDeliveryPerson);
riderOperationsRoutes.get("/status", getRiderStatus);
riderOperationsRoutes.get("/payouts", getRiderPayoutSummary);
riderOperationsRoutes.get("/payouts/banks", getRiderBankList);
riderOperationsRoutes.put("/payouts/bank-details", setRiderBankDetails);
riderOperationsRoutes.post("/payouts/withdrawals", requestRiderWithdrawal);
riderOperationsRoutes.post("/assignments/:assignmentId/proof", upload.single("proof"), submitDeliveryProof);
riderOperationsRoutes.get("/vehicle", getRiderVehicle);
riderOperationsRoutes.put("/vehicle", upsertRiderVehicle);
riderOperationsRoutes.post("/vehicle/document", upload.single("document"), uploadRiderVehicleDocument);
riderOperationsRoutes.post("/support/tickets", createRiderSupportTicket);
riderOperationsRoutes.get("/support/tickets", getRiderSupportTickets);

export const riderOperationsAdminRoutes = Router();
riderOperationsAdminRoutes.use(authenticate, authorizeAdmin);
riderOperationsAdminRoutes.get("/withdrawals", getAdminRiderWithdrawals);
riderOperationsAdminRoutes.post("/withdrawals/:withdrawalId/process", processRiderWithdrawal);
riderOperationsAdminRoutes.patch("/assignments/:assignmentId/proof/review", reviewDeliveryProof);
riderOperationsAdminRoutes.patch("/vehicles/:deliveryPersonId/review", reviewRiderVehicle);
riderOperationsAdminRoutes.patch("/support/tickets/:ticketId", reviewRiderSupportTicket);

// Customer, vendor, rider, and admin access to proof is enforced by the
// controller's assignment-involvement check rather than a role-only gate.
export const riderProofReadRoutes = Router();
riderProofReadRoutes.use(authenticate);
riderProofReadRoutes.get("/assignments/:assignmentId/proof", getDeliveryProof);

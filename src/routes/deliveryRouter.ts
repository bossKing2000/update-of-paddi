import { Router } from "express";
import { authenticate,authorizeDeliveryPerson } from "../middlewares/auth.middleware";
import { DeliveryAssignmentController } from "../controllers/deliveryControllers";

const router = Router();

// Assignments
router.post("/assign", authenticate, DeliveryAssignmentController.assignOrder);
router.patch("/:assignmentId/accept", authenticate,authorizeDeliveryPerson, DeliveryAssignmentController.acceptAssignment);
router.patch("/:assignmentId/decline", authenticate, authorizeDeliveryPerson,DeliveryAssignmentController.declineAssignment);

router.get("/my-assignments", authenticate,authorizeDeliveryPerson, DeliveryAssignmentController.getCurrentAssignments);
router.patch("/:assignmentId/status", authenticate, authorizeDeliveryPerson,DeliveryAssignmentController.updateDeliveryStatus);

router.get("/:assignmentId", authenticate,authorizeDeliveryPerson, DeliveryAssignmentController.getAssignmentById);
router.get("/driver/:driverId/history",authorizeDeliveryPerson, authenticate, DeliveryAssignmentController.getDriverHistory);
router.get("/customer/:customerId/history",authorizeDeliveryPerson, authenticate, DeliveryAssignmentController.getCustomerHistory);
router.get("/driver/:driverId/analytics",authorizeDeliveryPerson, authenticate, DeliveryAssignmentController.getDriverAnalytics);
router.get("/driver/available", authenticate,authorizeDeliveryPerson, DeliveryAssignmentController.getAvailableDrivers);
router.post("/broadcast/:broadcastId/accept", authenticate, authorizeDeliveryPerson,DeliveryAssignmentController.acceptBroadcast);

export default router;

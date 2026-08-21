import { Router } from "express";
import { authenticate, authorizeDeliveryPerson, authorizeVendor, authorizeCustomer, requireRole } from "../middlewares/auth.middleware";
import { DeliveryAssignmentController } from "../controllers/deliveryControllers";

const router = Router();
router.use(authenticate);

// Assignment creation — vendor (for their own order) or admin only.
// Previously had no role restriction at all, combined with a controller
// bug that let any delivery person self-assign — see deliveryControllers.ts.
router.post("/assign", requireRole("VENDOR", "ADMIN"), DeliveryAssignmentController.assignOrder);

router.patch("/:assignmentId/accept", authorizeDeliveryPerson, DeliveryAssignmentController.acceptAssignment);
router.patch("/:assignmentId/decline", authorizeDeliveryPerson, DeliveryAssignmentController.declineAssignment);

router.get("/my-assignments", authorizeDeliveryPerson, DeliveryAssignmentController.getCurrentAssignments);
router.get("/offers", authorizeDeliveryPerson, DeliveryAssignmentController.getBroadcastOffers);
router.patch("/:assignmentId/status", authorizeDeliveryPerson, DeliveryAssignmentController.updateDeliveryStatus);

// Driver's own live location + online status — previously there was no
// way to update either after registration at all.
router.patch("/location", authorizeDeliveryPerson, DeliveryAssignmentController.updateLocation);
router.patch("/online-status", authorizeDeliveryPerson, DeliveryAssignmentController.setOnlineStatus);

router.get("/driver/:driverId/history", authorizeDeliveryPerson, DeliveryAssignmentController.getDriverHistory);
// Was incorrectly gated behind authorizeDeliveryPerson, meaning no
// customer could ever reach their own delivery history. Now customer-only
// (with self-only ownership check in the controller), matching what the
// endpoint actually returns.
router.get("/customer/:customerId/history", authorizeCustomer, DeliveryAssignmentController.getCustomerHistory);
router.get("/driver/:driverId/analytics", authorizeDeliveryPerson, DeliveryAssignmentController.getDriverAnalytics);
router.get("/driver/available", authorizeDeliveryPerson, DeliveryAssignmentController.getAvailableDrivers);
router.post("/broadcast/:broadcastId/accept", authorizeDeliveryPerson, DeliveryAssignmentController.acceptBroadcast);
router.patch("/broadcast/:broadcastId/decline", authorizeDeliveryPerson, DeliveryAssignmentController.declineBroadcast);
router.get("/:assignmentId", DeliveryAssignmentController.getAssignmentById); // ownership checked inside

export default router;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const deliveryControllers_1 = require("../controllers/deliveryControllers");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.authenticate);
// Assignment creation — vendor (for their own order) or admin only.
// Previously had no role restriction at all, combined with a controller
// bug that let any delivery person self-assign — see deliveryControllers.ts.
router.post("/assign", (0, auth_middleware_1.requireRole)("VENDOR", "ADMIN"), deliveryControllers_1.DeliveryAssignmentController.assignOrder);
router.patch("/:assignmentId/accept", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.acceptAssignment);
router.patch("/:assignmentId/decline", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.declineAssignment);
router.get("/my-assignments", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.getCurrentAssignments);
router.get("/offers", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.getBroadcastOffers);
router.patch("/:assignmentId/status", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.updateDeliveryStatus);
// Driver's own live location + online status — previously there was no
// way to update either after registration at all.
router.patch("/location", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.updateLocation);
router.patch("/online-status", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.setOnlineStatus);
router.get("/driver/:driverId/history", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.getDriverHistory);
// Was incorrectly gated behind authorizeDeliveryPerson, meaning no
// customer could ever reach their own delivery history. Now customer-only
// (with self-only ownership check in the controller), matching what the
// endpoint actually returns.
router.get("/customer/:customerId/history", auth_middleware_1.authorizeCustomer, deliveryControllers_1.DeliveryAssignmentController.getCustomerHistory);
router.get("/driver/:driverId/analytics", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.getDriverAnalytics);
router.get("/driver/available", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.getAvailableDrivers);
router.post("/broadcast/:broadcastId/accept", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.acceptBroadcast);
router.patch("/broadcast/:broadcastId/decline", auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.declineBroadcast);
router.get("/:assignmentId", deliveryControllers_1.DeliveryAssignmentController.getAssignmentById); // ownership checked inside
exports.default = router;

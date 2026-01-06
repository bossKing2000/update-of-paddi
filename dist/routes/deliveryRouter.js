"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const deliveryControllers_1 = require("../controllers/deliveryControllers");
const router = (0, express_1.Router)();
// Assignments
router.post("/assign", auth_middleware_1.authenticate, deliveryControllers_1.DeliveryAssignmentController.assignOrder);
router.patch("/:assignmentId/accept", auth_middleware_1.authenticate, auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.acceptAssignment);
router.patch("/:assignmentId/decline", auth_middleware_1.authenticate, auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.declineAssignment);
router.get("/my-assignments", auth_middleware_1.authenticate, auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.getCurrentAssignments);
router.patch("/:assignmentId/status", auth_middleware_1.authenticate, auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.updateDeliveryStatus);
router.get("/:assignmentId", auth_middleware_1.authenticate, auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.getAssignmentById);
router.get("/driver/:driverId/history", auth_middleware_1.authorizeDeliveryPerson, auth_middleware_1.authenticate, deliveryControllers_1.DeliveryAssignmentController.getDriverHistory);
router.get("/customer/:customerId/history", auth_middleware_1.authorizeDeliveryPerson, auth_middleware_1.authenticate, deliveryControllers_1.DeliveryAssignmentController.getCustomerHistory);
router.get("/driver/:driverId/analytics", auth_middleware_1.authorizeDeliveryPerson, auth_middleware_1.authenticate, deliveryControllers_1.DeliveryAssignmentController.getDriverAnalytics);
router.get("/driver/available", auth_middleware_1.authenticate, auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.getAvailableDrivers);
router.post("/broadcast/:broadcastId/accept", auth_middleware_1.authenticate, auth_middleware_1.authorizeDeliveryPerson, deliveryControllers_1.DeliveryAssignmentController.acceptBroadcast);
exports.default = router;

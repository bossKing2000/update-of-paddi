"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeliveryAssignmentController = void 0;
const zod_1 = require("zod");
const deliveryAssignment_1 = require("../services/deliveryAssignment");
const paramUtils_1 = require("../utils/paramUtils");
const apiResponse_1 = require("../utils/apiResponse");
const AppError_1 = require("../errors/AppError");
const prisma_1 = __importDefault(require("../lib/prisma"));
const client_1 = require("@prisma/client");
class DeliveryAssignmentController {
    static async acceptBroadcast(req, res) {
        const broadcastId = (0, paramUtils_1.ensureString)(req.params.broadcastId);
        const driverId = req.user.id;
        const assignment = await deliveryAssignment_1.DeliveryAssignmentService.acceptBroadcast(broadcastId, driverId);
        return (0, apiResponse_1.sendSuccess)(res, { assignment }, "Broadcast accepted successfully");
    }
    static async getBroadcastOffers(req, res) {
        const offers = await deliveryAssignment_1.DeliveryAssignmentService.getBroadcastOffersForDriver(req.user.id);
        return (0, apiResponse_1.sendSuccess)(res, { offers }, "Delivery offers retrieved");
    }
    static async declineBroadcast(req, res) {
        const broadcastId = (0, paramUtils_1.ensureString)(req.params.broadcastId);
        const broadcast = await deliveryAssignment_1.DeliveryAssignmentService.declineBroadcast(broadcastId, req.user.id);
        return (0, apiResponse_1.sendSuccess)(res, { broadcastId: broadcast.id }, "Delivery offer declined");
    }
    /**
     * Assign a driver to an order. Two modes:
     *  - driverId provided -> manual assignment. Restricted to the order's
     *    own vendor (or an admin) — previously this endpoint had no role
     *    restriction at all, AND the controller defaulted driverId to the
     *    caller's own id when none was given, meaning any authenticated
     *    delivery person could self-assign to any order in the system by
     *    simply calling this with just an orderId. Both holes are closed.
     *  - no driverId -> broadcasts to nearby available drivers (the safe
     *    default). Vendor or admin only.
     */
    static async assignOrder(req, res) {
        const { orderId, driverId } = req.body;
        if (!orderId)
            throw new AppError_1.ValidationError("orderId is required");
        const order = await prisma_1.default.order.findUnique({ where: { id: orderId }, select: { vendorId: true } });
        if (!order)
            throw new AppError_1.NotFoundError("Order");
        const isOwnerVendor = req.user.role === client_1.Role.VENDOR && req.user.id === order.vendorId;
        const isAdmin = req.user.role === client_1.Role.ADMIN;
        if (!isOwnerVendor && !isAdmin)
            throw new AppError_1.ForbiddenError("Only this order's vendor can assign a delivery driver");
        const assignment = await deliveryAssignment_1.DeliveryAssignmentService.assignOrder(orderId, driverId);
        return (0, apiResponse_1.sendSuccess)(res, { assignment }, "Delivery assignment created");
    }
    static async acceptAssignment(req, res) {
        const assignmentId = (0, paramUtils_1.ensureString)(req.params.assignmentId);
        const assignment = await deliveryAssignment_1.DeliveryAssignmentService.acceptAssignment(assignmentId, req.user.id);
        return (0, apiResponse_1.sendSuccess)(res, { assignment }, "Assignment accepted");
    }
    static async declineAssignment(req, res) {
        const assignmentId = (0, paramUtils_1.ensureString)(req.params.assignmentId);
        const assignment = await deliveryAssignment_1.DeliveryAssignmentService.handleDecline(assignmentId, req.user.id);
        return (0, apiResponse_1.sendSuccess)(res, { assignment }, "Assignment declined");
    }
    static async getCurrentAssignments(req, res) {
        const assignments = await deliveryAssignment_1.DeliveryAssignmentService.getActiveAssignmentsForDriver(req.user.id);
        return (0, apiResponse_1.sendSuccess)(res, { assignments }, "Current assignments retrieved");
    }
    static async updateDeliveryStatus(req, res) {
        const assignmentId = (0, paramUtils_1.ensureString)(req.params.assignmentId);
        const { status } = req.body;
        if (!status || !(status in client_1.DeliveryStatus))
            throw new AppError_1.ValidationError("A valid status is required");
        if (status === "DELIVERED") {
            const proof = await prisma_1.default.deliveryProof.findUnique({ where: { assignmentId } });
            if (!proof || proof.status === "REJECTED") {
                throw new AppError_1.ConflictError("Submit a valid proof of delivery before completing this assignment");
            }
        }
        const result = await deliveryAssignment_1.DeliveryAssignmentService.updateStatus(assignmentId, req.user.id, status);
        return (0, apiResponse_1.sendSuccess)(res, { result }, `Delivery status updated to ${status}`);
    }
    /**
     * Ownership check added — previously took assignmentId straight from
     * the URL with no verification the requester was actually involved in
     * it (the assigned driver, the order's customer/vendor, or an admin).
     * Any authenticated delivery person could look up any assignment by ID.
     */
    static async getAssignmentById(req, res) {
        const assignmentId = (0, paramUtils_1.ensureString)(req.params.assignmentId);
        const assignment = await deliveryAssignment_1.DeliveryAssignmentService.getAssignmentById(assignmentId);
        const userId = req.user.id;
        const isInvolved = assignment.deliveryPerson.userId === userId ||
            assignment.order.customerId === userId ||
            assignment.order.vendorId === userId ||
            req.user.role === client_1.Role.ADMIN;
        if (!isInvolved)
            throw new AppError_1.ForbiddenError("You don't have access to this assignment");
        return (0, apiResponse_1.sendSuccess)(res, { assignment }, "Assignment retrieved");
    }
    /**
     * A driver can only view their own history — previously this took
     * :driverId straight from the URL with no check that it matched the
     * caller, meaning any driver could enumerate any other driver's
     * delivery history.
     */
    static async getDriverHistory(req, res) {
        const driverId = (0, paramUtils_1.ensureString)(req.params.driverId);
        if (driverId !== req.user.id && req.user.role !== client_1.Role.ADMIN) {
            throw new AppError_1.ForbiddenError("You can only view your own delivery history");
        }
        const history = await deliveryAssignment_1.DeliveryAssignmentService.getDriverHistory(driverId);
        return (0, apiResponse_1.sendSuccess)(res, { history }, "Driver history retrieved");
    }
    /** Same fix as getDriverHistory — self-only unless admin. */
    static async getCustomerHistory(req, res) {
        const customerId = (0, paramUtils_1.ensureString)(req.params.customerId);
        if (customerId !== req.user.id && req.user.role !== client_1.Role.ADMIN) {
            throw new AppError_1.ForbiddenError("You can only view your own delivery history");
        }
        const history = await deliveryAssignment_1.DeliveryAssignmentService.getCustomerHistory(customerId);
        return (0, apiResponse_1.sendSuccess)(res, { history }, "Customer delivery history retrieved");
    }
    /** Same fix — self-only unless admin. */
    static async getDriverAnalytics(req, res) {
        const driverId = (0, paramUtils_1.ensureString)(req.params.driverId);
        if (driverId !== req.user.id && req.user.role !== client_1.Role.ADMIN) {
            throw new AppError_1.ForbiddenError("You can only view your own analytics");
        }
        const analytics = await deliveryAssignment_1.DeliveryAssignmentService.getDriverAnalytics(driverId);
        return (0, apiResponse_1.sendSuccess)(res, { analytics }, "Driver analytics retrieved");
    }
    static async getAvailableDrivers(req, res) {
        const latitude = (0, paramUtils_1.ensureNumber)(req.query.latitude);
        const longitude = (0, paramUtils_1.ensureNumber)(req.query.longitude);
        if (!latitude || !longitude)
            throw new AppError_1.ValidationError("latitude and longitude are required in query");
        const drivers = await deliveryAssignment_1.DeliveryAssignmentService.findAvailableDrivers(latitude, longitude);
        return (0, apiResponse_1.sendSuccess)(res, { drivers }, "Available drivers retrieved");
    }
    // ── NEW: previously there was no way for a driver to ever update ──
    // their live position or online status after registration.
    static async updateLocation(req, res) {
        const schema = zod_1.z.object({ latitude: zod_1.z.number(), longitude: zod_1.z.number() });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success)
            throw new AppError_1.ValidationError("Valid latitude and longitude are required", parsed.error.flatten().fieldErrors);
        const driver = await deliveryAssignment_1.DeliveryAssignmentService.updateDriverLocation(req.user.id, parsed.data.latitude, parsed.data.longitude);
        return (0, apiResponse_1.sendSuccess)(res, { latitude: driver.latitude, longitude: driver.longitude }, "Location updated");
    }
    static async setOnlineStatus(req, res) {
        const schema = zod_1.z.object({ isOnline: zod_1.z.boolean() });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success)
            throw new AppError_1.ValidationError("isOnline (boolean) is required");
        const driver = await deliveryAssignment_1.DeliveryAssignmentService.setOnlineStatus(req.user.id, parsed.data.isOnline);
        return (0, apiResponse_1.sendSuccess)(res, { isOnline: driver.isOnline }, parsed.data.isOnline ? "You're now online" : "You're now offline");
    }
}
exports.DeliveryAssignmentController = DeliveryAssignmentController;

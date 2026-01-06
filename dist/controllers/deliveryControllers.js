"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeliveryAssignmentController = void 0;
const deliveryAssignment_1 = require("../services/deliveryAssignment");
class DeliveryAssignmentController {
    static async acceptBroadcast(req, res) {
        try {
            const { broadcastId } = req.params;
            const driverId = req.user?.id;
            if (!driverId) {
                return res
                    .status(401)
                    .json({ success: false, message: "Unauthorized: driver not found" });
            }
            const assignment = await deliveryAssignment_1.DeliveryAssignmentService.acceptBroadcast(broadcastId, driverId);
            return res.status(200).json({
                success: true,
                message: "Broadcast accepted successfully",
                data: assignment,
            });
        }
        catch (error) {
            console.error("❌ Accept broadcast error:", error);
            return res.status(400).json({
                success: false,
                message: error.message || "Failed to accept broadcast",
            });
        }
    }
    static async assignOrder(req, res) {
        try {
            const { orderId, driverId } = req.body; // <-- include driverId for manual assignment
            if (!orderId) {
                return res.status(400).json({ success: false, message: "orderId is required" });
            }
            const assignment = await deliveryAssignment_1.DeliveryAssignmentService.assignOrder(orderId, driverId); // <-- pass driverId to service
            return res.json({ success: true, assignment }); // standardized key "assignment"
        }
        catch (err) {
            console.error("assignOrder error:", err);
            return res.status(500).json({ success: false, message: err.message || "Server error" });
        }
    }
    static async acceptAssignment(req, res) {
        try {
            const { assignmentId } = req.params;
            const driverId = req.user?.id;
            if (!driverId)
                return res.status(401).json({ success: false, message: "Unauthorized" });
            if (!assignmentId)
                return res.status(400).json({ success: false, message: "assignmentId is required" });
            const assignment = await deliveryAssignment_1.DeliveryAssignmentService.acceptAssignment(assignmentId, driverId);
            return res.json({ success: true, assignment });
        }
        catch (err) {
            console.error("acceptAssignment error:", err);
            return res.status(500).json({ success: false, message: err.message || "Server error" });
        }
    }
    static async declineAssignment(req, res) {
        try {
            const { assignmentId } = req.params;
            if (!assignmentId)
                return res.status(400).json({ success: false, message: "assignmentId is required" });
            const assignment = await deliveryAssignment_1.DeliveryAssignmentService.handleDecline(assignmentId);
            return res.json({ success: true, assignment });
        }
        catch (err) {
            console.error("declineAssignment error:", err);
            return res.status(500).json({ success: false, message: err.message || "Server error" });
        }
    }
    static async getCurrentAssignments(req, res) {
        try {
            const driverId = req.user?.id;
            if (!driverId)
                return res.status(401).json({ success: false, message: "Unauthorized" });
            const assignments = await deliveryAssignment_1.DeliveryAssignmentService.getActiveAssignmentsForDriver(driverId);
            return res.json({ success: true, assignments });
        }
        catch (err) {
            console.error("getCurrentAssignments error:", err);
            return res.status(500).json({ success: false, message: err.message || "Server error" });
        }
    }
    static async updateDeliveryStatus(req, res) {
        try {
            const { assignmentId } = req.params;
            const { status } = req.body; // PICKED_UP, EN_ROUTE, DELIVERED, CANCELLED
            const driverId = req.user?.id;
            if (!driverId)
                return res.status(401).json({ success: false, message: "Unauthorized" });
            if (!assignmentId || !status)
                return res.status(400).json({ success: false, message: "Missing fields" });
            const result = await deliveryAssignment_1.DeliveryAssignmentService.updateStatus(assignmentId, driverId, status);
            return res.json({ success: true, result });
        }
        catch (err) {
            console.error("updateDeliveryStatus error:", err);
            return res.status(500).json({ success: false, message: err.message || "Server error" });
        }
    }
    static async getAssignmentById(req, res) {
        try {
            const { assignmentId } = req.params;
            const assignment = await deliveryAssignment_1.DeliveryAssignmentService.getAssignmentById(assignmentId);
            res.json({ success: true, assignment });
        }
        catch (err) {
            console.error("getAssignmentById error:", err);
            res.status(500).json({ success: false, message: err.message });
        }
    }
    static async getDriverHistory(req, res) {
        try {
            const { driverId } = req.params;
            const history = await deliveryAssignment_1.DeliveryAssignmentService.getDriverHistory(driverId);
            res.json({ success: true, history });
        }
        catch (err) {
            console.error("getDriverHistory error:", err);
            res.status(500).json({ success: false, message: err.message });
        }
    }
    static async getCustomerHistory(req, res) {
        try {
            const { customerId } = req.params;
            const history = await deliveryAssignment_1.DeliveryAssignmentService.getCustomerHistory(customerId);
            res.json({ success: true, history });
        }
        catch (err) {
            console.error("getCustomerHistory error:", err);
            res.status(500).json({ success: false, message: err.message });
        }
    }
    static async getDriverAnalytics(req, res) {
        try {
            const { driverId } = req.params;
            const analytics = await deliveryAssignment_1.DeliveryAssignmentService.getDriverAnalytics(driverId);
            res.json({ success: true, analytics });
        }
        catch (err) {
            console.error("getDriverAnalytics error:", err);
            res.status(500).json({ success: false, message: err.message });
        }
    }
    static async getAvailableDrivers(req, res) {
        try {
            const { latitude, longitude } = req.query;
            // Optional validation
            if (!latitude || !longitude) {
                return res.status(400).json({
                    success: false,
                    message: "latitude and longitude are required in query",
                });
            }
            const drivers = await deliveryAssignment_1.DeliveryAssignmentService.findAvailableDrivers(Number(latitude), Number(longitude));
            return res.json({ success: true, drivers });
        }
        catch (err) {
            console.error("getAvailableDrivers error:", err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }
}
exports.DeliveryAssignmentController = DeliveryAssignmentController;

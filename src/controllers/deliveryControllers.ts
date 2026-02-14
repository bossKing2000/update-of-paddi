import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { DeliveryAssignmentService } from "../services/deliveryAssignment";
import { ensureString, ensureNumber } from "../utils/paramUtils";

export class DeliveryAssignmentController {


    static async acceptBroadcast(req: AuthRequest, res: Response) {
    try {
      const broadcastId = ensureString(req.params.broadcastId);
      const driverId = req.user?.id;

      if (!driverId) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized: driver not found" });
      }

      const assignment = await DeliveryAssignmentService.acceptBroadcast(
        broadcastId,
        driverId
      );

      return res.status(200).json({
        success: true,
        message: "Broadcast accepted successfully",
        data: assignment,
      });
    } catch (error: any) {
      console.error("❌ Accept broadcast error:", error);

      return res.status(400).json({
        success: false,
        message: error.message || "Failed to accept broadcast",
      });
    }
  }

static async assignOrder(req: AuthRequest, res: Response) {
    try {
    const { orderId } = req.body; // <-- include driverId for manual assignment
    const driverId = ensureString(req.body.driverId) || req.user?.id;
    if (!orderId) {
      return res.status(400).json({ success: false, message: "orderId is required" });
    }

    const assignment = await DeliveryAssignmentService.assignOrder(orderId, driverId); // <-- pass driverId to service
    return res.json({ success: true, assignment }); // standardized key "assignment"
  } catch (err: any) {
    console.error("assignOrder error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

  static async acceptAssignment(req: AuthRequest, res: Response) {
    try {
      const assignmentId = ensureString(req.params.assignmentId);
      const driverId = req.user?.id;
      if (!driverId) return res.status(401).json({ success: false, message: "Unauthorized" });
      if (!assignmentId) return res.status(400).json({ success: false, message: "assignmentId is required" });

      const assignment = await DeliveryAssignmentService.acceptAssignment(assignmentId, driverId);
      return res.json({ success: true, assignment });
    } catch (err: any) {
      console.error("acceptAssignment error:", err);
      return res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  }

  static async declineAssignment(req: AuthRequest, res: Response) {
    try {
      const assignmentId = ensureString(req.params.assignmentId);
      if (!assignmentId) return res.status(400).json({ success: false, message: "assignmentId is required" });

      const assignment = await DeliveryAssignmentService.handleDecline(assignmentId);
      return res.json({ success: true, assignment });
    } catch (err: any) {
      console.error("declineAssignment error:", err);
      return res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  }

  static async getCurrentAssignments(req: AuthRequest, res: Response) {
    try {
      const driverId = req.user?.id;
      if (!driverId) return res.status(401).json({ success: false, message: "Unauthorized" });

      const assignments = await DeliveryAssignmentService.getActiveAssignmentsForDriver(driverId);
      return res.json({ success: true, assignments });
    } catch (err: any) {
      console.error("getCurrentAssignments error:", err);
      return res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  }

  static async updateDeliveryStatus(req: AuthRequest, res: Response) {
  try {
    const assignmentId = ensureString(req.params.assignmentId);
    const { status } = req.body; // PICKED_UP, EN_ROUTE, DELIVERED, CANCELLED
    const driverId = req.user?.id;

    if (!driverId) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (!assignmentId || !status) return res.status(400).json({ success: false, message: "Missing fields" });

    const result = await DeliveryAssignmentService.updateStatus(assignmentId, driverId, status);
    return res.json({ success: true, result });
  } catch (err: any) {
    console.error("updateDeliveryStatus error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
}

 static async getAssignmentById(req: AuthRequest, res: Response) {
    try {
      const assignmentId = ensureString(req.params.assignmentId);
      const assignment = await DeliveryAssignmentService.getAssignmentById(assignmentId);
      res.json({ success: true, assignment });
    } catch (err: any) {
      console.error("getAssignmentById error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  static async getDriverHistory(req: AuthRequest, res: Response) {
    try {
      const driverId = ensureString(req.params.driverId);
      const history = await DeliveryAssignmentService.getDriverHistory(driverId);
      res.json({ success: true, history });
    } catch (err: any) {
      console.error("getDriverHistory error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  static async getCustomerHistory(req: AuthRequest, res: Response) {
    try {
      const customerId = ensureString(req.params.customerId);
      const history = await DeliveryAssignmentService.getCustomerHistory(customerId);
      res.json({ success: true, history });
    } catch (err: any) {
      console.error("getCustomerHistory error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  static async getDriverAnalytics(req: AuthRequest, res: Response) {
    try {
      const driverId = ensureString(req.params.driverId);
      const analytics = await DeliveryAssignmentService.getDriverAnalytics(driverId);
      res.json({ success: true, analytics });
    } catch (err: any) {
      console.error("getDriverAnalytics error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }

  static async getAvailableDrivers(req: AuthRequest, res: Response) {
  try {
    const latitude = ensureNumber(req.query.latitude);
    const longitude = ensureNumber(req.query.longitude);

    // Optional validation
    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: "latitude and longitude are required in query",
      });
    }
    const drivers = await DeliveryAssignmentService.findAvailableDrivers(
      latitude,
      longitude
    );

    return res.json({ success: true, drivers });
  } catch (err: any) {
    console.error("getAvailableDrivers error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
}
}
 




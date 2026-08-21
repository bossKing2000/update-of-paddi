import { Response } from "express";
import { z } from "zod";
import { AuthRequest } from "../middlewares/auth.middleware";
import { DeliveryAssignmentService } from "../services/deliveryAssignment";
import { ensureString, ensureNumber } from "../utils/paramUtils";
import { sendSuccess } from "../utils/apiResponse";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors/AppError";
import prisma from "../lib/prisma";
import { DeliveryStatus, Role } from "@prisma/client";

export class DeliveryAssignmentController {
  static async acceptBroadcast(req: AuthRequest, res: Response) {
    const broadcastId = ensureString(req.params.broadcastId);
    const driverId = req.user!.id;
    const assignment = await DeliveryAssignmentService.acceptBroadcast(broadcastId, driverId);
    return sendSuccess(res, { assignment }, "Broadcast accepted successfully");
  }

  static async getBroadcastOffers(req: AuthRequest, res: Response) {
    const offers = await DeliveryAssignmentService.getBroadcastOffersForDriver(req.user!.id);
    return sendSuccess(res, { offers }, "Delivery offers retrieved");
  }

  static async declineBroadcast(req: AuthRequest, res: Response) {
    const broadcastId = ensureString(req.params.broadcastId);
    const broadcast = await DeliveryAssignmentService.declineBroadcast(broadcastId, req.user!.id);
    return sendSuccess(res, { broadcastId: broadcast.id }, "Delivery offer declined");
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
  static async assignOrder(req: AuthRequest, res: Response) {
    const { orderId, driverId } = req.body as { orderId?: string; driverId?: string };
    if (!orderId) throw new ValidationError("orderId is required");

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { vendorId: true } });
    if (!order) throw new NotFoundError("Order");

    const isOwnerVendor = req.user!.role === Role.VENDOR && req.user!.id === order.vendorId;
    const isAdmin = req.user!.role === Role.ADMIN;
    if (!isOwnerVendor && !isAdmin) throw new ForbiddenError("Only this order's vendor can assign a delivery driver");

    const assignment = await DeliveryAssignmentService.assignOrder(orderId, driverId);
    return sendSuccess(res, { assignment }, "Delivery assignment created");
  }

  static async acceptAssignment(req: AuthRequest, res: Response) {
    const assignmentId = ensureString(req.params.assignmentId);
    const assignment = await DeliveryAssignmentService.acceptAssignment(assignmentId, req.user!.id);
    return sendSuccess(res, { assignment }, "Assignment accepted");
  }

  static async declineAssignment(req: AuthRequest, res: Response) {
    const assignmentId = ensureString(req.params.assignmentId);
    const assignment = await DeliveryAssignmentService.handleDecline(assignmentId, req.user!.id);
    return sendSuccess(res, { assignment }, "Assignment declined");
  }

  static async getCurrentAssignments(req: AuthRequest, res: Response) {
    const assignments = await DeliveryAssignmentService.getActiveAssignmentsForDriver(req.user!.id);
    return sendSuccess(res, { assignments }, "Current assignments retrieved");
  }

  static async updateDeliveryStatus(req: AuthRequest, res: Response) {
    const assignmentId = ensureString(req.params.assignmentId);
    const { status } = req.body as { status?: string };
    if (!status || !(status in DeliveryStatus)) throw new ValidationError("A valid status is required");
    if (status === "DELIVERED") {
      const proof = await prisma.deliveryProof.findUnique({ where: { assignmentId } });
      if (!proof || proof.status === "REJECTED") {
        throw new ConflictError("Submit a valid proof of delivery before completing this assignment");
      }
    }

    const result = await DeliveryAssignmentService.updateStatus(assignmentId, req.user!.id, status as DeliveryStatus);
    return sendSuccess(res, { result }, `Delivery status updated to ${status}`);
  }

  /**
   * Ownership check added — previously took assignmentId straight from
   * the URL with no verification the requester was actually involved in
   * it (the assigned driver, the order's customer/vendor, or an admin).
   * Any authenticated delivery person could look up any assignment by ID.
   */
  static async getAssignmentById(req: AuthRequest, res: Response) {
    const assignmentId = ensureString(req.params.assignmentId);
    const assignment = await DeliveryAssignmentService.getAssignmentById(assignmentId);

    const userId = req.user!.id;
    const isInvolved =
      assignment.deliveryPerson.userId === userId ||
      assignment.order.customerId === userId ||
      assignment.order.vendorId === userId ||
      req.user!.role === Role.ADMIN;
    if (!isInvolved) throw new ForbiddenError("You don't have access to this assignment");

    return sendSuccess(res, { assignment }, "Assignment retrieved");
  }

  /**
   * A driver can only view their own history — previously this took
   * :driverId straight from the URL with no check that it matched the
   * caller, meaning any driver could enumerate any other driver's
   * delivery history.
   */
  static async getDriverHistory(req: AuthRequest, res: Response) {
    const driverId = ensureString(req.params.driverId);
    if (driverId !== req.user!.id && req.user!.role !== Role.ADMIN) {
      throw new ForbiddenError("You can only view your own delivery history");
    }
    const history = await DeliveryAssignmentService.getDriverHistory(driverId);
    return sendSuccess(res, { history }, "Driver history retrieved");
  }

  /** Same fix as getDriverHistory — self-only unless admin. */
  static async getCustomerHistory(req: AuthRequest, res: Response) {
    const customerId = ensureString(req.params.customerId);
    if (customerId !== req.user!.id && req.user!.role !== Role.ADMIN) {
      throw new ForbiddenError("You can only view your own delivery history");
    }
    const history = await DeliveryAssignmentService.getCustomerHistory(customerId);
    return sendSuccess(res, { history }, "Customer delivery history retrieved");
  }

  /** Same fix — self-only unless admin. */
  static async getDriverAnalytics(req: AuthRequest, res: Response) {
    const driverId = ensureString(req.params.driverId);
    if (driverId !== req.user!.id && req.user!.role !== Role.ADMIN) {
      throw new ForbiddenError("You can only view your own analytics");
    }
    const analytics = await DeliveryAssignmentService.getDriverAnalytics(driverId);
    return sendSuccess(res, { analytics }, "Driver analytics retrieved");
  }

  static async getAvailableDrivers(req: AuthRequest, res: Response) {
    const latitude = ensureNumber(req.query.latitude);
    const longitude = ensureNumber(req.query.longitude);
    if (!latitude || !longitude) throw new ValidationError("latitude and longitude are required in query");

    const drivers = await DeliveryAssignmentService.findAvailableDrivers(latitude, longitude);
    return sendSuccess(res, { drivers }, "Available drivers retrieved");
  }

  // ── NEW: previously there was no way for a driver to ever update ──
  // their live position or online status after registration.
  static async updateLocation(req: AuthRequest, res: Response) {
    const schema = z.object({ latitude: z.number(), longitude: z.number() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Valid latitude and longitude are required", parsed.error.flatten().fieldErrors);

    const driver = await DeliveryAssignmentService.updateDriverLocation(req.user!.id, parsed.data.latitude, parsed.data.longitude);
    return sendSuccess(res, { latitude: driver.latitude, longitude: driver.longitude }, "Location updated");
  }

  static async setOnlineStatus(req: AuthRequest, res: Response) {
    const schema = z.object({ isOnline: z.boolean() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("isOnline (boolean) is required");

    const driver = await DeliveryAssignmentService.setOnlineStatus(req.user!.id, parsed.data.isOnline);
    return sendSuccess(res, { isOnline: driver.isOnline }, parsed.data.isOnline ? "You're now online" : "You're now offline");
  }
}

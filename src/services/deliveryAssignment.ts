import { ActivityType, OrderStatus, DeliveryStatus, DeliveryPersonStatus, DeliveryBroadcastStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import { getIO } from "../socket";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { logger } from "../lib/logger";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "../errors/AppError";
import haversine from "haversine-distance";

const MAX_STACK = 3; // max concurrent active assignments per driver
const BROADCAST_WINDOW_SECONDS = 30;
const TOP_DRIVERS_PER_BROADCAST = 5;

// Valid status transitions a driver can make themselves via updateStatus.
// ASSIGNED/ACCEPTED/DECLINED are handled by their own dedicated,
// ownership-checked methods above, not through this generic endpoint.
const DELIVERY_TRANSITIONS: Partial<Record<DeliveryStatus, DeliveryStatus[]>> = {
  [DeliveryStatus.PICKED_UP]: [DeliveryStatus.ACCEPTED],
  [DeliveryStatus.EN_ROUTE]: [DeliveryStatus.PICKED_UP],
  [DeliveryStatus.DELIVERED]: [DeliveryStatus.EN_ROUTE, DeliveryStatus.PICKED_UP],
  [DeliveryStatus.FAILED]: [DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE],
  [DeliveryStatus.RETURNED]: [DeliveryStatus.FAILED],
  [DeliveryStatus.CANCELLED]: [DeliveryStatus.ASSIGNED, DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE],
};

/** Pure, independently-testable transition check — see tests/unit/deliveryTransitions.test.ts */
export function isValidDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  const allowedFrom = DELIVERY_TRANSITIONS[to];
  return !!allowedFrom && allowedFrom.includes(from);
}

export class DeliveryAssignmentService {
  /**
   * Expires broadcasts whose window has passed with no driver accepting,
   * and retries assignment for their order. Previously this function
   * existed but was never called from anywhere — broadcasts that timed
   * out with no response just sat in PENDING forever, and the order was
   * never reassigned or escalated. Now wired into a scheduled job (see
   * jobs/node-cron/runJob.ts).
   */
  static async expireOldBroadcasts() {
    const now = new Date();
    const expired = await prisma.deliveryBroadcast.findMany({
      where: { status: DeliveryBroadcastStatus.PENDING, expiresAt: { lt: now } },
    });

    for (const b of expired) {
      await prisma.deliveryBroadcast.update({
        where: { id: b.id },
        data: { status: DeliveryBroadcastStatus.EXPIRED },
      });

      try {
        await this.assignOrder(b.orderId);
      } catch (err) {
        logger.warn({ err, orderId: b.orderId, broadcastId: b.id }, "Failed to reassign order after broadcast expiry");
      }
    }

    if (expired.length > 0) logger.info({ count: expired.length }, "Expired stale delivery broadcasts and retried assignment");
    return expired.length;
  }

  static async findAvailableDrivers(lat: number, lng: number) {
    const activeDrivers = await prisma.deliveryPerson.findMany({
      where: { isOnline: true, status: DeliveryPersonStatus.ACTIVE, user: { isEmailVerified: true } },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });

    const driversWithDistance = activeDrivers.map((driver) => {
      const distance = haversine({ lat, lon: lng }, { lat: driver.latitude || 0, lon: driver.longitude || 0 }) / 1000;
      return {
        id: driver.user.id,
        name: driver.user.name,
        avatarUrl: driver.user.avatarUrl,
        status: driver.status,
        isOnline: driver.isOnline,
        vehicleType: driver.vehicleType,
        distance: parseFloat(distance.toFixed(2)),
      };
    });

    return driversWithDistance.sort((a, b) => a.distance - b.distance);
  }

  static async acceptBroadcast(broadcastId: string, driverId: string) {
    return prisma.$transaction(async (tx) => {
      const broadcast = await tx.deliveryBroadcast.findUnique({ where: { id: broadcastId } });
      if (!broadcast) throw new NotFoundError("Broadcast");
      if (broadcast.status !== DeliveryBroadcastStatus.PENDING) throw new ConflictError("Broadcast already accepted or expired");
      if (!broadcast.driverIds.includes(driverId)) throw new ForbiddenError("You are not part of this broadcast");
      if (broadcast.declinedDriverIds.includes(driverId)) throw new ConflictError("You already declined this delivery offer");

      const deliveryPerson = await tx.deliveryPerson.findUnique({ where: { userId: driverId } });
      if (!deliveryPerson) throw new NotFoundError("Driver profile");

      const assignment = await tx.deliveryAssignment.create({
        data: {
          orderId: broadcast.orderId,
          deliveryPersonId: deliveryPerson.id,
          status: DeliveryStatus.ACCEPTED,
          acceptedAt: new Date(),
          timeoutSeconds: 30,
          attempts: 1,
        },
      });

      await tx.deliveryBroadcast.update({
        where: { id: broadcastId },
        data: { status: DeliveryBroadcastStatus.ACCEPTED, acceptedDriverId: driverId },
      });

      const io = getIO();
      for (const otherDriverId of broadcast.driverIds.filter((d) => d !== driverId)) {
        io.to(otherDriverId).emit("deliveryExpired", { broadcastId, orderId: broadcast.orderId });
      }
      io.to(driverId).emit("deliveryAccepted", { broadcastId, orderId: broadcast.orderId, assignmentId: assignment.id });

      await recordActivityBundle({
        actorId: driverId,
        orderId: broadcast.orderId,
        actions: [
          { type: ActivityType.GENERAL, title: "Delivery Accepted", message: `You accepted order #${broadcast.orderId}`, targetId: driverId, socketEvent: "ORDER" },
        ],
        audit: { action: "DELIVERY_ACCEPTED", metadata: { broadcastId, driverId, assignmentId: assignment.id } },
        notifyRealtime: true,
        notifyPush: true,
      });

      return assignment;
    });
  }

  static async getBroadcastOffersForDriver(driverId: string) {
    const now = new Date();
    return prisma.deliveryBroadcast.findMany({
      where: { status: DeliveryBroadcastStatus.PENDING, expiresAt: { gt: now }, driverIds: { has: driverId }, NOT: { declinedDriverIds: { has: driverId } } },
      orderBy: { createdAt: "desc" },
      include: {
        order: {
          include: {
            customer: { select: { id: true, name: true, phoneNumber: true } },
            vendor: { select: { id: true, name: true, brandName: true, phoneNumber: true } },
            address: { select: { id: true, label: true, street: true, city: true, latitude: true, longitude: true } },
          },
        },
      },
    });
  }

  static async declineBroadcast(broadcastId: string, driverId: string) {
    return prisma.$transaction(async (tx) => {
      const broadcast = await tx.deliveryBroadcast.findUnique({ where: { id: broadcastId } });
      if (!broadcast) throw new NotFoundError("Broadcast");
      if (broadcast.status !== DeliveryBroadcastStatus.PENDING || broadcast.expiresAt <= new Date()) throw new ConflictError("This delivery offer is no longer available");
      if (!broadcast.driverIds.includes(driverId)) throw new ForbiddenError("You are not part of this broadcast");
      if (broadcast.declinedDriverIds.includes(driverId)) return broadcast;
      return tx.deliveryBroadcast.update({ where: { id: broadcastId }, data: { declinedDriverIds: { push: driverId } } });
    });
  }

  /**
   * Assigns a delivery. Two modes:
   *  - Manual (driverId provided): a specific driver is picked directly.
   *    Callers MUST verify authorization before calling this with a
   *    driverId — this function itself only checks the driver is
   *    actually available, not who's allowed to pick them. That
   *    authorization boundary lives in the controller (only the order's
   *    own vendor, or an admin, may manually assign — never the driver
   *    picking themselves).
   *  - Auto (no driverId): broadcasts to the nearest available drivers,
   *    first to accept gets it. This is the default/safe path.
   */
  static async assignOrder(orderId: string, driverId?: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { vendor: true } });
    if (!order) throw new NotFoundError("Order");
    if (!order.vendor) throw new NotFoundError("Vendor");

    const vendorAddress = await prisma.address.findFirst({
      where: { userId: order.vendorId, isDefault: true },
      select: { latitude: true, longitude: true },
    });
    if (!vendorAddress?.latitude || !vendorAddress?.longitude) throw new ValidationError("Vendor location missing — set a default address with coordinates first");

    const vendorLocation = { lat: vendorAddress.latitude, lon: vendorAddress.longitude };

    const drivers = await prisma.deliveryPerson.findMany({
      where: { isOnline: true, status: DeliveryPersonStatus.ACTIVE, user: { isEmailVerified: true } },
      select: { id: true, userId: true, latitude: true, longitude: true, user: { select: { name: true, email: true } } },
    });
    if (drivers.length === 0) throw new ConflictError("No available drivers");

    const driversWithInfo = await Promise.all(
      drivers.map(async (driver) => {
        const distanceKm = haversine(vendorLocation, { lat: driver.latitude || 0, lon: driver.longitude || 0 }) / 1000;
        const activeAssignments = await prisma.deliveryAssignment.count({
          where: { deliveryPersonId: driver.id, status: { in: [DeliveryStatus.ASSIGNED, DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP] } },
        });
        return { ...driver, distance: parseFloat(distanceKm.toFixed(2)), activeAssignments };
      })
    );

    const availableDrivers = driversWithInfo
      .filter((d) => d.activeAssignments < MAX_STACK)
      .sort((a, b) => a.distance - b.distance);

    // ── MANUAL ASSIGNMENT ──
    if (driverId) {
      const manualDriver = availableDrivers.find((d) => d.userId === driverId);
      if (!manualDriver) throw new ConflictError("Selected driver unavailable or exceeds stacking limit");

      const batchId = manualDriver.activeAssignments > 0 ? `batch_${Date.now()}_${manualDriver.id}` : null;

      const assignment = await prisma.deliveryAssignment.create({
        data: { orderId: order.id, deliveryPersonId: manualDriver.id, timeoutSeconds: 30, attempts: 1, batchId },
        include: { order: true, deliveryPerson: { include: { user: true } } },
      });

      await recordActivityBundle({
        actorId: manualDriver.userId,
        orderId: order.id,
        actions: [
          {
            type: ActivityType.GENERAL,
            title: "New Delivery Assigned",
            message: `You have been assigned order #${order.id}`,
            targetId: manualDriver.userId,
            socketEvent: "ORDER",
            metadata: { orderId: order.id, batchId, timeoutSeconds: assignment.timeoutSeconds },
          },
        ],
        audit: { action: "DELIVERY_ASSIGNED_MANUAL", metadata: { assignmentId: assignment.id, orderId: order.id, driverId: manualDriver.id } },
        notifyRealtime: true,
        notifyPush: true,
      });

      return { ...assignment, distance: manualDriver.distance };
    }

    // ── AUTO ASSIGNMENT (broadcast) ──
    if (availableDrivers.length === 0) throw new ConflictError("No drivers available within stacking limit");

    const topDrivers = availableDrivers.slice(0, TOP_DRIVERS_PER_BROADCAST);
    const driverIds = topDrivers.map((d) => d.userId);
    const expiresAt = new Date(Date.now() + BROADCAST_WINDOW_SECONDS * 1000);

    const broadcast = await prisma.deliveryBroadcast.create({
      data: { orderId: order.id, driverIds, expiresAt, status: DeliveryBroadcastStatus.PENDING },
    });

    const io = getIO();
    for (const d of topDrivers) {
      io.to(d.userId).emit("deliveryRequest", { broadcastId: broadcast.id, orderId: order.id, expiresAt });
    }

    await recordActivityBundle({
      actorId: "SYSTEM",
      orderId: order.id,
      actions: topDrivers.map((d) => ({
        type: ActivityType.GENERAL,
        title: "New Delivery Request",
        message: `A new order (#${order.id}) is available for pickup.`,
        targetId: d.userId,
        socketEvent: "DELIVERY_REQUEST",
        metadata: { orderId: order.id, broadcastId: broadcast.id, expiresAt },
      })),
      audit: { action: "DELIVERY_BROADCAST_INITIATED", metadata: { broadcastId: broadcast.id, orderId: order.id, driverIds } },
      notifyRealtime: true,
      notifyPush: true,
    });

    return { success: true, broadcast };
  }

  /**
   * Resolves the caller's assignment ownership. Every mutation below that
   * takes an assignmentId + driverId (userId) verifies the assignment
   * actually belongs to that driver — previously acceptAssignment skipped
   * this check entirely, meaning any authenticated driver could accept an
   * assignment broadcast to (or already claimed by) someone else.
   */
  private static async resolveOwnedAssignment(assignmentId: string, driverUserId: string) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverUserId } });
    if (!deliveryPerson) throw new NotFoundError("Driver profile");

    const assignment = await prisma.deliveryAssignment.findUnique({ where: { id: assignmentId }, include: { order: true } });
    if (!assignment) throw new NotFoundError("Assignment");
    if (assignment.deliveryPersonId !== deliveryPerson.id) throw new ForbiddenError("This assignment doesn't belong to you");

    return { deliveryPerson, assignment };
  }

  static async acceptAssignment(assignmentId: string, driverId: string) {
    const { assignment: existing } = await this.resolveOwnedAssignment(assignmentId, driverId);
    if (existing.status !== DeliveryStatus.ASSIGNED) throw new ConflictError(`Cannot accept an assignment in ${existing.status} status`);

    const assignment = await prisma.deliveryAssignment.update({
      where: { id: assignmentId },
      data: { status: DeliveryStatus.ACCEPTED, acceptedAt: new Date() },
      include: { order: true, deliveryPerson: { include: { user: true } } },
    });

    const driverUser = assignment.deliveryPerson.user;

    await recordActivityBundle({
      actorId: driverId,
      orderId: assignment.order.id,
      actions: [
        { type: ActivityType.GENERAL, title: "Driver Accepted", message: `Your driver ${driverUser.name} accepted order #${assignment.order.id}`, targetId: assignment.order.customerId, socketEvent: "ORDER", metadata: { orderId: assignment.order.id, driverId } },
        { type: ActivityType.GENERAL, title: "Driver Accepted", message: `Driver ${driverUser.name} accepted order #${assignment.order.id}`, targetId: assignment.order.vendorId, socketEvent: "ORDER", metadata: { orderId: assignment.order.id, driverId } },
      ],
      audit: { action: "DELIVERY_ACCEPTED", metadata: { assignmentId, orderId: assignment.order.id, driverId } },
      notifyRealtime: true,
      notifyPush: true,
    });

    await this.broadcastDriverLocation(driverId);
    return assignment;
  }

  /** Handle driver decline (driver-initiated, ownership-checked) */
  static async handleDecline(assignmentId: string, driverId: string) {
    const { assignment: existing } = await this.resolveOwnedAssignment(assignmentId, driverId);
    if (existing.status !== DeliveryStatus.ASSIGNED) throw new ConflictError(`Cannot decline an assignment in ${existing.status} status`);

    const assignment = await prisma.deliveryAssignment.update({
      where: { id: assignmentId },
      data: { status: DeliveryStatus.DECLINED, declinedAt: new Date(), attempts: { increment: 1 } },
      include: { order: true, deliveryPerson: { select: { userId: true } } },
    });

    await recordActivityBundle({
      actorId: assignment.deliveryPerson.userId,
      orderId: assignment.order.id,
      actions: [
        { type: ActivityType.GENERAL, title: "Driver Declined", message: `A driver declined order #${assignment.order.id}, reassigning...`, targetId: assignment.order.vendorId, socketEvent: "ORDER", metadata: { orderId: assignment.order.id, assignmentId } },
      ],
      audit: { action: "DELIVERY_DECLINED", metadata: { assignmentId, orderId: assignment.order.id, driverId: assignment.deliveryPersonId } },
      notifyRealtime: true,
      notifyPush: true,
    });

    try {
      await this.assignOrder(assignment.orderId);
    } catch (err) {
      logger.warn({ err, orderId: assignment.orderId }, "Failed to reassign order after decline");
    }

    return assignment;
  }

  static async getActiveAssignmentsForDriver(driverId: string) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverId } });
    if (!deliveryPerson) throw new NotFoundError("Driver profile");

    return prisma.deliveryAssignment.findMany({
      where: { deliveryPersonId: deliveryPerson.id, status: { in: [DeliveryStatus.ASSIGNED, DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP] } },
      include: {
        order: { include: { customer: { select: { id: true, name: true, avatarUrl: true } }, vendor: { select: { id: true, brandName: true, brandLogo: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Broadcast live driver location to customer & vendor for any active
   * assignment. Previously this queried `deliveryPersonId: driverId`
   * where `driverId` was actually the caller's userId — a type
   * confusion that meant this silently matched zero assignments (userId
   * and DeliveryPerson.id are different values), so location updates
   * never actually reached anyone after a driver accepted a delivery.
   */
  static async broadcastDriverLocation(driverUserId: string) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverUserId } });
    if (!deliveryPerson) return;

    const assignments = await prisma.deliveryAssignment.findMany({
      where: { deliveryPersonId: deliveryPerson.id, status: { in: [DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE] } },
      include: { order: { select: { customerId: true, vendorId: true } } },
    });

    if (assignments.length === 0) return;

    const io = getIO();
    const location = { lat: deliveryPerson.latitude, lng: deliveryPerson.longitude };
    for (const assignment of assignments) {
      io.to(assignment.order.customerId).emit("driverLocationUpdate", location);
      io.to(assignment.order.vendorId).emit("driverLocationUpdate", location);
    }
  }

  /**
   * Updates a driver's live GPS position. Previously there was no
   * endpoint anywhere that ever called this — DeliveryPerson.latitude/
   * longitude could only ever be whatever was set at registration, which
   * meant "find nearby drivers" and live location broadcasting were both
   * working off permanently stale coordinates.
   */
  static async updateDriverLocation(driverUserId: string, latitude: number, longitude: number) {
    const deliveryPerson = await prisma.deliveryPerson.update({
      where: { userId: driverUserId },
      data: { latitude, longitude, lastSeenAt: new Date() },
    });

    await prisma.driverLocationLog.create({
      data: { driverId: deliveryPerson.id, latitude, longitude },
    });

    await this.broadcastDriverLocation(driverUserId);
    return deliveryPerson;
  }

  static async setOnlineStatus(driverUserId: string, isOnline: boolean) {
    return prisma.deliveryPerson.update({ where: { userId: driverUserId }, data: { isOnline, lastSeenAt: new Date() } });
  }

  static async updateStatus(assignmentId: string, driverId: string, status: DeliveryStatus) {
    const { deliveryPerson, assignment } = await this.resolveOwnedAssignment(assignmentId, driverId);

    if (!(status in DELIVERY_TRANSITIONS)) throw new ValidationError(`${status} cannot be set directly through this endpoint`);
    if (!isValidDeliveryTransition(assignment.status, status)) {
      throw new ConflictError(`Cannot transition from ${assignment.status} to ${status}`);
    }

    const updated = await prisma.deliveryAssignment.update({
      where: { id: assignmentId },
      data: {
        status,
        ...(status === DeliveryStatus.PICKED_UP ? { startedAt: new Date() } : {}),
        ...(status === DeliveryStatus.DELIVERED ? { completedAt: new Date() } : {}),
      },
      include: { order: true },
    });

    await recordActivityBundle({
      actorId: driverId,
      orderId: updated.order.id,
      actions: [
        { type: ActivityType.GENERAL, title: `Order ${status}`, message: `Order #${updated.order.id} is now ${status}`, targetId: updated.order.customerId, socketEvent: "ORDER", metadata: { orderId: updated.order.id, assignmentId, status } },
        { type: ActivityType.GENERAL, title: `Order ${status}`, message: `Order #${updated.order.id} is now ${status}`, targetId: updated.order.vendorId, socketEvent: "ORDER", metadata: { orderId: updated.order.id, assignmentId, status } },
      ],
      audit: { action: "DELIVERY_STATUS_UPDATED", metadata: { assignmentId, orderId: updated.order.id, driverId, newStatus: status } },
      notifyRealtime: true,
      notifyPush: true,
    });

    // Sync the main Order table to reflect delivery progress.
    let mainOrderStatus: OrderStatus | undefined;
    switch (status) {
      case DeliveryStatus.PICKED_UP:
        mainOrderStatus = OrderStatus.OUT_FOR_DELIVERY;
        break;
      case DeliveryStatus.DELIVERED:
        mainOrderStatus = OrderStatus.COMPLETED;
        break;
      case DeliveryStatus.CANCELLED:
      case DeliveryStatus.FAILED:
      case DeliveryStatus.RETURNED:
        mainOrderStatus = OrderStatus.FAILED_DELIVERY;
        break;
    }
    if (mainOrderStatus) {
      await prisma.order.update({ where: { id: updated.orderId }, data: { status: mainOrderStatus } });
    }

    // Credit the driver and update their stats on successful delivery.
    // Previously walletBalance/totalDeliveries/DeliveryEarning were never
    // updated anywhere in the codebase — a driver's stats stayed frozen
    // at whatever they were set to at signup, forever, no matter how many
    // deliveries they actually completed.
    if (status === DeliveryStatus.DELIVERED) {
      const baseFee = Number(process.env.DELIVERY_BASE_FEE) || 300;
      const totalEarned = updated.order.deliveryFee;
      const distanceFee = Math.max(totalEarned - baseFee, 0);

      await prisma.$transaction([
        prisma.deliveryPerson.update({
          where: { id: deliveryPerson.id },
          data: { totalDeliveries: { increment: 1 }, walletBalance: { increment: totalEarned } },
        }),
        prisma.deliveryEarning.create({
          data: { deliveryPersonId: deliveryPerson.id, orderId: updated.orderId, baseFee: Math.min(baseFee, totalEarned), distanceFee, totalEarned },
        }),
      ]);
    }

    return updated;
  }

  static async getAssignmentById(assignmentId: string) {
    const assignment = await prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: { order: { include: { customer: true, vendor: true } }, deliveryPerson: { include: { user: true } } },
    });
    if (!assignment) throw new NotFoundError("Assignment");
    return assignment;
  }

  /**
   * Get past assignments for a driver. Previously queried
   * `deliveryPersonId: driverId` where `driverId` was the caller's
   * userId — the same type confusion as broadcastDriverLocation had,
   * meaning this almost always returned an empty list for any real
   * caller.
   */
  static async getDriverHistory(driverUserId: string, limit = 50) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverUserId } });
    if (!deliveryPerson) throw new NotFoundError("Driver profile");

    return prisma.deliveryAssignment.findMany({
      where: { deliveryPersonId: deliveryPerson.id, status: { in: [DeliveryStatus.DELIVERED, DeliveryStatus.FAILED, DeliveryStatus.RETURNED, DeliveryStatus.CANCELLED] } },
      include: { order: { include: { customer: true, vendor: true } }, deliveryPerson: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  static async getDriverAnalytics(driverUserId: string) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverUserId } });
    if (!deliveryPerson) throw new NotFoundError("Driver profile");

    const [completed, failed] = await Promise.all([
      prisma.deliveryAssignment.count({ where: { deliveryPersonId: deliveryPerson.id, status: DeliveryStatus.DELIVERED } }),
      prisma.deliveryAssignment.count({ where: { deliveryPersonId: deliveryPerson.id, status: { in: [DeliveryStatus.FAILED, DeliveryStatus.CANCELLED, DeliveryStatus.RETURNED] } } }),
    ]);

    return { completed, failed, totalDeliveries: deliveryPerson.totalDeliveries, walletBalance: deliveryPerson.walletBalance, rating: deliveryPerson.rating };
  }

  static async getCustomerHistory(customerId: string, limit = 50) {
    return prisma.deliveryAssignment.findMany({
      where: { order: { customerId }, status: { in: [DeliveryStatus.DELIVERED, DeliveryStatus.FAILED, DeliveryStatus.RETURNED, DeliveryStatus.CANCELLED] } },
      include: { order: { include: { vendor: true } }, deliveryPerson: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}

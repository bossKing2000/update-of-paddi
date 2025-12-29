import { ActivityType, OrderStatus } from "@prisma/client";
import prisma from "../config/prismaClient";
import { getIO } from "../socket";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import haversine from "haversine-distance";



export class DeliveryAssignmentService {

  static async expireOldBroadcasts() {
  const now = new Date();
  const expired = await prisma.deliveryBroadcast.findMany({
    where: { status: "PENDING", expiresAt: { lt: now } },
  });

  for (const b of expired) {
    await prisma.deliveryBroadcast.update({
      where: { id: b.id },
      data: { status: "EXPIRED" },
    });

    // Optionally retry new broadcast
    await this.assignOrder(b.orderId);
  }
}

  static async findAvailableDrivers(lat: number, lng: number) {
    const activeDrivers = await prisma.deliveryPerson.findMany({
      where: {
        isOnline: true,
        status: "ACTIVE",
        user: { isEmailVerified: true },
      },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    const driversWithDistance = activeDrivers.map((driver) => {
      const driverLat = driver.latitude || 0;
      const driverLng = driver.longitude || 0;

      const distance =
        haversine(
          { lat, lon: lng },
          { lat: driverLat, lon: driverLng }
        ) / 1000; // convert to km

      return {
        id: driver.user.id, // ✅ use userId here for uniformity
        name: driver.user.name,
        avatarUrl: driver.user.avatarUrl,
        status: driver.status,
        isOnline: driver.isOnline,
        vehicleType: driver.vehicleType,
        distance: parseFloat(distance.toFixed(2)),
      };
    });

    // Sort nearest first
    return driversWithDistance.sort((a, b) => a.distance - b.distance);
}

 static async acceptBroadcast(broadcastId: string, driverId: string) {
  return await prisma.$transaction(async (tx) => {
    const broadcast = await tx.deliveryBroadcast.findUnique({
      where: { id: broadcastId },
    });

    if (!broadcast) throw new Error("Broadcast not found");
    if (broadcast.status !== "PENDING")
      throw new Error("Broadcast already accepted or expired");
    if (!broadcast.driverIds.includes(driverId))
      throw new Error("You are not part of this broadcast");

    // ✅ Get deliveryPerson using the driver’s userId
    const deliveryPerson = await tx.deliveryPerson.findUnique({
      where: { userId: driverId },
    });
    if (!deliveryPerson) throw new Error("Driver profile not found");

    // ✅ Assign to this driver using deliveryPerson.id
    const assignment = await tx.deliveryAssignment.create({
      data: {
        orderId: broadcast.orderId,
        deliveryPersonId: deliveryPerson.id, // ✅ correct FK reference
        status: "ACCEPTED", // ✅ driver accepted the broadcast
        acceptedAt: new Date(),
        timeoutSeconds: 30,
        attempts: 1,
      },
    });

    // ✅ Update broadcast
    await tx.deliveryBroadcast.update({
      where: { id: broadcastId },
      data: {
        status: "ACCEPTED",
        acceptedDriverId: driverId, // still userId — this is fine
      },
    });

    // ✅ Notify other drivers their chance expired
    const io = getIO();
    for (const otherDriverId of broadcast.driverIds.filter((d) => d !== driverId)) {
      io.to(otherDriverId).emit("deliveryExpired", {
        broadcastId,
        orderId: broadcast.orderId,
      });
    }

    // ✅ Notify the accepted driver
    io.to(driverId).emit("deliveryAccepted", {
      broadcastId,
      orderId: broadcast.orderId,
      assignmentId: assignment.id,
    });

    // ✅ Record activity using userId for tracking/notifications
    await recordActivityBundle({
      actorId: driverId, // userId
      orderId: broadcast.orderId,
      actions: [
        {
          type: ActivityType.GENERAL,
          title: "Delivery Accepted",
          message: `You accepted order #${broadcast.orderId}`,
          targetId: driverId,
          socketEvent: "ORDER",
        },
      ],
      audit: {
        action: "DELIVERY_ACCEPTED",
        metadata: { broadcastId, driverId, assignmentId: assignment.id },
      },
      notifyRealtime: true,
      notifyPush: true,
    });

    return assignment;
  });
}

 static async assignOrder(orderId: string, driverId?: string) {
  // 1. Fetch order and vendor
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { vendor: true },
  });
  if (!order) throw new Error("Order not found");
  if (!order.vendor) throw new Error("Vendor not found");

  // 2. Vendor default address
  const vendorAddress = await prisma.address.findFirst({
    where: { userId: order.vendorId, isDefault: true },
    select: { latitude: true, longitude: true },
  });
  if (!vendorAddress?.latitude || !vendorAddress?.longitude)
    throw new Error("Vendor location missing");

  const vendorLocation = {
    lat: vendorAddress.latitude,
    lon: vendorAddress.longitude,
  };

  // 3. Fetch active drivers
  const drivers = await prisma.deliveryPerson.findMany({
    where: {
      isOnline: true,
      status: "ACTIVE",
      user: { isEmailVerified: true },
    },
    select: {
      id: true,
      userId: true,
      latitude: true,
      longitude: true,
      user: { select: { name: true, email: true } },
    },
  });
  if (drivers.length === 0) throw new Error("No available drivers");

  // 4. Compute distances and active assignments
  const driversWithInfo = await Promise.all(
    drivers.map(async (driver) => {
      const distanceKm =
        haversine(
          { lat: vendorLocation.lat, lon: vendorLocation.lon },
          { lat: driver.latitude || 0, lon: driver.longitude || 0 }
        ) / 1000;

      const activeAssignments = await prisma.deliveryAssignment.count({
        where: {
          deliveryPersonId: driver.id,
          status: { in: ["ASSIGNED", "ACCEPTED", "PICKED_UP"] },
        },
      });

      return {
        ...driver,
        distance: parseFloat(distanceKm.toFixed(2)),
        activeAssignments,
      };
    })
  );

  // 5. Filter by stacking limit and sort by nearest
  const maxStack = 3;
  const availableDrivers = driversWithInfo
    .filter((d) => (d.activeAssignments ?? 0) < maxStack)
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));

  // ================================
  // 🟢 MANUAL ASSIGNMENT (unchanged)
  // ================================
  if (driverId) {
    const manualDriver = availableDrivers.find((d) => d.userId === driverId);
    if (!manualDriver)
      throw new Error("Selected driver unavailable or exceeds stacking limit");

    const batchId =
      manualDriver.activeAssignments > 0
        ? `batch_${Date.now()}_${manualDriver.id}`
        : null;

    const assignment = await prisma.deliveryAssignment.create({
      data: {
        orderId: order.id,
        deliveryPersonId: manualDriver.id,
        timeoutSeconds: 30,
        attempts: 1,
        batchId,
      },
      include: {
        order: true,
        deliveryPerson: { include: { user: true } },
      },
    });

    const distanceKm =
      haversine(
        { lat: vendorLocation.lat, lon: vendorLocation.lon },
        { lat: manualDriver.latitude || 0, lon: manualDriver.longitude || 0 }
      ) / 1000;

    const assignmentWithDistance = {
      ...assignment,
      distance: parseFloat(distanceKm.toFixed(2)),
    };

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
          metadata: {
            orderId: order.id,
            batchId,
            timeoutSeconds: assignment.timeoutSeconds,
          },
        },
      ],
      audit: {
        action: "DELIVERY_ASSIGNED_MANUAL",
        metadata: {
          assignmentId: assignment.id,
          orderId: order.id,
          driverId: manualDriver.id,
        },
      },
      notifyRealtime: true,
      notifyPush: true,
    });

    return assignmentWithDistance;
  }

  // ===================================
  // 🚀 AUTO ASSIGNMENT (broadcast mode)
  // ===================================
  if (availableDrivers.length === 0)
    throw new Error("No drivers available within stacking limit");

  const topDrivers = availableDrivers.slice(0, 5);
  const driverIds = topDrivers.map((d) => d.userId); // ✅ broadcast holds userIds
  const expiresAt = new Date(Date.now() + 30 * 1000); // 30 sec broadcast window

  //  Create broadcast record
  const broadcast = await prisma.deliveryBroadcast.create({
    data: {
      orderId: order.id,
      driverIds,
      expiresAt,
      status: "PENDING",
    },
  });

  // 🔔 Notify each driver via socket
  const io = getIO();
  for (const d of topDrivers) {
    io.to(d.userId).emit("deliveryRequest", {
      broadcastId: broadcast.id,
      orderId: order.id,
      expiresAt,
    });
  }

  // Audit + Realtime tracking
  // 🧠 Record activity + DB notifications per driver
await recordActivityBundle({
  actorId: "SYSTEM", // or undefined if your type requires string | undefined
  orderId: order.id,
  actions: topDrivers.map((d) => ({
    type: ActivityType.GENERAL,
    title: "New Delivery Request",
    message: `A new order (#${order.id}) is available for pickup.`,
    targetId: d.userId,
    socketEvent: "DELIVERY_REQUEST",
    metadata: {
      orderId: order.id,
      broadcastId: broadcast.id,
      expiresAt,
    },
  })),
  audit: {
    action: "DELIVERY_BROADCAST_INITIATED",
    metadata: { broadcastId: broadcast.id, orderId: order.id, driverIds },
  },
  notifyRealtime: true,
  notifyPush: true,
});


  return { success: true, broadcast };
}


  static async acceptAssignment(assignmentId: string, driverId: string) {
    const assignment = await prisma.deliveryAssignment.update({
      where: { id: assignmentId },
      data: { status: "ACCEPTED" },
      include: {
        order: true,
        deliveryPerson: { include: { user: true } },
      },
    });

   
  const driverUser = assignment.deliveryPerson.user;

  // 🔔 Record activity + notify customer
  await recordActivityBundle({
    actorId: driverId, // driver accepted
    orderId: assignment.order.id,
    actions: [
      {
        type: ActivityType.GENERAL,
        title: "Driver Accepted",
        message: `Your driver ${driverUser.name} accepted order #${assignment.order.id}`,
        targetId: assignment.order.customerId,
        socketEvent: "ORDER",
        metadata: { orderId: assignment.order.id, driverId },
      },
      {
        type: ActivityType.GENERAL,
        title: "Driver Accepted",
        message: `Driver ${driverUser.name} accepted order #${assignment.order.id}`,
        targetId: assignment.order.vendorId,
        socketEvent: "ORDER",
        metadata: { orderId: assignment.order.id, driverId },
      },
    ],
    audit: {
      action: "DELIVERY_ACCEPTED",
      metadata: {
        assignmentId,
        orderId: assignment.order.id,
        driverId,
      },
    },
    notifyRealtime: true,
    notifyPush: true,
  });

    await this.broadcastDriverLocation(driverId);

    return assignment;
  }

  /**
   * Handle driver decline or timeout
   */
  static async handleDecline(assignmentId: string) {
  const assignment = await prisma.deliveryAssignment.update({
    where: { id: assignmentId },
    data: { status: "DECLINED", attempts: { increment: 1 } },
    include: { order: true, deliveryPerson: {select: {userId: true}} },
  });

  // 🔔 Record activity + notify vendor
  await recordActivityBundle({
    actorId: assignment.deliveryPerson.userId, // the driver who declined
    orderId: assignment.order.id,
    actions: [
      {
        type: ActivityType.GENERAL,
        title: "Driver Declined",
        message: `A driver declined order #${assignment.order.id}, reassigning...`,
        targetId: assignment.order.vendorId,
        socketEvent: "ORDER",
        metadata: { orderId: assignment.order.id, assignmentId },
      },
    ],
    audit: {
      action: "DELIVERY_DECLINED",
      metadata: {
        assignmentId,
        orderId: assignment.order.id,
        driverId: assignment.deliveryPersonId,
      },
    },
    notifyRealtime: true,
    notifyPush: true,
  });

  // 🔄 Attempt reassignment
  await this.assignOrder(assignment.orderId);

  return assignment;
}

  /**
   * Get all active assignments for a driver
   */

  static async getActiveAssignmentsForDriver(driverId: string) {
  // driverId here is the USER ID from the JWT
  const deliveryPerson = await prisma.deliveryPerson.findUnique({
    where: { userId: driverId },
  });

  if (!deliveryPerson) throw new Error("Driver not found");

  // ✅ Now query by the actual deliveryPerson.id
  return prisma.deliveryAssignment.findMany({
    where: {
      deliveryPersonId: deliveryPerson.id,
      status: { in: ["ASSIGNED", "ACCEPTED", "PICKED_UP"] },
    },
    include: {
      order: {
        include: {
          customer: {
            select: { id: true, name: true, avatarUrl: true },
          },
          vendor: {
            select: { id: true, brandName: true, brandLogo: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

  /**
   * Broadcast live driver location to customer & vendor
   */
  static async broadcastDriverLocation(driverId: string) {
    const assignments = await prisma.deliveryAssignment.findMany({
      where: {
        deliveryPersonId: driverId,
        status: { in: ["ACCEPTED", "PICKED_UP", "EN_ROUTE"] },
      },
      include: { deliveryPerson: true, order: true },
    });

    const io = getIO();
    for (const assignment of assignments) {
      const driver = assignment.deliveryPerson;
      if (!driver) continue;

      const location = { lat: driver.latitude, lng: driver.longitude };
      io.to(assignment.order.customerId).emit("driverLocationUpdate", location);
      io.to(assignment.order.vendorId).emit("driverLocationUpdate", location);
    }
  }

  /**
   * Update delivery status during the trip
   */

  static async updateStatus(assignmentId: string,driverId: string,
  status: "PICKED_UP" | "EN_ROUTE" | "DELIVERED" | "CANCELLED" | "FAILED" | "RETURNED"
) {
  // ✅ Step 1: Get the deliveryPerson record using the driver's userId
  const deliveryPerson = await prisma.deliveryPerson.findUnique({
    where: { userId: driverId },
  });
  if (!deliveryPerson) throw new Error("Driver not found");

  // ✅ Step 2: Verify that the assignment exists and belongs to this driver
  const assignment = await prisma.deliveryAssignment.findUnique({
    where: { id: assignmentId },
    include: { order: true },
  });
  if (!assignment) throw new Error("Assignment not found");
  if (assignment.deliveryPersonId !== deliveryPerson.id)
    throw new Error("Not your assignment");

  // ✅ Step 3: Update assignment status
  const updated = await prisma.deliveryAssignment.update({
    where: { id: assignmentId },
    data: { status },
    include: { order: true },
  });

  const io = getIO();

  // ✅ Step 4: Record activity + notify both customer and vendor
  await recordActivityBundle({
    actorId: driverId, // the driver performing the action
    orderId: updated.order.id,
    actions: [
      {
        type: ActivityType.GENERAL,
        title: `Order ${status}`,
        message: `Order #${updated.order.id} is now ${status}`,
        targetId: updated.order.customerId,
        socketEvent: "ORDER",
        metadata: { orderId: updated.order.id, assignmentId, status },
      },
      {
        type: ActivityType.GENERAL,
        title: `Order ${status}`,
        message: `Order #${updated.order.id} is now ${status}`,
        targetId: updated.order.vendorId,
        socketEvent: "ORDER",
        metadata: { orderId: updated.order.id, assignmentId, status },
      },
    ],
    audit: {
      action: "DELIVERY_STATUS_UPDATED",
      metadata: {
        assignmentId,
        orderId: updated.order.id,
        driverId,
        newStatus: status,
      },
    },
    notifyRealtime: true,
    notifyPush: true,
  });

  // ✅ Step 5: Sync the main Order table to reflect delivery progress
  let mainOrderStatus: OrderStatus | undefined;

  switch (status) {
    case "PICKED_UP":
      mainOrderStatus = OrderStatus.OUT_FOR_DELIVERY;
      break;
    case "DELIVERED":
      mainOrderStatus = OrderStatus.COMPLETED;
      break;
    case "CANCELLED":
    case "FAILED":
    case "RETURNED":
      mainOrderStatus = OrderStatus.FAILED_DELIVERY;
      break;
  }

  if (mainOrderStatus) {
    await prisma.order.update({
      where: { id: updated.orderId },
      data: { status: mainOrderStatus },
    });
  }

  // ✅ Step 6: Return updated assignment with related order
  return updated;
}


    static async getAssignmentById(assignmentId: string) {
    const assignment = await prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        order: { include: { customer: true, vendor: true } },
        deliveryPerson: { include: { user: true } },
      },
    });
    if (!assignment) throw new Error("Assignment not found");
    return assignment;
  }

  /**
   * Get past assignments for a driver
   */
  static async getDriverHistory(driverId: string, limit = 50) {
    return prisma.deliveryAssignment.findMany({
      where: {
        deliveryPersonId: driverId,
        status: { in: ["DELIVERED", "FAILED", "RETURNED", "CANCELLED"] },
      },
      include: {
        order: { include: { customer: true, vendor: true } },
        deliveryPerson: { include: { user: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  static async logDriverLocation(driverId: string, latitude: number, longitude: number) {
    await prisma.driverLocationLog.create({
      data: {
        driverId,
        latitude,
        longitude,
        timestamp: new Date(),
      },
    });
  }


  // ✅ Get analytics for driver (convert userId -> deliveryPerson.id)
static async getDriverAnalytics(driverId: string) {
  const deliveryPerson = await prisma.deliveryPerson.findUnique({
    where: { userId: driverId },
  });
  if (!deliveryPerson) throw new Error("Driver not found");

  const completed = await prisma.deliveryAssignment.count({
    where: { deliveryPersonId: deliveryPerson.id, status: "DELIVERED" },
  });

  const failed = await prisma.deliveryAssignment.count({
    where: {
      deliveryPersonId: deliveryPerson.id,
      status: { in: ["FAILED", "CANCELLED", "RETURNED"] },
    },
  });

  return { completed, failed };
}

// ✅ Get customer delivery history (no change in logic, only consistent formatting)
static async getCustomerHistory(customerId: string, limit = 50) {
  return prisma.deliveryAssignment.findMany({
    where: {
      order: { customerId },
      status: { in: ["DELIVERED", "FAILED", "RETURNED", "CANCELLED"] },
    },
    include: {
      order: {
        include: { vendor: true },
      },
      deliveryPerson: {
        include: { user: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

}

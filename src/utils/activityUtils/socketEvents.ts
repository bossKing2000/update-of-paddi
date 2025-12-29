import { getIO } from "../../socket";

export type SocketEventType = "ORDER" | "PAYMENT" | "REFUND" | "REVIEW" | "GENERAL"| "DELIVERY_REQUEST";

interface EmitOptions {
  userId?: string;   // for customers or delivery users
  vendorId?: string; // for vendors
  type: SocketEventType;
  data: Record<string, any>;
}

/**
 * Handles all socket emissions for activity-related updates.
 * Supports dynamic event names based on type and role.
 */
export async function emitSocketEvents({
  userId,
  vendorId,
  type,
  data,
}: EmitOptions): Promise<void> {
  try {
    const io = getIO();

    if (!io) {
      console.error("[SOCKET] ❌ Socket.io not initialized yet");
      return;
    }

    // Generic notification broadcast (used by all)
    if (userId) io.to(userId).emit("notification", data);
    if (vendorId) io.to(vendorId).emit("notification", data);

    switch (type) {
      case "PAYMENT":
        // Customer receives payment success
        if (userId) io.to(userId).emit("paymentSuccess", data);
        // Vendor gets notified of a new paid order
        if (vendorId) io.to(vendorId).emit("newPaidOrder", data);
        break;

      case "ORDER":
        // Customers and vendors both get order status updates
        if (userId) io.to(userId).emit("orderUpdate", data);
        if (vendorId) io.to(vendorId).emit("orderUpdate", data);
        break;

      case "REFUND":
        if (userId) io.to(userId).emit("refundStatus", data);
        if (vendorId) io.to(vendorId).emit("refundNotification", data);
        break;

      case "REVIEW":
        if (vendorId) io.to(vendorId).emit("newReview", data);
        if (userId) io.to(userId).emit("reviewResponse", data);
        break;

      case "GENERAL":
        if (userId) io.to(userId).emit("generalNotification", data);
        if (vendorId) io.to(vendorId).emit("generalNotification", data);
        break;


      case "DELIVERY_REQUEST":
        if (userId) io.to(userId).emit("deliveryRequest", data);
        break;


      default:
        console.warn(`[SOCKET] ⚠️ Unhandled event type: ${type}`);
        break;
    }

    console.log(`[SOCKET] ✅ Events emitted successfully for type: ${type}`);
  } catch (err) {
    console.error("[SOCKET] ❌ Socket emission failed:", err);
  }
}

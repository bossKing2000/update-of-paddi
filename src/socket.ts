import { Server as SocketIOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import config from "./config/config";
import { PrismaClient } from "@prisma/client";
import { DeliveryAssignmentService } from "./services/deliveryAssignment";

const prisma = new PrismaClient();
let io: SocketIOServer | null = null;

/**
 * Initialize Socket.IO
 */
export function initSocket(server: any) {
  const allowedOrigins: (string | RegExp)[] = [
    // "http://127.0.0.1:8080",
    // "http://localhost:8080",
    // "http://localhost:3000",
    // "http://127.0.0.1:60308",
    "https://ui-food-paddi.onrender.com",
  ];

  if (config.clientUrl) allowedOrigins.push(config.clientUrl);

  io = new SocketIOServer(server, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });

  io.on("connection", (socket: Socket) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      console.log("❌ Socket rejected: No token");
      return socket.disconnect();
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret) as any;
      const userId = decoded.userId || decoded.id;
      socket.data.userId = userId;

      console.log(`✅ Socket connected: user ${userId}`);

      // Join room for targeted notifications
      socket.join(userId);
      console.log("Rooms socket joined:", Array.from(socket.rooms));

      // ==========================
      // DRIVER LOCATION UPDATES
      // ==========================
      socket.on("updateLocation", async (data: { lat: number; lng: number }) => {
        try {
          const driver = await prisma.deliveryPerson.findUnique({
            where: { userId },
          });
          if (!driver) return;

          // Update driver's location in DB
          await prisma.deliveryPerson.update({
            where: { id: driver.id },
            data: { latitude: data.lat, longitude: data.lng },
          });

          // Broadcast location via DeliveryAssignmentService
          await DeliveryAssignmentService.broadcastDriverLocation(driver.id);
        } catch (err) {
          console.error("Error in updateLocation:", err);
        }
      }); 

      // ==========================
      // PLACEHOLDERS FOR FUTURE ORDER EVENTS
      // ==========================
      socket.on("orderAccepted", (data) => {});
      socket.on("orderPickedUp", (data) => {});
      socket.on("orderDelivered", (data) => {});

      // Handle disconnect
      socket.on("disconnect", (reason) => {
        console.log(`⚠️ User ${userId} disconnected: ${reason}`);
      });
    } catch (err) {
      console.log("❌ Socket rejected: Invalid token");
      socket.disconnect();
    }
  });

  console.log("🔥 Socket.IO initialized");
  return io;
}

/**
 * Get the current Socket.IO instance
 */
export function getIO(): SocketIOServer {
  if (!io) throw new Error(
    "Socket.IO not initialized! Call initSocket(server) first."
  );
  return io;
}

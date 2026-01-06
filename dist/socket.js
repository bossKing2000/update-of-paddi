"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSocket = initSocket;
exports.getIO = getIO;
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = __importDefault(require("./config/config"));
const client_1 = require("@prisma/client");
const deliveryAssignment_1 = require("./services/deliveryAssignment");
const prisma = new client_1.PrismaClient();
let io = null;
/**
 * Initialize Socket.IO
 */
function initSocket(server) {
    const allowedOrigins = [
        // "http://127.0.0.1:8080",
        // "http://localhost:8080",
        // "http://localhost:3000",
        // "http://127.0.0.1:60308",
        "https://ui-food-paddi.onrender.com",
    ];
    if (config_1.default.clientUrl)
        allowedOrigins.push(config_1.default.clientUrl);
    io = new socket_io_1.Server(server, {
        cors: {
            origin: allowedOrigins,
            credentials: true,
        },
    });
    io.on("connection", (socket) => {
        const token = socket.handshake.auth?.token;
        if (!token) {
            console.log("❌ Socket rejected: No token");
            return socket.disconnect();
        }
        try {
            const decoded = jsonwebtoken_1.default.verify(token, config_1.default.jwtSecret);
            const userId = decoded.userId || decoded.id;
            socket.data.userId = userId;
            console.log(`✅ Socket connected: user ${userId}`);
            // Join room for targeted notifications
            socket.join(userId);
            console.log("Rooms socket joined:", Array.from(socket.rooms));
            // ==========================
            // DRIVER LOCATION UPDATES
            // ==========================
            socket.on("updateLocation", async (data) => {
                try {
                    const driver = await prisma.deliveryPerson.findUnique({
                        where: { userId },
                    });
                    if (!driver)
                        return;
                    // Update driver's location in DB
                    await prisma.deliveryPerson.update({
                        where: { id: driver.id },
                        data: { latitude: data.lat, longitude: data.lng },
                    });
                    // Broadcast location via DeliveryAssignmentService
                    await deliveryAssignment_1.DeliveryAssignmentService.broadcastDriverLocation(driver.id);
                }
                catch (err) {
                    console.error("Error in updateLocation:", err);
                }
            });
            // ==========================
            // PLACEHOLDERS FOR FUTURE ORDER EVENTS
            // ==========================
            socket.on("orderAccepted", (data) => { });
            socket.on("orderPickedUp", (data) => { });
            socket.on("orderDelivered", (data) => { });
            // Handle disconnect
            socket.on("disconnect", (reason) => {
                console.log(`⚠️ User ${userId} disconnected: ${reason}`);
            });
        }
        catch (err) {
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
function getIO() {
    if (!io)
        throw new Error("Socket.IO not initialized! Call initSocket(server) first.");
    return io;
}

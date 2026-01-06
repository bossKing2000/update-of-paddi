"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendNotification = sendNotification;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const redis_1 = require("../../lib/redis");
const socket_1 = require("../../socket");
async function sendNotification({ userId, title, message, type, metadata = {}, }) {
    try {
        // ✅ 1. Create notification in DB
        const notif = await prismaClient_1.default.notification.create({
            data: {
                userId,
                title,
                message,
                type,
                metadata,
            },
        });
        // ✅ 2. Increment unread count in Redis
        const unreadKey = `notif:unread:${userId}`;
        const currentUnread = parseInt((await redis_1.redisNotifications.get(unreadKey)) || "0");
        const newUnread = currentUnread + 1;
        await redis_1.redisNotifications.set(unreadKey, newUnread);
        // ✅ 3. Invalidate any cached notification pages
        const keys = await redis_1.redisNotifications.keys(`notifications:${userId}:*`);
        if (keys.length > 0)
            await redis_1.redisNotifications.del(keys);
        // ✅ 4. Emit real-time socket updates (if user online)
        const io = (0, socket_1.getIO)();
        io.to(userId).emit("newNotification", notif);
        io.to(userId).emit("unreadCountUpdate", { unreadCount: newUnread });
        console.log(`[NOTIFY] ✅ Notification created + Redis updated for user ${userId}`);
        return notif;
    }
    catch (err) {
        console.error("[NOTIFY] ❌ Failed to send notification:", err);
        return null;
    }
}

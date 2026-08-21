"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendNotification = sendNotification;
exports.sendNotificationToMany = sendNotificationToMany;
exports.notifyRole = notifyRole;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const redis_1 = require("../../lib/redis");
const redisScan_1 = require("../../lib/redisScan");
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
        const keys = await (0, redisScan_1.scanKeys)(redis_1.redisNotifications, `notifications:${userId}:*`);
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
/**
 * Send the same notification to many users at once (e.g. all vendors
 * about a new promotion, or every affected user in a bulk operation).
 * Runs sends concurrently but caps concurrency so a large recipient list
 * doesn't hammer Redis/the DB with thousands of simultaneous writes.
 */
async function sendNotificationToMany(userIds, payload, concurrency = 25) {
    const results = [];
    for (let i = 0; i < userIds.length; i += concurrency) {
        const batch = userIds.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map((userId) => sendNotification({ ...payload, userId })));
        results.push(...batchResults);
    }
    return results;
}
/**
 * Broadcast a notification to every user with a given role (e.g. notify
 * all ADMINs that a payout failed, or all VENDORs about a platform-wide
 * announcement). Looks up recipients then delegates to sendNotificationToMany.
 */
async function notifyRole(role, payload) {
    const recipients = await prismaClient_1.default.user.findMany({
        where: { role },
        select: { id: true },
    });
    return sendNotificationToMany(recipients.map((r) => r.id), payload);
}

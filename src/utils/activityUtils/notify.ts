import prisma from "../../config/prismaClient";
import { redisNotifications } from "../../lib/redis";
import { getIO } from "../../socket";


interface NotifyOptions {
  userId: string;
  title: string;
  message: string;
  type: "ORDER" | "PAYMENT" | "REFUND" | "REVIEW" | "GENERAL" | "DELIVERY_REQUEST";
  metadata?: Record<string, any>;
}

export async function sendNotification({
  userId,
  title,
  message,
  type,
  metadata = {},
}: NotifyOptions) {
  try {
    // ✅ 1. Create notification in DB
    const notif = await prisma.notification.create({
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
    const currentUnread = parseInt((await redisNotifications.get(unreadKey)) || "0");
    const newUnread = currentUnread + 1;
    await redisNotifications.set(unreadKey, newUnread);

    // ✅ 3. Invalidate any cached notification pages
    const keys = await redisNotifications.keys(`notifications:${userId}:*`);
    if (keys.length > 0) await redisNotifications.del(keys);

    // ✅ 4. Emit real-time socket updates (if user online)
    const io = getIO();
    io.to(userId).emit("newNotification", notif);
    io.to(userId).emit("unreadCountUpdate", { unreadCount: newUnread });

    console.log(`[NOTIFY] ✅ Notification created + Redis updated for user ${userId}`);
    return notif;
  } catch (err) {
    console.error("[NOTIFY] ❌ Failed to send notification:", err);
    return null;
  }
}

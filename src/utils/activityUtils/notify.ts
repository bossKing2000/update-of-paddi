import prisma from "../../config/prismaClient";
import { redisNotifications } from "../../lib/redis";
import { scanKeys } from "../../lib/redisScan";
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
    const keys = await scanKeys(redisNotifications, `notifications:${userId}:*`);
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

/**
 * Send the same notification to many users at once (e.g. all vendors
 * about a new promotion, or every affected user in a bulk operation).
 * Runs sends concurrently but caps concurrency so a large recipient list
 * doesn't hammer Redis/the DB with thousands of simultaneous writes.
 */
export async function sendNotificationToMany(
  userIds: string[],
  payload: Omit<NotifyOptions, "userId">,
  concurrency = 25
) {
  const results: Array<Awaited<ReturnType<typeof sendNotification>>> = [];

  for (let i = 0; i < userIds.length; i += concurrency) {
    const batch = userIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((userId) => sendNotification({ ...payload, userId }))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Broadcast a notification to every user with a given role (e.g. notify
 * all ADMINs that a payout failed, or all VENDORs about a platform-wide
 * announcement). Looks up recipients then delegates to sendNotificationToMany.
 */
export async function notifyRole(
  role: "ADMIN" | "VENDOR" | "CUSTOMER" | "DELIVERY",
  payload: Omit<NotifyOptions, "userId">
) {
  const recipients = await prisma.user.findMany({
    where: { role },
    select: { id: true },
  });

  return sendNotificationToMany(
    recipients.map((r) => r.id),
    payload
  );
}

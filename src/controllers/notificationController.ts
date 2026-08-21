import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";
import { redisNotifications } from "../lib/redis";
import { scanKeys } from "../lib/redisScan";
import { ensureString } from "../utils/paramUtils";
import { sendSuccess } from "../utils/apiResponse";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from "../errors/AppError";

// GET /notifications
export const getMyNotifications = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const cacheKey = `notifications:${userId}:page:${page}:limit:${limit}`;
  const cached = await redisNotifications.get(cacheKey);
  if (cached) {
    return sendSuccess(
      res,
      JSON.parse(cached),
      "Notifications retrieved successfully (cache)",
    );
  }

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, read: false } }),
  ]);

  const result = {
    notifications,
    unreadCount,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };

  await redisNotifications.set(cacheKey, JSON.stringify(result), { EX: 60 });

  return sendSuccess(res, result, "Notifications retrieved successfully");
};

// PATCH /notifications/:notificationId/read
export const markNotificationAsRead = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user!.id;
  const notificationId = ensureString(req.params.notificationId);
  if (!notificationId) throw new ValidationError("notificationId is required");

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification) throw new NotFoundError("Notification");
  if (notification.userId !== userId)
    throw new ForbiddenError("This notification doesn't belong to you");

  if (!notification.read) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { read: true },
    });

    const unreadKey = `notif:unread:${userId}`;
    const current = parseInt((await redisNotifications.get(unreadKey)) || "0");
    await redisNotifications.set(unreadKey, Math.max(current - 1, 0));

    const keys = await scanKeys(
      redisNotifications,
      `notifications:${userId}:*`,
    );
    if (keys.length > 0) await redisNotifications.del(keys);
  }

  return sendSuccess(res, {}, "Notification marked as read");
};

// PATCH /notifications/read-all
export const markAllNotificationsAsRead = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user!.id;

  await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
  await redisNotifications.set(`notif:unread:${userId}`, 0);

  const keys = await scanKeys(redisNotifications, `notifications:${userId}:*`);
  if (keys.length > 0) await redisNotifications.del(keys);

  return sendSuccess(res, {}, "All notifications marked as read");
};

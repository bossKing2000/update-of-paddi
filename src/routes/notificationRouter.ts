import express from "express";
import { getMyNotifications, markNotificationAsRead, markAllNotificationsAsRead } from "../controllers/notificationController";
import { authenticate } from "../middlewares/auth.middleware";

const router = express.Router();

router.use(authenticate);

router.get("/", getMyNotifications);
router.patch("/:notificationId/read", markNotificationAsRead);
router.patch("/read-all", markAllNotificationsAsRead);

export default router;

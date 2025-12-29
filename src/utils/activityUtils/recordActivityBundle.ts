import { Request } from "express";
import prisma from "../../config/prismaClient";
import { ActivityType } from "@prisma/client";
import { emitSocketEvents } from "./socketEvents";
import { sendNotification } from "./notify";
import { createAuditLog } from "../auditLog.service";
import { getClientInfo } from "../ip";

/**
 * Represents a single activity (event) that should be recorded + notified.
 */
type ActivityAction = {
  type: ActivityType;
  title: string;
  message: string;
  targetId?: string; // customer/vendor/delivery receiving the notification
  socketEvent?: "GENERAL" | "ORDER" | "PAYMENT" | "REFUND" | "REVIEW" | "DELIVERY_REQUEST";
  metadata?: Record<string, any>;
  relation?: "customer" | "vendor" | "delivery"; // 👈 which relation to attach
};

/**
 * Optional audit entry that can be created along with the activity.
 */
type AuditData = {
  action: string;
  metadata?: Record<string, any>;
};

/**
 * The main activity bundle type used in controllers.
 */
type RecordActivityOptions = {
  req?: Request;
  actorId: string; // who performed the action (customer/vendor/system)
  orderId?: string;
  actions: ActivityAction[];
  audit?: AuditData;
  notifyRealtime?: boolean;
  notifyPush?: boolean;
};

/**
 * Records one or more related activities, sends notifications, and emits socket events.
 * Also supports creating an audit log entry.
 */
export async function recordActivityBundle({
  req,
  actorId,
  orderId,
  actions,
  audit,
  notifyRealtime = true,
  notifyPush = true,
}: RecordActivityOptions) {
  try {
    const promises: Promise<any>[] = [];

    for (const action of actions) {
      const { type, title, message, targetId, socketEvent, metadata = {}, relation } = action;

      // ✅ Determine relation to connect
      const relationData: Record<string, any> = {};
      if (relation === "customer") relationData.customerId = targetId;
      else if (relation === "vendor") relationData.vendorId = targetId;
      else if (relation === "delivery") relationData.deliveryId = targetId;

      // ✅ Create the activity record
      const activity = await prisma.activity.create({
        data: {
          orderId: orderId || null,
          type,
          title,
          message,
          meta: metadata,
          ...relationData,
        },
      });

      // ✅ Realtime socket notification
      if (notifyRealtime && socketEvent && targetId) {
        promises.push(
          emitSocketEvents({
            userId: targetId,
            type: socketEvent,
            data: activity,
          })
        );
      }

      // ✅ Push notification
      if (notifyPush && targetId) {
        promises.push(
          sendNotification({
            userId: targetId,
            title,
            message,
            type: socketEvent || "GENERAL",
            metadata: { orderId, ...metadata },
          })
        );
      }
    }

    // ✅ Optional audit log
    if (audit?.action) {
      const ipAddress = req ? getClientInfo(req) : "system";
      const userAgent = req?.headers["user-agent"] || "system";

      promises.push(
        createAuditLog({
          userId: actorId,
          action: audit.action,
          req,
          metadata: {
            orderId,
            ipAddress,
            userAgent,
            ...(audit.metadata || {}),
          },
        })
      );
    }

    await Promise.all(promises);
    console.log("[ACTIVITY] ✅ Recorded multi-action bundle successfully");
  } catch (err) {
    console.error("[ACTIVITY] ❌ Failed to record activity bundle:", err);
  }
}

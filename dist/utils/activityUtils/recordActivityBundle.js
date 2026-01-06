"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordActivityBundle = recordActivityBundle;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const socketEvents_1 = require("./socketEvents");
const notify_1 = require("./notify");
const auditLog_service_1 = require("../auditLog.service");
const ip_1 = require("../ip");
/**
 * Records one or more related activities, sends notifications, and emits socket events.
 * Also supports creating an audit log entry.
 */
async function recordActivityBundle({ req, actorId, orderId, actions, audit, notifyRealtime = true, notifyPush = true, }) {
    try {
        const promises = [];
        for (const action of actions) {
            const { type, title, message, targetId, socketEvent, metadata = {}, relation } = action;
            // ✅ Determine relation to connect
            const relationData = {};
            if (relation === "customer")
                relationData.customerId = targetId;
            else if (relation === "vendor")
                relationData.vendorId = targetId;
            else if (relation === "delivery")
                relationData.deliveryId = targetId;
            // ✅ Create the activity record
            const activity = await prismaClient_1.default.activity.create({
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
                promises.push((0, socketEvents_1.emitSocketEvents)({
                    userId: targetId,
                    type: socketEvent,
                    data: activity,
                }));
            }
            // ✅ Push notification
            if (notifyPush && targetId) {
                promises.push((0, notify_1.sendNotification)({
                    userId: targetId,
                    title,
                    message,
                    type: socketEvent || "GENERAL",
                    metadata: { orderId, ...metadata },
                }));
            }
        }
        // ✅ Optional audit log
        if (audit?.action) {
            const ipAddress = req ? (0, ip_1.getClientInfo)(req) : "system";
            const userAgent = req?.headers["user-agent"] || "system";
            promises.push((0, auditLog_service_1.createAuditLog)({
                userId: actorId,
                action: audit.action,
                req,
                metadata: {
                    orderId,
                    ipAddress,
                    userAgent,
                    ...(audit.metadata || {}),
                },
            }));
        }
        await Promise.all(promises);
        console.log("[ACTIVITY] ✅ Recorded multi-action bundle successfully");
    }
    catch (err) {
        console.error("[ACTIVITY] ❌ Failed to record activity bundle:", err);
    }
}

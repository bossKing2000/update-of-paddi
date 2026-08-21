"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const orderCleanupJob_1 = require("../workers jobs/orderCleanupJob");
const verifyPendingPayments_1 = require("../payment/worker/verifyPendingPayments");
const fixLiveStatusJob_1 = require("../workers jobs/fixLiveStatusJob");
const deliveryAssignment_1 = require("../../services/deliveryAssignment");
const logger_1 = require("../../lib/logger");
/**
 * 🧹 Order Cleanup Job
 * Runs every 3 minutes to cancel stale or unpaid orders.
 */
node_cron_1.default.schedule("*/3 * * * *", async () => {
    try {
        await (0, orderCleanupJob_1.runOrderCleanupJob)();
    }
    catch (err) {
        logger_1.logger.error({ err }, "[CRON] Order cleanup job failed");
    }
});
/**
 * 💳 Verify Pending Payments Job
 * Runs every 1 minute to auto-verify stuck or delayed transactions.
 */
node_cron_1.default.schedule("*/1 * * * *", async () => {
    try {
        await (0, verifyPendingPayments_1.verifyPendingPayments)();
    }
    catch (err) {
        logger_1.logger.error({ err }, "[CRON] Verify pending payments failed");
    }
});
/**
 * 🟢 Fix Live Status Job
 * Runs every 5 minutes to ensure product `isLive` status matches schedule.
 */
node_cron_1.default.schedule("*/5 * * * *", () => {
    (0, fixLiveStatusJob_1.fixLiveStatusJob)(false)
        .then((result) => logger_1.logger.info({ updatedCount: result.updatedCount }, "[CRON] Product status fix completed"))
        .catch((err) => logger_1.logger.error({ err }, "[CRON] Product status fix failed"));
});
/**
 * 🚚 Expire Stale Delivery Broadcasts
 * Runs every 1 minute — catches broadcasts whose 30-second acceptance
 * window passed with no driver responding, and retries assignment.
 * Previously this logic existed but was never scheduled anywhere, so an
 * order broadcast to drivers who never responded (neither accepted nor
 * declined) would sit unassigned forever.
 */
node_cron_1.default.schedule("*/1 * * * *", async () => {
    try {
        await deliveryAssignment_1.DeliveryAssignmentService.expireOldBroadcasts();
    }
    catch (err) {
        logger_1.logger.error({ err }, "[CRON] Expire delivery broadcasts job failed");
    }
});

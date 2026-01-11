"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const orderCleanupJob_1 = require("../workers jobs/orderCleanupJob");
const verifyPendingPayments_1 = require("../payment/worker/verifyPendingPayments");
const fixLiveStatusJob_1 = require("../workers jobs/fixLiveStatusJob");
/**
 * 🧹 Order Cleanup Job
 * Runs every 5 minutes to cancel stale or unpaid orders.
 */
node_cron_1.default.schedule("*/3 * * * * ", async () => {
    try {
        await (0, orderCleanupJob_1.runOrderCleanupJob)();
    }
    catch (err) {
        console.error("[CRON] Order cleanup job failed:", err);
    }
});
/**
 * 💳 Verify Pending Payments Job
 * Runs every 1 minute to auto-verify stuck or delayed transactions.s
 */
node_cron_1.default.schedule("*/1 * * * * ", async () => {
    try {
        await (0, verifyPendingPayments_1.verifyPendingPayments)();
    }
    catch (err) {
        console.error("[CRON] Verify pending payments failed:", err);
    }
});
/**
 * 🟢 Fix Live Status Job
 * Runs every 1 minute to ensure product `isLive` status matches schedule.
 */
// In your cron setup
node_cron_1.default.schedule('*/5 * * * * ', () => {
    console.log('⏰ Running scheduled product status fix...');
    (0, fixLiveStatusJob_1.fixLiveStatusJob)(false)
        .then(result => {
        console.log(`✅ Scheduled check: Updated ${result.updatedCount} products`);
    })
        .catch(err => {
        console.error('⚠️ Scheduled check failed:', err.message);
    });
});
// console.log("[CRON] 🕒 Order cleanup and payment verification jobs scheduled.");

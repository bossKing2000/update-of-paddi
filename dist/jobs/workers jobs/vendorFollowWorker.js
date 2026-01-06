"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.vendorFollowWorker = exports.vendorFollowQueue = void 0;
const bullmq_1 = require("bullmq");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const bullmqConnection_1 = require("../../lib/bullmqConnection");
const recordActivityBundle_1 = require("../../utils/activityUtils/recordActivityBundle");
// Queue initialization (so you can enqueue from anywhere)
exports.vendorFollowQueue = new bullmq_1.Queue("vendorFollowNotifications", {
    connection: bullmqConnection_1.bullmqConnection,
});
// Worker — processes each follow notification job
exports.vendorFollowWorker = new bullmq_1.Worker("vendorFollowNotifications", async (job) => {
    if (!job?.data)
        return;
    const { vendorId, customerId } = job.data;
    // Fetch customer info
    const customer = await prismaClient_1.default.user.findUnique({
        where: { id: customerId },
        select: { id: true, name: true },
    });
    if (!customer) {
        console.warn(`[vendorFollowWorker] Customer not found: ${customerId}`);
        return;
    }
    // Send real-time + push notification to vendor
    await (0, recordActivityBundle_1.recordActivityBundle)({
        actorId: customerId,
        actions: [
            {
                type: "GENERAL",
                title: "New Follower 👤",
                message: `${customer.name} started following you.`,
                targetId: vendorId,
                socketEvent: "GENERAL",
                relation: "vendor",
            },
        ],
        notifyPush: true,
        notifyRealtime: true,
    });
    console.log(`[vendorFollowWorker] ✅ Notified vendor ${vendorId} of new follower ${customerId}`);
}, { connection: bullmqConnection_1.bullmqConnection });
// Graceful error handling
exports.vendorFollowWorker.on("failed", (job, err) => {
    if (!job) {
        console.error("[vendorFollowWorker] ❌ Job failed, job object is undefined:", err);
        return;
    }
    console.error(`[vendorFollowWorker] ❌ Job ${job.id} failed:`, err);
});

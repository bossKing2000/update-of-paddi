"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.vendorFollowWorker = exports.vendorFollowQueue = void 0;
const bullmq_1 = require("bullmq");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const bullmqConnection_1 = require("../../lib/bullmqConnection");
exports.vendorFollowQueue = new bullmq_1.Queue("vendorFollowNotifications", { connection: bullmqConnection_1.bullmqConnection });
exports.vendorFollowWorker = new bullmq_1.Worker("vendorFollowNotifications", async (job) => {
    const { vendorId, customerId } = job.data;
    const customer = await prismaClient_1.default.user.findUnique({ where: { id: customerId }, select: { id: true, name: true } });
    if (!customer)
        return;
    await recordActivityBundle({
        actorId: customerId,
        actions: [
            {
                type: "GENERAL",
                title: "New follower",
                message: `${customer.name} started following you.`,
                targetId: vendorId,
                socketEvent: "GENERAL",
            },
        ],
        notifyPush: true,
        notifyRealtime: true,
    });
    console.log(`[vendorFollowWorker] Notified vendor ${vendorId} of new follower ${customerId}`);
}, { connection: bullmqConnection_1.bullmqConnection });
function recordActivityBundle(arg0) {
    throw new Error("Function not implemented.");
}

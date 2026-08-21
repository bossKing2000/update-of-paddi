"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.vendorFollowWorker = exports.vendorFollowQueue = void 0;
const bullmq_1 = require("bullmq");
const prisma_1 = __importDefault(require("../../lib/prisma"));
const bullmqConnection_1 = require("../../lib/bullmqConnection");
const recordActivityBundle_1 = require("../../utils/activityUtils/recordActivityBundle");
const logger_1 = require("../../lib/logger");
const client_1 = require("@prisma/client");
// The ONE canonical queue/worker pair for vendor-follow notifications.
//
// Previously there were THREE separate places defining a Queue and/or
// Worker for this same underlying BullMQ queue name
// ("vendorFollowNotifications"):
//   - this file (correct — imports the real recordActivityBundle)
//   - utils/activityUtils/vendorFollowNotifications.ts (imported by the
//     controller for its Queue, but its own Worker redefined
//     recordActivityBundle as a local stub that always threw
//     "Function not implemented" — and since server.ts also imported
//     *this* file directly, both Workers were simultaneously live,
//     competing for jobs on the same queue. Roughly half of all
//     "new follower" notifications were silently swallowed by the
//     broken worker, the other half succeeded via this one — an
//     intermittent, maddening-to-diagnose bug with no visible error
//     anywhere in the request path.)
//   - jobs/queues/productLiveQueues.ts (a third, entirely unused Queue
//     definition — dead code, zero importers)
// All consolidated into this single file. The controller now imports
// vendorFollowQueue from here.
exports.vendorFollowQueue = new bullmq_1.Queue("vendorFollowNotifications", { connection: bullmqConnection_1.bullmqConnection });
exports.vendorFollowWorker = new bullmq_1.Worker("vendorFollowNotifications", async (job) => {
    if (!job?.data)
        return;
    const { vendorId, customerId } = job.data;
    const customer = await prisma_1.default.user.findUnique({ where: { id: customerId }, select: { id: true, name: true } });
    if (!customer) {
        logger_1.logger.warn({ customerId, jobId: job.id }, "[vendorFollowWorker] Customer not found");
        return;
    }
    await (0, recordActivityBundle_1.recordActivityBundle)({
        actorId: customerId,
        actions: [
            {
                type: client_1.ActivityType.GENERAL,
                title: "New Follower",
                message: `${customer.name} started following you.`,
                targetId: vendorId,
                socketEvent: "GENERAL",
                relation: "vendor",
                metadata: { customerId, vendorId },
            },
        ],
        notifyPush: true,
        notifyRealtime: true,
    });
    logger_1.logger.info({ vendorId, customerId, jobId: job.id }, "[vendorFollowWorker] Notified vendor of new follower");
}, { connection: bullmqConnection_1.bullmqConnection });
exports.vendorFollowWorker.on("failed", (job, err) => {
    logger_1.logger.error({ err, jobId: job?.id }, "[vendorFollowWorker] Job failed");
});

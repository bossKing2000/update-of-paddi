import { Queue, Worker, Job } from "bullmq";
import prisma from "../../lib/prisma";
import { bullmqConnection } from "../../lib/bullmqConnection";
import { recordActivityBundle } from "../../utils/activityUtils/recordActivityBundle";
import { logger } from "../../lib/logger";
import { ActivityType } from "@prisma/client";

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
export const vendorFollowQueue = new Queue("vendorFollowNotifications", { connection: bullmqConnection });

export const vendorFollowWorker = new Worker(
  "vendorFollowNotifications",
  async (job: Job) => {
    if (!job?.data) return;

    const { vendorId, customerId } = job.data as { vendorId: string; customerId: string };

    const customer = await prisma.user.findUnique({ where: { id: customerId }, select: { id: true, name: true } });
    if (!customer) {
      logger.warn({ customerId, jobId: job.id }, "[vendorFollowWorker] Customer not found");
      return;
    }

    await recordActivityBundle({
      actorId: customerId,
      actions: [
        {
          type: ActivityType.GENERAL,
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

    logger.info({ vendorId, customerId, jobId: job.id }, "[vendorFollowWorker] Notified vendor of new follower");
  },
  { connection: bullmqConnection }
);

vendorFollowWorker.on("failed", (job, err) => {
  logger.error({ err, jobId: job?.id }, "[vendorFollowWorker] Job failed");
});

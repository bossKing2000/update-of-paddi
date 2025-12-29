import { Queue, Worker, Job } from "bullmq";
import prisma from "../../config/prismaClient";
import { bullmqConnection } from "../../lib/bullmqConnection";
import { recordActivityBundle } from "../../utils/activityUtils/recordActivityBundle";

// Queue initialization (so you can enqueue from anywhere)
export const vendorFollowQueue = new Queue("vendorFollowNotifications", {
  connection: bullmqConnection,
});

// Worker — processes each follow notification job
export const vendorFollowWorker = new Worker(
  "vendorFollowNotifications",
  async (job: Job) => {
    if (!job?.data) return;

    const { vendorId, customerId } = job.data as {
      vendorId: string;
      customerId: string;
    };

    // Fetch customer info
    const customer = await prisma.user.findUnique({
      where: { id: customerId },
      select: { id: true, name: true },
    });

    if (!customer) {
      console.warn(`[vendorFollowWorker] Customer not found: ${customerId}`);
      return;
    }

    // Send real-time + push notification to vendor
    await recordActivityBundle({
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

    console.log(
      `[vendorFollowWorker] ✅ Notified vendor ${vendorId} of new follower ${customerId}`
    );
  },
  { connection: bullmqConnection }
);

// Graceful error handling
vendorFollowWorker.on("failed", (job, err) => {
  if (!job) {
    console.error("[vendorFollowWorker] ❌ Job failed, job object is undefined:", err);
    return;
  }

  console.error(`[vendorFollowWorker] ❌ Job ${job.id} failed:`, err);
});


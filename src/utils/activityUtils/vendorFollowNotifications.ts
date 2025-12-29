import { Queue, Worker, Job } from "bullmq";
import prisma from "../../config/prismaClient";
import { bullmqConnection } from "../../lib/bullmqConnection";


export const vendorFollowQueue = new Queue("vendorFollowNotifications", { connection: bullmqConnection });

export const vendorFollowWorker = new Worker(
  "vendorFollowNotifications",
  async (job: Job) => {
    const { vendorId, customerId } = job.data as { vendorId: string; customerId: string };

    const customer = await prisma.user.findUnique({ where: { id: customerId }, select: { id: true, name: true }});
    if (!customer) return;

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
  },
  { connection: bullmqConnection }
);
function recordActivityBundle(arg0: { actorId: string; actions: { type: string; title: string; message: string; targetId: string; socketEvent: string; }[]; notifyPush: boolean; notifyRealtime: boolean; }) {
    throw new Error("Function not implemented.");
}


import { Queue } from "bullmq";
import { bullmqConnection } from "../../lib/bullmqConnection";

export const productLiveQueue = new Queue("productLiveQueue", { connection: bullmqConnection });
export const productDeactivateQueue = new Queue("productDeactivateQueue", { connection: bullmqConnection });
export const vendorFollowQueue = new Queue("vendorFollowNotifications", { connection: bullmqConnection });

import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';

// Ensure REDIS_URL exists
if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is not defined in your environment variables');
}

const redis = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null, // 🔹 required by BullMQ
});

export const productIndexQueue = new Queue('productIndex', { connection: redis });



import IORedis from "ioredis";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is required for BullMQ");
}

export const bullmqConnection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

bullmqConnection.on("connect", () => console.log("🔗 BullMQ Redis connecting..."));
bullmqConnection.on("ready", () => console.log("✅ BullMQ Redis ready"));
bullmqConnection.on("error", (err) => console.error("❌ BullMQ Redis error:", err));

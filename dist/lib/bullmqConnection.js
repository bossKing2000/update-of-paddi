"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bullmqConnection = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is required for BullMQ");
}
exports.bullmqConnection = new ioredis_1.default(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
});
exports.bullmqConnection.on("connect", () => console.log("🔗 BullMQ Redis connecting..."));
exports.bullmqConnection.on("ready", () => console.log("✅ BullMQ Redis ready"));
exports.bullmqConnection.on("error", (err) => console.error("❌ BullMQ Redis error:", err));

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.productIndexQueue = void 0;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
// Ensure REDIS_URL exists
if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is not defined in your environment variables');
}
const redis = new ioredis_1.default(process.env.REDIS_URL, {
    maxRetriesPerRequest: null, // 🔹 required by BullMQ
});
exports.productIndexQueue = new bullmq_1.Queue('productIndex', { connection: redis });

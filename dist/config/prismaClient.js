"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// This used to instantiate its own `new PrismaClient()`, completely
// separate from the singleton in `src/lib/prisma.ts`. That meant two
// independent connection pools competing for the same DATABASE_URL
// connection limit — a classic source of "too many connections" errors
// under load, especially on connection-capped hosted Postgres.
//
// Re-exporting the real singleton here instead means every one of the
// ~15 files that import from this path (activity/notification system,
// background jobs, AI services, etc.) now transparently shares the same
// pool, with zero changes required in those files.
const prisma_1 = __importDefault(require("../lib/prisma"));
exports.default = prisma_1.default;

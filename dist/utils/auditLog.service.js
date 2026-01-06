"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuditLog = createAuditLog;
const prisma_1 = __importDefault(require("../lib/prisma"));
async function createAuditLog({ userId, action, req, metadata = {} }) {
    const ip = req?.ip || 'system';
    const userAgent = req?.headers?.['user-agent'] || 'system';
    const path = req?.originalUrl || 'background-task';
    return prisma_1.default.auditLog.create({
        data: {
            userId: userId || null,
            action,
            ipAddress: ip,
            userAgent,
            path,
            metadata,
        },
    });
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuditEntry = createAuditEntry;
const ip_1 = require("../ip");
const auditLog_service_1 = require("../auditLog.service");
async function createAuditEntry({ req, userId, action, metadata = {}, }) {
    try {
        await (0, auditLog_service_1.createAuditLog)({
            userId,
            action,
            req,
            metadata: {
                ipAddress: (0, ip_1.getClientInfo)(req),
                userAgent: req.headers["user-agent"] || "unknown",
                ...metadata,
            },
        });
        console.log(`[AUDIT] ✅ Logged action: ${action}`);
    }
    catch (err) {
        console.error("[AUDIT] ❌ Failed to log audit:", err);
    }
}

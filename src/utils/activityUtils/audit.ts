import { Request } from "express";
import { getClientInfo } from "../ip";
import { createAuditLog } from "../auditLog.service";
import { logger } from "../../lib/logger";

interface AuditOptions {
  req: Request;
  userId: string;
  action: string;
  metadata?: Record<string, any>;
}

export async function createAuditEntry({
  req,
  userId,
  action,
  metadata = {},
}: AuditOptions) {
  try {
    await createAuditLog({
      userId,
      action,
      req,
      metadata: {
        ipAddress: getClientInfo(req),
        userAgent: req.headers["user-agent"] || "unknown",
        ...metadata,
      },
    });
    console.log(`[AUDIT] ✅ Logged action: ${action}`);
  } catch (err) {
    logger.error({ err, action }, "Failed to log audit entry");
  }
}

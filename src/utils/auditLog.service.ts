import { Request } from 'express';
import prisma from '../lib/prisma';

interface AuditLogInput {
  userId: string | null;
  action: string;
  req?: Request | { ip?: string; headers?: Record<string, string>; originalUrl?: string };
  metadata?: Record<string, any>;
}

export async function createAuditLog({ userId, action, req, metadata = {} }: AuditLogInput) {
  const ip = req?.ip || 'system';
  const userAgent = req?.headers?.['user-agent'] || 'system';
  const path = (req as any)?.originalUrl || 'background-task';

  return prisma.auditLog.create({
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

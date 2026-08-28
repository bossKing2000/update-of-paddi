// lib/session.ts
import { redisUsersSessions } from "./redis";
import prisma from "./prisma";
import { logger } from "./logger";

const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 days — matches refresh token lifetime

export interface SessionMetadata {
  ip?: string;
  userAgent?: string;
  deviceId?: string | null;
  geoCity?: string;
  geoRegion?: string;
  geoCountry?: string;
  lastLoginAt?: string | Date;
  [key: string]: unknown;
}

/**
 * Sessions are now keyed by userId + sessionId, not userId alone.
 *
 * Previously every session lived at a single key — `session:user:${userId}`
 * — with no per-device distinction at all. That meant a user could only
 * ever have ONE active session across their entire account: logging in
 * on a second device silently overwrote (and logged out) the first, with
 * no error and nothing to indicate why. There was also no way to revoke
 * one specific device's session while leaving others active.
 *
 * Each login now gets its own randomly-generated sessionId, embedded in
 * the signed JWT (not guessable from anything client-visible) and used
 * as the Redis key suffix. An index set tracks every active sessionId
 * for a user, so "list my devices" / "log out everywhere" can actually
 * be implemented.
 */

const sessionKey = (userId: string, sessionId: string) => `session:user:${userId}:${sessionId}`;
const indexKey = (userId: string) => `session:user:${userId}:index`;

export async function createUserSession(userId: string, sessionId: string, metadata: SessionMetadata) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const redisPayload = JSON.stringify(metadata);
  // DB is source of truth — Redis is cache
  // First, create the session in PostgreSQL (source of truth)
  await prisma.userSession.upsert({
    where: { sessionId },
    update: {
      ip: (metadata.ip as string) ?? null,
      userAgent: (metadata.userAgent as string) ?? null,
      deviceId: (metadata.deviceId as string) ?? null,
      geoCity: (metadata.geoCity as string) ?? null,
      geoRegion: (metadata.geoRegion as string) ?? null,
      geoCountry: (metadata.geoCountry as string) ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    },
    create: {
      userId,
      sessionId,
      ip: (metadata.ip as string) ?? null,
      userAgent: (metadata.userAgent as string) ?? null,
      deviceId: (metadata.deviceId as string) ?? null,
      geoCity: (metadata.geoCity as string) ?? null,
      geoRegion: (metadata.geoRegion as string) ?? null,
      geoCountry: (metadata.geoCountry as string) ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    },
  });
  // Attempt to populate Redis cache — failure should not block authentication
  try {
    const redisPayload = JSON.stringify({
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      deviceId: metadata.deviceId,
      geoCity: metadata.geoCity,
      geoRegion: metadata.geoRegion,
      geoCountry: metadata.geoCountry,
      lastLoginAt: metadata.lastLoginAt,
    });
    await redisUsersSessions.set(sessionKey(userId, sessionId), redisPayload, { EX: SESSION_TTL_SECONDS });
    await redisUsersSessions.sAdd(indexKey(userId), sessionId);
    await redisUsersSessions.expire(indexKey(userId), SESSION_TTL_SECONDS);
  } catch (e) {
    logger.warn({ err: e, userId, sessionId }, "Redis cache population failed during session creation (non-critical)");
  }
}

export async function getUserSession(userId: string, sessionId: string): Promise<SessionMetadata | null> {
  // Try cache first
  try {
    const data = await redisUsersSessions.get(sessionKey(userId, sessionId));
    if (data) return JSON.parse(data) as SessionMetadata;
  } catch (e) {
    logger.warn({ err: e }, "Redis getUserSession failed, falling back to DB");
  }
  // Fallback to DB — repopulate cache if found and not expired
  try {
    const dbSession = await prisma.userSession.findUnique({ where: { sessionId } });
    if (!dbSession) return null;
    if (dbSession.userId !== userId) return null;
    if (dbSession.expiresAt.getTime() < Date.now()) {
      // Expired — clean up
      await prisma.userSession.delete({ where: { sessionId } }).catch(() => {});
      return null;
    }
    const metadata: SessionMetadata = {
      ip: dbSession.ip ?? undefined,
      userAgent: dbSession.userAgent ?? undefined,
      deviceId: dbSession.deviceId ?? undefined,
      geoCity: dbSession.geoCity ?? undefined,
      geoRegion: dbSession.geoRegion ?? undefined,
      geoCountry: dbSession.geoCountry ?? undefined,
      lastLoginAt: dbSession.createdAt,
    };
    // Warm cache
    await redisUsersSessions
      .set(sessionKey(userId, sessionId), JSON.stringify(metadata), { EX: SESSION_TTL_SECONDS })
      .catch(() => {});
    await redisUsersSessions.sAdd(indexKey(userId), sessionId).catch(() => {});
    return metadata;
  } catch (e) {
    logger.warn({ err: e, userId, sessionId }, "DB getUserSession failed");
    return null;
  }
}

/** Revokes one specific session (e.g. logging out from just this device). */
export async function deleteUserSession(userId: string, sessionId: string) {
  await Promise.all([
    redisUsersSessions.del(sessionKey(userId, sessionId)).catch(() => {}),
    redisUsersSessions.sRem(indexKey(userId), sessionId).catch(() => {}),
    prisma.userSession.delete({ where: { sessionId } }).catch(() => {}),
  ]);
}

/** Revokes every active session for a user (log out everywhere / admin block / password reset). */
export async function deleteAllUserSessions(userId: string) {
  const sessionIds = await redisUsersSessions.sMembers(indexKey(userId)).catch(() => [] as string[]);
  if (sessionIds.length > 0) {
    await Promise.all(sessionIds.map((id) => redisUsersSessions.del(sessionKey(userId, id)).catch(() => {})));
  }
  await redisUsersSessions.del(indexKey(userId)).catch(() => {});
  // DB is authoritative — ensure all DB sessions are removed even if Redis was flushed
  await prisma.userSession.deleteMany({ where: { userId } }).catch((e) => {
    logger.warn({ err: e, userId }, "Failed to deleteAll DB sessions");
  });
}

/** Lists every active session for a user, with metadata — for a "your devices" screen. Expired sessions (TTL lapsed) are pruned from the index as they're found. */
export async function listUserSessions(userId: string): Promise<Array<SessionMetadata & { sessionId: string }>> {
  try {
    const sessionIds = await redisUsersSessions.sMembers(indexKey(userId));
    if (sessionIds.length > 0) {
      const results = await Promise.all(
        sessionIds.map(async (sessionId) => {
          const data = await redisUsersSessions.get(sessionKey(userId, sessionId));
          if (!data) {
            await redisUsersSessions.sRem(indexKey(userId), sessionId).catch(() => {});
            return null;
          }
          return { sessionId, ...JSON.parse(data) };
        })
      );
      const filtered = results.filter((s): s is SessionMetadata & { sessionId: string } => s !== null);
      if (filtered.length > 0) return filtered;
      // Fall through to DB fallback if Redis index was stale/empty after pruning
    }
  } catch (e) {
    logger.warn({ err: e, userId }, "Redis listUserSessions failed, falling back to DB");
  }
  // Fallback to DB — repopulate cache
  try {
    const dbSessions = await prisma.userSession.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    // Warm cache for future calls
    for (const s of dbSessions) {
      const meta: SessionMetadata = {
        ip: s.ip ?? undefined,
        userAgent: s.userAgent ?? undefined,
        deviceId: s.deviceId ?? undefined,
        geoCity: s.geoCity ?? undefined,
        geoRegion: s.geoRegion ?? undefined,
        geoCountry: s.geoCountry ?? undefined,
        lastLoginAt: s.createdAt,
      };
      await redisUsersSessions
        .set(sessionKey(userId, s.sessionId), JSON.stringify(meta), { EX: SESSION_TTL_SECONDS })
        .catch(() => {});
      await redisUsersSessions.sAdd(indexKey(userId), s.sessionId).catch(() => {});
    }
    return dbSessions.map((s) => ({
      sessionId: s.sessionId,
      ip: s.ip ?? undefined,
      userAgent: s.userAgent ?? undefined,
      deviceId: s.deviceId ?? undefined,
      geoCity: s.geoCity ?? undefined,
      geoRegion: s.geoRegion ?? undefined,
      geoCountry: s.geoCountry ?? undefined,
      lastLoginAt: s.createdAt,
    }));
  } catch (e) {
    logger.warn({ err: e, userId }, "DB listUserSessions failed");
    return [];
  }
}

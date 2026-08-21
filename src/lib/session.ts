// lib/session.ts
import { redisUsersSessions } from "./redis";

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
  await Promise.all([
    redisUsersSessions.set(sessionKey(userId, sessionId), JSON.stringify(metadata), { EX: SESSION_TTL_SECONDS }),
    redisUsersSessions.sAdd(indexKey(userId), sessionId),
  ]);
  await redisUsersSessions.expire(indexKey(userId), SESSION_TTL_SECONDS);
}

export async function getUserSession(userId: string, sessionId: string): Promise<SessionMetadata | null> {
  const data = await redisUsersSessions.get(sessionKey(userId, sessionId));
  return data ? JSON.parse(data) : null;
}

/** Revokes one specific session (e.g. logging out from just this device). */
export async function deleteUserSession(userId: string, sessionId: string) {
  await Promise.all([redisUsersSessions.del(sessionKey(userId, sessionId)), redisUsersSessions.sRem(indexKey(userId), sessionId)]);
}

/** Revokes every active session for a user (log out everywhere / admin block / password reset). */
export async function deleteAllUserSessions(userId: string) {
  const sessionIds = await redisUsersSessions.sMembers(indexKey(userId));
  if (sessionIds.length > 0) {
    await Promise.all(sessionIds.map((id) => redisUsersSessions.del(sessionKey(userId, id))));
  }
  await redisUsersSessions.del(indexKey(userId));
}

/** Lists every active session for a user, with metadata — for a "your devices" screen. Expired sessions (TTL lapsed) are pruned from the index as they're found. */
export async function listUserSessions(userId: string): Promise<Array<SessionMetadata & { sessionId: string }>> {
  const sessionIds = await redisUsersSessions.sMembers(indexKey(userId));
  if (sessionIds.length === 0) return [];

  const results = await Promise.all(
    sessionIds.map(async (sessionId) => {
      const data = await redisUsersSessions.get(sessionKey(userId, sessionId));
      if (!data) {
        // TTL already expired this session's key but the index still
        // references it — clean up lazily rather than leaving it forever.
        await redisUsersSessions.sRem(indexKey(userId), sessionId).catch(() => {});
        return null;
      }
      return { sessionId, ...JSON.parse(data) };
    })
  );

  return results.filter((s): s is SessionMetadata & { sessionId: string } => s !== null);
}

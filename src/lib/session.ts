// lib/session.ts
import { redisUsersSessions } from "./redis";
import prisma from "./prisma";
import { Role } from "@prisma/client";
import { logger } from "./logger";

const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days — longer than refresh token (7d) to allow grace period for session restoration

export interface SessionMetadata {
  /**
   * Phase 1E — the role THIS session is acting as.
   *
   * Distinct from the account-wide `User.role`: switching a role changes the
   * calling session only, so a customer session and a vendor session can be
   * live on two devices at once. `null`/`undefined` means a session created
   * before this column existed, and is resolved against the account role by
   * the caller — see `resolveSessionRole`.
   */
  activeRole?: string | null;
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
 * The authoritative active role for a session.
 *
 * A session that carries its own role wins; a legacy session (null, or a
 * Redis cache entry written before the column existed) falls back to the
 * account role, which is exactly the behaviour such a session was created
 * with. Returning null is meaningful: the account has not chosen a role yet.
 */
export function resolveSessionRole(
  session: Pick<SessionMetadata, "activeRole"> | null | undefined,
  accountRole: string | null | undefined,
): string | null {
  const sessionRole = session?.activeRole;
  if (typeof sessionRole === "string" && sessionRole.length > 0) return sessionRole;
  return accountRole ?? null;
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

const REFRESH_JTI_TTL_SECONDS = 7 * 24 * 3600; // 7 days — matches refresh token expiry
const REFRESH_GRACE_SECONDS = 10; // grace window for concurrent refresh requests
const refreshJtiKey = (userId: string, sessionId: string) => `refresh:jti:${userId}:${sessionId}`;
const refreshPrevJtiKey = (userId: string, sessionId: string) => `refresh:jti:prev:${userId}:${sessionId}`;

export async function createUserSession(userId: string, sessionId: string, metadata: SessionMetadata) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const redisPayload = JSON.stringify(metadata);
  // DB is source of truth — Redis is cache
  // First, create the session in PostgreSQL (source of truth)
  await prisma.userSession.upsert({
    where: { sessionId },
    update: {
      // Only overwritten when the caller states one. A refresh passes the
      // existing session back through here and must not silently reset the
      // role this session selected.
      ...(metadata.activeRole !== undefined
        ? { activeRole: (metadata.activeRole as Role | null) ?? null }
        : {}),
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
      // Prisma narrows this to the Role enum; callers validate the role against
      // the account's held roles before calling here.
      activeRole: (metadata.activeRole as Role | null) ?? null,
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
    // A caller that states no role (the refresh TTL slide) must not null out
    // the cached role: the database row is authoritative, so re-read it for
    // the cache payload. Writing `?? null` here stranded switched sessions —
    // the next request compared the fresh token against the account default
    // and failed with 401 on a legitimate session.
    let cacheRole: string | null;
    if (metadata.activeRole !== undefined) {
      cacheRole = (metadata.activeRole as Role | null) ?? null;
    } else {
      try {
        const row = await prisma.userSession.findUnique({
          where: { sessionId },
          select: { activeRole: true },
        });
        cacheRole = (row?.activeRole as Role | null) ?? null;
      } catch (e) {
        // The database is unreachable right after a successful upsert: evict
        // rather than write a payload we cannot prove correct. The next read
        // falls back to the database instead of trusting a guess.
        logger.warn({ err: e, userId, sessionId }, "createUserSession role re-read failed; evicting");
        await redisUsersSessions.del(sessionKey(userId, sessionId)).catch(() => {});
        return;
      }
    }
    const redisPayload = JSON.stringify({
      activeRole: cacheRole,
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

/**
 * Explicit session-lookup outcome (Phase 1E.5B).
 *
 * - `found`: a live session row belonging to the expected user, passing the
 *   same ownership/expiration rules as before.
 * - `missing`: conclusively no usable session (absent row, wrong owner, or
 *   expired and cleaned up). Safe to treat as revoked.
 * - `error`: a required store read failed, so validity is UNKNOWN. This must
 *   never be mistaken for `missing`: callers deny with a retryable failure
 *   instead of revoking or minting.
 *
 * Always switch on `status`. The result object itself is always truthy — a
 * truthiness check on it would authorize on uncertainty.
 */
export type SessionLookupStatus = "found" | "missing" | "error";

export type SessionLookupResult =
  | { status: "found"; session: SessionMetadata }
  | { status: "missing"; session: null }
  | { status: "error"; session: null };

export async function lookupUserSession(
  userId: string,
  sessionId: string,
): Promise<SessionLookupResult> {
  // Try cache first
  try {
    const data = await redisUsersSessions.get(sessionKey(userId, sessionId));
    if (data) return { status: "found", session: JSON.parse(data) as SessionMetadata };
  } catch (e) {
    logger.warn({ err: e }, "Redis getUserSession failed, falling back to DB");
  }
  // Fallback to DB — repopulate cache if found and not expired
  try {
    const dbSession = await prisma.userSession.findUnique({ where: { sessionId } });
    if (!dbSession) return { status: "missing", session: null };
    if (dbSession.userId !== userId) return { status: "missing", session: null };
    if (dbSession.expiresAt.getTime() < Date.now()) {
      // Expired — clean up
      await prisma.userSession.delete({ where: { sessionId } }).catch(() => {});
      return { status: "missing", session: null };
    }
    const metadata: SessionMetadata = {
      activeRole: dbSession.activeRole ?? null,
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
    return { status: "found", session: metadata };
  } catch (e) {
    logger.warn({ err: e, userId, sessionId }, "DB getUserSession failed");
    // Unknown, not missing: the row may be perfectly live. Callers must deny
    // with a retryable failure, never revoke or mint on this outcome.
    return { status: "error", session: null };
  }
}

/**
 * Nullable-compatibility wrapper. Preserves the historical contract exactly
 * (`found` → session, anything else → null) for callers whose denial path
 * already treats "cannot establish" and "confirmed absent" identically
 * (middleware 401, socket disconnect, switch/login guards). New code that
 * must tell the two apart — notably refresh, where the distinction decides
 * between retryable-503 and revocation — uses `lookupUserSession` instead.
 */
export async function getUserSession(userId: string, sessionId: string): Promise<SessionMetadata | null> {
  const result = await lookupUserSession(userId, sessionId);
  return result.status === "found" ? result.session : null;
}

/** Refresh-token rotation helpers — single-use jti per session. */
/**
 * Refresh-jti store errors are PROPAGATED, not swallowed.
 *
 * These four helpers previously caught and returned a benign-looking value.
 * That is unsafe for replay detection: a caller cannot distinguish "no jti
 * recorded" from "the store is unreachable", and the unreachable case was
 * being read as proof the token had never been used. A Redis outage therefore
 * silently disabled replay detection and let rotation state be lost.
 *
 * Throwing lets the caller fail CLOSED with a retryable error while leaving the
 * user's sessions intact — the caller must never revoke every session merely
 * because the store was briefly unreachable.
 */
export async function setRefreshJti(userId: string, sessionId: string, jti: string) {
  await redisUsersSessions.set(refreshJtiKey(userId, sessionId), jti, { EX: REFRESH_JTI_TTL_SECONDS });
}

export async function getRefreshJti(userId: string, sessionId: string): Promise<string | null> {
  return await redisUsersSessions.get(refreshJtiKey(userId, sessionId));
}

export async function rotateRefreshJti(userId: string, sessionId: string, oldJti: string, newJti: string) {
  // Keep old jti briefly for concurrent refresh grace window
  await redisUsersSessions.set(refreshPrevJtiKey(userId, sessionId), oldJti, { EX: REFRESH_GRACE_SECONDS });
  await redisUsersSessions.set(refreshJtiKey(userId, sessionId), newJti, { EX: REFRESH_JTI_TTL_SECONDS });
}

/**
 * Atomic refresh-token rotation (Batch 1D.60).
 *
 * The read-then-write sequence above (`getRefreshJti` → compare in JS →
 * `rotateRefreshJti`) lets two concurrent refreshes presenting the same
 * valid JTI both pass the read before either writes, so each mints an
 * independently valid token pair — and the loser can then trip replay
 * detection and revoke the whole account. This script folds the entire
 * decision — compare the expected current JTI, then rotate or classify —
 * into one server-side step, so exactly one concurrent caller can win a
 * rotation for a given current JTI.
 *
 * KEYS[1] = current jti key, KEYS[2] = prev jti key.
 * ARGV[1] = incoming jti (must be non-empty; legacy tokens without a jti
 * bypass this script via `setRefreshJti`, exactly as before).
 * ARGV[2] = new jti, ARGV[3] = current TTL seconds, ARGV[4] = prev TTL seconds.
 * Returns {code, current}: 0 = ROTATED, 1 = GRACE, 2 = REPLAY. `current` is
 * the JTI grace pairs must be minted with; callers only use it on GRACE.
 */
export const REFRESH_ROTATE_LUA = `
local cur = redis.call("GET", KEYS[1])
local prev = redis.call("GET", KEYS[2])
if (not cur) then
  redis.call("SET", KEYS[2], ARGV[1], "EX", tonumber(ARGV[4]))
  redis.call("SET", KEYS[1], ARGV[2], "EX", tonumber(ARGV[3]))
  return {0, ARGV[2]}
end
if cur == ARGV[1] then
  redis.call("SET", KEYS[2], cur, "EX", tonumber(ARGV[4]))
  redis.call("SET", KEYS[1], ARGV[2], "EX", tonumber(ARGV[3]))
  return {0, cur}
end
if prev and prev == ARGV[1] then
  return {1, cur}
end
return {2, cur}
`;

export type RefreshRotationOutcome =
  | { outcome: "rotated" }
  | { outcome: "grace"; currentJti: string }
  | { outcome: "replay"; currentJti: string };

/**
 * Compare-and-set rotation for one refresh request. Exactly one concurrent
 * caller presenting the current JTI gets `rotated`; the rest observe the
 * already-rotated state (`grace` while the previous JTI is still within its
 * window, `replay` otherwise). An unexpected shape fails closed as `replay`:
 * denying is always safer than minting here.
 *
 * Errors propagate (same convention as the other jti helpers): the caller
 * fails closed with a retryable error rather than treating an unreadable
 * store as proof the token is unused.
 */
export async function rotateRefreshJtiCAS(
  userId: string,
  sessionId: string,
  incomingJti: string,
  newJti: string,
): Promise<RefreshRotationOutcome> {
  const raw = (await redisUsersSessions.eval(REFRESH_ROTATE_LUA, {
    keys: [refreshJtiKey(userId, sessionId), refreshPrevJtiKey(userId, sessionId)],
    arguments: [
      incomingJti,
      newJti,
      String(REFRESH_JTI_TTL_SECONDS),
      String(REFRESH_GRACE_SECONDS),
    ],
  })) as [number, string | null];
  const [code, current] = raw;
  if (code === 1 && typeof current === "string" && current.length > 0) {
    return { outcome: "grace", currentJti: current };
  }
  if (code === 0) {
    return { outcome: "rotated" };
  }
  return { outcome: "replay", currentJti: typeof current === "string" ? current : "" };
}

export async function isRefreshJtiReplay(userId: string, sessionId: string, incomingJti: string): Promise<boolean> {
  const current = await redisUsersSessions.get(refreshJtiKey(userId, sessionId));
  if (current && current === incomingJti) return false; // valid current
  const prev = await redisUsersSessions.get(refreshPrevJtiKey(userId, sessionId));
  if (prev && prev === incomingJti) return false; // within grace window
  // No stored jti yet (legacy token) — allow once but not replay
  if (!current && !prev) return false;
  return true; // mismatch => replay / stolen token
  // NOTE: a Redis error now propagates. Previously this returned `false`,
  // which read as "not a replay" — i.e. an outage was treated as proof the
  // token was clean. The caller turns the throw into a retryable 503.
}

export async function deleteRefreshJti(userId: string, sessionId: string) {
  await Promise.all([
    redisUsersSessions.del(refreshJtiKey(userId, sessionId)).catch(() => {}),
    redisUsersSessions.del(refreshPrevJtiKey(userId, sessionId)).catch(() => {}),
  ]);
}

/** Revokes one specific session (e.g. logging out from just this device). */
export async function deleteUserSession(userId: string, sessionId: string) {
  await Promise.all([
    redisUsersSessions.del(sessionKey(userId, sessionId)).catch(() => {}),
    redisUsersSessions.sRem(indexKey(userId), sessionId).catch(() => {}),
    deleteRefreshJti(userId, sessionId),
    // Ownership-scoped on BOTH columns. Every Redis key touched above is
    // derived from `userId`, so a caller can only ever clear their own
    // namespace — but `delete({ where: { sessionId } })` is keyed on the global
    // `sessionId` primary key alone. `revokeSession` passes `req.user.id` as
    // the user and the caller-supplied id as the session, so before this fix a
    // request naming ANOTHER account's sessionId destroyed that account's
    // authoritative UserSession row while leaving its Redis cache intact: the
    // victim's live token kept working, but their record of the session was
    // silently gone, and rehydration from the database would have logged them
    // out with no action of their own.
    //
    // `deleteMany` (not `delete`) is the right primitive here: it filters on
    // arbitrary fields, returns `{ count }`, and does NOT error when nothing
    // matches — so "this session is not yours" is an ordinary zero-row outcome
    // rather than a swallowed exception. `sessionId` is unique, so at most one
    // row can ever match.
    prisma.userSession.deleteMany({ where: { sessionId, userId } }).catch(() => {}),
  ]);
}

/**
 * Revokes every active session for a user (log out everywhere / admin block /
 * password reset).
 *
 * Phase 1E.1: resolves to `true` ONLY when the authoritative database rows
 * were actually deleted, `false` when that delete failed.
 *
 * It previously swallowed that failure with a `warn`, so a caller could
 * cheerfully report "all devices signed out" while every session row — and
 * therefore every outstanding access token — survived. The return value lets
 * a caller state what actually happened. Existing callers are unaffected:
 * they either ignore it or already wrap the call in `.catch(...)`, and this
 * function still never rejects.
 *
 * Redis/cache deletion is deliberately NOT part of the verdict: the database
 * is the source of truth, and `getUserSession` falls back to it, so a
 * surviving cache entry cannot make a deleted session usable again.
 */
export async function deleteAllUserSessions(userId: string): Promise<boolean> {
  const sessionIds = await redisUsersSessions.sMembers(indexKey(userId)).catch(() => [] as string[]);
  if (sessionIds.length > 0) {
    await Promise.all(
      sessionIds.flatMap((id) => [
        redisUsersSessions.del(sessionKey(userId, id)).catch(() => {}),
        deleteRefreshJti(userId, id),
      ])
    );
  }
  // Sweep any remaining refresh jti keys (in case index was stale — use scan)
  try {
    for (const pat of [`refresh:jti:${userId}:*`, `refresh:jti:prev:${userId}:*`]) {
      // @ts-ignore — redis client supports scan
      let cursor = 0;
      do {
        const res: any = await (redisUsersSessions as any).scan(cursor, { MATCH: pat, COUNT: 100 });
        cursor = res.cursor ?? res[0] ?? 0;
        const keys: string[] = res.keys ?? res[1] ?? [];
        if (keys.length) await Promise.all(keys.map((k) => redisUsersSessions.del(k).catch(() => {})));
        if (typeof cursor === 'string') cursor = Number(cursor);
      } while (cursor !== 0);
    }
  } catch {}
  await redisUsersSessions.del(indexKey(userId)).catch(() => {});
  // DB is authoritative — ensure all DB sessions are removed even if Redis was flushed
  try {
    await prisma.userSession.deleteMany({ where: { userId } });
    return true;
  } catch (e) {
    // Not swallowed silently: callers that make a security claim (password
    // change) need to know the rows survived.
    logger.error({ err: e, userId }, "deleteAllUserSessions: DB sessions NOT deleted");
    return false;
  }
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
        activeRole: s.activeRole ?? null,
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

/**
 * Phase 1E — set the role THIS session acts as, leaving every other session
 * of the same account (and the account-wide `User.role`) untouched.
 *
 * The caller is responsible for having validated the role against the roles
 * the account actually holds; this function only records the decision.
 * The database is the source of truth, so the write is attempted there first
 * and the Redis cache is only refreshed afterwards — a cache failure must not
 * be able to make a switch look like it happened when it did not.
 */
export async function setSessionActiveRole(
  userId: string,
  sessionId: string,
  role: string | null,
): Promise<void> {
  await prisma.userSession.updateMany({
    where: { userId, sessionId },
    data: { activeRole: role as Role | null },
  });
  const current = await getUserSession(userId, sessionId);
  if (!current) return;
  try {
    await redisUsersSessions.set(
      sessionKey(userId, sessionId),
      JSON.stringify({ ...current, activeRole: role }),
      { EX: SESSION_TTL_SECONDS },
    );
  } catch (e) {
    // Phase 1E.1: the cache write is the only step that can leave the two
    // layers disagreeing, and a surviving stale entry is read cache-first by
    // `getUserSession`. Evict on failure so the next read misses the cache and
    // falls back to the database, which is the authoritative copy. Failing
    // closed here means the role switch still holds — it just costs one extra
    // read — instead of silently reverting later.
    logger.warn({ err: e, userId, sessionId }, "setSessionActiveRole cache refresh failed; evicting");
    await redisUsersSessions.del(sessionKey(userId, sessionId)).catch(() => {});
  }
}

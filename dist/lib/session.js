"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUserSession = createUserSession;
exports.getUserSession = getUserSession;
exports.deleteUserSession = deleteUserSession;
exports.deleteAllUserSessions = deleteAllUserSessions;
exports.listUserSessions = listUserSessions;
// lib/session.ts
const redis_1 = require("./redis");
const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 days — matches refresh token lifetime
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
const sessionKey = (userId, sessionId) => `session:user:${userId}:${sessionId}`;
const indexKey = (userId) => `session:user:${userId}:index`;
async function createUserSession(userId, sessionId, metadata) {
    await Promise.all([
        redis_1.redisUsersSessions.set(sessionKey(userId, sessionId), JSON.stringify(metadata), { EX: SESSION_TTL_SECONDS }),
        redis_1.redisUsersSessions.sAdd(indexKey(userId), sessionId),
    ]);
    await redis_1.redisUsersSessions.expire(indexKey(userId), SESSION_TTL_SECONDS);
}
async function getUserSession(userId, sessionId) {
    const data = await redis_1.redisUsersSessions.get(sessionKey(userId, sessionId));
    return data ? JSON.parse(data) : null;
}
/** Revokes one specific session (e.g. logging out from just this device). */
async function deleteUserSession(userId, sessionId) {
    await Promise.all([redis_1.redisUsersSessions.del(sessionKey(userId, sessionId)), redis_1.redisUsersSessions.sRem(indexKey(userId), sessionId)]);
}
/** Revokes every active session for a user (log out everywhere / admin block / password reset). */
async function deleteAllUserSessions(userId) {
    const sessionIds = await redis_1.redisUsersSessions.sMembers(indexKey(userId));
    if (sessionIds.length > 0) {
        await Promise.all(sessionIds.map((id) => redis_1.redisUsersSessions.del(sessionKey(userId, id))));
    }
    await redis_1.redisUsersSessions.del(indexKey(userId));
}
/** Lists every active session for a user, with metadata — for a "your devices" screen. Expired sessions (TTL lapsed) are pruned from the index as they're found. */
async function listUserSessions(userId) {
    const sessionIds = await redis_1.redisUsersSessions.sMembers(indexKey(userId));
    if (sessionIds.length === 0)
        return [];
    const results = await Promise.all(sessionIds.map(async (sessionId) => {
        const data = await redis_1.redisUsersSessions.get(sessionKey(userId, sessionId));
        if (!data) {
            // TTL already expired this session's key but the index still
            // references it — clean up lazily rather than leaving it forever.
            await redis_1.redisUsersSessions.sRem(indexKey(userId), sessionId).catch(() => { });
            return null;
        }
        return { sessionId, ...JSON.parse(data) };
    }));
    return results.filter((s) => s !== null);
}

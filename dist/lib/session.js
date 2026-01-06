"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setUserSession = setUserSession;
exports.getUserSession = getUserSession;
exports.deleteUserSession = deleteUserSession;
// lib/sessions.ts
const redis_1 = require("./redis");
const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 days
async function setUserSession(userId, sessionData) {
    const key = `session:user:${userId}`;
    await redis_1.redisUsersSessions.set(key, JSON.stringify(sessionData), { EX: SESSION_TTL_SECONDS });
}
async function getUserSession(userId) {
    const key = `session:user:${userId}`;
    const data = await redis_1.redisUsersSessions.get(key);
    return data ? JSON.parse(data) : null;
}
async function deleteUserSession(userId) {
    const key = `session:user:${userId}`;
    await redis_1.redisUsersSessions.del(key);
}

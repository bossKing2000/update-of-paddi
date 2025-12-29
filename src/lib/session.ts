// lib/sessions.ts
import { redisUsersSessions } from "./redis";

const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 days

export async function setUserSession(userId: string, sessionData: any) {
  const key = `session:user:${userId}`;
  await redisUsersSessions.set(key, JSON.stringify(sessionData), { EX: SESSION_TTL_SECONDS });
}

export async function getUserSession(userId: string) {
  const key = `session:user:${userId}`;
  const data = await redisUsersSessions.get(key);
  return data ? JSON.parse(data) : null;
}

export async function deleteUserSession(userId: string) {
  const key = `session:user:${userId}`;
  await redisUsersSessions.del(key);
}

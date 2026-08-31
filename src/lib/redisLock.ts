import crypto from "crypto";
import type { RedisClientType } from "redis";
import { logger } from "./logger";

/**
 * A simple mutual-exclusion lock over Redis SET NX EX, safe against the
 * classic "TTL expired, someone else grabbed the lock, then the original
 * holder's `finally` block deletes it out from under them" bug.
 *
 * This is intentionally NOT Redlock — it's a single-instance lock
 * (matching the project's existing single Redis deployment) with an
 * ownership token so release is a compare-and-delete instead of a bare
 * DEL. That's sufficient for this project's use case (best-effort
 * de-duplication of a user's own double-clicks/retries, backed by a
 * DB-level idempotency check either way) without adding a new dependency.
 */

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface AcquiredLock {
  key: string;
  token: string;
}

/**
 * Attempts to acquire the lock. Returns the acquired lock (key + the
 * unique token that proves ownership) on success, or null if someone
 * else currently holds it.
 */
export async function acquireLock(
  client: RedisClientType,
  key: string,
  ttlSeconds: number,
): Promise<AcquiredLock | null> {
  const token = crypto.randomUUID();
  const result = await client.set(key, token, { NX: true, EX: ttlSeconds });
  if (result === null) return null;
  return { key, token };
}

/**
 * Releases the lock ONLY if it's still held by this exact token — i.e.
 * only if nobody else has since acquired it after our TTL expired. The
 * GET+DEL happens atomically server-side via EVAL, so there's no
 * check-then-act race between the comparison and the delete.
 *
 * Returns true if we actually deleted our own lock, false if it had
 * already expired/been taken by someone else (in which case there is
 * nothing for us to safely clean up).
 */
export async function releaseLock(
  client: RedisClientType,
  lock: AcquiredLock,
): Promise<boolean> {
  try {
    const result = await client.eval(RELEASE_IF_OWNER_SCRIPT, {
      keys: [lock.key],
      arguments: [lock.token],
    });
    return Number(result) === 1;
  } catch (err) {
    logger.warn({ err, key: lock.key }, "releaseLock: EVAL failed");
    return false;
  }
}

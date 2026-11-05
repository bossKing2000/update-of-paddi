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

/**
 * Default bound for the payment lock's Redis commands, in milliseconds.
 *
 * Independent of the password-reset timeout constant on purpose: payment
 * initiation gates a multi-second Paystack round-trip where a spurious 500
 * during a Redis GC pause directly costs conversion, so this knob must be
 * tunable without touching the reset flows' fail-fast posture — and vice
 * versa.
 *
 * NOT production-validated: target-environment Redis p99 latency has not been
 * measured. 2000 ms sits comfortably above typical local Redis latency
 * (single-digit ms), well under human perception for an action that already
 * involves a Paystack round-trip, and far below the 20-second lock TTL, so a
 * timeout can never cause premature lock expiry. Measure and tune.
 */
export const PAYMENT_LOCK_COMMAND_TIMEOUT_MS = 2000;

/**
 * Apply the bounded command timeout when the injected client supports it.
 *
 * This is node-redis' OWN per-command timeout (`withCommandOptions`), not a
 * wrapper timer: on expiry the client removes the command from its write
 * queue and rejects. No `Promise.race` is used, so nothing here pretends to
 * cancel work that keeps running. See `passwordResetLimits.service.ts` for
 * the same pattern in the reset flows; it lives here separately (rather than
 * imported from the service layer) because this is library code and must not
 * depend on the service layer.
 *
 * A client without `withCommandOptions` (test doubles) degrades to the plain
 * client rather than throwing — safe because a double cannot stall.
 *
 * Scope of the guarantee: a timeout removes a command that is still WAITING
 * in the client's write queue; it is not a guarantee Redis never executes
 * it. If the command was already written to the socket, Redis may still run
 * it after the client gives up. For acquire that means a timed-out caller
 * may briefly hold an invisible lock (bounded by the TTL, surfaced as 409s
 * to retries — a denial, never a duplicate). For release it changes nothing:
 * the TTL cleans up either way.
 */
function withBoundedTimeout(client: RedisClientType, timeoutMs?: number): RedisClientType {
  if (!timeoutMs) return client;
  const scoped = client as unknown as {
    withCommandOptions?: (options: { timeout: number }) => RedisClientType;
  };
  if (typeof scoped.withCommandOptions !== "function") return client;
  return scoped.withCommandOptions({ timeout: timeoutMs });
}

export interface LockCommandOptions {
  /**
   * Bound, in ms, for how long this single Redis command may wait. Omitted
   * preserves the previous unbounded behaviour.
   */
  timeoutMs?: number;
}

export interface AcquiredLock {
  key: string;
  token: string;
}

/**
 * Attempts to acquire the lock. Returns the acquired lock (key + the
 * unique token that proves ownership) on success, or null if someone
 * else currently holds it.
 *
 * A timeout (or any Redis failure) REJECTS — it is never mapped to null.
 * Returning null means "a live holder exists, retry shortly" (409); a
 * rejection means "infrastructure failed" (500). Conflating the two would
 * mislead the client and, worse, could let a caller proceed under a false
 * assumption about who holds the lock.
 */
export async function acquireLock(
  client: RedisClientType,
  key: string,
  ttlSeconds: number,
  opts?: LockCommandOptions,
): Promise<AcquiredLock | null> {
  const token = crypto.randomUUID();
  const result = await withBoundedTimeout(client, opts?.timeoutMs).set(key, token, {
    NX: true,
    EX: ttlSeconds,
  });
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
 *
 * Best-effort by design: any failure (including a timeout) is swallowed
 * and reported as false, because release runs after the response is
 * decided and must never replace it. The TTL bounds anything left behind.
 */
export async function releaseLock(
  client: RedisClientType,
  lock: AcquiredLock,
  opts?: LockCommandOptions,
): Promise<boolean> {
  try {
    const result = await withBoundedTimeout(client, opts?.timeoutMs).eval(
      RELEASE_IF_OWNER_SCRIPT,
      {
        keys: [lock.key],
        arguments: [lock.token],
      },
    );
    return Number(result) === 1;
  } catch (err) {
    logger.warn({ err, key: lock.key }, "releaseLock: EVAL failed");
    return false;
  }
}

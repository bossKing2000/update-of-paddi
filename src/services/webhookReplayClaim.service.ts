import { randomUUID } from "crypto";
import type { RedisClientType } from "redis";

/**
 * Phase 3.2.8 (F-1) — webhook replay-claim state machine.
 *
 * Previously one key (`webhook:seen:<id>`, TTL 72h) meant both "a worker
 * holds this event" and "this event is done". A claim that was created but
 * never completed — Redis applied the write and the reply was lost, the
 * `del` failed, or the process died — made every redelivery answer
 * "already processed" for up to 72 hours while nothing had been processed.
 *
 * Two keys with an explicit owner token separate those states:
 *
 *   webhook:inflight:<id>  ->  <owner token>   short TTL (processing lease)
 *   webhook:done:<id>      ->  "1"             long TTL (durably resolved)
 *
 * Rules enforced atomically in Redis (Lua, the convention already used by
 * redisLock / phoneOtp / session):
 *   - acquire: a DONE event is reported as such; an event held by a live
 *     lease is reported BUSY (not completed); otherwise the caller becomes
 *     the owner and holds a bounded lease.
 *   - complete / release only succeed when the caller still owns the
 *     lease, so a stale worker can never complete or release a newer
 *     owner's claim (fencing).
 *   - a crashed owner's lease expires, so the event becomes acquirable
 *     again instead of staying suppressed for the full replay window.
 *
 * No schema or infrastructure change is involved: Redis alone, using the
 * same client (`redisPayments`) the handler already depends on.
 */

/** Lease for an in-progress event. Long enough for the handler's DB work,
 *  short enough that a crashed worker's event is retryable promptly. */
export const WEBHOOK_INFLIGHT_TTL_SECONDS = 300; // 5 minutes
/** Matches Paystack's full retry window; how long a resolved event stays deduped. */
export const WEBHOOK_DONE_TTL_SECONDS = 72 * 60 * 60;
/** Bound for every claim command, mirroring PAYMENT_LOCK_COMMAND_TIMEOUT_MS. */
export const WEBHOOK_CLAIM_COMMAND_TIMEOUT_MS = 2000;

export type ClaimOutcome = "ACQUIRED" | "DONE" | "BUSY";

/**
 * KEYS[1] = done key, KEYS[2] = inflight key
 * ARGV[1] = owner token, ARGV[2] = inflight TTL, ARGV[3] = done TTL
 * Returns 1 = ACQUIRED, 2 = DONE, 3 = BUSY.
 */
const ACQUIRE_LUA = `
if redis.call("exists", KEYS[1]) == 1 then
  return 2
end
if redis.call("set", KEYS[2], ARGV[1], "NX", "EX", ARGV[2]) then
  return 1
end
return 3
`;

/**
 * KEYS[1] = done key, KEYS[2] = inflight key
 * ARGV[1] = owner token, ARGV[2] = done TTL
 * Promotes the event to durably-done, but only for the current owner.
 * Returns 1 when this owner promoted it, 0 otherwise.
 */
const COMPLETE_LUA = `
if redis.call("get", KEYS[2]) == ARGV[1] then
  redis.call("del", KEYS[2])
  redis.call("set", KEYS[1], "1", "EX", ARGV[2])
  return 1
end
return 0
`;

/**
 * KEYS[1] = inflight key
 * ARGV[1] = owner token
 * Releases the lease only for the current owner. Returns 1 when released,
 * 0 when someone else owns it (a stale worker must not clear a live lease).
 */
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function doneKey(webhookId: string) {
  return `webhook:done:${webhookId}`;
}
function inflightKey(webhookId: string) {
  return `webhook:inflight:${webhookId}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  // The timer is always cleared once the command settles; leaving it armed
  // keeps the event loop alive for the full timeout on every fast call.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Redis command timed out")),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** A lease held by this process for one event. */
export interface WebhookClaim {
  webhookId: string;
  /** Opaque fencing token; never logged. */
  token: string;
}

export function newClaimToken(): string {
  return randomUUID();
}

/**
 * Atomically decide whether this worker may process the event.
 * - ACQUIRED: caller owns it until it completes, releases, or the lease expires.
 * - DONE: already resolved durably — a genuine duplicate.
 * - BUSY: another worker is processing it right now (not completed).
 *
 * Throws if Redis is unreachable — a Redis failure is never reported as a
 * successful acquisition.
 */
export async function acquireWebhookClaim(
  client: RedisClientType,
  webhookId: string,
  token: string,
): Promise<ClaimOutcome> {
  const result = await withTimeout(
    client.eval(ACQUIRE_LUA, {
      keys: [doneKey(webhookId), inflightKey(webhookId)],
      arguments: [
        token,
        String(WEBHOOK_INFLIGHT_TTL_SECONDS),
        String(WEBHOOK_DONE_TTL_SECONDS),
      ],
    }),
    WEBHOOK_CLAIM_COMMAND_TIMEOUT_MS,
  );
  const code = Number(result);
  if (code === 1) return "ACQUIRED";
  if (code === 2) return "DONE";
  if (code === 3) return "BUSY";
  throw new Error(`Unexpected claim script result: ${code}`);
}

/**
 * Mark the event durably resolved. Only the current owner may do this, so
 * a stale worker whose lease already expired and was re-acquired by
 * someone else cannot mark the event complete. Returns false when the
 * caller no longer owns it (the event stays eligible for retry).
 */
export async function completeWebhookClaim(
  client: RedisClientType,
  claim: WebhookClaim,
): Promise<boolean> {
  const result = await withTimeout(
    client.eval(COMPLETE_LUA, {
      keys: [doneKey(claim.webhookId), inflightKey(claim.webhookId)],
      arguments: [claim.token, String(WEBHOOK_DONE_TTL_SECONDS)],
    }),
    WEBHOOK_CLAIM_COMMAND_TIMEOUT_MS,
  );
  return Number(result) === 1;
}

/**
 * Release the lease so the event can be retried. Owner-checked for the
 * same reason as completion. Returns false when the caller no longer owns
 * it (another worker has taken over — nothing to release).
 */
export async function releaseWebhookClaim(
  client: RedisClientType,
  claim: WebhookClaim,
): Promise<boolean> {
  const result = await withTimeout(
    client.eval(RELEASE_LUA, {
      keys: [inflightKey(claim.webhookId)],
      arguments: [claim.token],
    }),
    WEBHOOK_CLAIM_COMMAND_TIMEOUT_MS,
  );
  return Number(result) === 1;
}

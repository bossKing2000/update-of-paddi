import crypto from "crypto";
import type { RedisClientType } from "redis";
import config from "../config/config";
import { logger } from "../lib/logger";
import { redisUsersSessions } from "../lib/redis";

/**
 * Redis-backed abuse controls for the password-reset flow (Batch 1D.53).
 *
 * Two controls, both enforced in Redis so they hold across concurrent
 * requests and application instances:
 *
 *   1. Per-account verify-attempt limiting: at most RESET_MAX_ATTEMPTS
 *      incorrect codes per challenge. Counting is increment-first and atomic
 *      (one Lua round trip), so concurrent verifications cannot slip extra
 *      guesses past the limit.
 *   2. Per-account resend cooldown: one reset email per
 *      RESET_COOLDOWN_SECONDS, acquired atomically with SET NX EX.
 *
 * This follows the phone-OTP precedent (src/services/phoneOtp.service.ts):
 * the same node-redis v5 `eval` / `set` primitives, the same fail-closed
 * posture (any Redis error throws instead of succeeding), and injectable
 * `client` options so unit tests can substitute FakeRedis.
 *
 * Privacy: Redis keys and values never contain raw emails, codes, or JWTs.
 * Account keys use the opaque user id; unknown-address decoy keys use a
 * one-way HMAC of the canonical email.
 */

export const RESET_MAX_ATTEMPTS = 5;
/**
 * Batch 1D.70: finalization attempts allowed per reset credential.
 *
 * Deliberately equal to RESET_MAX_ATTEMPTS, but a separate constant because
 * it guards a different thing (finalization volume) with a different key
 * (credential identity). Sharing the value keeps one tuning knob in review
 * while letting the two limits diverge later without a semantic clash.
 *
 * Batch 1D.72 (clarification): this is a per-CREDENTIAL budget, not an
 * account-wide one. The counter key is derived from the HMAC of the reset JWT
 * that was actually presented (see `resetFinalizeKeyFor`), so the budget
 * follows that token and nothing else. `verifyResetCode` issues a newly signed
 * reset JWT on every successful verification, and each new JWT has its own
 * identity and therefore its own budget — this limit must not be read as
 * bounding finalization attempts across an account. The per-account pressure
 * on that path is bounded separately, by the resend cooldown
 * (RESET_COOLDOWN_SECONDS) and by the /verify-reset-code rate limiter.
 */
export const RESET_FINALIZE_MAX_ATTEMPTS = 5;
/**
 * Attempt-counter lifetime. Must cover the challenge it guards: the reset
 * code TTL is 10 minutes in `forgotPassword`, so the counter may not lapse
 * first (that would silently re-arm an exhausted challenge).
 */
export const RESET_ATTEMPT_WINDOW_SECONDS = 10 * 60;
export const RESET_COOLDOWN_SECONDS = 60;

export class PasswordResetLimitsError extends Error {
  constructor(message = "Password reset service unavailable") {
    super(message);
    this.name = "PasswordResetLimitsError";
  }
}

export function resetAttemptsKeyFor(userId: string): string {
  return `pwdreset:attempts:${userId}`;
}

/**
 * Batch 1D.70: opaque, credential-scoped identity for the finalization
 * counter.
 *
 * Domain separation is the whole point of the separate function:
 *
 * - It is NOT the raw reset JWT. That value is a live bearer credential, and
 *   Redis keys surface in MONITOR, SLOWLOG and RDB/AOF dumps; a key equal to
 *   the credential would hand account takeover to anyone with read access to
 *   Redis.
 * - It is NOT `resetJwtDigest(...)`, i.e. the value stored in Postgres. That
 *   is one-way and not replayable, but reusing it would make the Redis key
 *   byte-identical to a persisted database column, collapsing two trust
 *   boundaries into one for no benefit. Because the domain prefix differs
 *   ("password-reset-finalize:" vs "password-reset-jwt:"), this digest can
 *   never equal a stored credential digest.
 * - It is NOT the user id or email. Keying on the account would let a caller
 *   learn whether an account exists by watching a budget drain, and would
 *   let an attacker burn a victim's budget to lock a real user out of their
 *   own account recovery.
 */
export function resetFinalizeIdentity(resetToken: string): string {
  return crypto
    .createHmac("sha256", config.jwtResetSecret)
    .update(`password-reset-finalize:${resetToken}`, "utf8")
    .digest("hex");
}

/** Redis key for one credential's finalization counter. */
export function resetFinalizeKeyFor(resetToken: string): string {
  return `pwdreset:finalize:${resetFinalizeIdentity(resetToken)}`;
}

export function resetCooldownKeyFor(userId: string): string {
  return `pwdreset:cooldown:${userId}`;
}

/**
 * One-way identity for unknown-address decoy work. Lets the
 * unknown-account branch perform the same class of Redis operation as the
 * known branch (preserving the anti-enumeration timing posture) without
 * storing anything reversible.
 */
export function resetUnknownIdentity(email: string): string {
  return crypto
    .createHmac("sha256", config.jwtResetSecret)
    .update(`password-reset-unknown:${email.trim().toLowerCase()}`, "utf8")
    .digest("hex");
}

export function resetUnknownCooldownKeyFor(email: string): string {
  return `pwdreset:cooldown:unknown:${resetUnknownIdentity(email)}`;
}

export function resetUnknownAttemptsKeyFor(email: string): string {
  return `pwdreset:attempts:unknown:${resetUnknownIdentity(email)}`;
}

// Increment-first attempt counting: INCR and the TTL assignment happen
// server-side in one round trip and the new count is returned, so the caller
// learns atomically whether this attempt exhausted the challenge. Returns
// the count AFTER this attempt (1-based).
//
// Why increment-first rather than check-then-increment: two concurrent wrong
// guesses at count 5 would both read "not exhausted" under check-first and
// both be answered INVALID (7 guesses through a 5-guess limit). Under
// increment-first they land at 6 and 7 and both are refused — the limit can
// only ever be exceeded by attempts already in flight, never bypassed.
export const RESET_ATTEMPT_LUA = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]))
end
return count
`;

export interface ResetLimitsOptions {
  client?: RedisClientType;
}

/**
 * Batch 1D.70: how long a limits command may wait before the service gives up
 * and the caller fails closed.
 *
 * This is node-redis' OWN per-command timeout (see `withCommandOptions`
 * below), not a wrapper timer: on expiry the client removes the command from
 * its write queue and rejects with `TimeoutError`. No `Promise.race` is used,
 * so nothing here pretends to cancel work that keeps running.
 *
 * Why it is needed at all: the app's clients are constructed with only
 * `{ url, database }`, so the offline queue stays ENABLED (node-redis default
 * `disableOfflineQueue: false`). While a connection is down but the socket is
 * open, a command is queued rather than rejected — without a bounded timeout
 * "fail closed" would degrade into "hang until Redis reconnects". A closed
 * socket already rejects immediately (`ClientClosedError`), so the timeout
 * covers the open-but-not-ready case that actually stalls.
 *
 * Scope of the guarantee (Batch 1D.71 review): a timeout removes a command
 * that is still WAITING in the client's write queue, but it is not a
 * transaction and it is not a guarantee that Redis does not execute the
 * command. If the command has already been written to the socket, Redis may
 * still run it after the client has given up. For this counter that means a
 * request can be answered 503 while the INCR still lands, so the caller's
 * retry can consume a further attempt. That direction is safe — the limit can
 * come to bite earlier than intended, never later — but a client must not
 * read "timed out" as "nothing happened".
 */
export const RESET_LIMITS_COMMAND_TIMEOUT_MS = 750;

/**
 * Apply the bounded command timeout when the injected client supports it.
 *
 * `withCommandOptions` exists on a real node-redis client. Test doubles do not
 * need it (they never stall) and must not be forced to implement it, so its
 * absence degrades to the plain client rather than throwing — which is safe
 * because a double cannot hang in the first place.
 */
function withBoundedTimeout(client: RedisClientType, timeoutMs?: number): RedisClientType {
  if (!timeoutMs) return client;
  const scoped = client as unknown as {
    withCommandOptions?: (options: { timeout: number }) => RedisClientType;
  };
  if (typeof scoped.withCommandOptions !== "function") return client;
  return scoped.withCommandOptions({ timeout: timeoutMs });
}

/**
 * Record one verification attempt against a challenge and report whether the
 * challenge is now exhausted. Throws PasswordResetLimitsError if Redis is
 * unavailable — verification must fail closed, never unlimited.
 *
 * Batch 1D.70 adds two optional knobs, both used by the finalization counter
 * and both defaulting to this function's original behaviour so existing
 * callers are unaffected:
 *
 * - `windowSeconds`: the expiry applied when the counter is created. The
 *   finalizer passes the credential's ACTUAL remaining lifetime rather than a
 *   fresh fixed window, so the counter provably outlives the token it guards
 *   (the Lua only sets EXPIRE on the first increment, so later attempts can
 *   never shorten or extend it).
 * - `timeoutMs`: bounds how long the command may wait (see above).
 */
export async function recordResetAttempt(
  key: string,
  opts?: ResetLimitsOptions & { windowSeconds?: number; maxAttempts?: number; timeoutMs?: number },
): Promise<{ count: number; exhausted: boolean }> {
  const client = opts?.client ?? redisUsersSessions;
  const windowSeconds = opts?.windowSeconds ?? RESET_ATTEMPT_WINDOW_SECONDS;
  const maxAttempts = opts?.maxAttempts ?? RESET_MAX_ATTEMPTS;
  let count: unknown;
  try {
    count = await withBoundedTimeout(client, opts?.timeoutMs).eval(RESET_ATTEMPT_LUA, {
      keys: [key],
      arguments: [String(windowSeconds)],
    });
  } catch (err) {
    logger.warn({ err }, "passwordResetLimits.recordResetAttempt: store failed");
    throw new PasswordResetLimitsError();
  }
  const n = Number(count);
  return { count: n, exhausted: n > maxAttempts };
}

/**
 * Atomically acquire the per-account resend cooldown (SET NX EX). Returns
 * true when this caller won the slot and may issue + email; false when a
 * cooldown is already active and the caller must return the uniform response
 * without issuing or emailing. Throws on Redis failure (fail closed).
 *
 * Batch 1D.74: optional `timeoutMs`, same pattern as `recordResetAttempt` —
 * omitted, behaviour is unchanged. The app's Redis clients leave the offline
 * queue enabled, so without a bound a command issued while the connection is
 * unhealthy waits for TCP detection instead of failing. A timeout here still
 * throws `PasswordResetLimitsError`, so the caller keeps failing closed; note
 * the command may still have executed (see RESET_LIMITS_COMMAND_TIMEOUT_MS).
 */
export async function acquireResetCooldown(
  key: string,
  opts?: ResetLimitsOptions & { timeoutMs?: number },
): Promise<boolean> {
  const client = opts?.client ?? redisUsersSessions;
  try {
    const acquired = await withBoundedTimeout(client, opts?.timeoutMs).set(key, "1", {
      EX: RESET_COOLDOWN_SECONDS,
      NX: true,
    });
    return acquired !== null;
  } catch (err) {
    logger.warn({ err }, "passwordResetLimits.acquireResetCooldown: store failed");
    throw new PasswordResetLimitsError();
  }
}

/**
 * Drop the attempt counter, e.g. when a fresh challenge is issued. Throws on
 * Redis failure: issuance must not proceed on a stale, possibly exhausted
 * counter — that would strand the user with an unverifiable code.
 *
 * Batch 1D.74: optional `timeoutMs`, same pattern as `recordResetAttempt` —
 * omitted, behaviour is unchanged. The delete is idempotent, so a command that
 * times out having already executed costs nothing on a retry.
 */
export async function clearResetAttempts(
  key: string,
  opts?: ResetLimitsOptions & { timeoutMs?: number },
): Promise<void> {
  const client = opts?.client ?? redisUsersSessions;
  try {
    await withBoundedTimeout(client, opts?.timeoutMs).del(key);
  } catch (err) {
    logger.warn({ err }, "passwordResetLimits.clearResetAttempts: store failed");
    throw new PasswordResetLimitsError();
  }
}

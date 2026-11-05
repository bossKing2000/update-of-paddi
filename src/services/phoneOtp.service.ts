import crypto from "crypto";
import type { RedisClientType } from "redis";
import { redisUsersSessions } from "../lib/redis";
import { logger } from "../lib/logger";
import config from "../config/config";
import { normalizePhoneNumber } from "../utils/phone";
import { clientRateLimitIdentity } from "../utils/clientIp";

// Phase 1D.2 — phone OTP service (security layer only).
//
// - OTPs are 6-digit cryptographically random numbers (crypto.randomInt).
// - Only an HMAC-SHA256 digest is stored in Redis, bound to
//   purpose + normalized phone + OTP. Plaintext OTPs are never stored,
//   never logged, and only returned to callers that explicitly opt in
//   (automated tests). Production API layers must not expose them.
// - Verification is atomic via a Redis Lua script (compare digest,
//   increment attempts, delete on success or exhaustion).
// - Redis key layout follows the project's colon-prefix convention
//   (session:user:…, refresh:jti:…, login_attempts:…, webhook:seen:…).
// - Lives on the auth Redis database (redisUsersSessions, DB 4): OTP
//   state is account-security state with the same failure domain as
//   sessions/JTIs, isolated by dedicated otp: key prefixes. No new
//   Redis database was created for this.
// - Any Redis failure fails CLOSED: request/verify throw instead of
//   succeeding. (Deliberate deviation from the checkout-idempotency
//   service, which fails open — an OTP must never verify without proof.)
//
// Phase 1D.38 hardening of the request path:
//   - Cooldown check, both rate-limit counters and the record write were
//     four independent round trips, so two concurrent requests could both
//     read "no record" and both mint and deliver a code, and a failure
//     between INCR and EXPIRE left a counter that never lapsed (permanent
//     lockout). They are now one atomic Lua script (ISSUE_LUA), which is
//     what makes the limits hold across application instances sharing one
//     Redis rather than only within a single process.
//   - The per-IP budget is keyed on the caller-supplied IP, normalised to a
//     network identity first (Phase 1D.39 / F1). Callers MUST pass the IP
//     that Express resolved under the app's `trust proxy` setting (req.ip)
//     — never a raw X-Forwarded-For read. See utils/clientIp.ts for the
//     trust assumption that address carries.

export enum OtpPurpose {
  PHONE_VERIFICATION = "PHONE_VERIFICATION",
  PHONE_CHANGE = "PHONE_CHANGE",
  PHONE_LOGIN = "PHONE_LOGIN",
  PHONE_PASSWORD_RESET = "PHONE_PASSWORD_RESET",
}

export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_MAX_REQUESTS_PER_PHONE = 5;
export const OTP_MAX_REQUESTS_PER_IP = 20;
export const OTP_RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

export type OtpRequestStatus = "SUCCESS" | "COOLDOWN" | "RATE_LIMITED";

export interface OtpRequestResult {
  status: OtpRequestStatus;
  /** Test-only escape hatch. Only present when opts.exposeOtp is true. */
  otp?: string;
}

export type OtpVerifyStatus = "SUCCESS" | "INVALID" | "EXPIRED" | "MAX_ATTEMPTS";

export interface OtpVerifyResult {
  status: OtpVerifyStatus;
}

export class OtpServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtpServiceError";
  }
}

/** Delivery (e.g. SMS gateway) failed after the OTP was stored. */
export class OtpDeliveryError extends OtpServiceError {
  constructor(message = "OTP delivery failed") {
    super(message);
    this.name = "OtpDeliveryError";
  }
}

/** Key builders are pure (no secrets) and exported for tests/admin tooling. */
export function otpKeyFor(purpose: OtpPurpose, e164: string): string {
  return `otp:phone:${purpose}:${e164}`;
}

/**
 * Per-phone request budget.
 *
 * Deliberately purpose-INDEPENDENT: the product requirement is five OTP
 * requests per normalized phone number per 24 hours, across every purpose and
 * endpoint. Keying on `purpose` as well handed each purpose its own budget, so
 * one number could be sent 5 codes per purpose (10 on the authenticated
 * surface, plus another 5 from public phone login). The normalized E.164 is
 * already the caller's identity here, so equivalent input spellings share
 * this counter too.
 *
 * The OTP *record* stays purpose-scoped (`otpKeyFor`), so codes for different
 * purposes are still independent credentials and cannot be verified against
 * each other — only the request budget is shared.
 */
export function otpRateLimitKeyFor(e164: string): string {
  return `otp:rl:phone:${e164}`;
}

/**
 * Per-IP/network budget. Deliberately purpose-independent: the point of the limit
 * is to cap SMS spend from one origin across every phone flow, so a caller
 * cannot reset its budget by switching purpose.
 *
 * The IP component is a *network* identity, not a raw address: IPv6 callers
 * rotate host bits freely inside their allocation, so keying on the full
 * address would hand each rotation a fresh budget. See utils/clientIp.ts.
 */
export function otpIpRateLimitKeyFor(ip: string): string {
  return `otp:rl:ip:${ip}`;
}

function getOtpSecret(): string {
  const secret = process.env.PHONE_OTP_SECRET || config.phoneOtpSecret;
  if (!secret) {
    throw new OtpServiceError("PHONE_OTP_SECRET is not configured");
  }
  return secret;
}

/** Canonical context-bound digest. Never store or compare the raw OTP. */
export function otpDigest(secret: string, purpose: OtpPurpose, e164: string, otp: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${purpose}:${e164}:${otp}`, "utf8")
    .digest("hex");
}

interface OtpRecord {
  /** Hex HMAC digest of purpose:phone:otp. */
  d: string;
  /** Failed verification attempts so far. */
  a: number;
  /** Epoch ms when the OTP was (re)generated. */
  c: number;
  /** Epoch ms of the last generation (resend-cooldown basis). */
  s: number;
}

// Atomic verify: compare digest, bump attempts, delete on success or
// exhaustion — all server-side so concurrent verifications cannot both
// succeed. Returns 0 = missing/expired, 1 = success, 2 = max attempts,
// 3 = invalid (attempts remaining).
//
// Phase 1D.38: the exhaustion test is `>` rather than `>=`. With OTP_MAX_ATTEMPTS
// = 5 that permits five wrong codes to be answered INVALID and rejects the
// sixth, which is what "maximum 5 wrong attempts per OTP" means; the previous
// `>=` destroyed the OTP on the Nth wrong attempt, so N-1 were ever usable.
// Phase 1D.39 (F4): exported so an integration suite can execute these
// exact scripts against a real Redis. The unit tests in tests/unit run them
// through tests/helpers/fakeRedis.ts, which is a MODEL of this behaviour and
// cannot prove the scripts parse or behave identically inside Redis.
export const VERIFY_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return 0
end
local rec = cjson.decode(raw)
if rec.d == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return 1
end
rec.a = (rec.a or 0) + 1
if rec.a > tonumber(ARGV[2]) then
  redis.call("DEL", KEYS[1])
  return 2
end
-- Persist the bumped attempt count while keeping the record's ORIGINAL
-- five-minute deadline, and never making it longer than it was.
--
-- This must be KEEPTTL, not a read-back-and-reset with EX. Redis documents
-- that a plain SET "discards" any previous TTL, and TTL rounds to 0 during
-- the final 500 ms of a key's life (src/expire.c: (ttl+500)/1000). The previous
-- shape -- read TTL, then SET with EX when ttl > 0, otherwise plain SET --
-- therefore fell into its else branch during that half-second and rewrote the
-- record with NO expiry: a credential that had already reached its five-minute
-- lifetime became permanent, and its original digest still matched, so a wrong
-- guess could resurrect a long-expired code indefinitely. KEEPTTL preserves the
-- absolute expiry exactly, costs no extra round trip, and needs no fallback
-- branch. Requires Redis >= 6.0.
redis.call("SET", KEYS[1], cjson.encode(rec), "KEEPTTL")
return 3
`;

// Atomic issue: cooldown check, both counters and the record write in one
// round trip. Returns 0 = stored, 1 = cooldown, 2 = rate limited.
//
// ARGV[9] ("1"/"0") gates the per-IP counter: with no IP the caller gets the
// per-phone budget only, which is the pre-1D.38 behaviour rather than a
// silently shared bucket.
export const ISSUE_LUA = `
local now = tonumber(ARGV[1])
local existing = redis.call("GET", KEYS[1])
if existing then
  local rec = cjson.decode(existing)
  if now - (rec.s or 0) < tonumber(ARGV[2]) then
    return 1
  end
end
local phoneCount = redis.call("INCR", KEYS[2])
if phoneCount == 1 then
  redis.call("EXPIRE", KEYS[2], tonumber(ARGV[3]))
end
if phoneCount > tonumber(ARGV[4]) then
  return 2
end
if ARGV[9] == "1" then
  local ipCount = redis.call("INCR", KEYS[3])
  if ipCount == 1 then
    redis.call("EXPIRE", KEYS[3], tonumber(ARGV[5]))
  end
  if ipCount > tonumber(ARGV[6]) then
    return 2
  end
end
redis.call("SET", KEYS[1], ARGV[7], "EX", tonumber(ARGV[8]))
return 0
`;

export interface RequestOtpOptions {
  client?: RedisClientType;
  /**
   * Test-only: include the plaintext OTP in the result so automated
   * tests can verify it. Production callers must never set this —
   * use onGenerated to hand the OTP to the delivery provider instead.
   */
  exposeOtp?: boolean;
/**
   * Production delivery hook: invoked with the plaintext OTP after it
   * is stored, so the caller can hand it to the delivery provider without
   * the OTP ever appearing in an API response. If delivery throws, the
   * stored OTP is deleted (no misleading active code is left behind)
   * and an OtpDeliveryError is thrown.
   */
  onGenerated?: (otp: string) => Promise<void> | void;
  /**
   * Phase 1D.39 (F2) — fire-and-forget delivery.
   *
   * The record is already stored when this runs; delivery is then scheduled
   * and NOT awaited, and its outcome cannot change the caller's response.
   * This is what removes the latency oracle on an unauthenticated endpoint:
   * whether an SMS leaves the building no longer changes how long the
   * caller waits, so "this number has an account" stops being observable
   * from response time. It also means a gateway outage can no longer turn
   * into a distinguishable 503.
   *
   * A failure is handled here rather than by the caller: the stored record
   * is deleted (best effort) and the error is logged, so a rejected
   * delivery can never surface as an unhandled rejection.
   *
   * Only use this where the caller has no way to observe delivery success
   * anyway; the awaited `onGenerated` path still reports gateway failure to
   * the client, which the authenticated flow depends on.
   */
  detachDelivery?: boolean;
}

export async function requestOtp(
  input: { phoneNumber: string; purpose: OtpPurpose; ip?: string | null },
  opts?: RequestOtpOptions,
): Promise<OtpRequestResult> {
  const e164 = normalizePhoneNumber(input.phoneNumber);
  const secret = getOtpSecret();
  const client = opts?.client ?? redisUsersSessions;
  const key = otpKeyFor(input.purpose, e164);
  // The per-phone budget is shared across purposes (see otpRateLimitKeyFor),
  // so a caller cannot reset it by switching purpose.
  const rateKey = otpRateLimitKeyFor(e164);
  // Phase 1D.39 (F1): the per-IP budget is keyed on a normalised network
  // identity, and it is ALWAYS charged. Previously a caller that supplied no
  // IP fell through with the counter disabled, which was an unlimited
  // budget; now an unusable address collapses onto a single bounded bucket.
  const ip = clientRateLimitIdentity(input.ip);
  const ipKey = otpIpRateLimitKeyFor(ip);
  const now = Date.now();

  const otp = String(crypto.randomInt(100000, 1000000));
  const record: OtpRecord = {
    d: otpDigest(secret, input.purpose, e164, otp),
    a: 0,
    c: now,
    s: now,
  };

  let code: unknown;
  try {
    code = await client.eval(ISSUE_LUA, {
      keys: [key, rateKey, ipKey],
      arguments: [
        String(now),
        String(OTP_RESEND_COOLDOWN_SECONDS * 1000),
        String(OTP_RATE_LIMIT_WINDOW_SECONDS),
        String(OTP_MAX_REQUESTS_PER_PHONE),
        String(OTP_RATE_LIMIT_WINDOW_SECONDS),
        String(OTP_MAX_REQUESTS_PER_IP),
        JSON.stringify(record),
        String(OTP_TTL_SECONDS),
        // Phase 1D.39 (F1): always enabled — the IP budget is charged for
        // every request, including one whose address was unusable.
        "1",
      ],
    });
  } catch (err) {
    logger.warn({ err, purpose: input.purpose }, "phoneOtp.request: store failed");
    throw new OtpServiceError("OTP service unavailable");
  }

  if (Number(code) === 1) {
    logger.info({ purpose: input.purpose }, "phoneOtp.request: cooldown");
    return { status: "COOLDOWN" };
  }
  if (Number(code) !== 0) {
    logger.info({ purpose: input.purpose }, "phoneOtp.request: rate limited");
    return { status: "RATE_LIMITED" };
  }

  if (opts?.onGenerated) {
    if (opts.detachDelivery) {
      // Phase 1D.39 (F2). Everything the caller can observe is already
      // decided at this point. The catch below is attached synchronously
      // here, so the promise is always handled and can never surface as an
      // unhandled rejection, and the failure stays internal.
      Promise.resolve()
        .then(() => opts.onGenerated!(otp))
        .catch(async (err) => {
          logger.warn({ err, purpose: input.purpose }, "phoneOtp.request: detached delivery failed");
          try {
            await client.del(key);
          } catch (delErr) {
            logger.warn(
              { err: delErr, purpose: input.purpose },
              "phoneOtp.request: cleanup after detached delivery failure failed",
            );
          }
        });
    } else {
      try {
        await opts.onGenerated(otp);
      } catch (err) {
        try {
          await client.del(key);
        } catch (delErr) {
          logger.warn({ err: delErr, purpose: input.purpose }, "phoneOtp.request: cleanup after delivery failure failed");
        }
        logger.warn({ err, purpose: input.purpose }, "phoneOtp.request: delivery failed");
        throw new OtpDeliveryError();
      }
    }
  }

  logger.info({ purpose: input.purpose }, "phoneOtp.request: sent");
  return opts?.exposeOtp ? { status: "SUCCESS", otp } : { status: "SUCCESS" };
}

/**
 * Best-effort invalidation of any outstanding OTP for a number. Used when a
 * phone is removed so a code issued before removal cannot outlive the
 * binding that justified it. Not a security decision on its own (the TTL and
 * the phone binding still apply), so a Redis failure is logged, not thrown.
 */
export async function clearOtp(input: {
  phoneNumber: string;
  purpose: OtpPurpose;
  client?: RedisClientType;
}): Promise<void> {
  const client = input.client ?? redisUsersSessions;
  try {
    const e164 = normalizePhoneNumber(input.phoneNumber);
    await client.del(otpKeyFor(input.purpose, e164));
  } catch (err) {
    logger.warn({ err, purpose: input.purpose }, "phoneOtp.clear: failed");
  }
}

export interface VerifyOtpOptions {
  client?: RedisClientType;
}

export async function verifyOtp(
  input: { phoneNumber: string; purpose: OtpPurpose; otp: string },
  opts?: VerifyOtpOptions,
): Promise<OtpVerifyResult> {
  const e164 = normalizePhoneNumber(input.phoneNumber);
  const secret = getOtpSecret();
  const client = opts?.client ?? redisUsersSessions;

  if (!/^\d{6}$/.test(input.otp)) {
    return { status: "INVALID" };
  }

  const expected = otpDigest(secret, input.purpose, e164, input.otp);
  const key = otpKeyFor(input.purpose, e164);

  let code: unknown;
  try {
    code = await client.eval(VERIFY_LUA, {
      keys: [key],
      arguments: [expected, String(OTP_MAX_ATTEMPTS)],
    });
  } catch (err) {
    logger.warn({ err, purpose: input.purpose }, "phoneOtp.verify: store failed");
    throw new OtpServiceError("OTP service unavailable");
  }

  const status: OtpVerifyStatus =
    Number(code) === 1
      ? "SUCCESS"
      : Number(code) === 2
        ? "MAX_ATTEMPTS"
        : Number(code) === 0
          ? "EXPIRED"
          : "INVALID";

  logger.info({ purpose: input.purpose, status }, "phoneOtp.verify");
  return { status };
}

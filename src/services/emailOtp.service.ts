import crypto from "crypto";
import type { RedisClientType } from "redis";
import config from "../config/config";
import { redisUsersSessions } from "../lib/redis";
import { logger } from "../lib/logger";
import { clientRateLimitIdentity } from "../utils/clientIp";
import {
  ISSUE_LUA,
  VERIFY_LUA,
  OtpServiceError,
  OtpDeliveryError,
  OTP_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_RATE_LIMIT_WINDOW_SECONDS,
  OTP_MAX_REQUESTS_PER_IP,
} from "./phoneOtp.service";

// Email OTP — a purpose-scoped sibling of src/services/phoneOtp.service.ts.
//
// WHY A SEPARATE SERVICE RATHER THAN REUSING THE PHONE ONE:
// phoneOtp keys records as `otp:phone:<purpose>:<identifier>`. This service
// uses `otp:email:<purpose>:<identifier>` and, critically, prefixes its HMAC
// input with the literal string `email:`. Even if the SAME HMAC secret is used
// for both channels, an email digest can therefore never equal a phone digest,
// so a code issued for one channel can never be replayed against the other.
//
// PURPOSE SEPARATION is the security property this file exists to provide:
//   - a login code       (EMAIL_LOGIN)      authenticates a session
//   - a verification code (VERIFY_EMAIL)   proves email ownership
//   - a reset code       (PASSWORD_RESET)  is handled by passwordResetLimits
// None of the three can authorize any other. Each purpose gets its own Redis
// key, so issuing one never invalidates another and consuming one never
// consumes another.
//
// The atomic Lua scripts are imported from the phone service: they operate
// purely on KEYS/ARGV and never hardcode a key prefix, so they are
// namespace-agnostic by construction. Reusing them is what keeps concurrency
// semantics identical to the already-verified phone flow.

/** Purpose values. Distinct enum from OtpPurpose so a purpose cannot be
 * accidentally passed across the channel boundary. */
export enum EmailOtpPurpose {
  /** One-time code that, once verified, issues a full session. */
  LOGIN = "LOGIN",
  /** One-time code proving ownership of an email address at signup. */
  VERIFY_EMAIL = "VERIFY_EMAIL",
}

export type EmailOtpRequestStatus = "SUCCESS" | "COOLDOWN" | "RATE_LIMITED";
export type EmailOtpVerifyStatus = "SUCCESS" | "INVALID" | "EXPIRED" | "MAX_ATTEMPTS";

export interface EmailOtpRequestResult {
  status: EmailOtpRequestStatus;
  otp?: string;
}

export interface EmailOtpVerifyResult {
  status: EmailOtpVerifyStatus;
}

export { OtpServiceError, OtpDeliveryError };

/** Per-email request budget, shared across purposes (as the phone service
 * does) so switching purpose cannot buy an attacker a fresh budget. */
export const EMAIL_OTP_MAX_REQUESTS_PER_ADDRESS = 5;

interface EmailOtpRecord {
  /** Hex HMAC digest of email:<purpose>:<address>:<code>. */
  d: string;
  /** Failed verification attempts so far. */
  a: number;
  /** Epoch ms when the code was (re)generated. */
  c: number;
  /** Epoch ms of the last generation (resend-cooldown basis). */
  s: number;
}

/**
 * Canonical address form used in keys AND in the HMAC input, so two spellings
 * of the same address can never produce two independent codes or two digests.
 * Mirrors how registration canonicalises emails (trim + lowercase).
 */
export function canonicalizeEmail(email: string): string {
  return String(email).trim().toLowerCase();
}

export function emailOtpKeyFor(purpose: EmailOtpPurpose, email: string): string {
  return `otp:email:${purpose}:${canonicalizeEmail(email)}`;
}

export function emailOtpRateLimitKeyFor(email: string): string {
  return `otp:rl:email:${canonicalizeEmail(email)}`;
}

export function emailOtpIpRateLimitKeyFor(ip: string): string {
  return `otp:rl:email-ip:${ip}`;
}

/**
 * HMAC secret. EMAIL_OTP_SECRET is preferred so the email channel can be
 * rotated independently; it falls back to the existing phone OTP secret.
 * Separation does NOT depend on this being a different key — the `email:`
 * label inside the digest input already guarantees channel separation.
 */
function getEmailOtpSecret(): string {
  const secret = process.env.EMAIL_OTP_SECRET || config.phoneOtpSecret;
  if (!secret) {
    throw new OtpServiceError("EMAIL_OTP_SECRET is not configured");
  }
  return secret;
}

export function emailOtpDigest(
  secret: string,
  purpose: EmailOtpPurpose,
  email: string,
  otp: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    // The `email:` prefix is what makes an email digest un-replayable against
    // a phone digest even when both channels share one HMAC secret.
    .update(`email:${purpose}:${canonicalizeEmail(email)}:${otp}`, "utf8")
    .digest("hex");
}

export interface RequestEmailOtpOptions {
  client?: RedisClientType;
  /**
   * Test-only: include the plaintext code in the result. Production callers
   * must never set this — use onGenerated to hand the code to the provider.
   */
  exposeOtp?: boolean;
  /**
   * Production delivery hook, invoked with the plaintext code after it is
   * stored so it never appears in an API response. If it throws, the stored
   * code is deleted and OtpDeliveryError is raised — no misleading active code
   * is left behind.
   */
  onGenerated?: (otp: string) => Promise<void> | void;
  /**
   * Fire-and-forget delivery, used on the UNAUTHENTICATED request endpoint.
   *
   * Everything the caller can observe is already decided at this point, so
   * not awaiting removes the latency oracle that would otherwise let a caller
   * time the response to learn "this address has an account". A gateway
   * outage can no longer turn into a distinguishable 503.
   */
  detachDelivery?: boolean;
}

export async function requestEmailOtp(
  input: { email: string; purpose: EmailOtpPurpose; ip?: string | null },
  opts?: RequestEmailOtpOptions,
): Promise<EmailOtpRequestResult> {
  const email = canonicalizeEmail(input.email);
  const secret = getEmailOtpSecret();
  const client = opts?.client ?? redisUsersSessions;
  const key = emailOtpKeyFor(input.purpose, email);
  const rateKey = emailOtpRateLimitKeyFor(email);
  const ip = clientRateLimitIdentity(input.ip);
  const ipKey = emailOtpIpRateLimitKeyFor(ip);
  const now = Date.now();

  const otp = String(crypto.randomInt(100000, 1000000));
  const record: EmailOtpRecord = {
    d: emailOtpDigest(secret, input.purpose, email, otp),
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
        String(EMAIL_OTP_MAX_REQUESTS_PER_ADDRESS),
        String(OTP_RATE_LIMIT_WINDOW_SECONDS),
        String(OTP_MAX_REQUESTS_PER_IP),
        JSON.stringify(record),
        String(OTP_TTL_SECONDS),
        // The IP budget is always charged, including for an unusable address.
        "1",
      ],
    });
  } catch (err) {
    logger.warn({ err, purpose: input.purpose }, "emailOtp.request: store failed");
    throw new OtpServiceError("OTP service unavailable");
  }

  if (Number(code) === 1) {
    logger.info({ purpose: input.purpose }, "emailOtp.request: cooldown");
    return { status: "COOLDOWN" };
  }
  if (Number(code) !== 0) {
    logger.info({ purpose: input.purpose }, "emailOtp.request: rate limited");
    return { status: "RATE_LIMITED" };
  }

  if (opts?.onGenerated) {
    if (opts.detachDelivery) {
      // The catch is attached synchronously, so the promise is always handled
      // and can never surface as an unhandled rejection.
      Promise.resolve()
        .then(() => opts.onGenerated!(otp))
        .catch(async (err) => {
          logger.warn({ err, purpose: input.purpose }, "emailOtp.request: detached delivery failed");
          try {
            await client.del(key);
          } catch (delErr) {
            logger.warn(
              { err: delErr, purpose: input.purpose },
              "emailOtp.request: cleanup after detached delivery failure failed",
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
          logger.warn(
            { err: delErr, purpose: input.purpose },
            "emailOtp.request: cleanup after delivery failure failed",
          );
        }
        logger.warn({ err, purpose: input.purpose }, "emailOtp.request: delivery failed");
        throw new OtpDeliveryError();
      }
    }
  }

  logger.info({ purpose: input.purpose }, "emailOtp.request: sent");
  return opts?.exposeOtp ? { status: "SUCCESS", otp } : { status: "SUCCESS" };
}

/** Best-effort invalidation of an outstanding code for an address/purpose. */
export async function clearEmailOtp(input: {
  email: string;
  purpose: EmailOtpPurpose;
  client?: RedisClientType;
}): Promise<void> {
  const client = input.client ?? redisUsersSessions;
  try {
    await client.del(emailOtpKeyFor(input.purpose, input.email));
  } catch (err) {
    logger.warn({ err, purpose: input.purpose }, "emailOtp.clear: failed");
  }
}

export interface VerifyEmailOtpOptions {
  client?: RedisClientType;
}

export async function verifyEmailOtp(
  input: { email: string; purpose: EmailOtpPurpose; otp: string },
  opts?: VerifyEmailOtpOptions,
): Promise<EmailOtpVerifyResult> {
  const email = canonicalizeEmail(input.email);
  const secret = getEmailOtpSecret();
  const client = opts?.client ?? redisUsersSessions;

  if (!/^\d{6}$/.test(input.otp)) {
    return { status: "INVALID" };
  }

  const expected = emailOtpDigest(secret, input.purpose, email, input.otp);
  const key = emailOtpKeyFor(input.purpose, email);

  let code: unknown;
  try {
    code = await client.eval(VERIFY_LUA, {
      keys: [key],
      arguments: [expected, String(OTP_MAX_ATTEMPTS)],
    });
  } catch (err) {
    logger.warn({ err, purpose: input.purpose }, "emailOtp.verify: store failed");
    throw new OtpServiceError("OTP service unavailable");
  }

  const status: EmailOtpVerifyStatus =
    Number(code) === 1
      ? "SUCCESS"
      : Number(code) === 2
        ? "MAX_ATTEMPTS"
        : Number(code) === 0
          ? "EXPIRED"
          : "INVALID";

  logger.info({ purpose: input.purpose, status }, "emailOtp.verify");
  return { status };
}

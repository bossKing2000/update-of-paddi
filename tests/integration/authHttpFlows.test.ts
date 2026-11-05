/**
 * Phase 1D / 1E — real-HTTP auth flows over REAL PostgreSQL + REAL Redis.
 *
 * These tests mount the actual Express auth router and drive it with supertest,
 * so the real route -> middleware -> controller -> zod -> Prisma path executes
 * end to end. Nothing in this file re-implements a controller to assert on it:
 * assertions are made on HTTP status/message plus the resulting database and
 * Redis state.
 *
 * External side effects are stubbed, business logic is not:
 *   - SMS delivery -> InMemorySmsProvider, so the generated code is captured.
 *   - Reset email -> sendResetEmail, so the 6-char reset code is captured.
 *   - geoMiddleware / trackUserAction -> pass-through, so no test performs a
 *     network call to ipapi.co or writes tracking rows asynchronously.
 *   - Rate limiters -> pass-through. Rate limiting has dedicated unit coverage
 *     (tests/unit/phoneOtpRateLimit.test.ts, secureResetRateLimit.test.ts,
 *     ipv6RateLimitBypass.test.ts). Mocking here is required because
 *     express-rate-limit uses a process-global in-memory store: without it a
 *     single file would exhaust the shared per-IP budget across its own cases
 *     and observe 429s that no real user would ever hit. The Redis-backed OTP
 *     budgets inside the service stay REAL and are still exercised.
 *
 * Isolation, so repeat runs against a long-lived disposable Redis are stable:
 *   - Every request carries its own X-Forwarded-For, so no two requests share a
 *     Redis per-IP OTP budget. `app.set("trust proxy", 1)` mirrors
 *     src/server.ts, and clientRateLimitIdentity() passes IPv4 through
 *     unchanged, so each address is genuinely a separate client.
 *   - Phone numbers are unique per run, so the service's per-number resend
 *     cooldown from a previous run cannot suppress an SMS this run expects.
 *
 * Note: the retired public SMS phone-login routes (`/phone/login/request-otp`,
 * `/phone/login/verify-otp`) no longer exist; email OTP login
 * (`/email/login/request-otp`, `/email/login/verify-otp`) is the passwordless
 * login method and is covered by tests/integration/emailOtpHttp.test.ts.
 *
 * Fails closed unless REDIS_URL names an authorized loopback target.
 */
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import bcrypt from "bcryptjs";

import prisma from "../../src/lib/prisma";
import { redisUsersSessions, redisPayments, connectRedis } from "../../src/lib/redis";
import { generateAccessToken } from "../../src/utils/generateToken";
import {
  InMemorySmsProvider,
  __setSmsProviderForTests,
} from "../../src/services/sms/smsProvider";
import { sendResetEmail } from "../../src/services/mail/sendResetEmail";
import authRoutes from "../../src/routes/auth.routes";
import { errorHandler } from "../../src/middlewares/error.middleware";
import type { Role } from "@prisma/client";

jest.mock("../../src/middlewares/rateLimiter.middleware", () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    authRateLimiter: passthrough,
    paymentRateLimiter: passthrough,
    checkoutRateLimiter: passthrough,
    otpRateLimiter: passthrough,
    phoneOtpRateLimiter: passthrough,
    passwordChangeRateLimiter: passthrough,
    secureResetRateLimiter: passthrough,
    cartSummaryRateLimiter: passthrough,
    aiRateLimiter: passthrough,
    emailOtpRateLimiter: passthrough,
  };
});

jest.mock("../../src/middlewares/geo.middleware", () => ({
  geoMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../src/middlewares/tracking.middleware", () => ({
  trackUserAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../src/services/mail/sendResetEmail", () => ({
  sendResetEmail: jest.fn(async () => undefined),
}));

const sendResetEmailMock = sendResetEmail as jest.MockedFunction<
  typeof sendResetEmail
>;

// Test-only OTP secret, following the convention already used by
// tests/unit/phoneOtp.test.ts and
// tests/integration/redis/phoneOtpRedis.integration.test.ts. The service reads
// PHONE_OTP_SECRET lazily on every call and rejects an empty value, so the
// suite needs one. This dummy is scoped to the test process and is NOT a
// credential: it signs nothing outside this disposable run and must never be
// copied into real configuration.
if (!process.env.PHONE_OTP_SECRET) {
  process.env.PHONE_OTP_SECRET =
    "test-only-phone-otp-secret-not-a-credential-authhttpflows";
}

const REDIS_URL = process.env.REDIS_URL ?? "";
if (!/^redis:\/\/127\.0\.0\.1:\d+/.test(REDIS_URL)) {
  throw new Error(
    "[authHttpFlows] BLOCKED: REDIS_URL must name the authorized disposable loopback target.",
  );
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRoutes);
app.use(errorHandler);

const OLD_PASSWORD = "Str0ngPass!";
const NEW_PASSWORD = "N3wStr0ngPass!";
const RESET_PASSWORD = "R3sEtStr0ngPass!";

const sms = new InMemorySmsProvider();

const createdUserIds: string[] = [];

/**
 * Each request gets a distinct client address inside the RFC 2544
 * documentation range, so the real Redis per-IP OTP budgets are never shared
 * between cases and never carry over from an earlier run of this file.
 */
let ipCounter = 0;
function nextClientIp(): string {
  ipCounter += 1;
  const octet3 = Math.floor(ipCounter / 250) % 250;
  const octet4 = (ipCounter % 250) + 1;
  return `198.18.${octet3}.${octet4}`;
}

/** POST with a fresh client identity attached. */
function post(path: string) {
  return request(app)
    .post(`/api/auth${path}`)
    .set("X-Forwarded-For", nextClientIp());
}

function get(path: string) {
  return request(app)
    .get(`/api/auth${path}`)
    .set("X-Forwarded-For", nextClientIp());
}

/**
 * Unique-per-run 11-digit local number. The per-number resend cooldown and the
 * unique index on phoneNumberE164 both persist in the disposable Redis and
 * PostgreSQL instances, so a fixed number would let a previous run's state
 * decide this run's outcome.
 */
const RUN_TAG = 1000 + Math.floor(Math.random() * 9000);
let phoneCounter = 0;
function nextLocalPhone(): string {
  phoneCounter += 1;
  return "080" + String(RUN_TAG * 10 + phoneCounter).padStart(8, "0");
}

function toE164(local: string): string {
  return "+234" + local.slice(1);
}

function uniqueEmail(tag: string): string {
  return (
    `${tag}-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@ahf.test`
  );
}

type MakeUserOptions = {
  email?: string;
  password?: string | null;
  role?: Role;
  roles?: Role[];
  isEmailVerified?: boolean;
  phoneNumberE164?: string | null;
  isPhoneVerified?: boolean;
};

async function makeUser(opts: MakeUserOptions = {}) {
  const role = opts.role ?? "CUSTOMER";
  const password = opts.password === undefined ? OLD_PASSWORD : opts.password;

  const user = await prisma.user.create({
    data: {
      name: "Auth Http Flow User",
      email: opts.email ?? uniqueEmail("user"),
      password: password ? bcrypt.hashSync(password, 10) : null,
      role,
      roles: opts.roles ?? [role],
      tokenVersion: 1,
      isEmailVerified: opts.isEmailVerified ?? true,
      phoneNumberE164: opts.phoneNumberE164 ?? null,
      isPhoneVerified: opts.isPhoneVerified ?? false,
    },
    select: { id: true, email: true },
  });

  createdUserIds.push(user.id);
  return user;
}

/**
 * Mirrors what `src/lib/session.ts` writes: the Redis session document keyed
 * `session:user:<userId>:<sessionId>` plus the matching UserSession row.
 */
async function makeSession(userId: string, activeRole: Role = "CUSTOMER") {
  const sessionId = `${userId}-sess`;
  const ttlSeconds = 30 * 24 * 3600;

  await prisma.userSession.create({
    data: {
      userId,
      sessionId,
      activeRole,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    },
  });

  await redisUsersSessions.set(
    `session:user:${userId}:${sessionId}`,
    JSON.stringify({ activeRole, lastLoginAt: new Date().toISOString() }),
    { EX: ttlSeconds },
  );

  return sessionId;
}

async function tokenFor(
  userId: string,
  sessionId: string,
  role: Role = "CUSTOMER",
  tokenVersion = 1,
): Promise<string> {
  return generateAccessToken(userId, role, sessionId, tokenVersion);
}

beforeAll(async () => {
  // redisUsersSessions carries sessions + OTP state; redisPayments carries the
  // per-email login-attempt counter that `login` reads before it will accept a
  // password. Both must be connected or the controller throws "The client is
  // closed" and the flow 500s. connectRedis is used rather than
  // ensureRedisReady() because the latter calls process.exit(1) on failure.
  await connectRedis(redisUsersSessions, "UserSessions").catch(() => undefined);
  await connectRedis(redisPayments, "Payments").catch(() => undefined);
  __setSmsProviderForTests(sms);
});

beforeEach(() => {
  sms.clear();
  sendResetEmailMock.mockClear();
});

afterAll(async () => {
  __setSmsProviderForTests(null);
  for (const userId of createdUserIds) {
    await prisma.userSession.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.passwordResetToken.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }
  await redisUsersSessions.quit().catch(() => undefined);
  await redisPayments.quit().catch(() => undefined);
});

describe("Phase 1D/1E — real HTTP auth flows over real PostgreSQL + Redis", () => {
  it("requests and verifies a phone OTP for an authenticated user (real Redis Lua verify)", async () => {
    const local = nextLocalPhone();
    const e164 = toE164(local);
    const user = await makeUser({ phoneNumberE164: e164, isPhoneVerified: false });
    const sessionId = await makeSession(user.id);
    const token = await tokenFor(user.id, sessionId);

    const requested = await post("/phone/request-otp")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: local, purpose: "PHONE_VERIFICATION" });

    expect(requested.status).toBe(200);
    expect(requested.body.message).toBe("Verification code sent");

    const otp = sms.lastOtpFor(e164);
    expect(otp).toMatch(/^\d{6}$/);

    const verified = await post("/phone/verify-otp")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: local, otp, purpose: "PHONE_VERIFICATION" });

    expect(verified.status).toBe(200);
    expect(verified.body.message).toBe("Phone number verified successfully");

    const stored = await prisma.user.findUnique({
      where: { id: user.id },
      select: { isPhoneVerified: true, phoneNumberE164: true },
    });
    expect(stored).toEqual({ isPhoneVerified: true, phoneNumberE164: e164 });
  });

  it("rejects a wrong phone OTP and exhausts the attempt budget (real Redis)", async () => {
    const local = nextLocalPhone();
    const e164 = toE164(local);
    const user = await makeUser({ phoneNumberE164: e164, isPhoneVerified: false });
    const sessionId = await makeSession(user.id);
    const token = await tokenFor(user.id, sessionId);

    const requested = await post("/phone/request-otp")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: local, purpose: "PHONE_VERIFICATION" });
    expect(requested.status).toBe(200);

    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await post("/phone/verify-otp")
        .set("Authorization", `Bearer ${token}`)
        .send({ phoneNumber: local, otp: "000000", purpose: "PHONE_VERIFICATION" });

      expect(wrong.status).toBe(400);
      expect(wrong.body.message).toBe("Invalid verification code");
    }

    const exhausted = await post("/phone/verify-otp")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: local, otp: "000000", purpose: "PHONE_VERIFICATION" });

    expect(exhausted.status).toBe(429);
    expect(exhausted.body.message).toBe(
      "Too many attempts, please request a new code",
    );
  });

  it("changes the password, kills the old token, and allows login with the new one", async () => {
    const user = await makeUser({ password: OLD_PASSWORD, isEmailVerified: true });
    const sessionId = await makeSession(user.id);
    const oldToken = await tokenFor(user.id, sessionId);

    const changed = await post("/change-password")
      .set("Authorization", `Bearer ${oldToken}`)
      .send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });

    expect(changed.status).toBe(200);
    expect(typeof changed.body.accessToken).toBe("string");

    // The tokenVersion bump means the pre-change access token must now fail.
    const afterChange = await post("/select-role")
      .set("Authorization", `Bearer ${oldToken}`)
      .send({ role: "ADMIN" });
    expect(afterChange.status).toBe(401);

    const oldPasswordLogin = await post("/login")
      .set("x-client-type", "mobile")
      .send({ email: user.email, password: OLD_PASSWORD });
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await post("/login")
      .set("x-client-type", "mobile")
      .send({ email: user.email, password: NEW_PASSWORD });
    expect(newPasswordLogin.status).toBe(200);
    expect(typeof newPasswordLogin.body.accessToken).toBe("string");
  });

  it("runs the full password reset: forgot -> verify code -> secure reset (single-use)", async () => {
    const user = await makeUser({ password: OLD_PASSWORD, isEmailVerified: true });

    const forgot = await post("/forgot-password").send({ email: user.email });

    expect(forgot.status).toBe(200);
    expect(forgot.body.message).toBe(
      "If an account exists for that address, a reset code has been sent.",
    );
    expect(sendResetEmailMock).toHaveBeenCalledTimes(1);
    const code = sendResetEmailMock.mock.calls[0][2];
    expect(code).toMatch(/^[A-Za-z0-9]{6}$/);

    const verifiedCode = await post("/verify-reset-code").send({
      email: user.email,
      code,
    });

    expect(verifiedCode.status).toBe(200);
    expect(verifiedCode.body.message).toBe("Reset code verified successfully");
    const resetToken = verifiedCode.body.resetToken;
    expect(typeof resetToken).toBe("string");

    const reset = await post("/secure-reset-password").send({
      resetToken,
      newPassword: RESET_PASSWORD,
    });

    expect(reset.status).toBe(200);
    expect(reset.body.message).toBe(
      "Password has been reset successfully. You have been logged out of all devices for security.",
    );

    // The reset token is single-use: replaying it must not mint another reset.
    const replay = await post("/secure-reset-password").send({
      resetToken,
      newPassword: RESET_PASSWORD,
    });
    expect([406, 407]).toContain(replay.status);

    const loggedIn = await post("/login")
      .set("x-client-type", "mobile")
      .send({ email: user.email, password: RESET_PASSWORD });
    expect(loggedIn.status).toBe(200);
    expect(typeof loggedIn.body.accessToken).toBe("string");
  });

  it("does not reveal account existence through forgot-password", async () => {
    const known = await makeUser({ isEmailVerified: true });
    const unknownEmail = uniqueEmail("absent");

    const knownResponse = await post("/forgot-password").send({ email: known.email });
    const unknownResponse = await post("/forgot-password").send({
      email: unknownEmail,
    });

    expect(knownResponse.status).toBe(unknownResponse.status);
    expect(knownResponse.body.message).toBe(unknownResponse.body.message);
  });

  it("rotates the refresh token on every use and treats an immediate retry as grace", async () => {
    const user = await makeUser({ password: OLD_PASSWORD, isEmailVerified: true });

    const loggedIn = await post("/login")
      .set("x-client-type", "mobile")
      .send({ email: user.email, password: OLD_PASSWORD });

    expect(loggedIn.status).toBe(200);
    expect(typeof loggedIn.body.accessToken).toBe("string");
    const firstRefresh = loggedIn.body.refreshToken;
    expect(typeof firstRefresh).toBe("string");

    const rotated = await post("/refresh-token").send({
      refreshToken: firstRefresh,
    });

    expect(rotated.status).toBe(200);
    expect(typeof rotated.body.accessToken).toBe("string");
    const secondRefresh = rotated.body.refreshToken;
    expect(typeof secondRefresh).toBe("string");
    expect(secondRefresh).not.toBe(firstRefresh);

    // Re-presenting the token that was JUST rotated is, by design, a benign
    // concurrent client retry rather than theft: src/lib/session.ts keeps the
    // previous JTI for REFRESH_GRACE_SECONDS (10s) and the CAS returns the
    // `grace` outcome. Grace must NOT rotate again — it re-mints against the
    // current JTI so competing clients converge on one token pair.
    const grace = await post("/refresh-token").send({
      refreshToken: firstRefresh,
    });

    expect(grace.status).toBe(200);
    expect(typeof grace.body.accessToken).toBe("string");
    expect(grace.body.refreshToken).toBe(secondRefresh);

    // The grace token is still live, so a normal refresh continues to work.
    const next = await post("/refresh-token").send({
      refreshToken: secondRefresh,
    });
    expect(next.status).toBe(200);
    expect(next.body.refreshToken).not.toBe(secondRefresh);
  });

  it("detects a stale-token replay as theft and revokes every session", async () => {
    const user = await makeUser({ password: OLD_PASSWORD, isEmailVerified: true });

    const loggedIn = await post("/login")
      .set("x-client-type", "mobile")
      .send({ email: user.email, password: OLD_PASSWORD });
    expect(loggedIn.status).toBe(200);

    const jti1 = loggedIn.body.refreshToken;

    // Rotate twice so jti1 is neither the current nor the immediately-previous
    // JTI — i.e. it has fallen out of the 10s grace window entirely.
    const rotate1 = await post("/refresh-token").send({ refreshToken: jti1 });
    expect(rotate1.status).toBe(200);
    const jti2 = rotate1.body.refreshToken;

    const rotate2 = await post("/refresh-token").send({ refreshToken: jti2 });
    expect(rotate2.status).toBe(200);
    expect(rotate2.body.refreshToken).not.toBe(jti2);

    // A stolen token from an earlier generation must be refused, and the
    // compromise must not leave any session usable.
    const replay = await post("/refresh-token").send({ refreshToken: jti1 });

    expect(replay.status).toBe(401);
    expect(replay.body.message).toBe("Session compromised. Please log in again.");

    const survivingSessions = await prisma.userSession.count({ where: { userId: user.id } });
    expect(survivingSessions).toBe(0);

    // tokenVersion was incremented, so even a still-valid access token is dead.
    const access = await get("/profile").set(
      "Authorization",
      `Bearer ${loggedIn.body.accessToken}`,
    );
    expect(access.status).toBe(401);
  });
});

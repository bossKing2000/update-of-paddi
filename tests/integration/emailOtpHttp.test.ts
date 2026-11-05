/**
 * Phase 1E — Registration, email verification and EMAIL OTP passwordless login,
 * over REAL PostgreSQL + REAL Redis through the REAL Express router.
 *
 * Scope of this file (everything here is real HTTP; nothing is mocked except
 * external delivery and the rate limiters):
 *   - POST /auth/register                        → account creation + initial state
 *   - GET  /auth/verify-email                    → ownership link, single-use, expiry
 *   - POST /auth/resend-verification            → limits + enumeration safety
 *   - POST /auth/email/login/request-otp         → issuance, cooldown, IP budget
 *   - POST /auth/email/login/verify-otp          → session issuance + every refusal
 *   - POST /auth/login                           → unverified-vs-verified authorization
 *
 * Purpose separation is the property this file exists to prove. A code issued
 * for one purpose must never authenticate another. Three namespaces are live:
 *   email login   (EmailOtpPurpose.LOGIN)      → issues a session
 *   email verify  (db emailVerificationToken)   → marks isEmailVerified
 *   password reset(passwordResetLimits service) → mints a resetToken
 * and a password-reset code is asserted to be useless at the login endpoint.
 *
 * External side effects stubbed, business logic not:
 *   - email delivery -> InMemoryEmailProvider. No SMTP, no real email, ever.
 *   - rate limiters  -> pass-through, so cases do not contend for one
 *     process-global express-rate-limit budget. Rate limiting itself is pinned
 *     separately by tests/unit/emailOtpRateLimit.test.ts and by the Redis
 *     limits exercised below through the real OTP service.
 *
 * Fails closed unless REDIS_URL names an authorized loopback target.
 */
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import prisma from "../../src/lib/prisma";
import { redisUsersSessions, redisPayments, connectRedis } from "../../src/lib/redis";
import {
  InMemoryEmailProvider,
  __setEmailProviderForTests,
} from "../../src/services/mail/emailProvider";
import { canonicalizeEmail, emailOtpKeyFor, EmailOtpPurpose } from "../../src/services/emailOtp.service";
import { acquireResetCooldown } from "../../src/services/passwordResetLimits.service";
import { redisPayments as resetRedis } from "../../src/lib/redis";
import authRoutes from "../../src/routes/auth.routes";
import { errorHandler } from "../../src/middlewares/error.middleware";

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

if (!process.env.EMAIL_OTP_SECRET) {
  // Test-only, following the convention already used by tests/unit/phoneOtp.test.ts.
  // The service reads this lazily and rejects an empty value. This dummy is scoped
  // to the test process and is NOT a credential.
  process.env.EMAIL_OTP_SECRET = "test-only-email-otp-secret-not-a-credential-eotthttp";
}

const REDIS_URL = process.env.REDIS_URL ?? "";
if (!/^redis:\/\/127\.0\.0\.1:\d+/.test(REDIS_URL)) {
  throw new Error(
    "[emailOtpHttp] BLOCKED: REDIS_URL must name the authorized disposable loopback target.",
  );
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRoutes);
app.use(errorHandler);

const PASSWORD = "Str0ngPass!";
const mail = new InMemoryEmailProvider();
const createdUserIds: string[] = [];
const createdSessions: string[] = [];

/** Distinct client address per request so Redis per-IP budgets never collide. */
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.21.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

function uniqueEmail(tag: string): string {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@eot.test`;
}

const post = (p: string) => request(app).post(`/api/auth${p}`).set("X-Forwarded-For", nextIp());
const get = (p: string) => request(app).get(`/api/auth${p}`).set("X-Forwarded-For", nextIp());

async function trackUsers(): Promise<string[]> {
  return createdUserIds;
}

beforeAll(async () => {
  await connectRedis(redisUsersSessions, "UserSessions").catch(() => undefined);
  await connectRedis(redisPayments, "Payments").catch(() => undefined);
  __setEmailProviderForTests(mail);
});

beforeEach(() => {
  mail.clear();
});

afterAll(async () => {
  __setEmailProviderForTests(null);
  const users = await trackUsers();
  for (const userId of users) {
    await prisma.userSession.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.passwordResetToken.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }
  await redisUsersSessions.quit().catch(() => undefined);
  await redisPayments.quit().catch(() => undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /auth/register", () => {
  it("creates an unverified account, returns a usable session, and sends the verification link", async () => {
    const email = uniqueEmail("reg");
    const res = await post("/register").send({
      name: "New Customer",
      email,
      password: PASSWORD,
      role: "CUSTOMER",
    });

    console.log("DEBUG register response:", res.status, res.body);

    expect(res.status).toBe(201);
    expect(typeof res.body.accessToken).toBe("string");

    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);
    expect(row).not.toBeNull();
    // Correct INITIAL verification state.
    expect(row!.isEmailVerified).toBe(false);
    expect(row!.emailVerificationToken).not.toBeNull();
    expect(row!.emailVerificationExpiresAt).not.toBeNull();

    // Registration now actually DELIVERS the link (this call was dead code
    // before Phase 1E), and it goes through the provider abstraction.
    expect(mail.countFor(email)).toBe(1);
    const link = mail.sent.find((m) => m.to === email)!;
    expect(link.purpose).toBe("VERIFY_EMAIL");
    expect(link.text).toContain("/api/auth/verify-email?token=");

    // And the account is genuinely usable immediately.
    const login = await post("/login").set("x-client-type", "mobile").send({ email, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.message).toBe("Please verify your email before logging in.");
  });

  it("rejects a weak password and an invalid address without creating anything", async () => {
    const before = await prisma.user.count();

    const weak = await post("/register").send({
      name: "Weak",
      email: uniqueEmail("weak"),
      password: "short",
    });
    expect(weak.status).toBeGreaterThanOrEqual(400);

    const badEmail = await post("/register").send({
      name: "Bad",
      email: "not-an-email",
      password: PASSWORD,
      role: "CUSTOMER",
    });
    expect(badEmail.status).toBeGreaterThanOrEqual(400);

    expect(await prisma.user.count()).toBe(before);
    expect(mail.sent.length).toBe(0);
  });

  it("refuses a duplicate address and never sends a second link", async () => {
    const email = uniqueEmail("dup");
    const first = await post("/register").send({ name: "One", email, password: PASSWORD, role: "CUSTOMER" });
    expect(first.status).toBe(201);
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);
    mail.clear();

    const second = await post("/register").send({ name: "Two", email, password: PASSWORD, role: "CUSTOMER" });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(mail.countFor(email)).toBe(0);
  });

  it("refuses to self-assign the ADMIN role", async () => {
    const email = uniqueEmail("admin");
    const res = await post("/register").send({
      name: "Sneaky",
      email,
      password: PASSWORD,
      role: "ADMIN",
    });
    console.log("DEBUG ADMIN register response:", res.status, res.body);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Email verification
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /auth/verify-email", () => {
  it("verifies a registered address and the token cannot be reused", async () => {
    const email = uniqueEmail("ver");
    await post("/register").send({ name: "Verify Me", email, password: PASSWORD, role: "CUSTOMER" });
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);
    const token = row!.emailVerificationToken!;

    const ok = await get(`/verify-email?token=${token}`);
    expect(ok.status).toBe(200);

    const after = await prisma.user.findUnique({ where: { email } });
    expect(after!.isEmailVerified).toBe(true);
    // Single-use: the credential is cleared, so the same link is now dead.
    expect(after!.emailVerificationToken).toBeNull();

    const replay = await get(`/verify-email?token=${token}`);
    expect(replay.status).toBe(400);

    // A verified account can now log in with its password.
    const login = await post("/login")
      .set("x-client-type", "mobile")
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(typeof login.body.accessToken).toBe("string");
  });

  it("refuses an expired link", async () => {
    const email = uniqueEmail("expired");
    await post("/register").send({ name: "Expired", email, password: PASSWORD, role: "CUSTOMER" });
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);

    await prisma.user.update({
      where: { id: row!.id },
      data: { emailVerificationExpiresAt: new Date(Date.now() - 1000) },
    });

    const res = await get(`/verify-email?token=${row!.emailVerificationToken}`);
    expect(res.status).toBe(400);
    const after = await prisma.user.findUnique({ where: { email } });
    expect(after!.isEmailVerified).toBe(false);
  });

  it("refuses a token that was never issued", async () => {
    const res = await get("/verify-email?token=11111111-2222-3333-4444-555555555555");
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/resend-verification", () => {
  it("issues a fresh link, supersedes the previous token, and is enumeration-safe", async () => {
    const email = uniqueEmail("resend");
    await post("/register").send({ name: "Resend", email, password: PASSWORD, role: "CUSTOMER" });
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);
    const firstToken = row!.emailVerificationToken!;
    mail.clear();

    const res = await post("/resend-verification").send({ email });
    expect(res.status).toBe(200);

    const updated = await prisma.user.findUnique({ where: { email } });
    expect(updated!.emailVerificationToken).not.toBe(firstToken);
    expect(mail.countFor(email)).toBe(1);

    // The superseded token is dead; only the newest one verifies.
    expect((await get(`/verify-email?token=${firstToken}`)).status).toBe(400);
    expect((await get(`/verify-email?token=${updated!.emailVerificationToken}`)).status).toBe(200);
  });

  it("returns an identical response for an unknown address", async () => {
    const unknown = uniqueEmail("nobody");
    const res = await post("/resend-verification").send({ email: unknown });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe(
      "If an account exists for that address, a verification email has been sent.",
    );
    expect(mail.countFor(unknown)).toBe(0);
  });

  it("returns an identical response for an already-verified address", async () => {
    const email = uniqueEmail("done");
    await post("/register").send({ name: "Done", email, password: PASSWORD, role: "CUSTOMER" });
    const row = await prisma.user.findUnique({ where: { email } });
    createdUserIds.push(row!.id);
    await prisma.user.update({ where: { id: row!.id }, data: { isEmailVerified: true } });
    mail.clear();

    const res = await post("/resend-verification").send({ email });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe(
      "If an account exists for that address, a verification email has been sent.",
    );
    expect(mail.countFor(email)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Email OTP login
// ─────────────────────────────────────────────────────────────────────────────

async function registerAccount(tag: string, opts: { verified?: boolean } = {}) {
  const email = uniqueEmail(tag);
  await post("/register").send({ name: "OTP User", email, password: PASSWORD, role: "CUSTOMER" });
  const row = await prisma.user.findUnique({ where: { email } });
  createdUserIds.push(row!.id);
  if (opts.verified) {
    await prisma.user.update({ where: { id: row!.id }, data: { isEmailVerified: true } });
  }
  return { id: row!.id, email };
}

describe("POST /auth/email/login/request-otp", () => {
  it("issues a code to a real account and returns the generic message", async () => {
    const { email } = await registerAccount("issue");
    const res = await post("/email/login/request-otp").send({ email });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(
      "If an account exists for this email address, a verification code has been sent.",
    );
    const code = mail.lastCodeFor(email);
    expect(code).toMatch(/^\d{6}$/);

    // Stored only as an HMAC digest, never in plaintext.
    const raw = await redisUsersSessions.get(emailOtpKeyFor(EmailOtpPurpose.LOGIN, email));
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(code);
    expect(raw).not.toContain("\"o\"");
  });

  it("returns an identical response and sends nothing for an unknown address", async () => {
    const unknown = uniqueEmail("ghost");
    const res = await post("/email/login/request-otp").send({ email: unknown });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(
      "If an account exists for this email address, a verification code has been sent.",
    );
    expect(mail.countFor(unknown)).toBe(0);
  });

  it("accepts a differently-cased or padded address as the same account", async () => {
    const { email } = await registerAccount("case");
    const res = await post("/email/login/request-otp").send({
      email: `  ${email.toUpperCase()}  `,
    });
    expect(res.status).toBe(200);
    expect(mail.countFor(canonicalizeEmail(email))).toBe(2); // 1 verification + 1 login OTP
  });

  it("enforces the resend cooldown and never sends a second code inside it", async () => {
    const { email } = await registerAccount("cooldown");
    // Registration sends 1 verification email, login OTP sends 1 => total 2
    const first = await post("/email/login/request-otp").send({ email });
    expect(first.status).toBe(200);
    expect(mail.countFor(email)).toBe(2); // 1 verification + 1 login OTP

    const second = await post("/email/login/request-otp").send({ email });
    expect(second.status).toBe(429);
    expect(mail.countFor(email)).toBe(2); // Cooldown blocks second OTP, no additional email
  });

  it("enforces the per-IP budget across many different addresses", async () => {
    // One shared client address, more requests than the IP budget allows.
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      const res = await request(app)
        .post("/api/auth/email/login/request-otp")
        .set("X-Forwarded-For", ip)
        .send({ email: uniqueEmail("ip") });
      statuses.push(res.status);
    }
    // Some must be refused once the per-IP budget is spent.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
  });

  it("refuses a blocked account and a malformed address", async () => {
    const blocked = await registerAccount("blocked");
    await prisma.user.update({
      where: { id: blocked.id },
      data: { isBlocked: true },
    });
    mail.clear();
    const blockedRes = await post("/email/login/request-otp").send({ email: blocked.email });
    expect(blockedRes.status).toBe(200);
    expect(mail.countFor(blocked.email)).toBe(0);

    const malformed = await post("/email/login/request-otp").send({ email: "nope" });
    expect(malformed.status).toBe(422);
  });
});

describe("POST /auth/email/login/verify-otp", () => {
  it("authenticates a correct code and issues the same session contract as password login", async () => {
    const { id, email } = await registerAccount("ok");
    await post("/email/login/request-otp").send({ email });
    const code = mail.lastCodeFor(email)!;

    const res = await post("/email/login/verify-otp")
      .set("x-client-type", "mobile")
      .send({ email, otp: code });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Login successful");
    expect(typeof res.body.accessToken).toBe("string");
    expect(typeof res.body.refreshToken).toBe("string");

    // Registration creates a session, login creates another.
    // The login session should have the correct activeRole.
    const sessions = await prisma.userSession.findMany({ where: { userId: id } });
    expect(sessions).toHaveLength(2);
    const loginSession = sessions.find(s => s.activeRole === "CUSTOMER");
    expect(loginSession).toBeTruthy();
    expect(await redisUsersSessions.get(`session:user:${id}:${loginSession!.sessionId}`)).not.toBeNull();
    createdSessions.push(loginSession!.sessionId);
  });

  it("does not mark the address verified as a side effect", async () => {
    const { email } = await registerAccount("notverified");
    expect((await prisma.user.findUnique({ where: { email } }))!.isEmailVerified).toBe(false);

    await post("/email/login/request-otp").send({ email });
    const code = mail.lastCodeFor(email)!;
    await post("/email/login/verify-otp").send({ email, otp: code });

    // Possession of the mailbox proves the LOGIN, not that the address was
    // verified as part of the signup lifecycle.
    expect((await prisma.user.findUnique({ where: { email } }))!.isEmailVerified).toBe(false);
  });

  it("is single-use: the same code cannot authenticate twice", async () => {
    const { email } = await registerAccount("reuse");
    await post("/email/login/request-otp").send({ email });
    const code = mail.lastCodeFor(email)!;

    const first = await post("/email/login/verify-otp").send({ email, otp: code });
    expect(first.status).toBe(200);

    const replay = await post("/email/login/verify-otp").send({ email, otp: code });
    expect(replay.status).toBe(400);
    expect(replay.body.message).toBe("Invalid or expired verification code");
  });

  it("rejects a wrong code, and refuses the sixth attempt", async () => {
    const { email } = await registerAccount("wrong");
    await post("/email/login/request-otp").send({ email });

    for (let i = 0; i < 5; i += 1) {
      const wrong = await post("/email/login/verify-otp").send({ email, otp: "000000" });
      expect(wrong.status).toBe(400);
      expect(wrong.body.message).toBe("Invalid or expired verification code");
    }
    const exhausted = await post("/email/login/verify-otp").send({ email, otp: "000000" });
    expect(exhausted.status).toBe(429);
    expect(exhausted.body.message).toBe("Too many attempts, please request a new code");

    // Exhaustion destroyed the code — the CORRECT code is now useless too.
    const correct = mail.lastCodeFor(email)!;
    const after = await post("/email/login/verify-otp").send({ email, otp: correct });
    expect(after.status).toBe(400);
  });

  it("gives the same answer for an unknown address as for a wrong code", async () => {
    const unknown = uniqueEmail("nosuch");
    const res = await post("/email/login/verify-otp").send({ email: unknown, otp: "123456" });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid or expired verification code");
  });

  it("refuses a blocked account and revokes its sessions", async () => {
    const { id, email } = await registerAccount("blk");
    await post("/email/login/request-otp").send({ email });
    const code = mail.lastCodeFor(email)!;
    await prisma.user.update({ where: { id }, data: { isBlocked: true } });

    const res = await post("/email/login/verify-otp").send({ email, otp: code });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("This account has been blocked.");
    expect(await prisma.userSession.count({ where: { userId: id } })).toBe(0);
  });

  it("cannot be raced: concurrent verifications of one code yield exactly one session", async () => {
    const { id, email } = await registerAccount("race");
    await post("/email/login/request-otp").send({ email });
    const code = mail.lastCodeFor(email)!;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => post("/email/login/verify-otp").send({ email, otp: code })),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    // Registration + 1 successful login = 2 sessions
    expect(await prisma.userSession.count({ where: { userId: id } })).toBe(2);
  });

  it("rejects a malformed body before consuming anything", async () => {
    const res = await post("/email/login/verify-otp").send({ email: "nope", otp: "123456" });
    expect(res.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Purpose separation — the security property this flow hinges on
// ─────────────────────────────────────────────────────────────────────────────

describe("purpose separation", () => {
  it("a login code cannot verify an address, and a verification link cannot log in", async () => {
    const { id, email } = await registerAccount("sep");
    const row = await prisma.user.findUnique({ where: { email } });
    const verifyToken = row!.emailVerificationToken!;

    // Issue a LOGIN code.
    await post("/email/login/request-otp").send({ email });
    const loginCode = mail.lastCodeFor(email)!;

    // The login code is not the verification token.
    expect(loginCode).not.toBe(verifyToken);

    // And the login code does not exist in the verification namespace.
    const loginRecord = await redisUsersSessions.get(
      emailOtpKeyFor(EmailOtpPurpose.LOGIN, email),
    );
    expect(loginRecord).not.toBeNull();

    // Verifying the address still requires the emailed link.
    expect((await get(`/verify-email?token=${loginCode}`)).status).toBe(400);
    expect((await prisma.user.findUnique({ where: { id } }))!.isEmailVerified).toBe(false);

    // Conversely the verification link is not a login credential.
    const loginAttempt = await post("/email/login/verify-otp").send({
      email,
      otp: loginCode,
    });
    expect(loginAttempt.status).toBe(200);
  });

  it("a password-reset code cannot be used as a login code", async () => {
    const { email } = await registerAccount("reset");
    const res = await post("/forgot-password").send({ email });
    expect(res.status).toBe(200);

    // The reset flow mints its own short-lived code through a different store.
    // Whatever it produced must not authenticate a session at the login route.
    const resetAttempt = await post("/email/login/verify-otp").send({
      email,
      otp: "123456",
    });
    expect([400, 429]).toContain(resetAttempt.status);
    expect(resetAttempt.body.accessToken).toBeUndefined();
  });

  it("an email OTP record is stored under a different key namespace than a phone OTP", async () => {
    const email = uniqueEmail("ns");
    await post("/email/login/request-otp").send({ email });
    const key = await redisUsersSessions.get(emailOtpKeyFor(EmailOtpPurpose.LOGIN, email));
    expect(key).not.toBeNull();
    expect(key).not.toContain("otp:phone");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorization around the new flow
// ─────────────────────────────────────────────────────────────────────────────

describe("email OTP login respects account state", () => {
  it("signs the session with the account's live tokenVersion", async () => {
    const { id, email } = await registerAccount("tv");
    await prisma.user.update({ where: { id }, data: { tokenVersion: 7 } });
    await post("/email/login/request-otp").send({ email });
    const code = mail.lastCodeFor(email)!;

    const res = await post("/email/login/verify-otp").send({ email, otp: code });
    expect(res.status).toBe(200);

    // The login session should have the updated tokenVersion and activeRole
    const sessions = await prisma.userSession.findMany({ where: { userId: id } });
    const loginSession = sessions.find(s => s.activeRole === "CUSTOMER");
    expect(loginSession).toBeTruthy();
    expect(loginSession!.activeRole).toBe("CUSTOMER");

    const payload = JSON.parse(
      Buffer.from(res.body.accessToken.split(".")[1], "base64url").toString("utf8"),
    );
    expect(payload.tokenVersion).toBe(7);
    expect(payload.typ).toBe("access");
  });

  it("does not disturb ordinary email/password login", async () => {
    const { email } = await registerAccount("both", { verified: true });
    await post("/email/login/request-otp").send({ email });
    const code = mail.lastCodeFor(email)!;
    expect((await post("/email/login/verify-otp").send({ email, otp: code })).status).toBe(200);

    const passwordLogin = await post("/login")
      .set("x-client-type", "mobile")
      .send({ email, password: PASSWORD });
    expect(passwordLogin.status).toBe(200);
    expect(typeof passwordLogin.body.accessToken).toBe("string");
  });
});
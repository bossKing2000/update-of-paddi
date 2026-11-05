/**
 * Phase 1F.2 item 8 — logout and revocation over REAL PostgreSQL + REAL Redis.
 *
 * Scope: the four authenticated session endpoints in `src/routes/auth.routes.ts`
 *   POST   /logout                 — revoke THIS device only
 *   POST   /logout-all-devices     — revoke every session + bump tokenVersion
 *   GET    /sessions               — list this user's sessions, flag the current one
 *   DELETE /sessions/:sessionId   — revoke one named session of this user
 *
 * Why this file exists: tests/unit/changePassword.test.ts already covers
 * "logout revokes only the current session" and "logout-all bumps the token
 * version", but those mock `src/lib/session.ts` entirely. They prove the
 * controller CALLS the revoker; they cannot prove the Redis session document
 * and the UserSession row are actually removed, that an already-issued access
 * token stops working, or that a refresh token stops working. This file drives
 * the real router over HTTP against disposable infrastructure and asserts on
 * observable server state.
 *
 * Contract, derived from the implementation (not invented here):
 *   - `logout` (auth.controller.ts) revokes ONLY the caller's current session.
 *     The source comment is explicit that it must NOT call
 *     `incrementTokenVersion`, because doing so used to silently break every
 *     other logged-in device too.
 *   - `logoutAllDevices` revokes every session AND increments tokenVersion, so
 *     no outstanding access or refresh token on any device can mint a new one.
 *   - `revokeSession` resolves the target through `req.user.id`, i.e. the
 *     caller can only name a session under their own account.
 *   - `authenticate` (auth.middleware.ts) is what actually enforces revocation:
 *     it re-reads the session every request, so a revoked session yields 401
 *     "Session expired or not found. Please log in again." even though the JWT
 *     itself is still cryptographically valid and unexpired.
 *
 * External side effects stubbed, business logic not: rate limiters, geo and
 * tracking only. Rate limiting has dedicated unit coverage
 * (phoneOtpRateLimit / secureResetRateLimit / ipv6RateLimitBypass) and the
 * in-process express-rate-limit store is global, so leaving it live would make
 * cases contend for one shared per-IP budget.
 *
 * Fails closed unless REDIS_URL names an authorized loopback target.
 */
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import prisma from "../../src/lib/prisma";
import { redisUsersSessions, redisPayments, connectRedis } from "../../src/lib/redis";
import { generateAccessToken } from "../../src/utils/generateToken";
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

jest.mock("../../src/services/mail/emailProvider", () => {
  const provider = {
    name: "memory",
    sendEmail: jest.fn(async () => {}),
  };
  return {
    __esModule: true,
    getEmailProvider: jest.fn(() => provider),
    EmailProviderError: class extends Error { constructor(m: string) { super(m); this.name = "EmailProviderError"; } },
    LogEmailProvider: class { name = "log"; async sendEmail() {} },
    InMemoryEmailProvider: class { name = "memory"; sent: { to: string; otp: string }[] = []; async sendEmail(i: { to: string; otp: string }) { this.sent.push(i); } lastCodeFor(t: string) { for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].to === t) return this.sent[i].otp; return null; } clear() { this.sent.length = 0; } },
    FailingEmailProvider: class { name = "failing"; async sendEmail() { throw new Error("Email gateway unavailable"); } },
    SmtpEmailProvider: class { name = "smtp"; async sendEmail() { throw new Error("Not implemented"); } },
    maskEmail: (e: string) => e,
    __setEmailProviderForTests: jest.fn(),
  };
});

jest.mock("../../src/services/emailOtp.service", () => {
  const EmailOtpPurpose = { LOGIN: "LOGIN", VERIFY_EMAIL: "VERIFY_EMAIL" };
  const canonicalizeEmail = (e: string) => e.trim().toLowerCase();
  const emailOtpKeyFor = (purpose: string, email: string) => `otp:email:${purpose}:${canonicalizeEmail(email)}`;
  const emailOtpRateLimitKeyFor = (email: string) => `otp:rl:email:${email.toLowerCase().trim()}`;
  const emailOtpIpRateLimitKeyFor = (ip: string) => `otp:rl:email-ip:${ip}`;
  const EMAIL_OTP_MAX_REQUESTS_PER_ADDRESS = 5;
  return {
    __esModule: true,
    requestEmailOtp: jest.fn(async () => ({ status: "SUCCESS" })),
    verifyEmailOtp: jest.fn(async () => ({ status: "SUCCESS" })),
    clearEmailOtp: jest.fn(async () => {}),
    EmailOtpPurpose,
    canonicalizeEmail,
    emailOtpKeyFor,
    emailOtpRateLimitKeyFor,
    emailOtpIpRateLimitKeyFor,
    EMAIL_OTP_MAX_REQUESTS_PER_ADDRESS,
  };
});

const REDIS_URL = process.env.REDIS_URL ?? "";
if (!/^redis:\/\/127\.0\.0\.1:\d+/.test(REDIS_URL)) {
  throw new Error(
    "[logoutRevocationHttp] BLOCKED: REDIS_URL must name the authorized disposable loopback target.",
  );
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRoutes);
app.use(errorHandler);

const PASSWORD = "Str0ngPass!";
const createdUserIds: string[] = [];

let ipCounter = 0;
function nextClientIp(): string {
  ipCounter += 1;
  return `198.20.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

function uniqueEmail(tag: string): string {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@lrh.test`;
}

type Session = { accessToken: string; refreshToken: string; sessionId: string };

async function makeUser(role: Role = "CUSTOMER", roles: Role[] = [role]) {
  const user = await prisma.user.create({
    data: {
      name: "Logout Revocation User",
      email: uniqueEmail("lrh"),
      password: bcrypt.hashSync(PASSWORD, 10),
      role,
      roles,
      tokenVersion: 1,
      isEmailVerified: true,
    },
    select: { id: true, email: true },
  });
  createdUserIds.push(user.id);
  return user;
}

function post(path: string) {
  return request(app).post(`/api/auth${path}`).set("X-Forwarded-For", nextClientIp());
}
function get(path: string) {
  return request(app).get(`/api/auth${path}`).set("X-Forwarded-For", nextClientIp());
}
function del(path: string) {
  return request(app).delete(`/api/auth${path}`).set("X-Forwarded-For", nextClientIp());
}

/**
 * A real login through the real controller: it mints the access/refresh pair,
 * creates the UserSession row and writes the Redis session document, exactly
 * as a real client would receive it. Two logins therefore yield two genuinely
 * independent sessions, which is what "one device" vs "all devices" needs.
 */
async function loginAs(user: { id: string; email: string }): Promise<Session> {
  const res = await post("/login")
    .set("x-client-type", "mobile")
    .send({ email: user.email, password: PASSWORD });

  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  // sessionId is signed into the access token; reading it here is test
  // bookkeeping so the test can name the session on later requests.
  const decoded = jwt.decode(res.body.accessToken) as { sessionId: string };

  return {
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    sessionId: decoded.sessionId,
  };
}

/** Authoritative server-side state for one session, from both stores. */
async function sessionState(userId: string, sessionId: string) {
  const [row, redisDoc] = await Promise.all([
    prisma.userSession.findUnique({ where: { sessionId }, select: { userId: true } }),
    redisUsersSessions.get(`session:user:${userId}:${sessionId}`),
  ]);
  return {
    dbRowExists: row !== null,
    dbRowBelongsToUser: row?.userId === userId,
    redisDocExists: redisDoc !== null,
  };
}

async function tokenVersionOf(userId: string): Promise<number> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { tokenVersion: true },
  });
  return row?.tokenVersion ?? -1;
}

/** Access token for an authenticated route, asserting nothing. */
function asAccess(token: string) {
  return get("/profile").set("Authorization", `Bearer ${token}`);
}
/** Refresh through the real public endpoint. */
function asRefresh(refreshToken: string) {
  return post("/refresh-token").send({ refreshToken });
}

beforeAll(async () => {
  // redisUsersSessions holds the session documents, the per-user session index
  // and the refresh-JTI keys that replay detection depends on. redisPayments
  // holds the per-email login-attempt counter `login` reads before it will
  // accept a password. Both are needed: an unconnected client throws
  // "The client is closed" and turns a real revocation into a 500.
  await connectRedis(redisUsersSessions, "UserSessions").catch(() => undefined);
  await connectRedis(redisPayments, "Payments").catch(() => undefined);
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await prisma.loginHistory.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.userSession.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }
  await redisUsersSessions.quit().catch(() => undefined);
  await redisPayments.quit().catch(() => undefined);
});

describe("Phase 1F.2 item 8 — logout and revocation over real PostgreSQL + Redis", () => {
  it("logs out the current device only: its access and refresh tokens die, other devices survive", async () => {
    const user = await makeUser();
    const deviceA = await loginAs(user);
    const deviceB = await loginAs(user);

    // Precondition: both devices are independently live.
    expect((await asAccess(deviceA.accessToken)).status).toBe(200);
    expect((await asAccess(deviceB.accessToken)).status).toBe(200);
    expect(await sessionState(user.id, deviceA.sessionId)).toEqual({
      dbRowExists: true,
      dbRowBelongsToUser: true,
      redisDocExists: true,
    });
    expect(await sessionState(user.id, deviceB.sessionId)).toEqual({
      dbRowExists: true,
      dbRowBelongsToUser: true,
      redisDocExists: true,
    });

    const versionBefore = await tokenVersionOf(user.id);

    const loggedOut = await post("/logout").set("Authorization", `Bearer ${deviceA.accessToken}`);
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.body.message).toBe("Logged out successfully");

    // Server-side revocation actually happened in BOTH stores.
    const afterA = await sessionState(user.id, deviceA.sessionId);
    expect(afterA.dbRowExists).toBe(false);
    expect(afterA.redisDocExists).toBe(false);

    // The access token is still cryptographically valid and unexpired, but
    // `authenticate` re-reads the session every request, so it must now fail.
    const accessAfter = await asAccess(deviceA.accessToken);
    expect(accessAfter.status).toBe(401);
    expect(accessAfter.body.message).toBe("Session expired or not found. Please log in again.");

    // Client-side token deletion is NOT enough — the refresh token must be dead
    // server-side too. `refreshToken` rotates the JTI, then re-checks the
    // session, finds it gone, and refuses without minting.
    const refreshAfter = await asRefresh(deviceA.refreshToken);
    expect(refreshAfter.status).toBe(401);

    // The other device is untouched: logout must not be account-wide.
    expect((await asAccess(deviceB.accessToken)).status).toBe(200);
    const refreshB = await asRefresh(deviceB.refreshToken);
    expect(refreshB.status).toBe(200);
    expect(refreshB.body.accessToken).toBeDefined();
    expect(refreshB.body.refreshToken).not.toBe(deviceB.refreshToken);

    expect(await sessionState(user.id, deviceB.sessionId)).toEqual({
      dbRowExists: true,
      dbRowBelongsToUser: true,
      redisDocExists: true,
    });

    // Per-device logout must NOT bump tokenVersion — that is what
    // logout-all-devices is for, and bumping it here is the documented old bug.
    expect(await tokenVersionOf(user.id)).toBe(versionBefore);
  });

  it("refuses logout without a usable access session", async () => {
    const user = await makeUser();
    const device = await loginAs(user);

    // No Authorization header at all.
    const noToken = await post("/logout");
    expect(noToken.status).toBe(401);
    expect(noToken.body.message).toBe("No token provided");

    // Structurally invalid credential.
    const garbage = await post("/logout").set("Authorization", "Bearer not-a-jwt");
    expect(garbage.status).toBe(401);
    expect(garbage.body.message).toBe("Invalid or expired token");

    // A well-formed access token for a session that does not exist. This is
    // the shape a revoked/forged session presents, and it must not be honoured.
    const orphan = generateAccessToken(user.id, "CUSTOMER", `${user.id}-never-created`, 1);
    const orphanRes = await post("/logout").set("Authorization", `Bearer ${orphan}`);
    expect(orphanRes.status).toBe(401);
    expect(orphanRes.body.message).toBe("Session expired or not found. Please log in again.");

    // Access and refresh tokens share one signing secret, so a refresh token
    // must not be usable as a Bearer credential (the `typ !== "access"` gate).
    const refreshAsAccess = await post("/logout").set(
      "Authorization",
      `Bearer ${device.refreshToken}`,
    );
    expect(refreshAsAccess.status).toBe(401);
    expect(refreshAsAccess.body.message).toBe("Invalid or expired token");

    // None of the above may have disturbed the real session.
    expect((await asAccess(device.accessToken)).status).toBe(200);
  });

  it("refuses a repeated logout with the same token", async () => {
    const user = await makeUser();
    const device = await loginAs(user);

    const first = await post("/logout").set("Authorization", `Bearer ${device.accessToken}`);
    expect(first.status).toBe(200);

    // The session is gone, so the identical (still cryptographically valid)
    // token is now indistinguishable from a revoked one.
    const second = await post("/logout").set("Authorization", `Bearer ${device.accessToken}`);
    expect(second.status).toBe(401);
    expect(second.body.message).toBe("Session expired or not found. Please log in again.");

    // Logout is not idempotent-by-silence here: it fails closed, which is the
    // documented authenticate behaviour rather than a logout-specific rule.
    expect(await sessionState(user.id, device.sessionId)).toEqual({
      dbRowExists: false,
      dbRowBelongsToUser: false,
      redisDocExists: false,
    });
  });

  it("logs out every device and bumps tokenVersion so no token survives", async () => {
    const user = await makeUser();
    const deviceA = await loginAs(user);
    const deviceB = await loginAs(user);
    const versionBefore = await tokenVersionOf(user.id);

    const res = await post("/logout-all-devices").set(
      "Authorization",
      `Bearer ${deviceA.accessToken}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Logged out from all devices");

    // Every session row is gone, on every device.
    const remaining = await prisma.userSession.count({ where: { userId: user.id } });
    expect(remaining).toBe(0);
    expect(await sessionState(user.id, deviceA.sessionId)).toEqual({
      dbRowExists: false,
      dbRowBelongsToUser: false,
      redisDocExists: false,
    });
    expect(await sessionState(user.id, deviceB.sessionId)).toEqual({
      dbRowExists: false,
      dbRowBelongsToUser: false,
      redisDocExists: false,
    });

    // Access tokens: the session lookup fails, AND tokenVersion moved on.
    expect((await asAccess(deviceA.accessToken)).status).toBe(401);
    expect((await asAccess(deviceB.accessToken)).status).toBe(401);

    // Refresh tokens: sessions gone and JTI state swept, so neither device can
    // mint a new pair.
    expect((await asRefresh(deviceA.refreshToken)).status).toBe(401);
    expect((await asRefresh(deviceB.refreshToken)).status).toBe(401);

    expect(await tokenVersionOf(user.id)).toBe(versionBefore + 1);
  });

  it("revokes one named session of your own account without signing you out", async () => {
    const user = await makeUser();
    const current = await loginAs(user);
    const other = await loginAs(user);
    const versionBefore = await tokenVersionOf(user.id);

    const listed = await get("/sessions").set("Authorization", `Bearer ${current.accessToken}`);
    expect(listed.status).toBe(200);
    const listedIds = (listed.body.sessions as Array<{ sessionId: string; current: boolean }>).map(
      (s) => s.sessionId,
    );
    expect(listedIds).toEqual(expect.arrayContaining([current.sessionId, other.sessionId]));
    // Exactly one session is flagged as the caller's current one.
    expect(
      (listed.body.sessions as Array<{ current: boolean }>).filter((s) => s.current),
    ).toHaveLength(1);

    const revoked = await del(`/sessions/${other.sessionId}`).set(
      "Authorization",
      `Bearer ${current.accessToken}`,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({
      message: "Session revoked",
      wasCurrentSession: false,
    });

    // The named device is dead in both stores, on both token types.
    expect(await sessionState(user.id, other.sessionId)).toEqual({
      dbRowExists: false,
      dbRowBelongsToUser: false,
      redisDocExists: false,
    });
    expect((await asAccess(other.accessToken)).status).toBe(401);
    expect((await asRefresh(other.refreshToken)).status).toBe(401);

    // The caller is untouched — this is per-session revocation, not a logout.
    expect((await asAccess(current.accessToken)).status).toBe(200);
    expect(await tokenVersionOf(user.id)).toBe(versionBefore);

    const relisted = await get("/sessions").set(
      "Authorization",
      `Bearer ${current.accessToken}`,
    );
    const remainingIds = (relisted.body.sessions as Array<{ sessionId: string }>).map(
      (s) => s.sessionId,
    );
    expect(remainingIds).toContain(current.sessionId);
    expect(remainingIds).not.toContain(other.sessionId);
  });

  it("revokes the caller's own current session when named directly", async () => {
    const user = await makeUser();
    const current = await loginAs(user);

    const revoked = await del(`/sessions/${current.sessionId}`).set(
      "Authorization",
      `Bearer ${current.accessToken}`,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.wasCurrentSession).toBe(true);

    expect(await sessionState(user.id, current.sessionId)).toEqual({
      dbRowExists: false,
      dbRowBelongsToUser: false,
      redisDocExists: false,
    });
    expect((await asAccess(current.accessToken)).status).toBe(401);
    expect((await asRefresh(current.refreshToken)).status).toBe(401);
  });

  it("does not let one account revoke another account's session row (ownership regression)", async () => {
    const attacker = await makeUser();
    const victim = await makeUser();
    const attackerSession = await loginAs(attacker);
    const victimSession = await loginAs(victim);

    const before = await sessionState(victim.id, victimSession.sessionId);
    expect(before).toEqual({
      dbRowExists: true,
      dbRowBelongsToUser: true,
      redisDocExists: true,
    });

    // The attacker names the victim's session id. `revokeSession` resolves the
    // target through `req.user.id`, so every Redis key it touches is scoped to
    // the ATTACKER's namespace and cannot reach the victim's live session.
    const res = await del(`/sessions/${victimSession.sessionId}`).set(
      "Authorization",
      `Bearer ${attackerSession.accessToken}`,
    );
    expect(res.status).toBe(200);

    // REGRESSION (Task 7.62): the victim's AUTHORITATIVE row must survive.
    // Before the fix this deleted via `prisma.userSession.delete({ where:
    // { sessionId } })` — the global primary key, with no userId predicate —
    // so a cross-account request destroyed another user's session record even
    // though every Redis operation in the same function was correctly scoped.
    const after = await sessionState(victim.id, victimSession.sessionId);
    expect(after).toEqual({
      dbRowExists: true,
      dbRowBelongsToUser: true,
      redisDocExists: true,
    });

    // The victim's session is untouched end to end, on both token types.
    expect((await asAccess(victimSession.accessToken)).status).toBe(200);
    const victimRefresh = await asRefresh(victimSession.refreshToken);
    expect(victimRefresh.status).toBe(200);
    expect(victimRefresh.body.accessToken).toBeDefined();

    // And the attacker's own session is equally unharmed — a refused delete
    // must not become a self-inflicted logout either.
    expect((await asAccess(attackerSession.accessToken)).status).toBe(200);
    expect(
      await prisma.userSession.count({ where: { userId: attacker.id } }),
    ).toBe(1);
    expect(
      await prisma.userSession.count({ where: { userId: victim.id } }),
    ).toBe(1);

    // Zero-row ownership mismatch is an ordinary no-op, not an error: the
    // attacker naming a session that does not exist at all changes nothing.
    const nonexistent = await del("/sessions/does-not-exist").set(
      "Authorization",
      `Bearer ${attackerSession.accessToken}`,
    );
    expect(nonexistent.status).toBe(200);
    expect(nonexistent.body).toEqual({
      message: "Session revoked",
      wasCurrentSession: false,
    });
    expect((await asAccess(attackerSession.accessToken)).status).toBe(200);
    expect(
      await prisma.userSession.count({ where: { userId: victim.id } }),
    ).toBe(1);
  });
});

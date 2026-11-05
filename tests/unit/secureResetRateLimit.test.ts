/**
 * Batch 1D.67 — dedicated rate limiter for POST /api/auth/secure-reset-password.
 *
 * These tests drive the REAL mounted router (`src/routes/auth.routes.ts`),
 * not the controller in isolation, because the thing under test is a piece of
 * wiring: a limiter mounted on one specific public route. Calling the
 * controller directly — as the reset suites do — cannot observe that at all.
 *
 * Isolation: `src/server.ts` runs behind exactly one proxy and sets
 * `trust proxy = 1`, so the app under test does the same and each test sends a
 * distinct `X-Forwarded-For`. The limiter keys on the client address, so
 * distinct addresses are distinct budgets; nothing needs to be reset between
 * tests and no test can leak count into another.
 *
 * What these tests prove, and what they do not: they prove the route is
 * limited, the budget is 10 per client per 15 minutes, the excess is refused
 * before any controller work happens, the counter is NOT shared with the
 * other auth routes, and the reset contracts (406/407/200) are unchanged
 * while the budget holds. They do NOT prove cross-instance behaviour: the
 * limiter uses the library's default in-process store, so each replica counts
 * independently and the budget resets on restart. Prisma, Redis, and bcrypt
 * are mocked; real Redis/PostgreSQL evidence is outstanding.
 */
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
    userSession: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    passwordResetToken: {
      upsert: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    $transaction: jest.fn(async (cb: any) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

// The limiter is in-process and never touches Redis, but the router's module
// graph does; mock it so importing the router opens no connection.
jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisUsersSessions: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    sAdd: jest.fn(async () => 1),
    sRem: jest.fn(async () => 1),
    sMembers: jest.fn(async () => []),
    scan: jest.fn(async () => ({ cursor: 0, keys: [] })),
    // Batch 1D.70: the route now also consults the shared, credential-scoped
    // finalization counter (1 key / 1 arg, RESET_ATTEMPT_LUA). Model it with
    // real per-key counters so this suite sees the same interaction production
    // does: one credential is capped at 5 attempts REGARDLESS of the IP
    // budget, which is exactly why the IP tests below use a distinct
    // credential per request to isolate the per-IP limiter.
    eval: jest.fn(async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
      if (opts.keys.length === 1) {
        const key = opts.keys[0];
        const next = (counterState.get(key) ?? 0) + 1;
        counterState.set(key, next);
        return next;
      }
      return [0, "x"];
    }),
  },
  redisPayments: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
  },
  ShopCartRedis: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
  },
}));

jest.mock("../../src/services/mail/emailProvider", () => ({
  __esModule: true,
  getEmailProvider: jest.fn(() => ({
    name: "memory",
    sendEmail: jest.fn(async () => {}),
  })),
  EmailProviderError: class EmailProviderError extends Error {},
  LogEmailProvider: class {},
  InMemoryEmailProvider: class {},
  FailingEmailProvider: class {},
  SmtpEmailProvider: class {},
  maskEmail: (e: string) => e,
  __setEmailProviderForTests: jest.fn(),
}));

// bcrypt at production cost dominates this suite's runtime and is not what is
// under test; the real hashing is covered by the reset finalization suite.
jest.mock("bcryptjs", () => ({
  __esModule: true,
  default: {
    hash: jest.fn(async () => "hashed-password"),
    compare: jest.fn(async () => true),
  },
}));

import bcrypt from "bcryptjs";
import prisma from "../../src/lib/prisma";
import config from "../../src/config/config";
import { resetJwtDigest } from "../../src/utils/resetTokenDigest";
import authRoutes from "../../src/routes/auth.routes";

const db = prisma as unknown as Record<string, any>;
const bcryptMock = bcrypt as unknown as { hash: jest.Mock };

const KNOWN = { id: "u-1", email: "u-1@example.com" };
const STRONG = "NewPass456@";
const RESET_PATH = "/api/auth/secure-reset-password";
const FORGOT_PATH = "/api/auth/forgot-password";

let app: express.Express;
interface RowState { userId: string; token: string; expiresAt: Date }
let row: RowState | null;

/** A client address distinct per test, so budgets never leak between tests. */
let nextIp = 0;
const freshIp = () => `203.0.113.${(nextIp += 1) % 250}`;

/** Backing store for the shared finalization counter (Redis, not per process). */
const counterState = new Map<string, number>();

/** A distinct signed credential, so the per-credential counter is not the limit under test. */
const distinctToken = () =>
  jwt.sign({ id: KNOWN.id, nonce: (distinctToken.n += 1) }, config.jwtResetSecret, { expiresIn: "10m" });
distinctToken.n = 0;

/** A signed, unexpired reset token whose digest matches the seeded row. */
function seededToken(): string {
  const token = jwt.sign({ id: KNOWN.id }, config.jwtResetSecret, { expiresIn: "10m" });
  row = {
    userId: KNOWN.id,
    token: resetJwtDigest(config.jwtResetSecret, token),
    expiresAt: new Date(Date.now() + 60_000),
  };
  return token;
}

/** A validly signed token for an existing account with no stored challenge. */
function unbackedToken(): string {
  return jwt.sign({ id: KNOWN.id }, config.jwtResetSecret, { expiresIn: "10m" });
}

/** Predicate mirror of the handler's conditional delete, so consumption sticks. */
function matchesWhere(
  current: RowState | null,
  where: { userId?: string; token?: string; expiresAt?: { gt?: Date } },
): boolean {
  if (!current) return false;
  if (where.userId !== undefined && where.userId !== current.userId) return false;
  if (where.token !== undefined && where.token !== current.token) return false;
  if (where.expiresAt?.gt !== undefined && !(current.expiresAt > where.expiresAt.gt)) return false;
  return true;
}

function post(path: string, ip: string, body: Record<string, unknown>) {
  return request(app).post(path).set("X-Forwarded-For", ip).send(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  row = null;
  counterState.clear();
  db.user.findUnique.mockImplementation(async (args: any) =>
    args?.where?.id === KNOWN.id
      ? { ...KNOWN, password: "OldPass123!", tokenVersion: 0, authProviders: [] as string[] }
      : null,
  );
  db.passwordResetToken.findUnique.mockImplementation(async (args: any) =>
    args?.where?.userId === KNOWN.id ? row : null,
  );
  db.passwordResetToken.deleteMany.mockImplementation(async (args: any) => {
    // Synchronous check-and-remove: the credential is consumed, so a replay
    // of the same token finds nothing and is refused.
    if (matchesWhere(row, args?.where ?? {})) {
      row = null;
      return { count: 1 };
    }
    return { count: 0 };
  });

  app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/auth", authRoutes);
});

describe("secure-reset-password limiter — budget", () => {
  it("allows 10 requests per client in the window, then refuses the 11th with 429", async () => {
    const ip = freshIp();

    for (let i = 1; i <= 10; i += 1) {
      // A distinct credential each time: this test is about the PER-IP budget,
      // and a single credential is separately capped at 5 attempts by the
      // shared finalization counter (see the credential test below).
      const res = await post(RESET_PATH, ip, { resetToken: distinctToken(), newPassword: STRONG });
      expect(res.status).toBe(406);
      expect(res.status).not.toBe(429);
    }

    const limited = await post(RESET_PATH, ip, { resetToken: distinctToken(), newPassword: STRONG });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      code: "RATE_LIMITED",
      message: "Too many password reset attempts, please try again later",
    });
  });

  it("refuses the excess request before the controller does any work", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      await post(RESET_PATH, ip, { resetToken: distinctToken(), newPassword: STRONG });
    }
    db.passwordResetToken.findUnique.mockClear();
    bcryptMock.hash.mockClear();

    const limited = await post(RESET_PATH, ip, { resetToken: distinctToken(), newPassword: STRONG });
    expect(limited.status).toBe(429);
    // The point of the limiter: no token verification, no database lookups
    // and no bcrypt work is done on a refused request.
    expect(db.passwordResetToken.findUnique).not.toHaveBeenCalled();
    expect(bcryptMock.hash).not.toHaveBeenCalled();
  });

  it("gives each client its own budget", async () => {
    const noisy = freshIp();
    const quiet = freshIp();
    for (let i = 0; i < 10; i += 1) {
      await post(RESET_PATH, noisy, { resetToken: distinctToken(), newPassword: STRONG });
    }
    expect((await post(RESET_PATH, noisy, { resetToken: distinctToken(), newPassword: STRONG })).status).toBe(429);

    const other = await post(RESET_PATH, quiet, { resetToken: distinctToken(), newPassword: STRONG });
    expect(other.status).not.toBe(429);
  });
});

describe("secure-reset-password limiter — counter isolation", () => {
  it("does not share its budget with the shared authRateLimiter routes", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      await post(RESET_PATH, ip, { resetToken: distinctToken(), newPassword: STRONG });
    }
    expect((await post(RESET_PATH, ip, { resetToken: distinctToken(), newPassword: STRONG })).status).toBe(429);

    // Exhausting the reset limiter must not have drawn down the budget that
    // guards /forgot-password (and the other authRateLimiter routes).
    const forgot = await post(FORGOT_PATH, ip, { email: "someone@example.com" });
    expect(forgot.status).not.toBe(429);
    expect(forgot.status).toBe(200);
  });

  it("is unaffected when the shared authRateLimiter budget is exhausted", async () => {
    const ip = freshIp();
    // authRateLimiter allows 20 per window; the 21st is refused.
    let lastForgotStatus = 0;
    for (let i = 0; i < 21; i += 1) {
      lastForgotStatus = (await post(FORGOT_PATH, ip, { email: "someone@example.com" })).status;
    }
    expect(lastForgotStatus).toBe(429);

    const reset = await post(RESET_PATH, ip, { resetToken: distinctToken(), newPassword: STRONG });
    expect(reset.status).not.toBe(429);
  });
});

describe("secure-reset-password limiter — existing contracts preserved", () => {
  it("keeps the invalid-token contracts (406 stored-challenge mismatch, 407 undecodable)", async () => {
    const ip = freshIp();

    const unbacked = await post(RESET_PATH, ip, {
      resetToken: unbackedToken(),
      newPassword: STRONG,
    });
    expect(unbacked.status).toBe(406);
    expect(unbacked.body).toEqual({ message: "Invalid or expired reset token" });

    const garbage = await post(RESET_PATH, ip, { resetToken: "not-a-jwt", newPassword: STRONG });
    expect(garbage.status).toBe(407);
    expect(garbage.body).toEqual({ message: "Invalid or expired reset token" });

    const weak = await post(RESET_PATH, ip, { resetToken: unbackedToken(), newPassword: "short" });
    expect(weak.status).toBe(422);
  });

  it("still finalizes a valid reset, with the single-use gate intact", async () => {
    const ip = freshIp();
    const token = seededToken();
    db.user.update.mockResolvedValue({});

    const res = await post(RESET_PATH, ip, { resetToken: token, newPassword: STRONG });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message:
        "Password has been reset successfully. You have been logged out of all devices for security.",
    });
    // The consume-then-write transaction still gates the credential on an
    // exactly-one row delete; the limiter does not bypass it.
    expect(db.passwordResetToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Password change and session revocation are unchanged: every existing
    // session is still torn down after the commit.
    expect(db.user.update).toHaveBeenCalledTimes(1);
    expect(db.user.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
    expect(db.userSession.deleteMany).toHaveBeenCalledWith({ where: { userId: KNOWN.id } });

    // Replaying the consumed token is refused — single use is unchanged.
    const replay = await post(RESET_PATH, ip, { resetToken: token, newPassword: STRONG });
    expect(replay.status).toBe(406);
  });

  it("the shared per-credential counter caps one token at 5 even from a fresh IP", async () => {
    // Batch 1D.70 end-to-end through the real router: a fresh IP has a full
    // 10-request budget, but the SAME credential is capped at 5 by the shared
    // Redis counter. The two limits are independent and distinguishable.
    const token = unbackedToken();
    const ipA = freshIp();

    for (let n = 1; n <= 5; n += 1) {
      const res = await post(RESET_PATH, ipA, { resetToken: token, newPassword: STRONG });
      expect(res.status).toBe(406);
    }
    const limited = await post(RESET_PATH, ipA, { resetToken: token, newPassword: STRONG });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      code: "RESET_RATE_LIMITED",
      message: "Too many password reset attempts. Please try again later.",
    });

    // A DIFFERENT client presenting the same exhausted credential is refused
    // too: the counter is shared, not per-process and not per-IP.
    const ipB = freshIp();
    const fromOtherClient = await post(RESET_PATH, ipB, { resetToken: token, newPassword: STRONG });
    expect(fromOtherClient.status).toBe(429);
    expect(fromOtherClient.body.code).toBe("RESET_RATE_LIMITED");
  });

  it("a 429 discloses nothing about the token or the account", async () => {
    const ip = freshIp();
    for (let i = 0; i < 11; i += 1) {
      await post(RESET_PATH, ip, { resetToken: distinctToken(), newPassword: STRONG });
    }
    const limited = await post(RESET_PATH, ip, { resetToken: distinctToken(), newPassword: STRONG });

    expect(limited.status).toBe(429);
    const body = JSON.stringify(limited.body);
    expect(body).not.toContain(KNOWN.id);
    expect(body).not.toContain("Invalid or expired reset token");
    expect(body).not.toContain("User not found");
  });
});

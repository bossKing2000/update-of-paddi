/**
 * Phase 1E — the public EMAIL OTP routes are protected by
 * `emailOtpRateLimiter`.
 *
 * These tests drive the REAL mounted router (`src/routes/auth.routes.ts`),
 * not the controller in isolation, because the thing under test is wiring: a
 * limiter mounted on specific routes. Every controller suite in the project
 * calls the handler directly and therefore cannot observe whether a limiter
 * is present, or which routes share one. A regression that dropped the limiter
 * from `/email/login/verify-otp` would leave every other OTP suite green.
 *
 * Why the verify route matters most: it is public, unauthenticated, and it is
 * the endpoint that consumes OTP guesses. Its protection must not rest on the
 * OTP service alone — `verifyOtp` reads one record and never touches the
 * per-IP budget, so without this limiter nothing bounds the request rate here.
 *
 * Isolation: `src/server.ts` runs behind one proxy with `trust proxy = 1`, so
 * the app under test does the same and each test sends a distinct
 * `X-Forwarded-For`. The limiter keys on the client address, so distinct
 * addresses are distinct budgets and nothing needs resetting between tests.
 *
 * What these tests do NOT prove: cross-instance behaviour. The limiter uses the
 * library's default in-process store, so each replica counts independently and
 * the budget resets on restart. The authoritative, shared limits live in the
 * Redis-backed OTP service and were verified separately against real Redis.
 * Prisma and Redis are mocked; no real service is contacted.
 */
import express from "express";
import request from "supertest";

// The OTP service refuses to derive a digest without one, and does so BEFORE
// reaching Redis — which would surface as 503 and hide the limiter's behaviour.
// Same throwaway value the OTP unit suite uses.
process.env.PHONE_OTP_SECRET = "test-only-phone-otp-secret-do-not-use-in-prod";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
    userSession: { deleteMany: jest.fn(async () => ({ count: 0 })), upsert: jest.fn(async () => ({})) },
  },
}));

// The limiter itself never touches Redis, but the router's module graph does.
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
    // ISSUE_LUA / VERIFY_LUA are exercised here only as far as the limiter
    // allows a request to reach them. `verifyOtp` reads one record and never
    // increments a budget, so "no record" is modelled as return code 0
    // (EXPIRED) — the shape the controller turns into a plain 400.
    eval: jest.fn(async () => 0),
  },
  redisPayments: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
  },
}));

import prisma from "../../src/lib/prisma";
import authRoutes from "../../src/routes/auth.routes";

const db = prisma as unknown as Record<string, any>;

const REQUEST_OTP_PATH = "/api/auth/email/login/request-otp";
const VERIFY_OTP_PATH = "/api/auth/email/login/verify-otp";
const LIMIT_MESSAGE = "Too many email verification requests, please try again later";

let app: express.Express;
let nextIp = 0;
const freshIp = () => `203.0.113.${(nextIp += 1) % 250}`;

const post = (path: string, ip: string, body: Record<string, unknown>) =>
  request(app).post(path).set("X-Forwarded-For", ip).send(body);

const verify = (ip: string) =>
  post(VERIFY_OTP_PATH, ip, { email: "08031234560@example.com", otp: "123456" });

beforeEach(() => {
  jest.clearAllMocks();
  app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/auth", authRoutes);
});

describe("email OTP limiter — the email-login verify route is limited", () => {
  it("allows 10 requests per client in the window, then refuses the 11th with 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      const res = await verify(ip);
      // No OTP record exists, so every allowed request reaches the controller
      // and is refused there — never by the limiter.
      expect(res.status).toBe(400);
      expect(res.status).not.toBe(429);
    }

    const limited = await verify(ip);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      code: "RATE_LIMITED",
      message: LIMIT_MESSAGE,
    });
  });

  it("refuses the excess before the controller does any work", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      await verify(ip);
    }
    db.user.findUnique.mockClear();

    const limited = await verify(ip);
    expect(limited.status).toBe(429);
    // The point of the limiter: no OTP verification and no database lookup
    // happen on a refused request.
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("a 429 discloses nothing about the number, the code or the account", async () => {
    const ip = freshIp();
    for (let i = 0; i < 11; i += 1) {
      await verify(ip);
    }
    const limited = await verify(ip);

    expect(limited.status).toBe(429);
    const body = JSON.stringify(limited.body);
    expect(body).not.toContain("123456");
    expect(body).not.toContain("08031234560@example.com");
    expect(body).not.toContain("User not found");
    expect(body).not.toContain("Invalid or expired verification code");
  });
});

describe("email OTP limiter — budget isolation", () => {
  it("covers the request-otp route too, and both routes share one budget", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      await verify(ip);
    }

    // A DIFFERENT public phone route from the same client. It is wrapped by
    // the same limiter instance and keyed by the same identity, so the budget
    // spent on verify-otp is not a fresh allowance for request-otp.
    const request = await post(REQUEST_OTP_PATH, ip, { email: "08031234560@example.com" });
    expect(request.status).toBe(429);
    expect(request.body.message).toBe(LIMIT_MESSAGE);
  });

  it("gives each client its own budget", async () => {
    const noisy = freshIp();
    const quiet = freshIp();
    for (let i = 0; i < 11; i += 1) {
      await verify(noisy);
    }
    expect((await verify(noisy)).status).toBe(429);
    expect((await verify(quiet)).status).not.toBe(429);
  });
});
/**
 * Batch 1D.77 — IPv6 subnet-rotation bypasses on two rate limiters.
 *
 * `passwordChangeRateLimiter` and `aiRateLimiter` keyed their IP branch on the
 * raw `req.ip`. An IPv6 client is handed a whole prefix and may use any
 * address inside it, so keying on the raw address handed it a FRESH BUDGET PER
 * REQUEST by rotating host bits — defeating, respectively, the brute-force
 * budget on current-password change and the cost budget on AI endpoints that
 * fan out to paid embedding calls.
 *
 * Both now fold IPv6 to a /56 with `clientRateLimitIdentity`, the pattern the
 * project already uses for `phoneOtpRateLimiter` and `secureResetRateLimiter`.
 *
 * These tests drive the REAL mounted routers, not the helper in isolation, so
 * they cover what actually regressed: the middleware as it is wired onto its
 * route, including the real per-IP budget. The helper's own normalisation is
 * already pinned in clientIp.test.ts.
 *
 * Not proven here: anything about real IPv6 assignment (these are simulated
 * addresses), the per-process store's behaviour across replicas, or the
 * request's actual authentication outcome — the limiter runs before
 * `authenticate` on /change-password, so the first five requests get 401 and
 * the sixth is what the limiter refuses.
 */
import express from "express";
import request from "supertest";

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
    $transaction: jest.fn(async (cb: any) => cb(jest.requireMock("../../src/lib/prisma").default)),
  },
}));

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
    eval: jest.fn(async () => 1),
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

// The AI router pulls in the OpenAI-backed services and a second Prisma
// client. The limiter is what is under test, so the controllers are stubbed.
jest.mock("../../src/AI/recommendationService", () => ({
  __esModule: true,
  getPersonalizedRecommendations: jest.fn(async () => ({ recommendations: [] })),
}));
jest.mock("../../src/AI/vendorAvailabilityService", () => ({
  __esModule: true,
  getVendorAvailability: jest.fn(async () => ({ vendors: [] })),
}));
jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: {},
}));

import config from "../../src/config/config";
import { clientRateLimitIdentity, UNKNOWN_CLIENT_IDENTITY } from "../../src/utils/clientIp";
import authRoutes from "../../src/routes/auth.routes";
import aiRouter from "../../src/routes/aiRouter";

const CHANGE_PW = "/api/auth/change-password";
const AI_RECS = "/api/ai/recommendations";

const PASSWORD_CHANGE_LIMIT = 5;
const AI_LIMIT = 30;

/**
 * Six DIFFERENT addresses inside one /56 — same first three groups, varying
 * the fourth. This is the shape of a real bypass: one client, one allocation,
 * many source addresses.
 */
const sameSubnet = (net: string, n: number) =>
  `2001:db8:${net}:${n.toString(16).padStart(4, "0")}::${n}`;

/** A genuinely different /56 (differs in the third group, inside the prefix). */
const otherSubnet = (net: string, n: number) =>
  `2001:db8:${net === "7a" ? "7b" : "7a"}:${n.toString(16).padStart(4, "0")}::${n}`;

let app: express.Express;

function post(path: string, ip: string) {
  return request(app).post(path).set("X-Forwarded-For", ip).send({});
}
function get(path: string, ip: string) {
  return request(app).get(path).set("X-Forwarded-For", ip);
}

beforeEach(() => {
  app = express();
  // Mirrors src/server.ts: exactly one proxy hop in front of the app.
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use("/api/ai", aiRouter);
});

describe("passwordChangeRateLimiter — IPv6 rotation (1D.77)", () => {
  it("six host addresses inside one /56 share the budget and the sixth is refused", async () => {
    const statuses: number[] = [];
    for (let n = 1; n <= PASSWORD_CHANGE_LIMIT; n += 1) {
      const res = await post(CHANGE_PW, sameSubnet("7a", n));
      statuses.push(res.status);
      expect(res.status).not.toBe(429);
    }

    const limited = await post(CHANGE_PW, sameSubnet("7a", 6));
    expect(limited.status).toBe(429);
    // The existing contract is unchanged by the key fix.
    expect(limited.body).toEqual({
      success: false,
      code: "RATE_LIMITED",
      message: "Too many password change attempts, please try again later",
    });
    // Five rotations consumed the budget; the sixth did not get a fresh one.
    expect(statuses).toHaveLength(PASSWORD_CHANGE_LIMIT);
  });

  it("a different /56 is limited independently", async () => {
    for (let n = 1; n <= PASSWORD_CHANGE_LIMIT; n += 1) {
      await post(CHANGE_PW, sameSubnet("7a", n));
    }
    expect((await post(CHANGE_PW, sameSubnet("7a", 9))).status).toBe(429);

    // A client in another allocation still has its own budget.
    const other = await post(CHANGE_PW, otherSubnet("7a", 1));
    expect(other.status).not.toBe(429);
  });

  it("keeps the existing single-address budget and IPv4 behaviour", async () => {
    // One IPv4 host: still exactly 5 per window, contract unchanged.
    for (let n = 1; n <= PASSWORD_CHANGE_LIMIT; n += 1) {
      expect((await post(CHANGE_PW, "198.51.100.7")).status).not.toBe(429);
    }
    const limited = await post(CHANGE_PW, "198.51.100.7");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");

    // Distinct IPv4 hosts remain distinct clients — folding must not merge them.
    expect((await post(CHANGE_PW, "198.51.100.8")).status).not.toBe(429);
  });
});

describe("aiRateLimiter — IPv6 rotation (1D.77)", () => {
  it("rotating host addresses inside one /56 share the budget", async () => {
    // The AI budget is 30, not 5: the point under test is that rotations do
    // not mint fresh budgets, not the specific number. No threshold changed.
    for (let n = 1; n <= AI_LIMIT; n += 1) {
      const res = await get(AI_RECS, sameSubnet("7c", n));
      expect(res.status).not.toBe(429);
    }

    const limited = await get(AI_RECS, sameSubnet("7c", 31));
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      code: "RATE_LIMITED",
      message: "Too many AI requests, please slow down",
    });
  });

  it("a different /56 is limited independently", async () => {
    for (let n = 1; n <= AI_LIMIT; n += 1) {
      await get(AI_RECS, sameSubnet("7c", n));
    }
    expect((await get(AI_RECS, sameSubnet("7c", 40))).status).toBe(429);
    expect((await get(AI_RECS, otherSubnet("7c", 1))).status).not.toBe(429);
  });
});

describe("client identity invariants still hold (1D.77)", () => {
  it("the addresses used above really do share one /56 identity", () => {
    // Guards the premise of the tests above: if these ever diverged, the
    // limiter tests would pass for the wrong reason.
    const ids = [1, 2, 3, 4, 5, 6].map((n) => clientRateLimitIdentity(sameSubnet("7a", n)));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe(clientRateLimitIdentity(otherSubnet("7a", 1)));
  });

  it("unusable addresses still map to the bounded UNKNOWN_CLIENT_IDENTITY", () => {
    expect(clientRateLimitIdentity(undefined)).toBe(UNKNOWN_CLIENT_IDENTITY);
    expect(clientRateLimitIdentity("")).toBe(UNKNOWN_CLIENT_IDENTITY);
    expect(clientRateLimitIdentity("   ")).toBe(UNKNOWN_CLIENT_IDENTITY);
    // And they share one bucket rather than being unlimited.
    expect(clientRateLimitIdentity(undefined)).toBe(clientRateLimitIdentity(""));
  });

  it("the reset secret is irrelevant here — this batch changed only keying", () => {
    // Guards against an accidental import-time dependency in the middleware.
    expect(typeof config.jwtResetSecret).toBe("string");
  });
});

/**
 * Phase 1E.5C.2 — refresh DB boundary (real PostgreSQL + real disposable Redis).
 *
 * Verifies the typed session-lookup contract against live infrastructure:
 * confirmed-missing sessions stay 401 without resurrection, while database
 * infrastructure failures answer 503 without minting, revoking, or bumping —
 * so a transient fault can never cascade into account-wide revocation via a
 * post-grace replay classification.
 *
 * FAILS CLOSED without REFRESH_TEST_REDIS_URL. Real Prisma client (pinned to
 * the disposable TEST database by the integration preflight/worker pin) plus
 * a real node-redis client pointed ONLY at the disposable Redis target.
 * Fixtures use the `u_rdb_` prefix; cleanup is scoped to that prefix —
 * never broad deletes, never FLUSH.
 */
const REDIS_URL = process.env.REFRESH_TEST_REDIS_URL;
if (!REDIS_URL || !REDIS_URL.startsWith("redis://127.0.0.1:")) {
  throw new Error(
    "[refreshDbBoundary] BLOCKED: REFRESH_TEST_REDIS_URL must name the authorized disposable loopback target.",
  );
}

jest.mock("../../src/lib/redis", () => {
  // Real client, disposable target only. Every other Redis client throws if
  // touched, so a stray write path fails loudly instead of silently hitting
  // ambient infrastructure.
  const { createClient } = require("redis");
  const fail = () => {
    throw new Error("[refreshDbBoundary] unexpected Redis client use");
  };
  return {
    __esModule: true,
    redisUsersSessions: createClient({ url: process.env.REFRESH_TEST_REDIS_URL }),
    redisNotifications: { get: fail, set: fail },
    redisProducts: { get: fail, set: fail },
    redisSearch: { get: fail, set: fail },
    redisTotalViews: { get: fail, set: fail },
    ShopCartRedis: { get: fail, set: fail },
    redisPayments: { get: fail, set: fail, del: fail },
  };
});

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

import jwt from "jsonwebtoken";
import config from "../../src/config/config";
import prisma from "../../src/lib/prisma";
import { generateRefreshToken } from "../../src/utils/generateToken";
import { refreshToken as refreshHandler } from "../../src/controllers/auth.controller";

const store = require("../../src/lib/redis").redisUsersSessions as {
  connect: () => Promise<void>;
  quit: () => Promise<void>;
  get: (k: string) => Promise<string | null>;
};

const PX_BASE = "u_rdb_";
// Phase 3.1.4: per-run prefix. The production Redis key format
// (`refresh:jti:<userId>:<sessionId>`) derives from these same ids, so fixed
// tags reused the exact keys of prior runs and stale rotation state flipped
// later runs' assertions. pid + timestamp makes every run's keys disjoint;
// the existing startsWith(PX) cleanup below keeps working unchanged, and no
// production key format is modified.
const PX = `${PX_BASE}${process.pid}_${Date.now().toString(36)}_`;
const SESSION_TTL_CHECK_SKEW_MS = 60_000;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
};

const req = (token: string): any =>
  ({ body: { refreshToken: token }, cookies: {}, headers: {} }) as any;

const statusOf = (r: any): number => r.status.mock.calls[0][0];
const bodyOf = (r: any): any => r.json.mock.calls[0][0];

async function makeUser(tag: string, over: Record<string, unknown> = {}) {
  const id = `${PX}${tag}`;
  return prisma.user.create({
    data: {
      id,
      name: id,
      email: `${id}@t.invalid`,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
      ...over,
    } as never,
  });
}

async function makeSession(userId: string, tag: string, activeRole: string | null = "CUSTOMER") {
  const sessionId = `${PX}${tag}`;
  return prisma.userSession.create({
    data: {
      userId,
      sessionId,
      activeRole: activeRole as never,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    },
  });
}

function signRefresh(userId: string, sessionId: string, jti?: string, version = 0) {
  return generateRefreshToken(userId, version, sessionId, jti as string);
}

const curKey = (u: string, s: string) => `refresh:jti:${u}:${s}`;

beforeAll(async () => {
  await store.connect();
}, 30_000);

afterEach(async () => {
  jest.restoreAllMocks();
  await prisma.userSession.deleteMany({ where: { userId: { startsWith: PX } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: PX } } });
});

afterAll(async () => {
  await prisma.userSession.deleteMany({ where: { userId: { startsWith: PX } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: PX } } });
  await store.quit().catch(() => {});
}, 30_000);

describe("A. valid refresh against real rows", () => {
  it("returns 200, slides the session TTL, preserves the role, leaves others untouched", async () => {
    const me = await makeUser("a1");
    const other = await makeUser("a1o");
    await makeSession(me.id, "a1s");
    const otherSession = await makeSession(other.id, "a1os");
    const before = (await prisma.userSession.findUnique({ where: { sessionId: `${PX}a1s` } }))!;

    const r = res();
    await refreshHandler(req(signRefresh(me.id, `${PX}a1s`, "j1")), r);
    expect(statusOf(r)).toBe(200);
    expect(bodyOf(r).accessToken).toEqual(expect.any(String));
    expect(bodyOf(r).refreshToken).toEqual(expect.any(String));

    const after = (await prisma.userSession.findUnique({ where: { sessionId: `${PX}a1s` } }))!;
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime() - SESSION_TTL_CHECK_SKEW_MS);
    expect(after.activeRole).toBe("CUSTOMER");
    // Other user's rows and versions byte-identical.
    expect(await prisma.userSession.findUnique({ where: { sessionId: otherSession.sessionId } })).toEqual(
      expect.objectContaining({ userId: other.id }),
    );
    expect((await prisma.user.findUnique({ where: { id: other.id } }))!.tokenVersion).toBe(0);
    expect((await prisma.user.findUnique({ where: { id: me.id } }))!.tokenVersion).toBe(0);
    // JTI state: current persisted, previous seeded for grace.
    expect(await store.get(curKey(me.id, `${PX}a1s`))).not.toBeNull();
  }, 60_000);
});

describe("B. confirmed missing or revoked session", () => {
  it("returns 401 without resurrecting the session or minting", async () => {
    const me = await makeUser("b1");
    await makeSession(me.id, "b1s");
    await prisma.userSession.delete({ where: { sessionId: `${PX}b1s` } });

    const r = res();
    await refreshHandler(req(signRefresh(me.id, `${PX}b1s`, "j1")), r);
    expect(statusOf(r)).toBe(401);
    expect(bodyOf(r).accessToken).toBeUndefined();
    expect(await prisma.userSession.findUnique({ where: { sessionId: `${PX}b1s` } })).toBeNull();
    expect((await prisma.user.findUnique({ where: { id: me.id } }))!.tokenVersion).toBe(0);
  }, 60_000);
});

describe("C. user-lookup infrastructure failure", () => {
  it("returns 503 with no tokens, no revocation, no version bump", async () => {
    const me = await makeUser("c1");
    await makeSession(me.id, "c1s");
    const findSpy = jest.spyOn(prisma.user, "findUnique").mockRejectedValueOnce(new Error("db down"));

    const r = res();
    await refreshHandler(req(signRefresh(me.id, `${PX}c1s`, "j1")), r);
    expect(statusOf(r)).toBe(503);
    expect(bodyOf(r).accessToken).toBeUndefined();
    expect(bodyOf(r).refreshToken).toBeUndefined();
    expect(await prisma.userSession.count({ where: { userId: me.id } })).toBe(1);
    expect((await prisma.user.findUnique({ where: { id: me.id } }))!.tokenVersion).toBe(0);
    findSpy.mockRestore();
  }, 60_000);
});

describe("D. session-lookup infrastructure failure", () => {
  it("returns 503 with no revocation, no bump, and preserved JTI state", async () => {
    const me = await makeUser("d1");
    await makeSession(me.id, "d1s");
    const spy = jest.spyOn(prisma.userSession, "findUnique").mockRejectedValueOnce(new Error("db down"));

    const r = res();
    await refreshHandler(req(signRefresh(me.id, `${PX}d1s`, "j1")), r);
    expect(statusOf(r)).toBe(503);
    expect(bodyOf(r).accessToken).toBeUndefined();
    expect(await prisma.userSession.count({ where: { userId: me.id } })).toBe(1);
    expect((await prisma.user.findUnique({ where: { id: me.id } }))!.tokenVersion).toBe(0);
    // Rotation already persisted cur; nothing tore it down.
    expect(await store.get(curKey(me.id, `${PX}d1s`))).not.toBeNull();
    spy.mockRestore();
  }, 60_000);
});

describe("E. recovery after a transient session-lookup failure", () => {
  it("a retry inside grace succeeds with no erroneous revocation", async () => {
    const me = await makeUser("e1");
    await makeSession(me.id, "e1s");

    const fail = jest.spyOn(prisma.userSession, "findUnique").mockRejectedValueOnce(new Error("db down"));
    const outage = res();
    await refreshHandler(req(signRefresh(me.id, `${PX}e1s`, "j1")), outage);
    expect(statusOf(outage)).toBe(503);
    fail.mockRestore();

    const retry = res();
    await refreshHandler(req(signRefresh(me.id, `${PX}e1s`, "j1")), retry);
    expect(statusOf(retry)).toBe(200);
    expect(retry.json.mock.calls[0][0].accessToken).toEqual(expect.any(String));
    expect(await prisma.userSession.count({ where: { userId: me.id } })).toBe(1);
    expect((await prisma.user.findUnique({ where: { id: me.id } }))!.tokenVersion).toBe(0);
  }, 60_000);
});

describe("F. session-write failure after rotation", () => {
  it("returns 503, keeps rotation state, and recovers inside grace with documented partial state", async () => {
    const me = await makeUser("f1");
    const row = await makeSession(me.id, "f1s");

    const fail = jest.spyOn(prisma.userSession, "upsert").mockRejectedValueOnce(new Error("db down"));
    const r = res();
    await refreshHandler(req(signRefresh(me.id, `${PX}f1s`, "j1")), r);
    expect(statusOf(r)).toBe(503);
    expect(bodyOf(r).accessToken).toBeUndefined();
    fail.mockRestore();

    // Rotation persisted (cur present); the DB row TTL did NOT slide —
    // the design keeps Redis and PostgreSQL untransacted, so report, don't hide.
    expect(await store.get(curKey(me.id, `${PX}f1s`))).not.toBeNull();
    const kept = (await prisma.userSession.findUnique({ where: { sessionId: `${PX}f1s` } }))!;
    expect(kept.expiresAt.getTime()).toBe(row.expiresAt.getTime());
    expect(await prisma.userSession.count({ where: { userId: me.id } })).toBe(1);

    // Retry inside grace converges without revocation.
    const retry = res();
    await refreshHandler(req(signRefresh(me.id, `${PX}f1s`, "j1")), retry);
    expect(statusOf(retry)).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: me.id } }))!.tokenVersion).toBe(0);
  }, 60_000);
});

describe("G. genuine replay", () => {
  it("returns 401, revokes only the victim, bumps only the victim", async () => {
    const victim = await makeUser("g1v");
    const other = await makeUser("g1o");
    await makeSession(victim.id, "g1s");
    await makeSession(other.id, "g1os");

    const first = res();
    await refreshHandler(req(signRefresh(victim.id, `${PX}g1s`, "j1")), first);
    expect(statusOf(first)).toBe(200);

    const r = res();
    await refreshHandler(req(signRefresh(victim.id, `${PX}g1s`, "attacker-jti")), r);
    expect(statusOf(r)).toBe(401);
    expect(bodyOf(r).accessToken).toBeUndefined();
    expect(await prisma.userSession.count({ where: { userId: victim.id } })).toBe(0);
    expect((await prisma.user.findUnique({ where: { id: victim.id } }))!.tokenVersion).toBe(1);
    expect(await prisma.userSession.count({ where: { userId: other.id } })).toBe(1);
    expect((await prisma.user.findUnique({ where: { id: other.id } }))!.tokenVersion).toBe(0);
  }, 60_000);
});

describe("H. response safety and isolation", () => {
  it("error bodies expose no tokens, SQL, credentials, or connection detail", async () => {
    const me = await makeUser("h1");
    await makeSession(me.id, "h1s");
    const fail = jest.spyOn(prisma.userSession, "findUnique").mockRejectedValueOnce(new Error("db down"));
    const r = res();
    await refreshHandler(req(signRefresh(me.id, `${PX}h1s`, "j1")), r);
    expect(statusOf(r)).toBe(503);
    const bodyStr = JSON.stringify(bodyOf(r)).toLowerCase();
    for (const leak of ["eyJ", "redis", "prisma", "select", "postgres", "127.0.0.1", "session:user", "password"]) {
      expect(bodyStr).not.toContain(leak);
    }
    fail.mockRestore();
  }, 60_000);
});

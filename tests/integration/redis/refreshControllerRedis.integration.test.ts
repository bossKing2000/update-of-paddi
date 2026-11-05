/**
 * Phase 1F.2 — refresh-controller behavior against a real disposable Redis.
 *
 * Gap closed: `tests/unit/sessionHardening.test.ts` proves the controller's
 * HTTP contract (200/401/503 shapes, revocation scope, no leak) through a
 * mocked store, and `refreshRotationRedis.integration.test.ts` proves the Lua
 * through real Redis at the helper level — but neither proves the two together:
 * that a real `rotateRefreshJtiCAS` outcome drives the correct HTTP status,
 * response shape, and revocation scope in `refreshToken`.
 *
 * This suite binds the REAL `rotateRefreshJtiCAS`/`getUserSession`/
 * `createUserSession`/`deleteAllUserSessions` (via `src/lib/session.ts`,
 * unmocked) to a disposable Redis, with an in-memory Prisma double standing
 * in for PostgreSQL. No live PostgreSQL is touched. The only I/O is to the
 * disposable Redis named by REFRESH_TEST_REDIS_URL.
 *
 * Safety: same guard as the helper suite — fails (not skips) unless the
 * target is loopback, non-default DB, plain redis://, and not the ambient
 * REDIS_URL. Only run-scoped keys are created and deleted; a sentinel proves
 * cleanup is scoped. No FLUSHDB/FLUSHALL/wildcard DEL.
 */

import { createClient, type RedisClientType } from "redis";
import jwt from "jsonwebtoken";
import { evaluateDisposableRedisTarget } from "../../helpers/localRedisTarget";

const TARGET = evaluateDisposableRedisTarget(process.env.REFRESH_TEST_REDIS_URL);
if (!TARGET.ok) {
  throw new Error(
    `[refresh-controller-redis] BLOCKED: REFRESH_TEST_REDIS_URL is unusable.\n` +
      `Reason from evaluateDisposableRedisTarget: ${TARGET.reason}\n` +
      "This suite must fail rather than skip; an unexecuted check is not evidence.",
  );
}

jest.mock("../../../src/lib/redis", () => {
  const { createClient: create } = require("redis");
  const client = create({ url: process.env.REFRESH_TEST_REDIS_URL });
  client.on("error", () => {});
  return {
    __esModule: true,
    redisUsersSessions: client,
    redisNotifications: { get: async () => null, set: async () => "OK", del: async () => 0 },
    redisProducts: { get: async () => null },
    redisSearch: { get: async () => null },
    redisTotalViews: { get: async () => null },
    ShopCartRedis: { get: async () => null },
    redisPayments: { get: async () => null },
  };
});

// In-memory Prisma double: users + sessions only, no I/O.
type UserRow = {
  id: string;
  role: string;
  roles: string[];
  tokenVersion: number;
  isBlocked: boolean;
};
type SessionRow = {
  userId: string;
  sessionId: string;
  activeRole: string | null;
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
  geoCity?: string | null;
  geoRegion?: string | null;
  geoCountry?: string | null;
  expiresAt: Date;
  createdAt: Date;
};
const users = new Map<string, UserRow>();
const sessions = new Map<string, SessionRow>();

jest.mock("../../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(async ({ where }: any) => users.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.get(where.id);
        if (!u) return {};
        if (data?.tokenVersion?.increment) u.tokenVersion += data.tokenVersion.increment;
        return {};
      }),
    },
    userSession: {
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const existing = sessions.get(where.sessionId);
        if (existing) {
          if (update?.activeRole !== undefined) existing.activeRole = update.activeRole;
          if (update?.expiresAt) existing.expiresAt = update.expiresAt;
          return existing;
        }
        const row: SessionRow = {
          userId: create.userId,
          sessionId: create.sessionId,
          activeRole: create.activeRole ?? null,
          ip: create.ip ?? null,
          userAgent: create.userAgent ?? null,
          deviceId: create.deviceId ?? null,
          geoCity: create.geoCity ?? null,
          geoRegion: create.geoRegion ?? null,
          geoCountry: create.geoCountry ?? null,
          expiresAt: create.expiresAt,
          createdAt: new Date(),
        };
        sessions.set(create.sessionId, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => sessions.get(where.sessionId) ?? null),
      delete: jest.fn(async ({ where }: any) => {
        sessions.delete(where.sessionId);
        return {};
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        for (const [k, v] of [...sessions]) {
          if (where?.userId && v.userId !== where.userId) continue;
          sessions.delete(k);
          count += 1;
        }
        return { count };
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return [...sessions.values()].filter((s) => (where?.userId ? s.userId === where.userId : true));
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    passwordResetToken: { deleteMany: jest.fn(async () => ({})) },
  },
}));

jest.mock("../../../src/services/mail/emailProvider", () => ({
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

import { redisUsersSessions } from "../../../src/lib/redis";
import { refreshToken as refreshHandler } from "../../../src/controllers/auth.controller";
import prisma from "../../../src/lib/prisma";
import config from "../../../src/config/config";

const RUN = `f12rc${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const curKey = (u: string, s: string) => `refresh:jti:${u}:${s}`;
const prevKey = (u: string, s: string) => `refresh:jti:prev:${u}:${s}`;
const sessKey = (u: string, s: string) => `session:user:${u}:${s}`;
const idxKey = (u: string) => `session:user:${u}:index`;
const createdKeys = new Set<string>();
const SENTINEL = `refresh:jti:${RUN}:sentinel`;
const SENTINEL_VALUE = "sentinel-must-survive";

let client: RedisClientType;
let moduleClient: RedisClientType;
const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

function trackUserSessionKeys(userId: string, sessionId: string) {
  createdKeys.add(curKey(userId, sessionId));
  createdKeys.add(prevKey(userId, sessionId));
  createdKeys.add(sessKey(userId, sessionId));
  createdKeys.add(idxKey(userId));
}

function newIds(tag: string) {
  const userId = `${RUN}_u_${tag}`;
  const sessionId = `${RUN}_s_${tag}`;
  trackUserSessionKeys(userId, sessionId);
  return { userId, sessionId };
}

function seedUser(userId: string, overrides: Partial<UserRow> = {}): UserRow {
  const row: UserRow = {
    id: userId,
    role: "CUSTOMER",
    roles: ["CUSTOMER"],
    tokenVersion: 0,
    isBlocked: false,
    ...overrides,
  };
  users.set(userId, row);
  return row;
}

function seedSession(userId: string, sessionId: string, activeRole: string | null = null) {
  const row: SessionRow = {
    userId,
    sessionId,
    activeRole,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    createdAt: new Date(),
  };
  sessions.set(sessionId, row);
  return row;
}

function signRefresh(userId: string, sessionId: string, jti: string, tokenVersion = 0) {
  return jwt.sign({ id: userId, tokenVersion, sessionId, jti }, config.jwtSecret, { expiresIn: "7d" });
}

function res(): any {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
}
const req = (token: string): any => ({ body: { refreshToken: token }, cookies: {}, headers: {} } as any);

async function cleanupTrackedKeys(): Promise<void> {
  const mine = [...createdKeys];
  if (mine.length === 0) return;
  await client.del(mine);
  const survivors: string[] = [];
  for (const k of mine) {
    if (await client.exists(k)) survivors.push(k);
  }
  if (survivors.length > 0) {
    throw new Error(`tracked-key cleanup failed; survivors: ${survivors.join(", ")}`);
  }
  createdKeys.clear();
}

beforeAll(async () => {
  client = createClient({ url: process.env.REFRESH_TEST_REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  moduleClient = redisUsersSessions as unknown as RedisClientType;
  moduleClient.on("error", () => {});
  if (!moduleClient.isOpen) await moduleClient.connect();
  await client.set(SENTINEL, SENTINEL_VALUE);
}, 30000);

afterAll(async () => {
  try {
    if (createdKeys.size) await client.del([...createdKeys]).catch(() => {});
    await client.del(SENTINEL).catch(() => {});
  } finally {
    if ((moduleClient as any)?.isOpen) await (moduleClient as any).quit().catch(() => {});
    if ((client as any)?.isOpen) await client.quit().catch(() => {});
  }
});

beforeEach(async () => {
  jest.clearAllMocks();
  users.clear();
  sessions.clear();
  // Re-install Prisma double implementations cleared by clearAllMocks
  (db.user.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => users.get(where.id) ?? null);
  (db.user.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
    const u = users.get(where.id);
    if (!u) return {};
    if (data?.tokenVersion?.increment) u.tokenVersion += data.tokenVersion.increment;
    return {};
  });
  (db.userSession.upsert as jest.Mock).mockImplementation(async ({ where, update, create }: any) => {
    const existing = sessions.get(where.sessionId);
    if (existing) {
      if (update?.activeRole !== undefined) existing.activeRole = update.activeRole;
      if (update?.expiresAt) existing.expiresAt = update.expiresAt;
      return existing;
    }
    const row: SessionRow = {
      userId: create.userId,
      sessionId: create.sessionId,
      activeRole: create.activeRole ?? null,
      ip: create.ip ?? null,
      userAgent: create.userAgent ?? null,
      deviceId: create.deviceId ?? null,
      geoCity: create.geoCity ?? null,
      geoRegion: create.geoRegion ?? null,
      geoCountry: create.geoCountry ?? null,
      expiresAt: create.expiresAt,
      createdAt: new Date(),
    };
    sessions.set(create.sessionId, row);
    return row;
  });
  (db.userSession.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => sessions.get(where.sessionId) ?? null);
  (db.userSession.delete as jest.Mock).mockImplementation(async ({ where }: any) => {
    sessions.delete(where.sessionId);
    return {};
  });
  (db.userSession.deleteMany as jest.Mock).mockImplementation(async ({ where }: any) => {
    let count = 0;
    for (const [k, v] of [...sessions]) {
      if (where?.userId && v.userId !== where.userId) continue;
      sessions.delete(k);
      count += 1;
    }
    return { count };
  });
});

afterEach(async () => {
  await cleanupTrackedKeys();
});

describe("refresh controller against real Redis", () => {
  it("valid rotation returns 200 with the API contract and rotates exactly once", async () => {
    const { userId, sessionId } = newIds("valid");
    seedUser(userId);
    seedSession(userId, sessionId, null);
    // Establish cache via real create path (DB + Redis)
    const { createUserSession } = require("../../../src/lib/session");
    await createUserSession(userId, sessionId, { ip: "9.9.9.9" });

    const r = res();
    await refreshHandler(req(signRefresh(userId, sessionId, "j1")), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const body = r.json.mock.calls[0][0] as { accessToken: string; refreshToken: string };
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(r.cookie).toHaveBeenCalledWith("refreshToken", expect.any(String), expect.objectContaining({ httpOnly: true }));
    // Real store holds the new current jti, prev is the presented one
    const cur = await client.get(curKey(userId, sessionId));
    const prev = await client.get(prevKey(userId, sessionId));
    expect(typeof cur).toBe("string");
    expect(cur).not.toBe("j1");
    expect(prev).toBe("j1");
  });

  it("replay with an unrelated JTI returns 401, revokes only the victim, and bumps only the victim", async () => {
    const victim = newIds("victim");
    const other = newIds("other");
    seedUser(victim.userId);
    seedUser(other.userId);
    seedSession(victim.userId, victim.sessionId, null);
    seedSession(other.userId, other.sessionId, null);
    const { createUserSession } = require("../../../src/lib/session");
    await createUserSession(victim.userId, victim.sessionId, { ip: "1.1.1.1" });
    await createUserSession(other.userId, other.sessionId, { ip: "2.2.2.2" });

    // First legitimate rotation establishes cur (not j1)
    await refreshHandler(req(signRefresh(victim.userId, victim.sessionId, "j1")), res());
    const curAfterFirst = await client.get(curKey(victim.userId, victim.sessionId));
    expect(typeof curAfterFirst).toBe("string");
    expect(curAfterFirst).not.toBe("j1");

    // Attacker presents an unrelated JTI -> replay
    const r = res();
    await refreshHandler(req(signRefresh(victim.userId, victim.sessionId, "attacker-jti")), r);

    expect(r.status).toHaveBeenCalledWith(401);
    const body = r.json.mock.calls[0][0] as { message: string; accessToken?: unknown };
    expect(body.message).toMatch(/compromised|log in/i);
    expect(body.accessToken).toBeUndefined();
    // Victim sessions revoked (DB rows gone), other user's rows intact
    expect(sessions.has(victim.sessionId)).toBe(false);
    expect(sessions.has(other.sessionId)).toBe(true);
    expect(users.get(victim.userId)!.tokenVersion).toBe(1);
    expect(users.get(other.userId)!.tokenVersion).toBe(0);
    // Controller revocation tears down the victim's JTI pair (unlike the
    // helper-level replay which mutates nothing): both keys must be gone, and
    // crucially no new attacker-controlled value was ever written.
    expect(await client.exists(curKey(victim.userId, victim.sessionId))).toBe(0);
    expect(await client.exists(prevKey(victim.userId, victim.sessionId))).toBe(0);
    // Other user's Redis state untouched
    expect(await client.exists(curKey(other.userId, other.sessionId))).toBe(0);
  });

  it("grace retry with the previous JTI returns 200, reuses current, and revokes nothing", async () => {
    const { userId, sessionId } = newIds("grace");
    seedUser(userId);
    seedSession(userId, sessionId, null);
    const { createUserSession } = require("../../../src/lib/session");
    await createUserSession(userId, sessionId, { ip: "3.3.3.3" });

    await refreshHandler(req(signRefresh(userId, sessionId, "j1")), res());
    const cur = await client.get(curKey(userId, sessionId));
    expect(cur).not.toBe("j1");

    const r = res();
    await refreshHandler(req(signRefresh(userId, sessionId, "j1")), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const body = r.json.mock.calls[0][0] as { accessToken: string; refreshToken: string };
    const decoded = jwt.decode(body.refreshToken) as any;
    expect(decoded.jti).toBe(cur);
    expect(await client.get(curKey(userId, sessionId))).toBe(cur);
    expect(sessions.has(sessionId)).toBe(true);
    expect(users.get(userId)!.tokenVersion).toBe(0);
  });

  it("two concurrent refreshes of the same JTI both succeed and converge on one rotation", async () => {
    const { userId, sessionId } = newIds("race");
    seedUser(userId);
    seedSession(userId, sessionId, null);
    const { createUserSession } = require("../../../src/lib/session");
    await createUserSession(userId, sessionId, { ip: "4.4.4.4" });

    const token = signRefresh(userId, sessionId, "j1");
    const ra = res();
    const rb = res();
    await Promise.all([refreshHandler(req(token), ra), refreshHandler(req(token), rb)]);

    expect(ra.status).toHaveBeenCalledWith(200);
    expect(rb.status).toHaveBeenCalledWith(200);
    const jtis = [ra, rb].map((r) => (jwt.decode(r.json.mock.calls[0][0].refreshToken) as any).jti as string);
    // Exactly-once: both callers converged on the same new JTI (winner + grace)
    expect(new Set(jtis).size).toBe(1);
    expect(jtis[0]).not.toBe("j1");
    expect(await client.get(curKey(userId, sessionId))).toBe(jtis[0]);
    expect(await client.get(prevKey(userId, sessionId))).toBe("j1");
  });

  it("a closed store fails closed with 503, revokes nothing, and leaks no internals", async () => {
    const { userId, sessionId } = newIds("outage");
    const other = newIds("outage-other");
    seedUser(userId);
    seedUser(other.userId);
    seedSession(userId, sessionId, null);
    seedSession(other.userId, other.sessionId, null);
    const { createUserSession } = require("../../../src/lib/session");
    await createUserSession(userId, sessionId, { ip: "5.5.5.5" });
    await createUserSession(other.userId, other.sessionId, { ip: "6.6.6.6" });

    // Real outage: close the shared store. getUserSession falls back to the
    // mocked DB (session still found); the atomic CAS must reject, and the
    // controller must fail closed with 503 without revoking anyone.
    await (moduleClient as any).quit().catch(() => {});
    try {
      const r = res();
      await refreshHandler(req(signRefresh(userId, sessionId, "j1")), r);
      expect(r.status).toHaveBeenCalledWith(503);
      const body = r.json.mock.calls[0][0] as { message: string };
      expect(body.message).toMatch(/temporarily unavailable|retry/i);
      expect((body as any).accessToken).toBeUndefined();
      const bodyStr = JSON.stringify(body).toLowerCase();
      for (const leak of ["redis", "econnrefused", "jti", "127.0.0.1", "6399"]) {
        expect(bodyStr).not.toContain(leak);
      }
      // Outage is not evidence of compromise: nobody revoked, no version bump
      expect(sessions.has(sessionId)).toBe(true);
      expect(sessions.has(other.sessionId)).toBe(true);
      expect(users.get(userId)!.tokenVersion).toBe(0);
      expect(users.get(other.userId)!.tokenVersion).toBe(0);
    } finally {
      // Reconnect for the remaining tests and cleanup
      (moduleClient as any).on("error", () => {});
      if (!(moduleClient as any).isOpen) await (moduleClient as any).connect().catch(() => {});
      // Re-warm cache entries the outage may have left unwritten
      await createUserSession(userId, sessionId, { ip: "5.5.5.5" }).catch(() => {});
    }
  });

  it("Z. cleanup removes only this run's keys and spares the sentinel", async () => {
    const ids = newIds("cleanup");
    seedUser(ids.userId);
    seedSession(ids.userId, ids.sessionId, null);
    const { createUserSession } = require("../../../src/lib/session");
    await createUserSession(ids.userId, ids.sessionId, { ip: "6.6.6.6" });
    await refreshHandler(req(signRefresh(ids.userId, ids.sessionId, "j1")), res());

    expect(await client.exists(curKey(ids.userId, ids.sessionId))).toBe(1);
    expect(await client.get(SENTINEL)).toBe(SENTINEL_VALUE);
    await cleanupTrackedKeys();
    expect(await client.exists(curKey(ids.userId, ids.sessionId))).toBe(0);
    expect(await client.get(SENTINEL)).toBe(SENTINEL_VALUE);
    await client.del(SENTINEL);
  });
});

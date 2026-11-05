/**
 * Phase 1E.5B — typed session lookup and safe refresh error handling.
 *
 * `lookupUserSession` distinguishes found / missing / error so the refresh
 * controller can deny retryably (503) on infrastructure failure instead of
 * mistaking it for a revoked session (401 today, replay-revocation tomorrow).
 *
 * Real `src/lib/session.ts` helpers + real `refreshToken` controller; only the
 * stores are doubles (in-memory Redis Map with per-key failure, in-memory
 * Prisma rows with injectable single-shot failures). No live services.
 */
import jwt from "jsonwebtoken";
import config from "../../src/config/config";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
    },
    userSession: {
      delete: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(),
      findFirst: jest.fn(async () => null),
      upsert: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    passwordResetToken: { deleteMany: jest.fn(async () => ({})) },
  },
}));

const store = new Map<string, string>();
const failKeys = new Set<string>();

const redisUsersSessions = {
  get: jest.fn(async (key: string) => {
    if (failKeys.has(key)) throw new Error("redis down");
    return store.get(key) ?? null;
  }),
  set: jest.fn(async (key: string, value: string) => {
    if (failKeys.has(key)) throw new Error("redis down");
    store.set(key, value);
    return "OK";
  }),
  del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  sAdd: jest.fn(async () => 1),
  sRem: jest.fn(async () => 1),
  sMembers: jest.fn(async () => [] as string[]),
  expire: jest.fn(async () => 1),
  scan: jest.fn(async () => ({ cursor: 0, keys: [] as string[] })),
  // Faithful mirror of REFRESH_ROTATE_LUA against the same store, so the
  // atomic decision is exercised rather than stubbed.
  eval: jest.fn(async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
    for (const k of opts.keys) {
      if (failKeys.has(k)) throw new Error("redis down");
    }
    const [curKey, prevKey] = opts.keys;
    const [incoming, newJti] = opts.arguments;
    const cur = store.get(curKey) ?? null;
    const prev = store.get(prevKey) ?? null;
    if (cur === null) {
      store.set(prevKey, incoming);
      store.set(curKey, newJti);
      return [0, newJti];
    }
    if (cur === incoming) {
      store.set(prevKey, cur);
      store.set(curKey, newJti);
      return [0, cur];
    }
    if (prev !== null && prev === incoming) {
      return [1, cur];
    }
    return [2, cur];
  }),
};

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisUsersSessions,
  redisPayments: { get: jest.fn(async () => null), set: jest.fn(async () => "OK"), del: jest.fn(async () => 1) },
  ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => "OK") },
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

import prisma from "../../src/lib/prisma";
import { refreshToken as refreshHandler } from "../../src/controllers/auth.controller";
import { lookupUserSession, getUserSession } from "../../src/lib/session";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
};

const req = (token: string): any =>
  ({ body: { refreshToken: token }, cookies: {}, headers: {} } as any);

const USER = {
  id: "u-1",
  role: "CUSTOMER" as const,
  roles: ["CUSTOMER"] as string[],
  tokenVersion: 0,
  isBlocked: false,
};

const OTHER = {
  id: "u-2",
  role: "CUSTOMER" as const,
  roles: ["CUSTOMER"] as string[],
  tokenVersion: 0,
  isBlocked: false,
};

function signRefresh(userId: string, sessionId: string, jti?: string, version = 0) {
  const payload: Record<string, unknown> = { id: userId, tokenVersion: version, sessionId };
  if (jti !== undefined) payload.jti = jti;
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "7d" });
}

const userRows = new Map<string, typeof USER>();

function seedUser(u: typeof USER) {
  userRows.set(u.id, u);
  db.user.findUnique.mockImplementation(async ({ where }: any) =>
    userRows.has(where.id) ? { ...userRows.get(where.id)! } : null,
  );
}

function seedSession(userId: string, sessionId: string, activeRole: string | null = null) {
  const row = {
    userId,
    sessionId,
    activeRole,
    ip: null,
    userAgent: null,
    deviceId: null,
    geoCity: null,
    geoRegion: null,
    geoCountry: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    createdAt: new Date(),
  };
  db.userSession.findUnique.mockImplementation(async ({ where }: any) =>
    where.sessionId === sessionId ? { ...row } : null,
  );
  return row;
}

const curKey = (u: string, s: string) => `refresh:jti:${u}:${s}`;
const prevKey = (u: string, s: string) => `refresh:jti:prev:${u}:${s}`;

/**
 * Drop the cached session payload so the next lookup exercises the database
 * fallback. Production caches lapse independently of the database, so a test
 * that needs DB behavior must not accidentally assert against a warm cache.
 */
function evictSessionCache(userId = "u-1", sessionId = "sess-1") {
  store.delete(`session:user:${userId}:${sessionId}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  failKeys.clear();
  userRows.clear();
  seedUser(USER);
  db.user.update.mockResolvedValue({});
  db.userSession.deleteMany.mockResolvedValue({ count: 0 });
  db.userSession.upsert.mockImplementation(async ({ create }: any) => ({ ...create }));
});

describe("lookupUserSession contract", () => {
  it("reports found for a live row, missing for absent/foreign/expired rows", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    await expect(lookupUserSession("u-1", "sess-1")).resolves.toMatchObject({ status: "found" });
    expect((await lookupUserSession("u-1", "sess-1")).session).toMatchObject({ activeRole: "CUSTOMER" });

    db.userSession.findUnique.mockResolvedValue(null);
    await expect(lookupUserSession("u-1", "nope")).resolves.toMatchObject({
      status: "missing",
      session: null,
    });

    seedSession("u-1", "sess-1");
    await expect(lookupUserSession("u-2", "sess-1")).resolves.toMatchObject({ status: "missing" });

    db.userSession.findUnique.mockResolvedValue({
      userId: "u-1",
      sessionId: "sess-1",
      activeRole: null,
      expiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
    } as never);
    evictSessionCache();
    await expect(lookupUserSession("u-1", "sess-1")).resolves.toMatchObject({ status: "missing" });
  });

  it("reports error — never missing — when the database read fails", async () => {
    seedSession("u-1", "sess-1");
    db.userSession.findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(lookupUserSession("u-1", "sess-1")).resolves.toMatchObject({
      status: "error",
      session: null,
    });
  });

  it("still falls back to the database when Redis fails", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    failKeys.add("session:user:u-1:sess-1");
    await expect(lookupUserSession("u-1", "sess-1")).resolves.toMatchObject({ status: "found" });
  });

  it("getUserSession keeps its nullable contract for every outcome", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    expect(await getUserSession("u-1", "sess-1")).toMatchObject({ activeRole: "CUSTOMER" });
    db.userSession.findUnique.mockResolvedValue(null);
    evictSessionCache();
    expect(await getUserSession("u-1", "nope")).toBeNull();
    db.userSession.findUnique.mockRejectedValueOnce(new Error("db down"));
    evictSessionCache();
    // Compatibility: existing callers still observe null here and keep their
    // denial behavior; only refresh branches on the typed result.
    expect(await getUserSession("u-1", "sess-1")).toBeNull();
  });
});

describe("refresh on session-lookup infrastructure failure", () => {
  it("a valid refresh still returns 200 (harness sanity)", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    const r = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json.mock.calls[0][0].accessToken).toEqual(expect.any(String));
  });

  it("normal-path database failure returns 503 with no tokens, no revocation, no version bump", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    db.userSession.findUnique.mockRejectedValueOnce(new Error("db down"));
    const r = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), r);
    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.json.mock.calls[0][0].accessToken).toBeUndefined();
    expect(r.json.mock.calls[0][0].refreshToken).toBeUndefined();
    expect(db.userSession.deleteMany).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("grace-path database failure returns 503 and preserves JTI state for recovery", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    // Establish cur=w1/prev=j1 through a first healthy refresh.
    const first = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), first);
    expect(first.status).toHaveBeenCalledWith(200);

    db.userSession.findUnique.mockRejectedValueOnce(new Error("db down"));
    evictSessionCache();
    const r = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), r);
    expect(r.status).toHaveBeenCalledWith(503);
    // Nothing revoked, nothing bumped, rotation state untouched.
    expect(db.userSession.deleteMany).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(store.get(curKey("u-1", "sess-1"))).not.toBeNull();
  });

  it("a retry inside the grace window recovers once the database heals", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    const first = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), first);
    expect(first.status).toHaveBeenCalledWith(200);

    db.userSession.findUnique.mockRejectedValueOnce(new Error("db down"));
    evictSessionCache();
    const outage = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), outage);
    expect(outage.status).toHaveBeenCalledWith(503);

    const retry = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), retry);
    expect(retry.status).toHaveBeenCalledWith(200);
    expect(retry.json.mock.calls[0][0].accessToken).toEqual(expect.any(String));
  });

  it("upsert failure after a won rotation returns 503 and keeps rotation state", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    db.userSession.upsert.mockRejectedValueOnce(new Error("db down"));
    const r = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), r);
    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.json.mock.calls[0][0].accessToken).toBeUndefined();
    // The CAS already rotated: the client can still recover inside grace.
    expect(store.get(curKey("u-1", "sess-1"))).not.toBeNull();
    expect(db.userSession.deleteMany).not.toHaveBeenCalled();
  });

  it("user-lookup failure returns 503, not a misleading 401, without revocation", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    db.user.findUnique.mockRejectedValueOnce(new Error("db down"));
    const r = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), r);
    expect(r.status).toHaveBeenCalledWith(503);
    expect(db.userSession.deleteMany).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("confirmed replay still revokes the victim and bumps only the victim", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    seedUser(OTHER);
    const first = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), first);
    expect(first.status).toHaveBeenCalledWith(200);

    // Re-mock findUnique to serve the session row again (first call consumed
    // no one-shot), then present an unrelated JTI: genuine replay.
    const r = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "attacker-jti")), r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(db.userSession.deleteMany).toHaveBeenCalled();
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-1" } }),
    );
  });

  it("confirmed-missing session stays 401 with no resurrection", async () => {
    db.userSession.findUnique.mockResolvedValue(null);
    const r = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json.mock.calls[0][0].accessToken).toBeUndefined();
  });

  it("legacy token without jti and a dead JTI store returns 503 via the marked path", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    failKeys.add(curKey("u-1", "sess-1"));
    const r = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1")), r);
    expect(r.status).toHaveBeenCalledWith(503);
  });

  it("error bodies carry no tokens, SQL, credentials, or internals", async () => {
    seedSession("u-1", "sess-1", "CUSTOMER");
    db.userSession.findUnique.mockRejectedValueOnce(new Error("db down"));
    const r = res();
    await refreshHandler(req(signRefresh("u-1", "sess-1", "j1")), r);
    expect(r.status).toHaveBeenCalledWith(503);
    const bodyStr = JSON.stringify(r.json.mock.calls[0][0]).toLowerCase();
    for (const leak of ["redis", "econnrefused", "jti", "127.0.0.1", "prisma", "select", "session:user"]) {
      expect(bodyStr).not.toContain(leak);
    }
  });
});

/**
 * Batch 1E.37 — session hardening.
 *
 * Two confirmed defects are pinned here:
 *
 *  1. ACCESS-TOKEN LIFETIME. `generateToken.ts` issued access tokens with
 *     `expiresIn: '5h'` against a Phase 1E requirement of 15 minutes. Because
 *     `role` is a JWT claim that `authenticate` trusts without re-reading the
 *     database, a five-hour token meant a demotion or revocation could take up
 *     to five hours to bite. Refresh tokens keep their own independent 7-day
 *     lifetime.
 *
 *  2. REPLAY DETECTION UNDER A REDIS OUTAGE. `getRefreshJti`, `isRefreshJtiReplay`,
 *     `setRefreshJti` and `rotateRefreshJti` each swallowed Redis errors and
 *     returned a benign value. An unreadable store therefore looked identical
 *     to "no jti recorded", so a Redis blip silently disabled single-use replay
 *     detection AND lost the rotation state. They now propagate, and the refresh
 *     handler fails CLOSED with a retryable 503 — without revoking sessions,
 *     because an outage is not evidence of compromise.
 */
import jwt from "jsonwebtoken";
import config from "../../src/config/config";
import { generateAccessToken, generateRefreshToken } from "../../src/utils/generateToken";

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
      upsert: jest.fn(async () => ({})),
    },
    passwordResetToken: { deleteMany: jest.fn(async () => ({})) },
  },
}));

/**
 * In-memory Redis stand-in with a `fail` switch, so an outage can be
 * simulated precisely. Mirrors tests/helpers/fakeRedis.ts but adds the ability
 * to fail only specific keys (the session cache must keep working while the
 * jti store is down — that is the scenario under test).
 */
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
  sMembers: jest.fn(async () => []),
  // Batch 1D.60: mirrors REFRESH_ROTATE_LUA (compare current, rotate or
  // classify) against the same store, so the atomic decision is exercised
  // rather than stubbed. Runs synchronously: concurrent callers serialize
  // here the way Redis single-threads the script. Fails when any involved
  // key is broken, preserving the outage tests below.
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

const liveSessions = new Map<string, unknown>();
jest.mock("../../src/lib/session", () => {
  const actual = jest.requireActual("../../src/lib/session");
  return {
    ...actual,
    // The DB fallback must keep working while Redis is unavailable, so the
    // session store is simulated independently of the jti store.
    getUserSession: jest.fn(async (userId: string, sessionId: string) => {
      const live = liveSessions.get(`${userId}:${sessionId}`);
      return live === undefined ? null : live;
    }),
    // Phase 1E.5B: mirrors the getUserSession mock above exactly — present
    // rows are found, absent rows are missing (never error in this harness).
    lookupUserSession: jest.fn(async (userId: string, sessionId: string) => {
      const live = liveSessions.get(`${userId}:${sessionId}`);
      return live === undefined
        ? { status: "missing" as const, session: null }
        : { status: "found" as const, session: live };
    }),
    createUserSession: jest.fn(async (userId: string, sessionId: string) => {
      liveSessions.set(`${userId}:${sessionId}`, { ip: "1.2.3.4" });
    }),
    deleteAllUserSessions: jest.fn(async () => {
      liveSessions.clear();
    }),
    deleteUserSession: jest.fn(async () => {}),
    listUserSessions: jest.fn(async () => []),
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

import prisma from "../../src/lib/prisma";
import { refreshToken as refreshHandler } from "../../src/controllers/auth.controller";
import {
  getRefreshJti,
  setRefreshJti,
  rotateRefreshJti,
  isRefreshJtiReplay,
} from "../../src/lib/session";
import { deleteAllUserSessions } from "../../src/lib/session";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockDeleteAll = deleteAllUserSessions as jest.Mock;

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
  // Phase 1E: refresh now verifies the resolved session role is still held by
  // the account, exactly as `authenticate` does. A real User row always carries
  // `roles` (non-nullable array), so the fixture must too — otherwise the
  // fail-closed check would see "no roles" and refuse every refresh.
  roles: ["CUSTOMER"] as string[],
  tokenVersion: 0,
  isBlocked: false,
};

const JTI_KEY = "refresh:jti:u-1:sess-1";

/** Build a valid, signed refresh token carrying an explicit jti. */
function refresh(jti: string, over: Record<string, unknown> = {}) {
  return jwt.sign({ id: "u-1", tokenVersion: 0, sessionId: "sess-1", jti, ...over }, config.jwtSecret, {
    expiresIn: "7d",
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  failKeys.clear();
  liveSessions.clear();
  db.user.findUnique.mockResolvedValue({ ...USER });
  db.user.update.mockResolvedValue({});
});

/** Make every jti key fail while the session cache keeps working. */
function breakJtiStore() {
  failKeys.add(JTI_KEY);
  failKeys.add(`refresh:jti:prev:u-1:sess-1`);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("1. access-token lifetime is 15 minutes", () => {
  function claims(token: string) {
    return jwt.decode(token) as { iat: number; exp: number };
  }

  it("access tokens expire in 15 minutes, not 5 hours", () => {
    const token = generateAccessToken("u-1", "CUSTOMER", "sess-1", 0);
    const { iat, exp } = claims(token);

    expect(exp - iat).toBe(15 * 60);
  });

  it("a token minted 14 minutes ago is still valid; 16 minutes ago is not", () => {
    const justInside = jwt.sign(
      { id: "u-1", role: "CUSTOMER", sessionId: "sess-1" },
      config.jwtSecret,
      { expiresIn: "1m" },
    );
    expect(jwt.verify(justInside, config.jwtSecret)).toMatchObject({ id: "u-1" });

    const outside = jwt.sign(
      { id: "u-1", role: "CUSTOMER", sessionId: "sess-1" },
      config.jwtSecret,
      { expiresIn: "-1s" },
    );
    expect(() => jwt.verify(outside, config.jwtSecret)).toThrow();
  });

  it("refresh tokens keep their own 7-day lifetime", () => {
    const { iat, exp } = claims(generateRefreshToken("u-1", 0, "sess-1", "j1"));

    expect(exp - iat).toBe(7 * 24 * 3600);
  });

  it("the two lifetimes are configured independently", () => {
    const access = claims(generateAccessToken("u-1", "CUSTOMER", "sess-1", 0));
    const refreshTok = claims(generateRefreshToken("u-1", 0, "sess-1", "j1"));

    expect(refreshTok.exp - refreshTok.iat).toBeGreaterThan(access.exp - access.iat);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("2. Redis outage cannot turn an unknown replay state into acceptance", () => {
  it("the jti helpers now PROPAGATE a Redis error instead of returning a benign value", async () => {
    breakJtiStore();

    await expect(getRefreshJti("u-1", "sess-1")).rejects.toThrow("redis down");
    await expect(setRefreshJti("u-1", "sess-1", "j1")).rejects.toThrow("redis down");
    await expect(rotateRefreshJti("u-1", "sess-1", "old", "new")).rejects.toThrow("redis down");
    await expect(isRefreshJtiReplay("u-1", "sess-1", "j1")).rejects.toThrow("redis down");
  });

  it("isRefreshJtiReplay no longer reports 'not a replay' when the store is down", async () => {
    // Previously: catch -> return false -> "safe". This assertion is the
    // direct regression guard for the reported defect.
    breakJtiStore();

    const verdict = await isRefreshJtiReplay("u-1", "sess-1", "whatever").catch((e: unknown) => e);

    expect(verdict).toBeInstanceOf(Error);
    expect(verdict).not.toBe(false);
  });

  it("refresh returns a RETRYABLE 503 while the store is down", async () => {
    breakJtiStore();
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4" });

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("temporarily unavailable") }),
    );
  });

  it("the 503 leaks no infrastructure detail", async () => {
    breakJtiStore();
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4" });

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    const body = JSON.stringify(r.json.mock.calls[0][0]).toLowerCase();
    for (const leak of ["redis", "econnrefused", "jti", "socket", "127.0.0.1"]) {
      expect(body).not.toContain(leak);
    }
  });

  it("an outage does NOT revoke the user's sessions", async () => {
    breakJtiStore();
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4" });

    await refreshHandler(req(refresh("j1")), res());

    // Critical: a temporary outage is not evidence of compromise.
    expect(mockDeleteAll).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("a retry after the store recovers succeeds", async () => {
    breakJtiStore();
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4" });
    await refreshHandler(req(refresh("j1")), res());

    failKeys.clear();
    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: expect.any(String), refreshToken: expect.any(String) }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("3. refresh still works, and replay is still detected, when healthy", () => {
  beforeEach(() => liveSessions.set("u-1:sess-1", { ip: "1.2.3.4" }));

  it("a first refresh adopts the incoming jti and returns a new access token", async () => {
    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const body = r.json.mock.calls[0][0] as { accessToken: string; refreshToken: string };
    expect(jwt.verify(body.accessToken, config.jwtSecret)).toMatchObject({
      id: "u-1",
      role: "CUSTOMER",
      sessionId: "sess-1",
    });
    expect(store.get(JTI_KEY)).toBeTruthy();
  });

  it("a rotated (previously used) token is rejected as a replay and revokes sessions", async () => {
    // First use establishes j1 as current.
    await refreshHandler(req(refresh("j1")), res());

    // An attacker presents a DIFFERENT, older token -> mismatch -> replay.
    const r = res();
    await refreshHandler(req(refresh("attacker-jti")), r);

    expect(r.status).toHaveBeenCalledWith(401);
    expect(mockDeleteAll).toHaveBeenCalledWith("u-1");
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tokenVersion: { increment: 1 } } }),
    );
  });

  it("the same jti used twice is NOT a replay (grace/concurrency window)", async () => {
    await refreshHandler(req(refresh("j1")), res());

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect(mockDeleteAll).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("4. unchanged protections still hold", () => {
  beforeEach(() => liveSessions.set("u-1:sess-1", { ip: "1.2.3.4" }));

  it("an invalid signature is rejected", async () => {
    const forged = jwt.sign({ id: "u-1", tokenVersion: 0, sessionId: "sess-1", jti: "j1" }, "wrong-secret", {
      expiresIn: "7d",
    });

    const r = res();
    await refreshHandler(req(forged), r);

    expect(r.status).toHaveBeenCalledWith(401);
  });

  it("an expired refresh token is rejected", async () => {
    const expired = jwt.sign(
      { id: "u-1", tokenVersion: 0, sessionId: "sess-1", jti: "j1" },
      config.jwtSecret,
      { expiresIn: "-1s" },
    );

    const r = res();
    await refreshHandler(req(expired), r);

    expect(r.status).toHaveBeenCalledWith(401);
  });

  it("a tokenVersion mismatch is rejected", async () => {
    db.user.findUnique.mockResolvedValue({ ...USER, tokenVersion: 5 });

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invalid refresh token" }),
    );
  });

  it("a BLOCKED account is refused and its sessions are revoked", async () => {
    db.user.findUnique.mockResolvedValue({ ...USER, isBlocked: true });

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(403);
    expect(mockDeleteAll).toHaveBeenCalledWith("u-1");
  });

  it("a revoked session is refused, not resurrected", async () => {
    liveSessions.clear(); // session gone from Redis and DB

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Please log in again" }),
    );
  });

  it("a grace classification with no live session is refused without revoking the account", async () => {
    // Batch 1D.62: the CAS says grace (incoming == prev), but the session
    // itself was revoked after that rotation. The correct answer is the
    // established unauthorized response — not a token pair, and not a
    // theft revocation: absence of a session is not evidence of theft.
    store.set(JTI_KEY, "j1");
    store.set(`refresh:jti:prev:u-1:sess-1`, "j0");
    liveSessions.clear(); // session gone from Redis and DB

    const r = res();
    await refreshHandler(req(refresh("j0")), r);

    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Please log in again" }),
    );
    // No token pair issued: no tokens in the body, no refresh cookie set.
    const body = r.json.mock.calls[0][0];
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(r.cookie).not.toHaveBeenCalled();
    // No account-wide revocation for a missing session, and no version bump.
    expect(mockDeleteAll).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    // No session recreated for the dead session id.
    expect(liveSessions.has("u-1:sess-1")).toBe(false);
    // Batch 1D.64: the dead session's jti pair is torn down, not left
    // behind. Both keys are asserted as absent state rather than as del()
    // call counts: a refresh token for a revoked session must not remain
    // usable, whichever grace/replay branch classified the request.
    expect(store.has(JTI_KEY)).toBe(false);
    expect(store.has(`refresh:jti:prev:u-1:sess-1`)).toBe(false);
  });

  it("the role in the minted access token comes from the DB, not the client", async () => {
    // An account whose default role is VENDOR must also HOLD VENDOR — the
    // refresh-time authorisation check reads `roles`, not `role`.
    db.user.findUnique.mockResolvedValue({
      ...USER,
      role: "VENDOR",
      roles: ["CUSTOMER", "VENDOR"],
    });

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    const body = r.json.mock.calls[0][0] as { accessToken: string };
    expect(jwt.decode(body.accessToken)).toMatchObject({ role: "VENDOR" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1E refresh-role consistency. Both refresh paths must resolve the role
// the same way (from the session) and must refuse to mint when that role is no
// longer authorised for the account.
describe("6. refresh mints from the SESSION role, and only while it is held", () => {
  beforeEach(() => liveSessions.set("u-1:sess-1", { ip: "1.2.3.4" }));

  it("a VENDOR session on a CUSTOMER-default account keeps VENDOR on the normal path", async () => {
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4", activeRole: "VENDOR" });
    db.user.findUnique.mockResolvedValue({
      ...USER,
      role: "CUSTOMER",
      roles: ["CUSTOMER", "VENDOR"],
    });

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const body = r.json.mock.calls[0][0] as { accessToken: string };
    // The account's global role must not leak into the token.
    expect(jwt.decode(body.accessToken)).toMatchObject({ role: "VENDOR" });
  });

  it("a VENDOR session on a CUSTOMER-default account keeps VENDOR on the GRACE path", async () => {
    // Regression: the grace branch used to mint `user.role`, so a legitimate
    // concurrent retry silently downgraded the session's role to CUSTOMER and
    // the very next request failed the session/token role comparison.
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4", activeRole: "VENDOR" });
    db.user.findUnique.mockResolvedValue({
      ...USER,
      role: "CUSTOMER",
      roles: ["CUSTOMER", "VENDOR"],
    });
    // incoming jti == prev jti -> the CAS classifies this as `grace`.
    store.set(JTI_KEY, "j1");
    store.set("refresh:jti:prev:u-1:sess-1", "j0");

    const r = res();
    await refreshHandler(req(refresh("j0")), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const body = r.json.mock.calls[0][0] as { accessToken: string };
    expect(jwt.decode(body.accessToken)).toMatchObject({ role: "VENDOR" });
    // Grace is a benign retry, not theft — no account-wide revocation.
    expect(mockDeleteAll).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("fails closed on the normal path when the session role is no longer held", async () => {
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4", activeRole: "VENDOR" });
    // The account no longer holds VENDOR (demoted to CUSTOMER only).
    db.user.findUnique.mockResolvedValue({ ...USER, role: "CUSTOMER", roles: ["CUSTOMER"] });

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(401);
    const body = r.json.mock.calls[0][0] as { accessToken?: string; refreshToken?: string };
    // No credential is minted at all — not merely a token that dies later.
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(r.cookie).not.toHaveBeenCalled();
    // This is an authorization failure, NOT evidence of theft: a missing role
    // must not trigger the replay path's account-wide revocation.
    expect(mockDeleteAll).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("fails closed on the GRACE path when the session role is no longer held", async () => {
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4", activeRole: "VENDOR" });
    db.user.findUnique.mockResolvedValue({ ...USER, role: "CUSTOMER", roles: ["CUSTOMER"] });
    store.set(JTI_KEY, "j1");
    store.set("refresh:jti:prev:u-1:sess-1", "j0");

    const r = res();
    await refreshHandler(req(refresh("j0")), r);

    expect(r.status).toHaveBeenCalledWith(401);
    const body = r.json.mock.calls[0][0] as { accessToken?: string };
    expect(body.accessToken).toBeUndefined();
    expect(r.cookie).not.toHaveBeenCalled();
    expect(mockDeleteAll).not.toHaveBeenCalled();
  });

  it("an account with no `roles` array is refused rather than assumed valid", async () => {
    // Fail-closed on an unreadable authorization record.
    db.user.findUnique.mockResolvedValue({
      id: "u-1",
      role: "CUSTOMER",
      tokenVersion: 0,
      isBlocked: false,
    } as never);

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(401);
    const body = r.json.mock.calls[0][0] as { accessToken?: string };
    expect(body.accessToken).toBeUndefined();
  });

  it("preserves the legacy-session fallback: a session with no activeRole uses the account role", async () => {
    // A pre-1E session row has activeRole === null and must keep working.
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4", activeRole: null });

    const r = res();
    await refreshHandler(req(refresh("j1")), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const body = r.json.mock.calls[0][0] as { accessToken: string };
    expect(jwt.decode(body.accessToken)).toMatchObject({ role: "CUSTOMER" });
  });

  it("does not change the account's global role during refresh", async () => {
    liveSessions.set("u-1:sess-1", { ip: "1.2.3.4", activeRole: "VENDOR" });
    db.user.findUnique.mockResolvedValue({
      ...USER,
      role: "CUSTOMER",
      roles: ["CUSTOMER", "VENDOR"],
    });

    await refreshHandler(req(refresh("j1")), res());

    // No write may persist a role back onto the account row.
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch 1D.60: the read-then-write race above is closed — the rotation
// decision is one atomic server-side step (see REFRESH_ROTATE_LUA).
describe("5. concurrent refresh rotates exactly once", () => {
  beforeEach(() => liveSessions.set("u-1:sess-1", { ip: "1.2.3.4" }));

  it("two simultaneous refreshes of the SAME token both succeed — but converge on one rotation", async () => {
    const token = refresh("j1");

    // NOTE: the handler writes the response into the passed-in res mock and
    // itself resolves undefined — so each concurrent call gets its OWN res
    // mock and assertions read those mocks, not return values.
    const ra = res();
    const rb = res();
    await Promise.all([
      refreshHandler(req(token), ra),
      refreshHandler(req(token), rb),
    ]);

    // Both requests present the same jti, which is the legitimate mobile
    // double-tap / overlapping-request case. Neither is treated as a replay.
    expect(mockDeleteAll).not.toHaveBeenCalled();
    for (const r of [ra, rb]) {
      expect(r.status).toHaveBeenCalledWith(200);
    }

    // Exactly ONE rotation happened: the store holds a single new current
    // jti with the presented jti as prev — not two independent pairs.
    const bodies = [ra, rb].map((r) => r.json.mock.calls[0][0] as { refreshToken: string });
    const jtis = bodies.map((bdy) => (jwt.decode(bdy.refreshToken) as any).jti as string);
    expect(new Set(jtis).size).toBe(1);
    expect(jtis[0]).not.toBe("j1");
    expect(store.get(JTI_KEY)).toBe(jtis[0]);
    expect(store.get(`refresh:jti:prev:u-1:sess-1`)).toBe("j1");
  });

  it("the rotation decision is a single atomic step, not read-then-write", async () => {
    // The residual race this replaces read the stored jti first (GET) and
    // wrote afterwards (SET), so two callers could both pass the read. The
    // decision must now arrive as one server-side step: exactly one `eval`,
    // and no standalone reads or writes of either jti key around it.
    redisUsersSessions.eval.mockClear();
    redisUsersSessions.get.mockClear();
    redisUsersSessions.set.mockClear();

    const r = res();
    await refreshHandler(req(refresh("j1")), r);
    expect(r.status).toHaveBeenCalledWith(200);

    expect(redisUsersSessions.eval).toHaveBeenCalledTimes(1);
    const jtiKeyReads = (redisUsersSessions.get.mock.calls as string[][])
      .map((c) => c[0])
      .filter((k: string) => k.startsWith("refresh:jti:"));
    const jtiKeyWrites = (redisUsersSessions.set.mock.calls as string[][])
      .map((c) => c[0])
      .filter((k: string) => k.startsWith("refresh:jti:"));
    expect(jtiKeyReads).toEqual([]);
    expect(jtiKeyWrites).toEqual([]);
  });

  it("a mismatch never overwrites a newer rotation", async () => {
    // cur=J2 (winner), prev=J1. A late presenter of an unrelated JTI is a
    // replay — and crucially the failed decision must leave J2/prev intact.
    store.set(JTI_KEY, "j-winner");
    store.set(`refresh:jti:prev:u-1:sess-1`, "j1");

    const r = res();
    await refreshHandler(req(refresh("attacker-jti")), r);

    expect(r.status).toHaveBeenCalledWith(401);
    expect(mockDeleteAll).toHaveBeenCalledWith("u-1");
    expect(store.get(JTI_KEY)).toBe("j-winner");
    expect(store.get(`refresh:jti:prev:u-1:sess-1`)).toBe("j1");
  });
});
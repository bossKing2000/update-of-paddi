/**
 * Phase 1E — change password, password reset session revocation, and
 * session-security regression tests.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      // Phase 1E: changePassword now bumps tokenVersion in the same statement
      // and reads the new value back, so the default mock returns it.
      update: jest.fn(async () => ({ tokenVersion: 1 })),
    },
    userSession: {
      upsert: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
    },
    passwordResetToken: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
      upsert: jest.fn(async () => ({})),
    },
    loginHistory: { findMany: jest.fn(async () => []), create: jest.fn(async () => ({})) },
    // Batch 1D.55: secureResetPassword finalizes inside a transaction. The
    // callback receives the mocked client itself, matching the repo's
    // established $transaction mock convention (see cancelRefund.test.ts).
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisPayments: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    incr: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
  },
  redisUsersSessions: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    sAdd: jest.fn(async () => 1),
    sRem: jest.fn(async () => 1),
    sMembers: jest.fn(async () => []),
    expire: jest.fn(async () => 1),
    // Batch 1D.70: secureResetPassword now consults the shared finalization
    // counter through this client. `eval` returns a low, non-exhausted count so
    // the reset path behaves normally here; this suite is about password
    // change and session safety, not the counter (covered in
    // secureResetFinalizeLimits.test.ts).
    eval: jest.fn(async () => 1),
  },
  ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => "OK") },
}));

jest.mock("../../src/lib/session", () => {
  const mockGetUserSession = jest.fn(async (_userId: string, _sessionId: string) => null);
  return {
    __esModule: true,
    createUserSession: jest.fn(async () => {}),
    getUserSession: mockGetUserSession,
    // Phase 1E.5B: delegates to the getUserSession mock so per-test
    // reconfigurations stay in lockstep (present → found, absent → missing).
    lookupUserSession: jest.fn(async (userId: string, sessionId: string) => {
      const session = await mockGetUserSession(userId, sessionId);
      return session
        ? { status: "found" as const, session }
        : { status: "missing" as const, session: null };
    }),
  deleteUserSession: jest.fn(async () => {}),
  deleteAllUserSessions: jest.fn(async () => true),
  listUserSessions: jest.fn(async () => []),
  setRefreshJti: jest.fn(async () => {}),
  getRefreshJti: jest.fn(async () => null),
  rotateRefreshJti: jest.fn(async () => {}),
  // Batch 1D.60: the refresh handler now decides via this atomic CAS.
  // Default models a won rotation; individual tests override per outcome.
  rotateRefreshJtiCAS: jest.fn(async () => ({ outcome: "rotated" })),
  isRefreshJtiReplay: jest.fn(async () => false),
  deleteRefreshJti: jest.fn(async () => {}),
  // Phase 1E: the refresh handler and changePassword both resolve the
  // session's active role.
  resolveSessionRole: jest.fn((session: any, accountRole: any) => {
    const sessionRole = session?.activeRole;
    return typeof sessionRole === "string" && sessionRole.length > 0 ? sessionRole : accountRole ?? null;
  }),
  setSessionActiveRole: jest.fn(async () => {}),
  };
});

import prisma from "../../src/lib/prisma";
import * as sessionLib from "../../src/lib/session";
import config from "../../src/config/config";
import { resetJwtDigest } from "../../src/utils/resetTokenDigest";
import {
  changePassword,
  refreshToken,
  logout,
  logoutAllDevices,
  revokeSession,
  getMySessions,
  secureResetPassword,
} from "../../src/controllers/auth.controller";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const sessions = sessionLib as unknown as Record<string, jest.Mock>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  return r;
};

const authed = (id: string, sessionId: string, body: unknown) =>
  ({ user: { id, role: "CUSTOMER", sessionId }, body }) as never;

const STRONG_OLD = "OldPass123!";
const STRONG_NEW = "NewPass456@";

async function passwordUser(overrides: Record<string, unknown> = {}) {
  const user = {
    id: "u1",
    email: "u@example.com",
    password: await bcrypt.hash(STRONG_OLD, 4),
    tokenVersion: 0,
    role: "CUSTOMER",
    roles: ["CUSTOMER"],
    isBlocked: false,
    authProviders: ["LOCAL"],
    ...overrides,
  };
  db.user.findUnique.mockResolvedValue(user);
  // Mirrors Prisma: an increment resolves to the NEW value, not to the
  // `{ increment: n }` instruction. Without this the controller would sign a
  // token carrying an object, and the assertions below would be meaningless.
  db.user.update.mockImplementation(async (args: any) => {
    const data = args?.data ?? {};
    const { tokenVersion, ...rest } = data as Record<string, any>;
    const bump =
      tokenVersion && typeof tokenVersion === "object"
        ? Number(tokenVersion.increment ?? 0)
        : 0;
    return { ...user, ...rest, tokenVersion: (user.tokenVersion ?? 0) + bump };
  });
  return user;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /change-password", () => {
  it("invalidates every pre-change credential and re-issues a fresh session", async () => {
    // Phase 1E security-first policy. The previous contract — sweep the other
    // sessions, keep the caller's, and never bump tokenVersion — meant a
    // failed sweep silently left other devices holding working credentials.
    await passwordUser();
    sessions.listUserSessions.mockResolvedValue([
      { sessionId: "s1" },
      { sessionId: "s2" },
      { sessionId: "s3" },
    ]);
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "CUSTOMER" });

    const r = res();
    await changePassword(authed("u1", "s1", { currentPassword: STRONG_OLD, newPassword: STRONG_NEW }), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const written = db.user.update.mock.calls[0][0].data.password as string;
    expect(written).not.toBe(STRONG_NEW);
    await expect(bcrypt.compare(STRONG_NEW, written)).resolves.toBe(true);
    await expect(bcrypt.compare(STRONG_OLD, written)).resolves.toBe(false);

    // THE authoritative step: one statement bumps tokenVersion alongside the
    // hash, so there is no window where old refresh tokens still validate.
    expect(db.user.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });

    // Every session is swept — including the caller's, whose sessionId is
    // about to be retired.
    expect(sessions.deleteAllUserSessions).toHaveBeenCalledWith("u1");

    // ...and the caller gets a NEW session under the NEW tokenVersion, so
    // they stay signed in without resurrecting any pre-change credential.
    const body = r.json.mock.calls[0][0];
    expect(typeof body.accessToken).toBe("string");
    const minted = jwt.decode(body.accessToken) as any;
    expect(minted.sessionId).not.toBe("s1");
    expect(minted.role).toBe("CUSTOMER");
    // Phase 1E.2: the replacement access token carries the POST-increment
    // version, so it survives the very check that kills the old one.
    expect(minted.tokenVersion).toBe(1);
    expect(minted.typ).toBe("access");
    expect(sessions.createUserSession).toHaveBeenCalledWith(
      "u1",
      minted.sessionId,
      expect.objectContaining({ activeRole: "CUSTOMER" }),
    );
    expect(sessions.setRefreshJti).toHaveBeenCalledWith("u1", minted.sessionId, expect.any(String));
    expect(r.cookie).toHaveBeenCalledWith("refreshToken", expect.any(String), expect.any(Object));

    // A web client gets the refresh token only through the httpOnly cookie.
    expect(body.refreshToken).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(STRONG_NEW);
    expect(JSON.stringify(body)).not.toContain(written);
  });

  it("returns the refresh token in the body for mobile clients", async () => {
    await passwordUser();
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "CUSTOMER" });

    const r = res();
    await changePassword(
      {
        user: { id: "u1", role: "CUSTOMER", sessionId: "s1" },
        body: { currentPassword: STRONG_OLD, newPassword: STRONG_NEW },
        headers: { "x-client-type": "mobile" },
        ip: "1.2.3.4",
      } as never,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    expect(typeof r.json.mock.calls[0][0].refreshToken).toBe("string");
  });

  it("does not report success when the authoritative write fails", async () => {
    // The whole policy rests on this one row update. If it fails, the caller
    // must not be told everything is fine.
    await passwordUser();
    db.user.update.mockRejectedValueOnce(new Error("db down"));

    const r = res();
    await changePassword(authed("u1", "s1", { currentPassword: STRONG_OLD, newPassword: STRONG_NEW }), r);

    expect(r.status).toHaveBeenCalledWith(500);
    expect(sessions.deleteAllUserSessions).not.toHaveBeenCalled();
    expect(JSON.stringify(r.json.mock.calls[0][0])).not.toContain(STRONG_NEW);
  });

  it("rejects unauthenticated requests", async () => {
    const r = res();
    await changePassword({ body: { currentPassword: STRONG_OLD, newPassword: STRONG_NEW } } as never, r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects missing current password and weak new passwords", async () => {
    await passwordUser();
    const missing = res();
    await changePassword(authed("u1", "s1", { newPassword: STRONG_NEW }), missing);
    expect(missing.status).toHaveBeenCalledWith(422);

    const weak = res();
    await changePassword(authed("u1", "s1", { currentPassword: STRONG_OLD, newPassword: "weak" }), weak);
    expect(weak.status).toHaveBeenCalledWith(422);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects a wrong current password without touching anything", async () => {
    await passwordUser();
    const r = res();
    await changePassword(authed("u1", "s1", { currentPassword: "Wrong123!", newPassword: STRONG_NEW }), r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(sessions.deleteUserSession).not.toHaveBeenCalled();
  });

  it("rejects reusing the current password", async () => {
    await passwordUser();
    const r = res();
    await changePassword(authed("u1", "s1", { currentPassword: STRONG_OLD, newPassword: STRONG_OLD }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("directs Google-only accounts to the forgot-password flow", async () => {
    await passwordUser({ password: null, authProviders: ["GOOGLE"] });
    const r = res();
    await changePassword(authed("u1", "s1", { currentPassword: "anything1!", newPassword: STRONG_NEW }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json.mock.calls[0][0].message).toMatch(/forgot-password/i);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown users", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const r = res();
    await changePassword(authed("ghost", "s1", { currentPassword: STRONG_OLD, newPassword: STRONG_NEW }), r);
    expect(r.status).toHaveBeenCalledWith(404);
  });

  it("does not claim every device was signed out when the database sweep failed", async () => {
    // Phase 1E.1. `deleteAllUserSessions` now reports whether the
    // authoritative DB rows actually went away. When they did not, outstanding
    // ACCESS tokens (which carry no version claim and stop only when their
    // session goes) may still be usable, so the message must not assert the
    // opposite. It must also not pretend the password change was undone.
    await passwordUser();
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "CUSTOMER" });
    sessions.deleteAllUserSessions.mockResolvedValueOnce(false);

    const r = res();
    await changePassword(authed("u1", "s1", { currentPassword: STRONG_OLD, newPassword: STRONG_NEW }), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const message = r.json.mock.calls[0][0].message as string;
    expect(message).not.toMatch(/all other devices have been signed out/i);
    expect(message).toMatch(/could not confirm/i);
    // The change itself stands: the version bump is what kills refresh tokens.
    expect(message).toMatch(/password changed successfully/i);
    expect(message).not.toMatch(/rolled back|not changed|failed to change/i);
    expect(db.user.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
  });

  it("still succeeds when the session sweep fails, because tokenVersion was already bumped", async () => {
    // The sweep is defence in depth. The authoritative invalidation is the
    // tokenVersion bump in the same statement as the hash, so a Redis outage
    // during cleanup cannot leave pre-change refresh tokens usable — and it
    // must not be reported as a successful global invalidation either.
    await passwordUser();
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "CUSTOMER" });
    sessions.deleteAllUserSessions.mockRejectedValueOnce(new Error("redis down"));

    const r = res();
    await changePassword(authed("u1", "s1", { currentPassword: STRONG_OLD, newPassword: STRONG_NEW }), r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect(db.user.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
    // The caller still gets a working session.
    expect(typeof r.json.mock.calls[0][0].accessToken).toBe("string");
    // ...and is not told everything else was signed out.
    expect(r.json.mock.calls[0][0].message).toMatch(/could not confirm/i);
  });
});

describe("session revocation", () => {
  it("a revoked session cannot refresh (no resurrection)", async () => {
    const user = await passwordUser();
    const token = jwt.sign(
      { id: "u1", tokenVersion: 0, sessionId: "s9", jti: "j9" },
      config.jwtSecret,
    );
    sessions.getUserSession.mockResolvedValue(null);

    const r = res();
    await refreshToken({ body: { refreshToken: token }, cookies: {} } as never, r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json.mock.calls[0][0].message).toMatch(/log in again/i);
    expect(JSON.stringify(r.json.mock.calls[0][0])).not.toContain("accessToken");
    expect(user).toBeTruthy();
  });

  it("a valid refresh rotates credentials", async () => {
    await passwordUser();
    const token = jwt.sign(
      { id: "u1", tokenVersion: 0, sessionId: "s1", jti: "j1" },
      config.jwtSecret,
    );
    // Batch 1D.60: the handler decides via the atomic CAS, not the old
    // read-then-write helpers.
    sessions.rotateRefreshJtiCAS.mockResolvedValue({ outcome: "rotated" });
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4" });

    const r = res();
    await refreshToken({ body: { refreshToken: token }, cookies: {} } as never, r);
    expect(r.status).toHaveBeenCalledWith(200);
    const body = r.json.mock.calls[0][0];
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    const decoded = jwt.decode(body.refreshToken) as any;
    expect(decoded.jti).toBeTruthy();
    expect(decoded.jti).not.toBe("j1");
    expect(sessions.rotateRefreshJtiCAS).toHaveBeenCalledWith("u1", "s1", "j1", decoded.jti);
  });

  it("refresh-token replay revokes the whole account", async () => {
    await passwordUser();
    const token = jwt.sign(
      { id: "u1", tokenVersion: 0, sessionId: "s1", jti: "j-old" },
      config.jwtSecret,
    );
    sessions.rotateRefreshJtiCAS.mockResolvedValue({ outcome: "replay", currentJti: "j-current" });

    const r = res();
    await refreshToken({ body: { refreshToken: token }, cookies: {} } as never, r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json.mock.calls[0][0].message).toMatch(/compromised/i);
    expect(sessions.deleteAllUserSessions).toHaveBeenCalledWith("u1");
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" } }),
    );
  });

  it("logout revokes only the current session", async () => {
    const r = res();
    await logout({ user: { id: "u1", role: "CUSTOMER", sessionId: "s1" } } as never, r);
    expect(sessions.deleteUserSession).toHaveBeenCalledWith("u1", "s1");
    expect(sessions.deleteUserSession).toHaveBeenCalledTimes(1);
    expect(r.clearCookie).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("logout-all revokes everything and bumps the token version", async () => {
    await passwordUser();
    const r = res();
    await logoutAllDevices({ user: { id: "u1", role: "CUSTOMER", sessionId: "s1" } } as never, r);
    expect(sessions.deleteAllUserSessions).toHaveBeenCalledWith("u1");
    const versionBump = db.user.update.mock.calls.find(
      (c: any) => c[0]?.data?.tokenVersion?.increment === 1,
    );
    expect(versionBump).toBeTruthy();
  });

  it("a user can only revoke sessions under their own id", async () => {
    const r = res();
    await revokeSession(
      { user: { id: "user-A", role: "CUSTOMER", sessionId: "s1" }, params: { sessionId: "session-X" } } as never,
      r,
    );
    expect(sessions.deleteUserSession).toHaveBeenCalledWith("user-A", "session-X");
    expect(sessions.deleteUserSession).toHaveBeenCalledTimes(1);
    expect(r.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ message: "Session revoked", wasCurrentSession: false }),
    );
  });

  it("session listings expose no secrets", async () => {
    sessions.listUserSessions.mockResolvedValue([
      { sessionId: "s1", ip: "1.2.3.4", userAgent: "jest", deviceId: null },
      { sessionId: "s2", ip: "5.6.7.8", userAgent: "jest", deviceId: null },
    ]);
    const r = res();
    await getMySessions({ user: { id: "u1", role: "CUSTOMER", sessionId: "s1" } } as never, r);
    const dumped = JSON.stringify(r.json.mock.calls[0][0]).toLowerCase();
    for (const secret of ["refreshtoken", "password", "hash", "jti", "otp", "secret"]) {
      expect(dumped).not.toContain(secret);
    }
    expect(r.json.mock.calls[0][0].sessions).toHaveLength(2);
  });
});

describe("refresh preserves the session's selected role (Phase 1E)", () => {
  it("mints the new access token from the SESSION role, not the account role", async () => {
    // The account role is CUSTOMER; this session switched itself to VENDOR.
    // Refreshing must not undo that choice.
    //
    // `roles` MUST also include VENDOR: `switchRole` only permits a role the
    // account already holds, so a session acting as VENDOR implies the account
    // holds [CUSTOMER, VENDOR]. Refresh now re-checks that membership (as
    // `authenticate` does), so a fixture claiming otherwise would model a state
    // the application cannot produce.
    await passwordUser({ roles: ["CUSTOMER", "VENDOR"] });
    const token = jwt.sign(
      { id: "u1", tokenVersion: 0, sessionId: "s1", jti: "j1" },
      config.jwtSecret,
    );
    sessions.rotateRefreshJtiCAS.mockResolvedValue({ outcome: "rotated" });
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "VENDOR" });

    const r = res();
    await refreshToken({ body: { refreshToken: token }, cookies: {} } as never, r);

    expect(r.status).toHaveBeenCalledWith(200);
    const decoded = jwt.decode(r.json.mock.calls[0][0].accessToken) as any;
    expect(decoded.role).toBe("VENDOR");
    expect(decoded.sessionId).toBe("s1");
  });

  it("falls back to the account role for a legacy session with no activeRole", async () => {
    await passwordUser();
    const token = jwt.sign(
      { id: "u1", tokenVersion: 0, sessionId: "s1", jti: "j1" },
      config.jwtSecret,
    );
    sessions.rotateRefreshJtiCAS.mockResolvedValue({ outcome: "rotated" });
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4" });

    const r = res();
    await refreshToken({ body: { refreshToken: token }, cookies: {} } as never, r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect((jwt.decode(r.json.mock.calls[0][0].accessToken) as any).role).toBe("CUSTOMER");
  });

  it("never writes activeRole back when it slides the session TTL (Phase 1E.1)", async () => {
    // The session read here is cache-first, so it can be OLDER than the
    // database row. Restating it would make createUserSession overwrite the
    // authoritative role with a stale one — silently reverting a role switch.
    // The refresh must therefore not mention the field at all.
    await passwordUser({ roles: ["CUSTOMER", "VENDOR"] });
    const token = jwt.sign(
      { id: "u1", tokenVersion: 0, sessionId: "s1", jti: "j1" },
      config.jwtSecret,
    );
    sessions.rotateRefreshJtiCAS.mockResolvedValue({ outcome: "rotated" });
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "VENDOR" });

    const r = res();
    await refreshToken({ body: { refreshToken: token }, cookies: {} } as never, r);

    expect(r.status).toHaveBeenCalledWith(200);
    const [, , metadata] = sessions.createUserSession.mock.calls[0];
    expect(Object.prototype.hasOwnProperty.call(metadata as object, "activeRole")).toBe(false);
    // The TTL slide still happens, and other metadata is carried through.
    expect((metadata as any).ip).toBe("1.2.3.4");
    expect((metadata as any).lastRefreshedAt).toBeInstanceOf(Date);
  });

  it("cannot revert a role switch when the cache is stale (Phase 1E.1)", async () => {
    // Deterministic stale-cache simulation: PostgreSQL holds VENDOR (the user
    // switched), Redis still answers CUSTOMER. Before the fix the refresh
    // spread that stale value straight back into the upsert, demoting the
    // session again.
    await passwordUser({ role: "CUSTOMER", roles: ["CUSTOMER", "VENDOR"] });
    const token = jwt.sign(
      { id: "u1", tokenVersion: 0, sessionId: "s1", jti: "j1" },
      config.jwtSecret,
    );
    sessions.rotateRefreshJtiCAS.mockResolvedValue({ outcome: "rotated" });
    // The cache is the stale one.
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "CUSTOMER" });

    const r = res();
    await refreshToken({ body: { refreshToken: token }, cookies: {} } as never, r);

    expect(r.status).toHaveBeenCalledWith(200);
    // Nothing was written back that could carry the stale role.
    const [, , metadata] = sessions.createUserSession.mock.calls[0];
    expect(metadata).not.toHaveProperty("activeRole");
  });
});

describe("access-token invalidation across credential changes (Phase 1E.2)", () => {
  it("old access and refresh tokens are both dead after a password change", async () => {
    // The end-to-end guarantee: one statement bumps tokenVersion, and BOTH
    // token families carry that value, so neither can be replayed.
    await passwordUser(); // tokenVersion: 0
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "CUSTOMER" });
    sessions.deleteAllUserSessions.mockResolvedValue(true);

    const oldAccess = jwt.sign(
      { id: "u1", role: "CUSTOMER", sessionId: "s-old", tokenVersion: 0, typ: "access" },
      config.jwtSecret,
    );
    const oldRefresh = jwt.sign(
      { id: "u1", tokenVersion: 0, sessionId: "s-old", jti: "j-old" },
      config.jwtSecret,
    );

    const r = res();
    await changePassword(authed("u1", "s-old", { currentPassword: STRONG_OLD, newPassword: STRONG_NEW }), r);
    expect(r.status).toHaveBeenCalledWith(200);

    // The account is now at version 1.
    expect(db.user.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });

    // The old access token is rejected by `authenticate`'s version gate: the
    // account row now reads version 1 while the token claims 0.
    const { authenticate } = require("../../src/middlewares/auth.middleware");
    db.user.findUnique.mockResolvedValue({
      id: "u1",
      isBlocked: false,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
      tokenVersion: 1,
    });
    await expect(
      authenticate(
        { headers: { authorization: `Bearer ${oldAccess}` } } as never,
        {} as never,
        jest.fn(),
      ),
    ).rejects.toThrow();

    // The old refresh token is rejected by the existing version check.
    db.user.findUnique.mockResolvedValue({ ...db.user.findUnique(), tokenVersion: 1 });
    const rr = res();
    await refreshToken({ body: { refreshToken: oldRefresh }, cookies: {} } as never, rr);
    expect(rr.status).toHaveBeenCalledWith(401);
  });

  it("the replacement access token works while the old one does not", async () => {
    await passwordUser();
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "CUSTOMER" });
    sessions.deleteAllUserSessions.mockResolvedValue(true);

    const r = res();
    await changePassword(authed("u1", "s-old", { currentPassword: STRONG_OLD, newPassword: STRONG_NEW }), r);
    const fresh = r.json.mock.calls[0][0].accessToken as string;
    const claims = jwt.decode(fresh) as any;

    const { authenticate } = require("../../src/middlewares/auth.middleware");
    const dbUser = require("../../src/lib/prisma").default as any;
    dbUser.user.findUnique.mockResolvedValue({
      isBlocked: false,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
      tokenVersion: claims.tokenVersion,
    });
    const { getUserSession } = require("../../src/lib/session") as { getUserSession: jest.Mock };
    getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: claims.role });

    const req: any = { headers: { authorization: `Bearer ${fresh}` } };
    await expect(authenticate(req, {} as never, jest.fn())).resolves.toBeUndefined();
    expect(req.user.role).toBe("CUSTOMER");
  });
});

describe("password reset session safety", () => {
  function resetTokenFor(userId: string): string {
    return jwt.sign({ id: userId }, config.jwtResetSecret, { expiresIn: "10m" });
  }

  it("a successful reset revokes all sessions and is single-use", async () => {
    const user = await passwordUser();
    const token = resetTokenFor("u1");
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: "u1",
      // Batch 1D.51: only the JWT digest rests in the DB, never the bearer.
      token: resetJwtDigest(config.jwtResetSecret, token),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    // Batch 1D.55: Prisma's deleteMany always resolves { count }; the
    // conditional consume depends on that count, so the double must too.
    db.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_NEW } } as never, r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(sessions.deleteAllUserSessions).toHaveBeenCalledWith("u1");
    const versionBump = db.user.update.mock.calls.find(
      (c: any) => c[0]?.data?.tokenVersion?.increment === 1,
    );
    expect(versionBump).toBeTruthy();
    // Batch 1D.55: consumption is a conditional delete — exactly this
    // credential (user + digest), still unexpired — inside the transaction.
    expect(db.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        token: resetJwtDigest(config.jwtResetSecret, token),
        expiresAt: expect.anything(),
      },
    });
    const stored = db.user.update.mock.calls.find((c: any) => c[0]?.data?.password);
    await expect(bcrypt.compare(STRONG_NEW, stored[0].data.password)).resolves.toBe(true);
    expect(user).toBeTruthy();

    // Single-use: the consumed token is gone.
    db.passwordResetToken.findUnique.mockResolvedValue(null);
    const replay = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: "Other123!" } } as never, replay);
    expect(replay.status).toHaveBeenCalledWith(406);
  });

  it("rejects expired reset tokens", async () => {
    await passwordUser();
    const token = resetTokenFor("u1");
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: "u1",
      token: resetJwtDigest(config.jwtResetSecret, token),
      expiresAt: new Date(Date.now() - 1000),
    });
    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_NEW } } as never, r);
    expect(r.status).toHaveBeenCalledWith(406);
    expect(sessions.deleteAllUserSessions).not.toHaveBeenCalled();
  });
});

/**
 * Phase 1F — authenticate middleware: token validation + per-request
 * session enforcement (the mechanism that makes logout immediate).
 */
import jwt from "jsonwebtoken";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(async () => ({ isBlocked: false })) },
  },
}));

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  getUserSession: jest.fn(async () => null),
  deleteAllUserSessions: jest.fn(async () => {}),
  // Phase 1E: `authenticate` resolves the session's own active role. Mirrored
  // from the real helper so the fallback semantics stay honest here.
  resolveSessionRole: jest.fn((session: any, accountRole: any) => {
    const sessionRole = session?.activeRole;
    return typeof sessionRole === "string" && sessionRole.length > 0 ? sessionRole : accountRole ?? null;
  }),
}));

import config from "../../src/config/config";
import prisma from "../../src/lib/prisma";
import * as sessionLib from "../../src/lib/session";
import { authenticate } from "../../src/middlewares/auth.middleware";
import { generateAccessToken } from "../../src/utils/generateToken";
import { UnauthorizedError, ForbiddenError } from "../../src/errors/AppError";

const db = prisma as unknown as { user: { findUnique: jest.Mock } };
const sessions = sessionLib as unknown as {
  getUserSession: jest.Mock;
  deleteAllUserSessions: jest.Mock;
};

const reqWith = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as never;
const next = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  // Phase 1E: the middleware resolves the session's active role against the
  // account row, so the default fixture must carry a role the live-session
  // token can match. Tests that exercise blocked/legacy paths never reach the
  // comparison.
  // Phase 1E.2 adds `tokenVersion`, which `authenticate` compares against this
  // same authoritative row.
  db.user.findUnique.mockResolvedValue({
    isBlocked: false,
    role: "VENDOR",
    roles: ["CUSTOMER", "VENDOR"],
    tokenVersion: ACCOUNT_VERSION,
  });
  sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4" });
});

/** The account's live tokenVersion in the default fixture. */
const ACCOUNT_VERSION = 3;

/**
 * Phase 1E.2: mint tokens through the real helper so they carry the current
 * shape (`typ` + `tokenVersion`). Tests that need a legacy or malformed token
 * sign one by hand.
 */
function bearer(payload: object, signOpts: object = {}): string {
  const { id = "u1", role, sessionId = "s1", ...rest } = payload as Record<string, unknown>;
  return `Bearer ${generateAccessToken(
    id as string,
    role as string,
    sessionId as string,
    (rest.tokenVersion as number) ?? ACCOUNT_VERSION,
  )}`;
}

/** Sign an arbitrary payload verbatim — for legacy / malformed / foreign claims. */
function rawBearer(payload: object, signOpts: object = {}): string {
  return `Bearer ${jwt.sign(payload, config.jwtSecret, signOpts)}`;
}

describe("authenticate", () => {
  it("rejects requests without a token", async () => {
    await expect(
      authenticate(reqWith(), {} as never, next),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      authenticate(reqWith("Token abc"), {} as never, next),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects malformed and wrong-secret tokens", async () => {
    await expect(
      authenticate(reqWith("Bearer not.a.token"), {} as never, next),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    const forged = `Bearer ${jwt.sign({ id: "u1", role: "ADMIN", sessionId: "s1" }, "wrong-secret")}`;
    await expect(
      authenticate(reqWith(forged), {} as never, next),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects expired tokens", async () => {
    const expired = bearer(
      { id: "u1", role: "CUSTOMER", sessionId: "s1" },
      { expiresIn: "-10s" },
    );
    await expect(
      authenticate(reqWith(expired), {} as never, next),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects legacy tokens without a sessionId", async () => {
    // Signed verbatim so it really has no sessionId — `bearer()` would supply
    // one by default.
    const legacy = rawBearer({ id: "u1", role: "CUSTOMER", typ: "access", tokenVersion: ACCOUNT_VERSION });
    await expect(
      authenticate(reqWith(legacy), {} as never, next),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(sessions.getUserSession).not.toHaveBeenCalled();
  });

  it("rejects revoked sessions even with a valid signature", async () => {
    sessions.getUserSession.mockResolvedValue(null);
    const token = bearer({ id: "u1", role: "CUSTOMER", sessionId: "s-gone" });
    await expect(
      authenticate(reqWith(token), {} as never, next),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(sessions.getUserSession).toHaveBeenCalledWith("u1", "s-gone");
  });

  it("authenticates live sessions and exposes only id/role/sessionId", async () => {
    const token = bearer({ id: "u1", role: "VENDOR", sessionId: "s1" });
    const req: any = reqWith(token);
    await authenticate(req, {} as never, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ id: "u1", role: "VENDOR", sessionId: "s1" });
  });

  it("blocks blocked accounts and wipes their sessions", async () => {
    db.user.findUnique.mockResolvedValue({ isBlocked: true });
    const token = bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1" });
    await expect(
      authenticate(reqWith(token), {} as never, next),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(sessions.deleteAllUserSessions).toHaveBeenCalledWith("u1");
  });
});

// Phase 1E.2: the access token now carries `tokenVersion`, and `authenticate`
// compares it against the authoritative user row on every request. That is
// what makes a password change invalidate pre-change ACCESS tokens the moment
// the version bump is durable — independent of whether session deletion
// succeeded.
describe("authenticate — access-token version gate (Phase 1E.2)", () => {
  const account = (over: Record<string, unknown> = {}) => ({
    isBlocked: false,
    role: "CUSTOMER",
    roles: ["CUSTOMER", "VENDOR"],
    tokenVersion: 4,
    ...over,
  });

  beforeEach(() => {
    db.user.findUnique.mockResolvedValue(account());
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4" });
  });

  it("accepts a correctly versioned token", async () => {
    const req: any = reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", tokenVersion: 4 }));
    await authenticate(req, {} as never, next);
    expect(req.user).toEqual({ id: "u1", role: "CUSTOMER", sessionId: "s1" });
  });

  it("rejects a token whose tokenVersion is older than the account's", async () => {
    // The password-change case: the account moved to 4, the token says 3.
    const req: any = reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", tokenVersion: 3 }));
    await expect(authenticate(req, {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects the old token even when its session still exists", async () => {
    // The exact Phase 1E gap: the sweep failed, so the session row survived.
    // The token must still be dead, because the version check is independent
    // of session deletion.
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4" });
    const req: any = reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", tokenVersion: 3 }));
    await expect(authenticate(req, {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(sessions.getUserSession).toHaveBeenCalled();
  });

  it("rejects a token with no tokenVersion claim rather than assuming it is current", async () => {
    const legacy = rawBearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", typ: "access" });
    await expect(authenticate(reqWith(legacy), {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a token whose tokenVersion is malformed", async () => {
    for (const bad of ["4", null, 1.5, NaN]) {
      const t = rawBearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", typ: "access", tokenVersion: bad });
      await expect(authenticate(reqWith(t), {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
    }
  });

  it("refuses a refresh token presented as a Bearer access token", async () => {
    // Both are signed with the same secret, and a refresh token legitimately
    // carries a matching tokenVersion — only `typ` distinguishes them.
    const refreshAsBearer = rawBearer({ id: "u1", tokenVersion: 4, sessionId: "s1", jti: "j1" });
    await expect(authenticate(reqWith(refreshAsBearer), {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("refuses a token with no typ claim, even one minted by an older build", async () => {
    const t = rawBearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", tokenVersion: 4 });
    await expect(authenticate(reqWith(t), {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("still enforces blocked-account and session checks", async () => {
    sessions.getUserSession.mockResolvedValue(null);
    await expect(
      authenticate(reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", tokenVersion: 4 })), {} as never, next),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // Back to a live session so the blocked check is what stops this one.
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4" });
    db.user.findUnique.mockResolvedValue(account({ isBlocked: true }));
    await expect(
      authenticate(reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", tokenVersion: 4 })), {} as never, next),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("still enforces the session role alongside the version", async () => {
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "VENDOR" });
    const req: any = reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", tokenVersion: 4 }));
    await expect(authenticate(req, {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects when the account row cannot be read at all", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const req: any = reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1", tokenVersion: 4 }));
    await expect(authenticate(req, {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
// Phase 1E: the session — not the JWT claim — is the authority on which role
// is in play. These prove a role switch or a demotion takes effect on the very
// next request, rather than whenever the 15-minute access token happens to
// expire, and that pre-existing sessions keep working across the change.
describe("authenticate — session-scoped active role (Phase 1E)", () => {
  const account = (over: Record<string, unknown> = {}) => ({
    isBlocked: false,
    role: "CUSTOMER",
    roles: ["CUSTOMER", "VENDOR"],
    tokenVersion: ACCOUNT_VERSION,
    ...over,
  });

  it("accepts a token that matches the session's role", async () => {
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "VENDOR" });
    db.user.findUnique.mockResolvedValue(account());

    const req: any = reqWith(bearer({ id: "u1", role: "VENDOR", sessionId: "s1" }));
    await authenticate(req, {} as never, next);
    expect(req.user).toEqual({ id: "u1", role: "VENDOR", sessionId: "s1" });
  });

  it("rejects a token whose role no longer matches the session", async () => {
    // A switch on this session has invalidated the token the client is holding.
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "VENDOR" });
    db.user.findUnique.mockResolvedValue(account());

    const req: any = reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1" }));
    await expect(authenticate(req, {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a session role the account no longer authorises", async () => {
    // Demotion: the session still says VENDOR but the held-roles list no
    // longer contains it. Neither layer may let it through.
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "VENDOR" });
    db.user.findUnique.mockResolvedValue(account({ roles: ["CUSTOMER"] }));

    const req: any = reqWith(bearer({ id: "u1", role: "VENDOR", sessionId: "s1" }));
    await expect(authenticate(req, {} as never, next)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps a legacy session working by falling back to the account role", async () => {
    // Rows created before the migration carry no activeRole. They must behave
    // exactly as they did: act as the account role.
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4" });
    db.user.findUnique.mockResolvedValue(account({ role: "VENDOR" }));

    const req: any = reqWith(bearer({ id: "u1", role: "VENDOR", sessionId: "s1" }));
    await authenticate(req, {} as never, next);
    expect(req.user.role).toBe("VENDOR");
  });

  it("rejects a legacy session whose token role disagrees with the account role", async () => {
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4" });
    db.user.findUnique.mockResolvedValue(account({ role: "CUSTOMER" }));

    const req: any = reqWith(bearer({ id: "u1", role: "VENDOR", sessionId: "s1" }));
    await expect(authenticate(req, {} as never, next)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("leaves a second session of the same account unaffected by the first", async () => {
    // Two devices, two sessions, two roles — independence is the whole point.
    db.user.findUnique.mockResolvedValue(account());
    sessions.getUserSession.mockImplementation(async (_id: string, sid: string) =>
      sid === "s-phone" ? { ip: "1.2.3.4", activeRole: "VENDOR" } : { ip: "1.2.3.4", activeRole: "CUSTOMER" },
    );

    const phone: any = reqWith(bearer({ id: "u1", role: "VENDOR", sessionId: "s-phone" }));
    const laptop: any = reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s-laptop" }));
    await authenticate(phone, {} as never, next);
    await authenticate(laptop, {} as never, next);

    expect(phone.user.role).toBe("VENDOR");
    expect(laptop.user.role).toBe("CUSTOMER");
  });

  it("still refuses a blocked account before any role decision", async () => {
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: "CUSTOMER" });
    db.user.findUnique.mockResolvedValue(account({ isBlocked: true }));

    const req: any = reqWith(bearer({ id: "u1", role: "CUSTOMER", sessionId: "s1" }));
    await expect(authenticate(req, {} as never, next)).rejects.toBeInstanceOf(ForbiddenError);
    expect(sessions.deleteAllUserSessions).toHaveBeenCalledWith("u1");
  });

  it("allows an account that has not chosen a role yet", async () => {
    sessions.getUserSession.mockResolvedValue({ ip: "1.2.3.4", activeRole: null });
    db.user.findUnique.mockResolvedValue(account({ role: null, roles: [] }));

    const req: any = reqWith(bearer({ id: "u1", sessionId: "s1" }));
    await authenticate(req, {} as never, next);
    expect(req.user.role).toBe("");
  });
});

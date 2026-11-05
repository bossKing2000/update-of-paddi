/**
 * Batch 1D.55 — atomic single-use password-reset finalization.
 *
 * Root cause under test: `secureResetPassword` used to read the credential
 * row, then — in separate statements — update the password and delete the
 * row. Two concurrent requests with one valid JWT both passed the read
 * check and both committed: the credential was consumed twice. A failure
 * between the writes likewise left a changed password beside a live
 * credential (or vice versa).
 *
 * The fix consumes the credential and writes the password inside ONE
 * `prisma.$transaction`, where a conditional delete
 * (`userId` + exact digest + still-unexpired) must remove exactly one row
 * before the password write runs. The loser finds nothing to delete and
 * aborts without touching the account.
 *
 * What these tests prove — and what they do not. Prisma is mocked, so the
 * "database" here is an in-test row store and the "transaction" is a
 * snapshot/restore wrapper: they prove the handler issues the consume and
 * the write as one atomic unit with a count check (exactly one winner, no
 * partial state on failure, no loser write). They cannot prove real
 * Postgres row-locking or isolation levels; that evidence needs an approved
 * isolated database and is reported as outstanding.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn() },
    passwordResetToken: {
      upsert: jest.fn(async () => ({})),
      findUnique: jest.fn(),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  deleteAllUserSessions: jest.fn(async () => {}),
}));

// Batch 1D.70: the shared finalization counter is a Redis-backed service. This
// suite is about the DATABASE transaction, so the counter is stubbed here and
// driven explicitly by the gate tests below. Without this mock the real
// service would hit an unconnected client and every reset would correctly
// fail closed with 503.
jest.mock("../../src/services/passwordResetLimits.service", () => ({
  __esModule: true,
  recordResetAttempt: jest.fn(async () => ({ count: 1, exhausted: false })),
  resetFinalizeKeyFor: jest.fn((token: string) => `pwdreset:finalize:${token}`),
  acquireResetCooldown: jest.fn(async () => true),
  clearResetAttempts: jest.fn(async () => {}),
  resetAttemptsKeyFor: jest.fn((id: string) => `pwdreset:attempts:${id}`),
  resetCooldownKeyFor: jest.fn((id: string) => `pwdreset:cooldown:${id}`),
  resetUnknownAttemptsKeyFor: jest.fn((e: string) => `pwdreset:attempts:unknown:${e}`),
  resetUnknownCooldownKeyFor: jest.fn((e: string) => `pwdreset:cooldown:unknown:${e}`),
  RESET_FINALIZE_MAX_ATTEMPTS: 5,
  RESET_LIMITS_COMMAND_TIMEOUT_MS: 750,
}));

import prisma from "../../src/lib/prisma";
import * as sessionLib from "../../src/lib/session";
import * as limitsService from "../../src/services/passwordResetLimits.service";
import config from "../../src/config/config";
import { secureResetPassword } from "../../src/controllers/auth.controller";
import { resetJwtDigest } from "../../src/utils/resetTokenDigest";

const limits = limitsService as unknown as Record<string, jest.Mock>;

const db = prisma as unknown as Record<string, any>;
const sessions = sessionLib as unknown as Record<string, jest.Mock>;
const SECRET = config.jwtResetSecret;

const KNOWN = { id: "u1", email: "u1@example.com" };
const STRONG_A = "NewPass456@";
const STRONG_B = "OtherPass789#";

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};
const statusOf = (r: any): number => r.status.mock.calls[0][0];
const bodyOf = (r: any): any => r.json.mock.calls[0][0];

function validJwt(userId = KNOWN.id): string {
  return jwt.sign({ id: userId }, config.jwtResetSecret, { expiresIn: "10m" });
}

interface RowState {
  row: { userId: string; token: string; expiresAt: Date } | null;
  password: string;
  tokenVersion: number;
}

let state: RowState;
let failNextUserUpdate = false;

function seedValidChallenge(token: string) {
  state.row = {
    userId: KNOWN.id,
    token: resetJwtDigest(SECRET, token),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

/** Predicate mirror of the handler's conditional delete (no awaits inside: atomic). */
function matchesWhere(
  row: RowState["row"],
  where: { userId?: string; token?: string; expiresAt?: { gt?: Date } },
): boolean {
  if (!row) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.token !== undefined && row.token !== where.token) return false;
  if (where.expiresAt?.gt !== undefined && !(row.expiresAt > where.expiresAt.gt)) return false;
  return true;
}

beforeEach(async () => {
  jest.clearAllMocks();
  state = {
    row: null,
    password: await bcrypt.hash("OldPass123!", 4),
    tokenVersion: 0,
  };
  failNextUserUpdate = false;

  db.user.findUnique.mockImplementation(async (args: any) =>
    args?.where?.id === KNOWN.id
      ? { ...KNOWN, password: state.password, tokenVersion: state.tokenVersion, authProviders: [] as string[] }
      : null,
  );
  db.passwordResetToken.findUnique.mockImplementation(async (args: any) =>
    args?.where?.userId === KNOWN.id ? state.row : null,
  );
  db.passwordResetToken.deleteMany.mockImplementation(async (args: any) => {
    // Synchronous check-and-remove: no await between predicate and removal,
    // so concurrent callers serialize here the way row locking serializes
    // the real conditional delete (within the limits of a mock — see file
    // header for what this does and does not prove).
    if (matchesWhere(state.row, args?.where ?? {})) {
      state.row = null;
      return { count: 1 };
    }
    return { count: 0 };
  });
  db.user.update.mockImplementation(async (args: any) => {
    if (failNextUserUpdate) {
      failNextUserUpdate = false;
      throw new Error("db down mid-transaction");
    }
    if (args?.data?.password) state.password = args.data.password;
    if (args?.data?.tokenVersion?.increment) state.tokenVersion += args.data.tokenVersion.increment;
    return { ...KNOWN, password: state.password, tokenVersion: state.tokenVersion };
  });
  // Snapshot/restore models transaction atomicity: a throw inside the
  // callback restores every row this fake owns, so a partial commit is
  // impossible by construction here.
  db.$transaction.mockImplementation(async (cb: any) => {
    const prismaMock = require("../../src/lib/prisma").default;
    const snapshot = JSON.parse(JSON.stringify({ ...state, password: "[hash]" }));
    const savedPassword = state.password;
    try {
      return await cb(prismaMock);
    } catch (err) {
      state.row = snapshot.row
        ? { ...snapshot.row, expiresAt: new Date(snapshot.row.expiresAt) }
        : null;
      state.password = savedPassword;
      state.tokenVersion = snapshot.tokenVersion;
      throw err;
    }
  });
});

describe("successful reset updates the password and consumes the credential", () => {
  it("writes the new hash, bumps the version, deletes exactly the presented credential", async () => {
    const token = validJwt();
    seedValidChallenge(token);

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, r);

    expect(statusOf(r)).toBe(200);
    expect(bodyOf(r)).toEqual({
      message:
        "Password has been reset successfully. You have been logged out of all devices for security.",
    });
    await expect(bcrypt.compare(STRONG_A, state.password)).resolves.toBe(true);
    expect(state.tokenVersion).toBe(1);
    expect(state.row).toBeNull();
    expect(sessions.deleteAllUserSessions).toHaveBeenCalledWith(KNOWN.id);
    // The response carries no credential material.
    expect(JSON.stringify(bodyOf(r))).not.toContain(token);
  });
});

describe("post-commit session cleanup failure does not undo the reset", () => {
  it("still returns success with committed password, consumed credential, and bumped version", async () => {
    // Batch 1D.57: session revocation after the commit is best-effort. A
    // Redis outage here must not turn an accomplished reset into an error
    // response (the old code answered 407 after the password had changed)
    // and must not roll anything back.
    const token = validJwt();
    seedValidChallenge(token);
    sessions.deleteAllUserSessions.mockRejectedValueOnce(new Error("redis down"));

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, r);

    // 1+5. Intended successful response — never a misleading error.
    expect(statusOf(r)).toBe(200);
    expect(bodyOf(r)).toEqual({
      message:
        "Password has been reset successfully. You have been logged out of all devices for security.",
    });
    // 2. The password update is committed, not rolled back.
    await expect(bcrypt.compare(STRONG_A, state.password)).resolves.toBe(true);
    // 3. The credential stays consumed.
    expect(state.row).toBeNull();
    // 4. The version increment is committed — this is the hard revocation
    // guarantee the cleanup failure cannot take away.
    expect(state.tokenVersion).toBe(1);
    // 6. No credential material leaks into the response.
    expect(JSON.stringify(bodyOf(r))).not.toContain(token);
  });
});

describe("missing, expired, invalid, or consumed credentials cannot reset", () => {
  it("rejects when no credential row exists, without touching the account", async () => {
    const token = validJwt();
    state.row = null;

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, r);

    expect(statusOf(r)).toBe(406);
    expect(bodyOf(r)).toEqual({ message: "Invalid or expired reset token" });
    await expect(bcrypt.compare(STRONG_A, state.password)).resolves.toBe(false);
    expect(state.tokenVersion).toBe(0);
  });

  it("rejects an expired credential without touching the account", async () => {
    const token = validJwt();
    state.row = {
      userId: KNOWN.id,
      token: resetJwtDigest(SECRET, token),
      expiresAt: new Date(Date.now() - 1000),
    };

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, r);

    expect(statusOf(r)).toBe(406);
    await expect(bcrypt.compare(STRONG_A, state.password)).resolves.toBe(false);
    // The expired row is left for TTL/cleanup, not consumed by the attempt.
    expect(state.row).not.toBeNull();
  });

  it("rejects a digest mismatch without touching the account", async () => {
    const token = validJwt();
    seedValidChallenge("some-other-jwt-value");

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, r);

    expect(statusOf(r)).toBe(406);
    await expect(bcrypt.compare(STRONG_A, state.password)).resolves.toBe(false);
    expect(state.row).not.toBeNull();
  });

  it("rejects a replayed credential after a successful reset", async () => {
    const token = validJwt();
    seedValidChallenge(token);

    const first = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, first);
    expect(statusOf(first)).toBe(200);

    const replay = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_B } } as never, replay);
    expect(statusOf(replay)).toBe(406);
    // Still the winner's password — the replay changed nothing.
    await expect(bcrypt.compare(STRONG_A, state.password)).resolves.toBe(true);
    await expect(bcrypt.compare(STRONG_B, state.password)).resolves.toBe(false);
  });

  it("rejects malformed bodies without touching anything", async () => {
    const token = validJwt();
    seedValidChallenge(token);

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: "short" } } as never, r);

    expect(statusOf(r)).toBe(422);
    expect(state.row).not.toBeNull();
    await expect(bcrypt.compare("short", state.password)).resolves.toBe(false);
  });
});

describe("failures roll back all transactional changes", () => {
  it("a mid-transaction write failure leaves the credential and password untouched", async () => {
    const token = validJwt();
    seedValidChallenge(token);
    const originalRow = { ...state.row! };
    failNextUserUpdate = true;

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, r);

    // A transaction failure is a server error, not an invalid credential.
    expect(statusOf(r)).toBe(407);
    // Rollback: the row is back byte-for-byte and the password never moved.
    expect(state.row).toEqual(originalRow);
    await expect(bcrypt.compare(STRONG_A, state.password)).resolves.toBe(false);
    await expect(bcrypt.compare("OldPass123!", state.password)).resolves.toBe(true);
    expect(state.tokenVersion).toBe(0);
  });
});

describe("two requests competing for one credential", () => {
  it("exactly one succeeds; the loser changes nothing", async () => {
    const token = validJwt();
    seedValidChallenge(token);

    const [ra, rb] = await Promise.all([
      (async () => {
        const r = res();
        await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, r);
        return { status: statusOf(r), body: bodyOf(r) };
      })(),
      (async () => {
        const r = res();
        await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_B } } as never, r);
        return { status: statusOf(r), body: bodyOf(r) };
      })(),
    ]);

    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 406]);

    const winner = ra.status === 200 ? { password: STRONG_A, body: ra.body } : { password: STRONG_B, body: rb.body };
    const loser = ra.status === 200 ? rb : ra;

    // The loser was refused as an invalid credential — never reported success.
    expect(loser.body).toEqual({ message: "Invalid or expired reset token" });
    // Exactly one password write committed, and it is the winner's.
    const passwordWrites = db.user.update.mock.calls.filter((c: any) => c[0]?.data?.password);
    expect(passwordWrites).toHaveLength(1);
    await expect(bcrypt.compare(winner.password, state.password)).resolves.toBe(true);
    // The credential is gone either way.
    expect(state.row).toBeNull();
    expect(state.tokenVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Batch 1D.70 — the shared, cross-instance finalization counter.
// ---------------------------------------------------------------------------
describe("secureResetPassword — shared finalization counter", () => {
  it("permits five attempts and rejects the sixth before bcrypt or any database work", async () => {
    seedValidChallenge(validJwt());
    const hashSpy = jest.spyOn(bcrypt, "hash");

    for (let n = 1; n <= 5; n += 1) {
      limits.recordResetAttempt.mockResolvedValueOnce({ count: n, exhausted: false });
      const r = res();
      // The credential is single-use, so only the first attempt can reach the
      // transaction; the rest are refused on their merits. What matters here
      // is that the counter let them all THROUGH the gate.
      await secureResetPassword({ body: { resetToken: validJwt(), newPassword: STRONG_A } } as never, r);
      expect(r.status).not.toBe(429);
    }
    const beforeRejection = db.user.update.mock.calls.length;

    limits.recordResetAttempt.mockResolvedValueOnce({ count: 6, exhausted: true });
    hashSpy.mockClear();
    db.passwordResetToken.findUnique.mockClear();
    db.passwordResetToken.deleteMany.mockClear();
    sessions.deleteAllUserSessions.mockClear();

    const limited = res();
    await secureResetPassword({ body: { resetToken: validJwt(), newPassword: STRONG_A } } as never, limited);

    expect(statusOf(limited)).toBe(429);
    // Fixed, non-sensitive body: nothing about the account or the credential.
    expect(bodyOf(limited)).toEqual({
      success: false,
      code: "RESET_RATE_LIMITED",
      message: "Too many password reset attempts. Please try again later.",
    });
    // Refused BEFORE the token lookup, the bcrypt hash, the password write,
    // the credential consumption and the session cleanup.
    expect(hashSpy).not.toHaveBeenCalled();
    expect(db.passwordResetToken.findUnique).not.toHaveBeenCalled();
    expect(db.user.update.mock.calls.length).toBe(beforeRejection);
    expect(db.passwordResetToken.deleteMany).not.toHaveBeenCalled();
    expect(sessions.deleteAllUserSessions).not.toHaveBeenCalled();
    hashSpy.mockRestore();
  });

  it("an invalid signature never reaches the counter and keeps its 407 contract", async () => {
    const forged = jwt.sign({ id: KNOWN.id }, "not-the-reset-secret", { expiresIn: "10m" });
    limits.recordResetAttempt.mockClear();

    const r = res();
    await secureResetPassword({ body: { resetToken: forged, newPassword: STRONG_A } } as never, r);

    expect(statusOf(r)).toBe(407);
    expect(bodyOf(r)).toEqual({ message: "Invalid or expired reset token" });
    // Unauthenticated input must not be able to create or charge a key.
    expect(limits.recordResetAttempt).not.toHaveBeenCalled();
  });

  it("keys the counter on the presented credential and expires it with the token's remaining life", async () => {
    const token = validJwt();
    seedValidChallenge(token);
    limits.recordResetAttempt.mockClear();

    // Bracket the call: the controller reads the clock between these two
    // instants, so the correct assertion is against the range they define.
    // Comparing against a single post-call reading is flaky — a second
    // boundary crossing shifts "remaining" by one.
    const before = Date.now();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, res());
    const after = Date.now();

    expect(limits.recordResetAttempt).toHaveBeenCalledTimes(1);
    const [key, opts] = limits.recordResetAttempt.mock.calls[0];
    expect(key).toBe(`pwdreset:finalize:${token}`);
    expect(opts.maxAttempts).toBe(5);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    // The TTL is the token's real remaining lifetime, not a fresh 10 minutes.
    const expMs = (jwt.decode(token) as { exp: number }).exp * 1000;
    const remainingAtCall = Math.ceil((expMs - after) / 1000);
    const remainingBeforeCall = Math.ceil((expMs - before) / 1000);
    expect(opts.windowSeconds).toBeGreaterThanOrEqual(remainingAtCall);
    expect(opts.windowSeconds).toBeLessThanOrEqual(remainingBeforeCall);
    expect(opts.windowSeconds).toBeLessThanOrEqual(600);
  });

  it("fails closed with 503 before bcrypt, the password write, credential consumption and session cleanup", async () => {
    seedValidChallenge(validJwt());
    limits.recordResetAttempt.mockRejectedValueOnce(new Error("redis down"));
    const hashSpy = jest.spyOn(bcrypt, "hash");

    const r = res();
    await secureResetPassword({ body: { resetToken: validJwt(), newPassword: STRONG_A } } as never, r);

    expect(statusOf(r)).toBe(503);
    // Fixed body — no account, token or store detail.
    expect(bodyOf(r)).toEqual({
      message: "Password reset is temporarily unavailable. Please retry shortly.",
    });
    expect(hashSpy).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.passwordResetToken.deleteMany).not.toHaveBeenCalled();
    expect(sessions.deleteAllUserSessions).not.toHaveBeenCalled();
    // Nothing was consumed, so the caller may retry once Redis recovers.
    expect(state.row).not.toBeNull();
    hashSpy.mockRestore();
  });

  it("a validly signed but unbacked credential keeps its 406 contract while it has budget", async () => {
    limits.recordResetAttempt.mockResolvedValueOnce({ count: 1, exhausted: false });
    state.row = null;

    const r = res();
    await secureResetPassword({ body: { resetToken: validJwt(), newPassword: STRONG_A } } as never, r);

    expect(statusOf(r)).toBe(406);
    expect(bodyOf(r)).toEqual({ message: "Invalid or expired reset token" });
  });

  it("spending the shared budget does not weaken the single-use credential gate", async () => {
    const token = validJwt();
    seedValidChallenge(token);

    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_A } } as never, res());
    expect(state.row).toBeNull();

    // The credential is dead regardless of the counter; the replay is refused
    // on its merits, and the counter has still charged the attempt.
    limits.recordResetAttempt.mockResolvedValueOnce({ count: 2, exhausted: false });
    const replay = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG_B } } as never, replay);

    expect(statusOf(replay)).toBe(406);
    expect(state.password).not.toBe(STRONG_B);
    expect(db.user.update).toHaveBeenCalledTimes(1);
  });
});

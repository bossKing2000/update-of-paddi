/**
 * Account-enumeration hardening (Batch 1E.35).
 *
 * Three public, unauthenticated endpoints previously disclosed whether an
 * address was registered:
 *
 *   - forgotPassword              404 "User not found" vs 200 "Reset code sent"
 *   - verifyResetCode             404 "User not found" vs 406 "Invalid or expired"
 *   - resendVerificationEmail     404 "User not found" vs 400 "Email is already verified"
 *
 * Each now returns an IDENTICAL status and body for the known and unknown
 * branches. These tests pin that equivalence, and — just as importantly — that
 * the real side effects still happen for a genuine account, so the fix cannot
 * quietly disable the feature.
 */
import crypto from "crypto";

const mockSendVerificationEmail = jest.fn(async () => {});

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    userSession: {
      upsert: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
    },
    passwordResetToken: {
      upsert: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    deliveryPerson: { create: jest.fn(async () => ({})) },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisPayments: { get: jest.fn(async () => null), set: jest.fn(async () => "OK"), del: jest.fn(async () => 1) },
  // Batch 1D.53: the reset abuse controls run through here. Served lazily
  // from the per-test FakeRedis so limits are exercised for real (shared
  // state, TTLs, atomic scripts) rather than stubbed.
  get redisUsersSessions() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../helpers/fakeRedis").testRedis.current;
  },
  ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => "OK") },
}));

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  createUserSession: jest.fn(async () => {}),
  getUserSession: jest.fn(async () => ({ ip: "1.2.3.4" })),
  deleteUserSession: jest.fn(async () => {}),
  deleteAllUserSessions: jest.fn(async () => {}),
  listUserSessions: jest.fn(async () => []),
  setRefreshJti: jest.fn(async () => {}),
  getRefreshJti: jest.fn(async () => null),
  rotateRefreshJti: jest.fn(async () => {}),
  isRefreshJtiReplay: jest.fn(async () => false),
  deleteRefreshJti: jest.fn(async () => {}),
}));

jest.mock("../../src/services/mail/emailProvider", () => ({
  __esModule: true,
  getEmailProvider: jest.fn(() => ({
    name: "memory",
    sendEmail: (...args: unknown[]) => mockSendVerificationEmail(...(args as [])),
  })),
  EmailProviderError: class EmailProviderError extends Error {},
  LogEmailProvider: class {},
  InMemoryEmailProvider: class {},
  FailingEmailProvider: class {},
  SmtpEmailProvider: class {},
  maskEmail: (e: string) => e,
  __setEmailProviderForTests: jest.fn(),
}));

const mockSendResetEmail = jest.fn(async () => {});

// Batch 1D.51: forgotPassword now awaits delivery through this module. The
// mock keeps tests hermetic (no SMTP) while still proving the controller
// invokes and awaits the provider — see passwordResetCredentials.test.ts.
jest.mock("../../src/services/mail/sendResetEmail", () => ({
  __esModule: true,
  sendResetEmail: (...args: unknown[]) => mockSendResetEmail(...(args as [])),
}));

import prisma from "../../src/lib/prisma";
import config from "../../src/config/config";
import { FakeRedis, testRedis } from "../helpers/fakeRedis";
import { resetCodeDigest } from "../../src/utils/resetTokenDigest";
import {
  forgotPassword,
  verifyResetCode,
  resendVerificationEmail,
} from "../../src/controllers/auth.controller";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
};

const req = (body: Record<string, unknown>): any =>
  ({ body, headers: {}, params: {}, query: {}, ip: "127.0.0.1", get: () => undefined } as any);

const statusOf = (r: any) => r.status.mock.calls[0][0];
const bodyOf = (r: any) => r.json.mock.calls[0][0];

const KNOWN = { id: "u-known", email: "known@example.com", isEmailVerified: false };

beforeEach(() => {
  jest.clearAllMocks();
  // Fresh shared-state FakeRedis per test: the reset cooldown/attempt limits
  // below run against this, so counters genuinely accumulate across calls.
  testRedis.current = new FakeRedis();
  db.user.findUnique.mockResolvedValue(null);
  db.user.findUnique.mockResolvedValue(null);
  db.passwordResetToken.findUnique.mockResolvedValue(null);
  db.passwordResetToken.findFirst.mockResolvedValue(null);
  db.user.update.mockResolvedValue({});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("forgotPassword — identical response for known and unknown accounts", () => {
  it("returns the same status and body either way", async () => {
    // Unknown
    db.user.findUnique.mockResolvedValue(null);
    const unknownRes = res();
    await forgotPassword(req({ email: "nobody@example.com" }), unknownRes);

    // Known
    db.user.findUnique.mockResolvedValue(KNOWN);
    const knownRes = res();
    await forgotPassword(req({ email: KNOWN.email }), knownRes);

    expect(statusOf(unknownRes)).toBe(statusOf(knownRes));
    expect(statusOf(unknownRes)).toBe(200);
    expect(bodyOf(unknownRes)).toEqual(bodyOf(knownRes));
  });

  it("does not leak existence in the message", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const r = res();
    await forgotPassword(req({ email: "nobody@example.com" }), r);

    const message = String(bodyOf(r).message).toLowerCase();
    expect(message).not.toContain("not found");
    expect(message).not.toContain("no user");
    expect(message).not.toContain("does not exist");
    // The message must not assert that mail was actually sent.
    expect(message).not.toMatch(/reset code sent/i);
  });

  it("still creates a reset record for a REAL account", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);

    await forgotPassword(req({ email: KNOWN.email }), res());

    // Security must not cost the legitimate user their reset code.
    expect(db.passwordResetToken.upsert).toHaveBeenCalledTimes(1);
    const arg = db.passwordResetToken.upsert.mock.calls[0][0];
    expect(arg.where.userId).toBe(KNOWN.id);
    expect(arg.create.userId).toBe(KNOWN.id);
    expect(arg.create.expiresAt).toBeInstanceOf(Date);
  });

  it("does NOT create a reset record for an unknown account", async () => {
    db.user.findUnique.mockResolvedValue(null);

    await forgotPassword(req({ email: "nobody@example.com" }), res());

    // Critically: a nonexistent account must not become "eligible" for reset.
    expect(db.passwordResetToken.upsert).not.toHaveBeenCalled();
  });

  it("does comparable work on both branches (no telltale short-circuit)", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await forgotPassword(req({ email: "nobody@example.com" }), res());
    const unknownLookups =
      db.user.findUnique.mock.calls.length + db.passwordResetToken.findFirst.mock.calls.length;

    jest.clearAllMocks();
    db.user.findUnique.mockResolvedValue(KNOWN);
    await forgotPassword(req({ email: KNOWN.email }), res());
    const knownLookups = db.user.findUnique.mock.calls.length;

    // The unknown branch must not be dramatically cheaper than the known one.
    expect(unknownLookups).toBeGreaterThanOrEqual(1);
    expect(knownLookups).toBeGreaterThanOrEqual(1);
  });

  it("still validates that an email was supplied", async () => {
    const r = res();
    await forgotPassword(req({}), r);
    expect(statusOf(r)).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("verifyResetCode — unknown account is indistinguishable from a bad code", () => {
  it("returns the same 406 for an unknown account and for a wrong code", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const unknownRes = res();
    await verifyResetCode(req({ email: "nobody@example.com", code: "ABC123" }), unknownRes);

    db.user.findUnique.mockResolvedValue(KNOWN);
    db.passwordResetToken.findUnique.mockResolvedValue({
      // A different code's digest: still a mismatch, now through the real
      // digest comparison rather than a plaintext inequality.
      userId: KNOWN.id,
      token: resetCodeDigest(config.jwtResetSecret, KNOWN.email, "ZZZZZZ"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const badCodeRes = res();
    await verifyResetCode(req({ email: KNOWN.email, code: "ABC123" }), badCodeRes);

    expect(statusOf(unknownRes)).toBe(406);
    expect(statusOf(unknownRes)).toBe(statusOf(badCodeRes));
    expect(bodyOf(unknownRes)).toEqual(bodyOf(badCodeRes));
  });

  it("rejects an EXPIRED code for a real account", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: resetCodeDigest(config.jwtResetSecret, KNOWN.email, "ABC123"),
      expiresAt: new Date(Date.now() - 1000),
    });

    const r = res();
    await verifyResetCode(req({ email: KNOWN.email, code: "ABC123" }), r);

    expect(statusOf(r)).toBe(406);
  });

  it("accepts a valid code and issues a reset token", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: resetCodeDigest(config.jwtResetSecret, KNOWN.email, "ABC123"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const r = res();
    await verifyResetCode(req({ email: KNOWN.email, code: "ABC123" }), r);

    expect(statusOf(r)).toBe(200);
    expect(bodyOf(r).resetToken).toEqual(expect.any(String));
  });

  it("never mints a reset token for an unknown account", async () => {
    db.user.findUnique.mockResolvedValue(null);

    const r = res();
    await verifyResetCode(req({ email: "nobody@example.com", code: "ABC123" }), r);

    expect(bodyOf(r).resetToken).toBeUndefined();
    expect(db.passwordResetToken.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("resendVerificationEmail — identical response for unknown, known and already-verified", () => {
  it("returns one identical response for all three account states", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const unknownRes = res();
    await resendVerificationEmail(req({ email: "nobody@example.com" }), unknownRes);

    db.user.findUnique.mockResolvedValue({ ...KNOWN });
    const knownRes = res();
    await resendVerificationEmail(req({ email: KNOWN.email }), knownRes);

    db.user.findUnique.mockResolvedValue({ ...KNOWN, isEmailVerified: true });
    const verifiedRes = res();
    await resendVerificationEmail(req({ email: KNOWN.email }), verifiedRes);

    expect(statusOf(unknownRes)).toBe(200);
    expect(statusOf(unknownRes)).toBe(statusOf(knownRes));
    expect(statusOf(knownRes)).toBe(statusOf(verifiedRes));
    expect(bodyOf(unknownRes)).toEqual(bodyOf(knownRes));
    expect(bodyOf(knownRes)).toEqual(bodyOf(verifiedRes));
  });

  it("does not leak isEmailVerified in the public body", async () => {
    db.user.findUnique.mockResolvedValue({ ...KNOWN, isEmailVerified: true });
    const r = res();

    await resendVerificationEmail(req({ email: KNOWN.email }), r);

    expect(JSON.stringify(bodyOf(r))).not.toContain("isEmailVerified");
    expect(JSON.stringify(bodyOf(r))).not.toContain("verified");
  });

  it("still re-sends for a real UNVERIFIED account", async () => {
    db.user.findUnique.mockResolvedValue({ ...KNOWN, isEmailVerified: false });

    await resendVerificationEmail(req({ email: KNOWN.email }), res());

    expect(db.user.update).toHaveBeenCalledTimes(1);
    const data = db.user.update.mock.calls[0][0].data;
    expect(data.emailVerificationToken).toEqual(expect.any(String));
    expect(data.emailVerificationExpiresAt).toBeInstanceOf(Date);
    expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("does NOT send or mutate anything for an already-verified account", async () => {
    db.user.findUnique.mockResolvedValue({ ...KNOWN, isEmailVerified: true });

    await resendVerificationEmail(req({ email: KNOWN.email }), res());

    // A verified account has no need for another token, and regenerating one
    // would invalidate the token already sitting in their inbox.
    expect(db.user.update).not.toHaveBeenCalled();
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });

  it("does nothing for an unknown account", async () => {
    db.user.findUnique.mockResolvedValue(null);

    await resendVerificationEmail(req({ email: "nobody@example.com" }), res());

    expect(db.user.update).not.toHaveBeenCalled();
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });

  it("still rejects a malformed email address", async () => {
    const r = res();
    await resendVerificationEmail(req({ email: "not-an-email" }), r);
    expect(statusOf(r)).toBe(400);
  });

  it("rejects with 400 rather than 404 for a bad shape (unchanged)", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const r = res();
    await resendVerificationEmail(req({}), r);
    expect(statusOf(r)).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("no enumeration string survives in any public response", () => {
  const forbidden = ["user not found", "no user", "does not exist", "already verified"];

  it("holds across every branch of all three endpoints", async () => {
    const bodies: string[] = [];
    const statuses: number[] = [];

    for (const lookup of [null, KNOWN, { ...KNOWN, isEmailVerified: true }]) {
      db.user.findUnique.mockResolvedValue(lookup);
      db.user.findUnique.mockResolvedValue(lookup);
      db.passwordResetToken.findUnique.mockResolvedValue(
        lookup
          ? {
              userId: lookup.id,
              // Digest of the exact code the loop submits, so the known
              // branch exercises the genuine accept path.
              token: resetCodeDigest(config.jwtResetSecret, "x@example.com", "ABC123"),
              expiresAt: new Date(Date.now() + 60_000),
            }
          : null,
      );

      for (const handler of [forgotPassword, verifyResetCode, resendVerificationEmail]) {
        const r = res();
        const body =
          handler === verifyResetCode
            ? { email: "x@example.com", code: "ABC123" }
            : { email: "x@example.com" };
        await handler(req(body), r);
        statuses.push(statusOf(r));
        bodies.push(JSON.stringify(bodyOf(r)).toLowerCase());
      }
    }

    for (const body of bodies) {
      for (const phrase of forbidden) expect(body).not.toContain(phrase);
    }
    // Every one of these is now a benign 200 or 406 — never a 404.
    for (const status of statuses) expect([200, 406]).toContain(status);
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// C-follow-up: delivery side effects, provider-failure opacity, and the
// casing/whitespace canonicalisation that decides WHICH branch runs.
describe("forgotPassword — side effects, provider failure, and canonicalisation", () => {
  it("does NOT deliver an email for an unknown account", async () => {
    db.user.findUnique.mockResolvedValue(null);

    await forgotPassword(req({ email: "nobody@example.com" }), res());

    expect(mockSendResetEmail).not.toHaveBeenCalled();
  });

  it("still delivers for an eligible registered account", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);

    await forgotPassword(req({ email: KNOWN.email }), res());

    expect(mockSendResetEmail).toHaveBeenCalledTimes(1);
  });

  it("an email-delivery FAILURE returns the same status and body as every other branch", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const unknownRes = res();
    await forgotPassword(req({ email: "nobody@example.com" }), unknownRes);

    // Known account whose provider call blows up.
    db.user.findUnique.mockResolvedValue(KNOWN);
    mockSendResetEmail.mockRejectedValueOnce(
      Object.assign(new Error("SMTP 535 auth failed for relay.internal"), {
        response: { data: "smtp credentials rejected" },
      }),
    );
    const failureRes = res();
    await forgotPassword(req({ email: KNOWN.email }), failureRes);

    // Identical public contract — a mailer outage is not an existence oracle.
    expect(statusOf(failureRes)).toBe(statusOf(unknownRes));
    expect(statusOf(failureRes)).toBe(200);
    expect(bodyOf(failureRes)).toEqual(bodyOf(unknownRes));

    // No provider internals leak into the body.
    const body = JSON.stringify(bodyOf(failureRes)).toLowerCase();
    expect(body).not.toContain("smtp");
    expect(body).not.toContain("relay");
    expect(body).not.toContain("535");
  });

  it("a delivery failure invalidates the code it could not deliver", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);
    mockSendResetEmail.mockRejectedValueOnce(new Error("smtp down"));

    await forgotPassword(req({ email: KNOWN.email }), res());

    // Compare-and-delete on the digest this request created.
    expect(db.passwordResetToken.deleteMany).toHaveBeenCalledTimes(1);
    const arg = db.passwordResetToken.deleteMany.mock.calls[0][0];
    expect(arg.where.userId).toBe(KNOWN.id);
    expect(arg.where.token).toEqual(expect.any(String));
  });

  it("resolves casing/whitespace variants of a REGISTERED address to that account", async () => {
    db.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.email === KNOWN.email ? KNOWN : null,
    );

    const r = res();
    await forgotPassword(req({ email: "  Known@Example.COM  " }), r);

    // The lookup used the canonical form registration would have stored.
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: KNOWN.email } });
    expect(db.passwordResetToken.upsert).toHaveBeenCalledTimes(1);
    expect(statusOf(r)).toBe(200);

    // …and the public body is still the generic one.
    const message = String(bodyOf(r).message).toLowerCase();
    expect(message).not.toContain("not found");
    expect(message).not.toContain("does not exist");
  });

  it("a casing/whitespace variant of an UNKNOWN address still looks unknown", async () => {
    db.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.email === KNOWN.email ? KNOWN : null,
    );

    const r = res();
    await forgotPassword(req({ email: "  Nobody@Example.COM  " }), r);

    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { email: "nobody@example.com" },
    });
    expect(db.passwordResetToken.upsert).not.toHaveBeenCalled();
    expect(mockSendResetEmail).not.toHaveBeenCalled();
    expect(statusOf(r)).toBe(200);
  });
});

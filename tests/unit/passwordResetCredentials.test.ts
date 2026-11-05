/**
 * Batch 1D.51 — reset credentials at rest + email delivery.
 *
 * Two high-severity defects are pinned here:
 *   1. The six-character reset code used to be written to
 *      `passwordResetToken.token` in plaintext (any DB read = reset anyone).
 *   2. The `sendResetEmail` call was commented out, so no code was ever
 *      delivered and the flow was dead.
 *
 * The fix stores HMAC digests (code bound to the canonical email, JWT bound
 * to itself) and reconnects delivery with fail-safe cleanup. These tests
 * assert that contract end to end at the controller boundary with mocked
 * persistence and a mocked mailer — they prove the code paths, not real
 * SMTP delivery or real-database behavior (see the final batch report).
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const mockSendResetEmail: jest.Mock = jest.fn(async () => {});

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
    // Batch 1D.55: secureResetPassword finalizes inside a transaction; the
    // callback receives the mocked client itself.
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

// The mailer module is mocked so no test can reach nodemailer, SMTP, or any
// remote infrastructure — while still proving the controller invokes and
// awaits the provider through this exact interface.
jest.mock("../../src/services/mail/sendResetEmail", () => ({
  __esModule: true,
  sendResetEmail: (...args: unknown[]) => mockSendResetEmail(...(args as [])),
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  // Batch 1D.53: reset cooldown/attempt limits run through here, served
  // lazily from the per-test FakeRedis.
  get redisUsersSessions() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../helpers/fakeRedis").testRedis.current;
  },
}));

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  deleteAllUserSessions: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import config from "../../src/config/config";
import { FakeRedis, testRedis } from "../helpers/fakeRedis";
import {
  forgotPassword,
  verifyResetCode,
  secureResetPassword,
} from "../../src/controllers/auth.controller";
import {
  resetCodeDigest,
  resetCodeMatches,
  resetJwtDigest,
  resetJwtMatches,
} from "../../src/utils/resetTokenDigest";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const SECRET = config.jwtResetSecret;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};
const statusOf = (r: any): number => r.status.mock.calls[0][0];
const bodyOf = (r: any): any => r.json.mock.calls[0][0];

const KNOWN = { id: "u-known", email: "known@example.com", authProviders: [] as string[] };

beforeEach(() => {
  jest.clearAllMocks();
  testRedis.current = new FakeRedis();
  mockSendResetEmail.mockResolvedValue(undefined);
  db.user.findUnique.mockResolvedValue(null);
  db.passwordResetToken.findUnique.mockResolvedValue(null);
  db.passwordResetToken.findFirst.mockResolvedValue(null);
  db.user.update.mockImplementation(async (args: any) => ({ ...KNOWN, ...args.data }));
});

describe("resetCodeDigest / resetJwtDigest", () => {
  it("is deterministic and binds the code to the canonical email", () => {
    const a = resetCodeDigest(SECRET, "Known@Example.com ", "ABC123");
    expect(a).toBe(resetCodeDigest(SECRET, "known@example.com", "ABC123"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("ABC123");
  });

  it("separates the code and JWT domains and separates accounts", () => {
    const code = resetCodeDigest(SECRET, KNOWN.email, "ABC123");
    expect(code).not.toBe(resetJwtDigest(SECRET, "ABC123"));
    expect(code).not.toBe(resetCodeDigest(SECRET, "other@example.com", "ABC123"));
    expect(code).not.toBe(resetCodeDigest("another-secret", KNOWN.email, "ABC123"));
  });

  it("matches the right value and rejects everything else, without throwing", () => {
    expect(resetCodeMatches(resetCodeDigest(SECRET, KNOWN.email, "ABC123"), SECRET, KNOWN.email, "ABC123")).toBe(true);
    expect(resetCodeMatches(resetCodeDigest(SECRET, KNOWN.email, "ABC123"), SECRET, KNOWN.email, "WRONG1")).toBe(false);
    // Legacy plaintext rows (and any malformed stored value) fail closed.
    expect(resetCodeMatches("ABC123", SECRET, KNOWN.email, "ABC123")).toBe(false);
    expect(resetCodeMatches(null, SECRET, KNOWN.email, "ABC123")).toBe(false);
    expect(resetCodeMatches(undefined, SECRET, KNOWN.email, "ABC123")).toBe(false);
    expect(resetJwtMatches(resetJwtDigest(SECRET, "jwt-value"), SECRET, "jwt-value")).toBe(true);
    expect(resetJwtMatches("jwt-value", SECRET, "jwt-value")).toBe(false);
  });
});

describe("forgotPassword stores digests and delivers", () => {
  it("1. the database never receives the plaintext reset code", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);

    await forgotPassword({ body: { email: KNOWN.email } } as never, res());

    // The same generated code the mailer was asked to deliver...
    expect(mockSendResetEmail).toHaveBeenCalledTimes(1);
    const emailedCode = mockSendResetEmail.mock.calls[0][2] as string;
    expect(typeof emailedCode).toBe("string");
    expect(emailedCode).toHaveLength(6);

    // ...is nowhere in what was persisted.
    const arg = db.passwordResetToken.upsert.mock.calls[0][0];
    expect(arg.create.token).not.toContain(emailedCode);
    expect(arg.update.token).not.toContain(emailedCode);
    expect(arg.create.token).toBe(resetCodeDigest(SECRET, KNOWN.email, emailedCode));
    expect(arg.update.token).toBe(arg.create.token);
  });

  it("6. delivery is invoked through the mailer interface and awaited", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);
    let resolved = false;
    mockSendResetEmail.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 20));
      resolved = true;
    });

    const r = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, r);

    expect(mockSendResetEmail).toHaveBeenCalledTimes(1);
    const [reqArg, to, code] = mockSendResetEmail.mock.calls[0];
    expect(reqArg).toBeDefined();
    expect(to).toBe(KNOWN.email);
    expect(code).toHaveLength(6);
    // The response was produced only after the provider settled.
    expect(resolved).toBe(true);
    expect(statusOf(r)).toBe(200);
  });

  it("7. delivery failure invalidates the credential but keeps the public response uniform", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);
    mockSendResetEmail.mockRejectedValueOnce(new Error("SMTP down"));

    const r = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, r);

    // No live code lingers that the user never received — and the delete is
    // scoped to the digest this request created (compare-and-delete), so it
    // cannot destroy a newer concurrent credential.
    const emailedCode = mockSendResetEmail.mock.calls[0][2] as string;
    expect(db.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: KNOWN.id, token: resetCodeDigest(SECRET, KNOWN.email, emailedCode) },
    });
    // And the outage is invisible to callers: identical to every branch.
    expect(statusOf(r)).toBe(200);
    expect(bodyOf(r)).toEqual({
      message: "If an account exists for that address, a reset code has been sent.",
    });
  });

  it("8. known and unknown requests return identical status and body", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const unknown = res();
    await forgotPassword({ body: { email: "nobody@example.com" } } as never, unknown);

    db.user.findUnique.mockResolvedValue(KNOWN);
    const known = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, known);

    expect(statusOf(known)).toBe(200);
    expect(statusOf(unknown)).toBe(statusOf(known));
    expect(bodyOf(unknown)).toEqual(bodyOf(known));
    expect(JSON.stringify(bodyOf(known))).not.toContain("nobody");
  });

  it("9. does not emit the debug console.log containing the email", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    db.user.findUnique.mockResolvedValue(KNOWN);

    const r = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, r);

    expect(statusOf(r)).toBe(200);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("verifyResetCode against digests", () => {
  it("2. a correct code verifies using the stored digest", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: resetCodeDigest(SECRET, KNOWN.email, "ABC123"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: "ABC123" } } as never, r);

    expect(statusOf(r)).toBe(200);
    expect(typeof bodyOf(r).resetToken).toBe("string");
  });

  it("3. an incorrect code is rejected", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: resetCodeDigest(SECRET, KNOWN.email, "RIGHT1"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: "WRONG1" } } as never, r);

    expect(statusOf(r)).toBe(406);
    expect(db.passwordResetToken.update).not.toHaveBeenCalled();
  });

  it("3b. an expired code is rejected even when the digest matches", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: resetCodeDigest(SECRET, KNOWN.email, "ABC123"),
      expiresAt: new Date(Date.now() - 1000),
    });

    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: "ABC123" } } as never, r);

    expect(statusOf(r)).toBe(406);
    expect(db.passwordResetToken.update).not.toHaveBeenCalled();
  });

  it("3c. a legacy plaintext row can never verify, even with the matching code", async () => {
    // Rows written before digests existed fail closed instead of throwing.
    db.user.findUnique.mockResolvedValue(KNOWN);
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: "ABC123",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: "ABC123" } } as never, r);

    expect(statusOf(r)).toBe(406);
  });

  it("4. the raw reset JWT is not stored in the database", async () => {
    db.user.findUnique.mockResolvedValue(KNOWN);
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: resetCodeDigest(SECRET, KNOWN.email, "ABC123"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: "ABC123" } } as never, r);

    expect(statusOf(r)).toBe(200);
    const issued = bodyOf(r).resetToken as string;
    const updateArg = db.passwordResetToken.update.mock.calls[0][0];
    expect(updateArg.data.token).not.toContain(issued);
    expect(updateArg.data.token).toBe(resetJwtDigest(SECRET, issued));
  });
});

describe("secureResetPassword against digests", () => {
  const STRONG = "NewPass456@";

  async function passwordUser() {
    const user = {
      ...KNOWN,
      password: await bcrypt.hash("OldPass123!", 4),
      tokenVersion: 0,
      isBlocked: false,
    };
    db.user.findUnique.mockResolvedValue(user);
    return user;
  }

  function validJwt(userId = KNOWN.id): string {
    return jwt.sign({ id: userId }, config.jwtResetSecret, { expiresIn: "10m" });
  }

  it("5. a valid JWT is accepted when its digest matches the stored representation", async () => {
    await passwordUser();
    const token = validJwt();
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: resetJwtDigest(SECRET, token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Batch 1D.55: Prisma's deleteMany always resolves { count }; the
    // conditional consume inside the transaction depends on that count.
    db.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG } } as never, r);

    expect(statusOf(r)).toBe(200);
    const stored = db.user.update.mock.calls.find((c: any) => c[0]?.data?.password);
    await expect(bcrypt.compare(STRONG, stored[0].data.password)).resolves.toBe(true);
    // Batch 1D.55: the consume is conditional on the exact presented
    // credential — user, digest, and still-unexpired.
    expect(db.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: KNOWN.id,
        token: resetJwtDigest(SECRET, token),
        expiresAt: expect.anything(),
      },
    });
  });

  it("5b. a JWT whose digest does not match is rejected without touching the account", async () => {
    await passwordUser();
    const token = validJwt();
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: resetJwtDigest(SECRET, "some-other-jwt"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const r = res();
    await secureResetPassword({ body: { resetToken: token, newPassword: STRONG } } as never, r);

    expect(statusOf(r)).toBe(406);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.passwordResetToken.deleteMany).not.toHaveBeenCalled();
  });
});

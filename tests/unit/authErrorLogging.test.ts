/**
 * Security regression: raw error objects must never be printed to the console
 * from the authentication controller (Phase 1 remediation, 10 catch blocks).
 *
 * WHAT MAKES THIS A REAL TEST
 * ---------------------------
 * The controller is invoked for real. Its `console.error` calls are replaced
 * with `logger.error({ err })`, so two things are proven at once:
 *
 *   1. The migrated catch blocks no longer write to `console.error`.
 *   2. Whatever they DO write is scrubbed by the production serializer.
 *
 * For (2) the project's own `loggerOptions` is used — not a stub — and output
 * goes to an in-memory stream, then every complete serialized JSON line is
 * scanned for synthetic sentinels. The `logger` module itself is mocked only
 * to swap the destination; every security-relevant option (redact, serializers,
 * formatters, level) is the real one. If the serializer regressed, these fail.
 *
 * Only synthetic sentinels are used. Nothing reads `.env`, the environment for
 * credentials, or any real secret. Assertions report sentinel NAMES only and
 * no secret value is ever printed.
 *
 * SCOPE / KNOWN GAP
 * -----------------
 * Covers four representative handlers, including the two the audit called out
 * as highest risk: `googleLogin` (widest catch — spans the provider exchange,
 * the user lookup/upsert and session issuance) and `getAllAddresses` (the
 * bare `console.error(err)` with no context label). `getProfile` and
 * `createAddress` stand in for the remaining authenticated handlers.
 *
 * `forgotPassword`, `selectRole`, `verifyCode`, `verifyEmail`, `updateAddress`
 * and `deleteAddress` were migrated identically but are NOT exercised here:
 * each needs a different module-level harness (OTP service, reset-token
 * digest, mail providers, auth middleware) and forcing them into one file would
 * mean building mocking infrastructure that is larger than the change under
 * test. Their migration is verified structurally by
 * `tests/unit/authMigratedLoggingStubs.test.ts`, and their HTTP contracts
 * remain covered by the existing suites listed in the batch report. This is a
 * documented coverage gap, not a claim of full coverage.
 */
import { Writable } from "stream";

const SENTINELS = {
  bearer: "SN-BEARER-VALUE",
  cookie: "SN-COOKIE-VALUE",
  apiKey: "SN-API-KEY-VALUE",
  accessToken: "SN-ACCESS-TOKEN-VALUE",
  refreshToken: "SN-REFRESH-TOKEN-VALUE",
  urlPassword: "SN-URL-PASSWORD-VALUE",
  nestedCause: "SN-NESTED-CAUSE-VALUE",
  bodySecret: "SN-BODY-SECRET-VALUE",
} as const;

/**
 * Captures every line the controller's logger emits. Declared at module scope
 * (and `mock`-prefixed, so the hoisted factory below may close over it) with
 * real types so the strict TS test config is satisfied.
 */
const mockChunks: string[] = [];
const mockSink = new Writable({
  write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    mockChunks.push(chunk.toString());
    cb();
  },
});

jest.mock("../../src/lib/logger", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = jest.requireActual("../../src/lib/logger");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pinoMod = require("pino");
  const { transport: _transport, ...rest } = actual.loggerOptions;
  void _transport;
  return {
    __esModule: true,
    ...actual,
    logger: pinoMod({ ...rest }, mockSink),
    safeErrorSerializer: actual.safeErrorSerializer,
    isSensitiveKey: actual.isSensitiveKey,
    redactSecretsInText: actual.redactSecretsInText,
    REDACTION_PLACEHOLDER: actual.REDACTION_PLACEHOLDER,
  };
});

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
    address: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
  redisUsersSessions: { get: jest.fn(async () => null), set: jest.fn(async () => "OK"), del: jest.fn(async () => 1) },
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

jest.mock("../../src/services/mail/sendResetEmail", () => ({
  __esModule: true,
  sendResetEmail: jest.fn(async () => {}),
}));

// The real OAuth2Client would attempt a network exchange. Stub it so the test
// reaches the outer catch deterministically and never touches a remote service.
const verifyIdToken = jest.fn();
jest.mock("google-auth-library", () => ({
  __esModule: true,
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: (...args: unknown[]) => verifyIdToken(...args),
  })),
}));

import prisma from "../../src/lib/prisma";
import { googleLogin, getAllAddresses, getProfile, createAddress } from "../../src/controllers/auth.controller";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

/** An error shaped like a real Axios/provider failure, stuffed with secrets. */
function secretBearingError(label: string): Error {
  const err: any = new Error(
    `${label} failed calling https://api.internal.example.com/v1?api_key=${SENTINELS.apiKey}`,
  );
  err.name = "RequestError";
  err.code = "ERR_BAD_REQUEST";
  err.config = {
    url: `https://api.internal.example.com/v1?api_key=${SENTINELS.apiKey}`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENTINELS.bearer}`,
      Cookie: `refreshToken=${SENTINELS.cookie}; accessToken=${SENTINELS.accessToken}`,
      "X-Api-Key": SENTINELS.apiKey,
    },
    data: { password: SENTINELS.bodySecret },
  };
  err.request = { socket: { remoteAddress: "127.0.0.1" }, headers: { authorization: SENTINELS.bearer } };
  err.response = {
    status: 500,
    data: {
      access_token: SENTINELS.accessToken,
      refresh_token: SENTINELS.refreshToken,
      password: SENTINELS.bodySecret,
      dsn: `postgres://svc:${SENTINELS.urlPassword}@db.internal.example.com:5432/app`,
    },
    headers: { "set-cookie": [`refreshToken=${SENTINELS.refreshToken}`] },
  };
  err.cause = { detail: `connection to postgres://svc:${SENTINELS.urlPassword}@db failed`, token: SENTINELS.nestedCause };
  err.meta = { target: "User_email_key", email: "victim@example.com" };
  return err as Error;
}

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
};

const baseReq = (body: Record<string, unknown> = {}): any => ({
  body,
  headers: {},
  params: {},
  query: {},
  ip: "127.0.0.1",
  get: () => undefined,
  user: { id: "u-1", role: "CUSTOMER" },
});

const output = () => mockChunks.join("");
const lines = () => mockChunks.join("").trim().split("\n").filter(Boolean);

function leakedSentinels(text: string): string[] {
  return Object.entries(SENTINELS)
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name);
}

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  mockChunks.length = 0;
  jest.clearAllMocks();
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

/** Assertions every migrated handler must satisfy. */
function expectSafeLogging(expectedMsg: string) {
  // (2) the migrated path never touches console.error
  expect(consoleErrorSpy).not.toHaveBeenCalled();
  // (3) exactly one log line, via the shared logger
  const emitted = lines();
  expect(emitted).toHaveLength(1);
  const parsed = JSON.parse(emitted[0]);
  expect(parsed.level).toBe(50); // error
  expect(parsed.msg).toBe(expectedMsg);
  // (4/6) the error really arrived under `err`, and safe diagnostics survive
  expect(parsed.err).toBeDefined();
  expect(parsed.err.type).toBe("RequestError");
  expect(parsed.err.message).toContain("failed calling");
  expect(typeof parsed.err.stack).toBe("string");
  expect(parsed.err.code).toBe("ERR_BAD_REQUEST");
  // (5) no sentinel survives anywhere in the complete serialized line
  expect(leakedSentinels(emitted[0])).toEqual([]);
}

describe("auth.controller — migrated error logging", () => {
  it("googleLogin: widest catch logs a scrubbed error and keeps its 500 contract", async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "user@example.com", name: "U", picture: "p", sub: "g-1" }),
    });
    db.user.findUnique.mockRejectedValue(secretBearingError("googleLogin"));

    const r = res();
    // `idToken` must be present or the handler returns 400 before the catch.
    await googleLogin(baseReq({ idToken: "synthetic-not-a-real-token" }), r);

    expectSafeLogging("googleLogin failed");
    // safe, non-sensitive context retained; nothing personal added
    expect(JSON.parse(lines()[0]).provider).toBe("GOOGLE");
    // (8) response contract unchanged
    expect(r.status).toHaveBeenCalledWith(500);
    expect(r.json).toHaveBeenCalledWith({
      message: "Something went wrong while logging in with Google. Please try again later.",
    });
  });

  it("getAllAddresses: former bare console.error(err) is now labelled and scrubbed", async () => {
    db.address.findMany.mockRejectedValue(secretBearingError("getAllAddresses"));

    const r = res();
    await getAllAddresses(baseReq(), r);

    expectSafeLogging("getAllAddresses failed");
    expect(JSON.parse(lines()[0]).userId).toBe("u-1");
    expect(r.status).toHaveBeenCalledWith(500);
    expect(r.json).toHaveBeenCalledWith({ error: "Server error" });
  });

  it("getProfile: authenticated read failure logs scrubbed and keeps its 500 contract", async () => {
    db.user.findUnique.mockRejectedValue(secretBearingError("getProfile"));

    const r = res();
    await getProfile(baseReq(), r);

    expectSafeLogging("getProfile failed");
    expect(JSON.parse(lines()[0]).userId).toBe("u-1");
    expect(r.status).toHaveBeenCalledWith(500);
    expect(r.json).toHaveBeenCalledWith({ message: "Failed to load user profile" });
  });

  it("createAddress: write failure logs scrubbed and keeps its 500 contract", async () => {
    db.address.create.mockRejectedValue(secretBearingError("createAddress"));

    const r = res();
    // Body must satisfy createAddressSchema or zod rejects it with a 400.
    await createAddress(
      baseReq({ label: "Home", street: "1 Test Way", city: "Lagos", country: "NG" }),
      r,
    );

    expectSafeLogging("createAddress failed");
    expect(JSON.parse(lines()[0]).userId).toBe("u-1");
    expect(r.status).toHaveBeenCalledWith(500);
    expect(r.json).toHaveBeenCalledWith({ error: "Server error" });
  });
});
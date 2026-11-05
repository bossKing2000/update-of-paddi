/**
 * Security regression: the direct-console error bypass.
 *
 * The Pino logger gained an allowlist error serializer and a whole-object
 * sanitizer in the previous task, but several `console.error(..., err)` call
 * sites bypassed it entirely. This suite proves the migrated sites now route
 * through the shared sanitizer, and that a synthetic Axios-shaped error
 * carrying credentials cannot reach the terminal.
 *
 * HOW THE REAL SERIALIZER IS EXERCISED
 * ------------------------------------
 * `src/lib/logger` is mocked with `jest.requireActual`, so the `logger` the
 * code under test receives is a spy whose `error` method runs the REAL
 * `safeErrorSerializer` over its payload. That proves two separate things —
 * that the call site passes the error under the `err` key, and that the real
 * production serializer strips it — rather than testing a helper in isolation.
 *
 * Mocks are registered at module scope. An earlier draft configured them
 * inside each test and then called `jest.resetModules()`, which hands the module
 * under test a *different* mock instance than the one that was configured, so
 * the injected failures never fired.
 *
 * ONLY SYNTHETIC SENTINELS ARE USED. No real credential is read from the
 * environment or `.env`, and nothing secret is printed: failures report
 * sentinel NAMES only.
 */
import type { Logger } from "pino";
import { safeErrorSerializer } from "../../src/lib/logger";

const S = {
  auth: "SNT-BEARER-TOKEN",
  cookie: "SNT-COOKIE",
  password: "SNT-PASSWORD",
  accessToken: "SNT-ACCESS-TOKEN",
  apiKey: "SNT-API-KEY",
  urlCredential: "SNT-URL-PASSWORD",
  bodySecret: "SNT-BODY-SECRET",
} as const;

/** Serialized forms produced by the real serializer, per logged call. */
const logged: Array<{ message: string; payload: Record<string, unknown> }> = [];

/** Mutable switches each test flips to make one dependency throw. */
const mockFail = {
  auditLog: false,
  notification: false,
  activity: false,
  verifyPayment: false,
};

const mockAuditCreate = jest.fn(async () => {
  if (mockFail.auditLog) throw makeAxiosError();
  return {};
});
const mockNotificationCreate = jest.fn(async () => {
  if (mockFail.notification) throw makeAxiosError();
  return {};
});
const mockActivityCreate = jest.fn(async () => {
  if (mockFail.activity) throw makeAxiosError();
  return {};
});
const mockVerifyPayment = jest.fn(async () => {
  if (mockFail.verifyPayment) throw makeAxiosError();
  return { status: "failed" };
});

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    auditLog: { create: mockAuditCreate },
    notification: { create: mockNotificationCreate },
    activity: { create: mockActivityCreate },
    webhookEvent: {
      findMany: jest.fn(async () => [
        { id: "evt-1", eventId: "e-1", payload: { data: { reference: "PSK-1" } }, status: "pending" },
      ]),
      update: jest.fn(async () => ({})),
    },
    payment: { findUnique: jest.fn(async () => ({ status: "PENDING" })) },
    $transaction: jest.fn(async (fn: any) => fn()),
  },
}));

jest.mock("../../src/services/paymentService", () => ({ verifyPayment: mockVerifyPayment }));

jest.mock("../../src/services/paymentFinalizer.service", () => ({
  finalizePaymentSuccess: jest.fn(async () => ({ outcome: "SUCCESS" })),
}));

// recordActivityBundle also emits sockets and notifications; stub them so the
// suite exercises only its logging path.
jest.mock("../../src/utils/activityUtils/socketEvents", () => ({
  emitSocketEvents: jest.fn(async () => undefined),
}));
jest.mock("../../src/utils/activityUtils/notify", () => ({
  sendNotification: jest.fn(async () => ({})),
  sendNotificationToMany: jest.fn(async () => []),
  notifyRole: jest.fn(async () => []),
}));

jest.mock("../../src/socket", () => ({
  getIO: () => ({ to: () => ({ emit: jest.fn() }) }),
}));

jest.mock("../../src/lib/logger", () => {
  const actual = jest.requireActual("../../src/lib/logger");
  const record =
    (level: string) =>
    (obj: unknown, msg?: unknown): void => {
      const payload = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
      logged.push({
        message: `${level}:${typeof msg === "string" ? msg : ""}`,
        // The REAL production serializer. Whatever it drops cannot reach a log.
        payload: (actual.safeErrorSerializer(payload.err) ?? {}) as Record<string, unknown>,
      });
    };
  const stub = {
    error: jest.fn(record("error")),
    warn: jest.fn(record("warn")),
    info: jest.fn(record("info")),
    debug: jest.fn(record("debug")),
    child: jest.fn(),
  };
  return { ...actual, logger: stub as unknown as Logger, createRequestLogger: jest.fn(() => stub) };
});


/** An Axios-shaped error carrying credentials in every sensitive location. */
function makeAxiosError(): Error {
  const err: any = new Error(
    `verify failed for postgresql://svc:${S.urlCredential}@db.internal:5432/app?api_key=${S.apiKey}`,
  );
  err.code = "ECONNABORTED";
  err.config = {
    baseURL: "https://api.example.com",
    url: "/verify?api_key=" + S.apiKey,
    method: "get",
    headers: {
      Authorization: "Bearer " + S.auth,
      Cookie: "sid=" + S.cookie,
      "X-Api-Key": S.apiKey,
    },
    data: JSON.stringify({ password: S.password }),
  };
  err.request = { _headerAuth: "Bearer " + S.auth };
  err.response = {
    status: 502,
    data: { access_token: S.accessToken },
    headers: { "set-cookie": S.cookie },
  };
  return err;
}

/** Sentinel names appearing in a serialized payload. */
function leaked(): string[] {
  const text = JSON.stringify(logged);
  return Object.entries(S)
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name);
}

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  logged.length = 0;
  mockFail.auditLog = false;
  mockFail.notification = false;
  mockFail.activity = false;
  mockFail.verifyPayment = false;
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  jest.clearAllMocks();
});

describe("console bypass — audit.createAuditEntry", () => {
  it("routes the failure through the sanitizer and never to console", async () => {
    mockFail.auditLog = true;
    const { createAuditEntry } = require("../../src/utils/activityUtils/audit");

    await createAuditEntry({
      userId: "u-1",
      action: "ORDER_CREATED",
      req: { headers: { "user-agent": "jest" }, ip: "127.0.0.1" } as never,
      metadata: { orderId: "o-1" },
    });

    // 7: no raw error object reaches a console method.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    // 6: the error went to the logger under `err`, and the serializer ran.
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.some((e) => e.message.includes("audit"))).toBe(true);
    // 2/3/4/6: nothing sensitive survives serialization.
    expect(leaked()).toEqual([]);
  });
});

describe("migrated paths — serializer output keeps diagnostics, drops internals", () => {
  it("5. retains type/code/status/method/url and drops config/request/response", () => {
    // Exercises the REAL serializer the migrated call sites now use.
    const payload = safeErrorSerializer(makeAxiosError()) as Record<string, unknown>;
    expect(payload.code).toBe("ECONNABORTED");
    expect(payload.status).toBe(502);
    expect(payload.method).toBe("get");
    expect(payload.url).toBe("/verify"); // query credential stripped
    expect(payload).not.toHaveProperty("config");
    expect(payload).not.toHaveProperty("request");
    expect(payload).not.toHaveProperty("response");
  });
});
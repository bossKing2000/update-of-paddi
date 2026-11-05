/**
 * Security regression: sensitive values must never reach serialized logs.
 *
 * WHAT MAKES THIS A REAL TEST
 * ---------------------------
 * The logger is NOT mocked and no helper is called in isolation. Each case
 * builds a pino instance from the project's own exported `loggerOptions` and
 * writes to an in-memory destination, then asserts on the complete serialized
 * JSON line. That exercises the production serializer, the production
 * redaction list and the production text scrub together — if any one of them
 * regressed, these tests fail.
 *
 * Only synthetic sentinels are used. No real secret, token, password or URL is
 * read from the environment or from `.env`, and nothing secret is printed: the
 * assertions report sentinel NAMES and counts only.
 *
 * The original exposure (verified against pino 10.3.1): pino does not apply
 * `stdSerializers.err` unless configured, so an Axios error's own enumerable
 * properties — `config`, `request`, `response` — were serialized verbatim.
 */
import pino from "pino";
import { Writable } from "stream";
import { loggerOptions, safeErrorSerializer, isSensitiveKey, redactSecretsInText, REDACTION_PLACEHOLDER } from "../../src/lib/logger";

const SENTINELS = {
  auth: "SN-AUTH-BEARER-VALUE",
  proxyAuth: "SN-PROXY-AUTH-VALUE",
  cookie: "SN-COOKIE-VALUE",
  password: "SN-PASSWORD-VALUE",
  accessToken: "SN-ACCESS-TOKEN-VALUE",
  refreshToken: "SN-REFRESH-TOKEN-VALUE",
  apiKey: "SN-API-KEY-VALUE",
  urlCredential: "SN-URL-PASSWORD-VALUE",
  bodySecret: "SN-BODY-SECRET-VALUE",
  nestedCauseSecret: "SN-NESTED-CAUSE-VALUE",
  jwt: "SN.JWT.VALUE",
} as const;

/** A logger with the real project options, writing to memory. */
function captureLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  // Same options, plus a destination. `transport` is dropped because a
  // transport owns its own destination; every security-relevant option
  // (redact, serializers, level) is kept identical.
  const { transport: _transport, ...rest } = loggerOptions;
  void _transport;
  const log = pino({ ...rest }, stream);
  return {
    log,
    output: () => chunks.join(""),
    lines: () => chunks.join("").trim().split("\n").filter(Boolean),
  };
}

/** Sentinel names that appear anywhere in the serialized output. */
function leakedSentinels(output: string): string[] {
  return Object.entries(SENTINELS)
    .filter(([, value]) => output.includes(value))
    .map(([name]) => name);
}

/** An Axios-shaped error carrying secrets in every sensitive location. */
function axiosLikeError(): Error {
  const err: any = new Error("gateway request failed for https://api.example.com/v1?token=" + SENTINELS.accessToken);
  err.code = "ECONNABORTED";
  err.config = {
    baseURL: "https://api.example.com",
    url: "/v1/pay?api_key=" + SENTINELS.apiKey,
    method: "post",
    headers: {
      Authorization: "Bearer " + SENTINELS.auth,
      "Proxy-Authorization": "Basic " + SENTINELS.proxyAuth,
      Cookie: "sid=" + SENTINELS.cookie,
      "X-Api-Key": SENTINELS.apiKey,
    },
    data: JSON.stringify({ password: SENTINELS.password, note: SENTINELS.bodySecret }),
    auth: { username: "u", password: SENTINELS.urlCredential },
  };
  err.request = { path: "/v1/pay", _headerAuth: "Bearer " + SENTINELS.auth };
  err.response = {
    status: 502,
    data: { access_token: SENTINELS.accessToken, refresh_token: SENTINELS.refreshToken },
    headers: { "set-cookie": SENTINELS.cookie },
  };
  const cause: any = new Error("inner failure");
  cause.config = { headers: { authorization: "Bearer " + SENTINELS.nestedCauseSecret } };
  err.cause = cause;
  return err;
}

describe("security — Axios-shaped error reaches no sensitive value", () => {
  it("1/12. an error with auth headers, cookies, tokens, bodies and a credential URL leaks nothing", () => {
    const { log, output } = captureLogger();
    log.error({ err: axiosLikeError(), reference: "PSK-1" }, "verification failed");

    const out = output();
    expect(out.length).toBeGreaterThan(0);
    // Every synthetic secret, anywhere in the serialized line.
    expect(leakedSentinels(out)).toEqual([]);
    // Belt and braces: the literal placeholder must be present, proving the
    // line was actually produced and inspected rather than empty.
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("2. header casing variations are all treated as sensitive keys", () => {
    for (const key of [
      "Authorization",
      "authorization",
      "AUTHORIZATION",
      "Proxy-Authorization",
      "proxy-authorization",
      "Cookie",
      "cookie",
      "Set-Cookie",
      "set-cookie",
      "X-Api-Key",
      "x_api_key",
      "userPassword",
      "stripeSecretKey",
      "sessionToken",
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    // Ordinary diagnostic keys must not be swept up.
    for (const key of ["orderId", "reference", "status", "message", "stack", "method", "url"]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it("3/4/6. nested config, request and response objects are dropped, not redacted", () => {
    const { log, output } = captureLogger();
    log.error({ err: axiosLikeError() }, "check");

    const parsed = JSON.parse(output().trim());
    expect(parsed.err.config).toBeUndefined();
    expect(parsed.err.request).toBeUndefined();
    expect(parsed.err.response).toBeUndefined();
    expect(leakedSentinels(output())).toEqual([]);
  });

  it("8. a nested cause is serialized through the same allowlist", () => {
    const { log, output } = captureLogger();
    log.error({ err: axiosLikeError() }, "check");

    const parsed = JSON.parse(output().trim());
    expect(parsed.err.cause).toBeDefined();
    expect(parsed.err.cause.config).toBeUndefined();
    expect(parsed.err.cause.message).toBe("inner failure");
    expect(leakedSentinels(output())).toEqual([]);
  });

  it("10. a timeout keeps useful diagnostics: type, code, status, method and path", () => {
    const { log, output } = captureLogger();
    log.error({ err: axiosLikeError(), reference: "PSK-1", requestId: "req-77" }, "verification timed out");

    const parsed = JSON.parse(output().trim());
    expect(parsed.err.type).toBe("Error");
    expect(parsed.err.code).toBe("ECONNABORTED");
    expect(parsed.err.status).toBe(502); // hoisted out of the dropped response
    expect(parsed.err.method).toBe("post");
    expect(parsed.err.url).toBe("/v1/pay"); // query string removed entirely
    expect(typeof parsed.err.stack).toBe("string");
    // Correlation identifiers survive sanitization.
    expect(parsed.reference).toBe("PSK-1");
    expect(parsed.requestId).toBe("req-77");
  });
});

describe("security — secrets in free text are masked, not dropped", () => {
  it("7/12. credential-bearing strings in messages and arbitrary fields are scrubbed", () => {
    expect(redactSecretsInText(`connecting to postgresql://user:${SENTINELS.urlCredential}@host:5432/db`)).not.toContain(
      SENTINELS.urlCredential,
    );
    expect(redactSecretsInText(`Authorization: Bearer ${SENTINELS.auth}`)).not.toContain(SENTINELS.auth);
    expect(redactSecretsInText(`Cookie: sid=${SENTINELS.cookie}`)).not.toContain(SENTINELS.cookie);
    expect(redactSecretsInText(`api_key=${SENTINELS.apiKey}`)).not.toContain(SENTINELS.apiKey);
    expect(redactSecretsInText(`password=${SENTINELS.password}`)).not.toContain(SENTINELS.password);
    expect(redactSecretsInText(`token ${SENTINELS.jwt} trailing`)).not.toContain(SENTINELS.jwt);
  });

  it("7b. the text scrub applies to arbitrary log fields, not just errors", () => {
    const { log, output } = captureLogger();
    log.info(
      {
        connectionUrl: `postgresql://svc:${SENTINELS.urlCredential}@db.internal:5432/app`,
        authorization: "Bearer " + SENTINELS.auth,
        note: `key=${SENTINELS.apiKey}`,
        orderId: "order-1",
      },
      "connected",
    );

    const out = output();
    expect(leakedSentinels(out)).toEqual([]);
    // Diagnostics survive.
    const parsed = JSON.parse(out.trim());
    expect(parsed.orderId).toBe("order-1");
    expect(parsed.authorization).toBe(REDACTION_PLACEHOLDER);
    expect(parsed.connectionUrl).not.toContain(SENTINELS.urlCredential);
  });
});

describe("security — robustness", () => {
  it("9. an ordinary application error without secrets is preserved intact", () => {
    const { log, output } = captureLogger();
    const err = new TypeError("Cannot read properties of undefined (reading 'id')");
    log.error({ err, orderId: "order-9" }, "lookup failed");

    const parsed = JSON.parse(output().trim());
    expect(parsed.err.type).toBe("TypeError");
    expect(parsed.err.message).toBe("Cannot read properties of undefined (reading 'id')");
    expect(parsed.err.stack).toContain("TypeError");
    expect(parsed.orderId).toBe("order-9");
    expect(leakedSentinels(output())).toEqual([]);
  });

  it("13. circular structures, deep nesting and odd shapes do not throw", () => {
    const err: any = new Error("weird");
    err.self = err; // cycle through an own property
    err.payload = { a: { b: { c: { d: { e: { f: { g: { h: { i: "too deep" } } } } } } } } };
    err.fn = () => 1;
    err.sym = Symbol("s");
    err.big = 10n;

    expect(() => safeErrorSerializer(err)).not.toThrow();
    const safe = safeErrorSerializer(err);
    expect((safe as Record<string, unknown> | undefined)?.message).toBe("weird");

    const { log, output } = captureLogger();
    expect(() => log.error({ err, weird: { alsoCircular: null as unknown } }, "odd")).not.toThrow();
    // A non-Error under `err` must not break serialization.
    expect(() => log.error({ err: "just a string" }, "odd")).not.toThrow();
    expect(() => log.error({ err: null }, "odd")).not.toThrow();
    expect(output().length).toBeGreaterThan(0);
  });

  it("13b. an object containing a cycle is scrubbed without throwing", () => {
    const cyclic: Record<string, unknown> = { password: SENTINELS.password, label: "x" };
    cyclic.self = cyclic;
    const { log, output } = captureLogger();
    expect(() => log.info({ payload: cyclic }, "cyclic")).not.toThrow();
    expect(leakedSentinels(output())).toEqual([]);
  });

  it("14. serialization does not mutate the original error object", () => {
    const err = axiosLikeError() as any;
    const before = {
      hasConfig: "config" in err,
      auth: err.config.headers.Authorization,
      url: err.config.url,
      message: err.message,
    };

    const serialized = safeErrorSerializer(err);
    expect(serialized).toBeDefined();

    // Application code that inspects the error afterwards must still see it.
    expect("config" in err).toBe(true);
    expect(err.config.headers.Authorization).toBe(before.auth);
    expect(err.config.url).toBe(before.url);
    expect(err.message).toBe(before.message);
    expect(serialized).not.toHaveProperty("config");
  });
});
import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
// Batch 1D.48: Jest sets NODE_ENV to "test" when it is otherwise unset
// (verified empirically for this repo's `npm test` runs). The pretty-print
// transport below spawns a `thread-stream` worker thread on construction;
// that worker keeps the Jest worker's event loop alive after the last test
// finishes, so suites importing this module hang instead of exiting
// ("Jest did not exit"). It is therefore disabled in the test environment
// only. Production (JSON logs, no transport) and ordinary development
// (pretty logs, transport) are unchanged.
const isTest = process.env.NODE_ENV === "test";

/** Maximum object depth walked when scrubbing. Guards pathological nesting. */
const MAX_SCRUB_DEPTH = 8;
/** Redaction placeholder, matching the pre-existing censor below. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Object keys whose VALUES are never safe to log, whatever they hold.
 * Compared case-insensitively against the final segment of the key, so
 * `Authorization`, `authorization` and `x-authorization` all match.
 */
const SENSITIVE_KEY_NAMES = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "oldpassword",
  "passphrase",
  "secret",
  "clientsecret",
  "apikey",
  "api_key",
  "accesskey",
  "privatekey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "sessionsecret",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "otp",
  "otpdigest",
  "otphash",
  "nin",
  "nindata",
  "cardnumber",
  "cardtoken",
  "cvv",
  "authorization_code",
  "authorizationcode",
  "signature",
  // Exact-match only (the substring sweep below skips names shorter than four
  // characters), so `key` redacts a `?key=...` parameter without swallowing
  // unrelated fields such as `sortKey` or `partitionKey`.
  "key",
  "keys",
]);

/**
 * True when a key name denotes a sensitive value.
 *
 * Header names are case-insensitive and frequently arrive hyphenated
 * (`set-cookie`, `x-api-key`), so separators are stripped before comparison.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[\s_\-]+/g, "");
  if (SENSITIVE_KEY_NAMES.has(normalized)) return true;
  // Catch prefixed/suffixed variants such as `x-api-key`, `userPassword`,
  // `stripeSecretKey` without matching unrelated words.
  for (const name of SENSITIVE_KEY_NAMES) {
    if (name.length >= 4 && normalized.includes(name)) return true;
  }
  return false;
}

/**
 * Credential shapes that can appear inside free text — an error message, a
 * stack frame, a URL — where there is no key name to act on.
 */
const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // scheme://user:password@host  ->  scheme://***:***@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1" + REDACTION_PLACEHOLDER + ":" + REDACTION_PLACEHOLDER + "@"],
  // Bearer / Basic credentials. Applied BEFORE the header patterns below,
  // because `Authorization: Bearer <token>` puts the token after a space: a
  // header pattern alone would mask only the word "Bearer" and leave the token
  // behind.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 " + REDACTION_PLACEHOLDER],
  // Authorization / Proxy-Authorization / Cookie headers inlined in text
  [/\b(authorization|proxy-authorization)\s*[:=]\s*("?)[^\s",;}]+/gi, "$1=" + REDACTION_PLACEHOLDER],
  [/\b(set-cookie|cookie)\s*[:=]\s*("?)[^\s",;}]+/gi, "$1=" + REDACTION_PLACEHOLDER],
  // `token <value>` / `password <value>` with a SPACE rather than `=`, which is
  // how these appear in prose log lines. The value must look like a credential:
  // it starts alphanumeric, contains at least one `. _ ~ + / -`, and is at
  // least eight characters. That keeps ordinary words out — "signature
  // verification" and "token expired" are not redacted.
  [
    /\b(token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|password|passwd|otp|client[_-]?secret)\s+[A-Za-z0-9][A-Za-z0-9._~+/-]{6,}/gi,
    "$1 " + REDACTION_PLACEHOLDER,
  ],
  // JWTs appearing anywhere in text
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTION_PLACEHOLDER],
];

/**
 * `key=value` / `key: value` pairs inside free text — a query string, a
 * serialized body, a log message.
 *
 * The key is matched with `isSensitiveKey` rather than a second, hand-written
 * regex list, so free-text scrubbing and object-key redaction can never drift
 * apart: one definition of "this name is sensitive" governs both.
 */
/**
 * The `(?!\/\/)` lookahead is load-bearing. Without it, the `key: value` form
 * matches a URL scheme — `https:` — and the greedy value swallows the rest of
 * the string, so a nested `?token=...` is consumed inside that one match and
 * never re-examined. Real logs contain URLs constantly.
 */
const KEY_VALUE_PAIR = /([A-Za-z0-9_.\-]+)(\s*[:=]\s*)(?!\/\/)("([^"]*)"|'([^']*)'|[^\s&,;{}]+)/g;

/**
 * Mask credential-bearing substrings inside a string, leaving surrounding text
 * (and therefore its diagnostic value) intact.
 */
export function redactSecretsInText(input: string): string {
  let out = String(input);
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(KEY_VALUE_PAIR, (match, key: string, _quoted, dq: string, sq: string) => {
    if (!isSensitiveKey(key)) return match;
    const quote = _quoted.startsWith("'") ? "'" : '"';
    const isQuoted = _quoted.length > 0 && (_quoted[0] === '"' || _quoted[0] === "'");
    void dq;
    void sq;
    return `${key}=${isQuoted ? quote + REDACTION_PLACEHOLDER + quote : REDACTION_PLACEHOLDER}`;
  });
  return out;
}

/**
 * Recursively replace the value of any sensitive key with the placeholder, and
 * scrub credential shapes out of every remaining string.
 *
 * Returns a NEW structure; the input is never mutated, so callers can keep
 * using the original error object afterwards. Cycles and excessive depth are
 * handled rather than throwing, because a logging call must never be the thing
 * that crashes a request.
 */
export function sanitizeForLogging<T>(input: T, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactSecretsInText(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (typeof input === "bigint") return input.toString();
  if (typeof input === "function" || typeof input === "symbol") return undefined;

  if (input instanceof Date) return input;
  if (input instanceof Error) return safeErrorSerializer(input, seen, depth);

  if (depth >= MAX_SCRUB_DEPTH) return REDACTION_PLACEHOLDER;

  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);

    if (Array.isArray(input)) {
      return input.map((item) => sanitizeForLogging(item, seen, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTION_PLACEHOLDER;
        continue;
      }
      const scrubbed = sanitizeForLogging(obj[key], seen, depth + 1);
      if (scrubbed !== undefined) out[key] = scrubbed;
    }
    return out;
  }
  return REDACTION_PLACEHOLDER;
}

/**
 * Error fields safe to keep. Everything else — `config`, `request`,
 * `response`, and any other property an Axios error carries — is DROPPED
 * rather than redacted, so there is no chance of a new field slipping through.
 */
const SAFE_ERROR_FIELDS = [
  "type",
  "name",
  "message",
  "code",
  "errno",
  "syscall",
  "status",
  "statusCode",
] as const;

const MAX_CAUSE_DEPTH = 3;

/**
 * Serialize an Error to a safe, allowlisted shape.
 *
 * WHY THIS EXISTS (verified empirically against pino 10.3.1)
 * ---------------------------------------------------------
 * Pino does NOT apply `stdSerializers.err` unless configured. Given a real
 * Axios error it serializes the instance's own enumerable properties, which for
 * Axios 1.x include `config`, `request` and `response`. `config` carries the
 * `Authorization` header; `config.data` carries request bodies; `response.data`
 * can carry access/refresh tokens; `response.headers` can carry `set-cookie`.
 * None of those key paths are covered by the `redact` list, which addresses
 * `req.headers.*` and top-level secret fields only.
 *
 * An allowlist is used instead of a blocklist because Axios (and future
 * upgrades) can attach properties nobody enumerated.
 */
export function safeErrorSerializer(
  err: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  // Not an Error. `formatters.log` has already scrubbed this value by the time
  // serializers run, so it is returned as-is (sanitized) rather than
  // `undefined` — Pino omits a key entirely when its serializer returns
  // undefined, which would silently drop legitimate structured context.
  if (!(err instanceof Error)) {
    return sanitizeForLogging(err, seen, depth);
  }
  if (seen.has(err)) return { type: "Error", message: "[Circular]" };
  seen.add(err);

  const out: Record<string, unknown> = { type: err.name || "Error" };

  for (const field of SAFE_ERROR_FIELDS) {
    const value = (err as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      out[field] = typeof value === "string" ? redactSecretsInText(value) : value;
    }
  }

  // Axios reports HTTP failures via `status`; AxiosError also exposes it on
  // the nested `response`, which is dropped, so surface it explicitly.
  const responseStatus = (err as unknown as { response?: { status?: unknown } }).response?.status;
  if (typeof responseStatus === "number" && out.status === undefined) {
    out.status = responseStatus;
  }

  // Request method and path are safe and materially useful; the URL is not,
  // because it can carry a query-string credential.
  const config = (err as unknown as { config?: Record<string, unknown> }).config;
  if (config && typeof config === "object") {
    if (typeof config.method === "string") out.method = config.method;
    if (typeof config.url === "string") {
      const withoutQuery = config.url.split("?")[0];
      out.url = redactSecretsInText(withoutQuery);
    }
  }

  if (typeof err.stack === "string") out.stack = redactSecretsInText(err.stack);

  // Nested causes are logged through the same allowlist, to a bounded depth.
  const cause = (err as unknown as { cause?: unknown }).cause;
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause =
      cause instanceof Error
        ? safeErrorSerializer(cause, seen, depth + 1)
        : redactSecretsInText(String(cause));
  }

  return out;
}

/**
 * Structured application logger.
 *
 * In production: emits newline-delimited JSON — pipe straight into any log
 * aggregator (Render logs, Datadog, CloudWatch, etc.) and every field is
 * queryable.
 *
 * In development: pretty-printed, colorized, human-readable.
 *
 * Use this instead of console.log/console.error everywhere. Prefer passing
 * structured context over string interpolation:
 *   logger.info({ userId, orderId }, "Order created");
 * not:
 *   logger.info(`Order ${orderId} created for user ${userId}`);
 * — the structured version is filterable/searchable in log tooling, the
 * string version isn't.
 *
 * Exported so tests can build an identically-configured logger writing to an
 * in-memory destination and assert on the real serialized output, rather than
 * on a copy of these options.
 */
export const loggerOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),

  // Defense in depth. `safeErrorSerializer` below already removes an error's
  // config/request/response entirely; these paths cover values logged OUTSIDE
  // the `err` key, and any secret-bearing key on any log line.
  redact: {
    paths: [
      "password",
      "*.password",
      "newPassword",
      "*.newPassword",
      "currentPassword",
      "*.currentPassword",
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.Authorization",
      "req.headers.Cookie",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.apiKey",
      "*.api_key",
      "*.secret",
      "*.clientSecret",
      "*.authorization",
      "*.Authorization",
      "*.proxyAuthorization",
      "*.cookie",
      "*.Cookie",
      "*.setCookie",
      "*.set-cookie",
      "*.config",
      "*.request",
      "*.response",
      "*.headers",
      "*.data",
      "*.nin",
      "*.ninData",
      "*.cardNumber",
      "*.cvv",
      "*.cardToken",
      "*.authorization_code",
      "*.authorizationCode",
      "authorization_code",
      "cardToken",
      "otp",
      "*.otp",
      "otpDigest",
      "*.otpDigest",
      "otpHash",
      "*.otpHash",
    ],
    censor: REDACTION_PLACEHOLDER,
  },

  // Central guarantee: an Error reaching ANY level is reduced to an allowlist
  // before serialization, so `config`, `request` and `response` never reach the
  // transport regardless of which call site logged it.
  serializers: {
    err: safeErrorSerializer,
  },

  /**
   * Belt-and-braces over EVERY log line, not just `err`.
   *
   * `serializers.err` above only fires for the `err` key. A secret can reach a
   * log line under any other key — `logger.info({ connectionUrl, headers,
   * payload })` — and `redact` can only match key NAMES it was told about,
   * never a credential embedded in a string value (a connection URL, a query
   * parameter, a serialized body).
   *
   * Pino applies `formatters.log` to the fully-merged object on every call, at
   * every level, before serialization — so one pass here covers production,
   * development and any future call site that is not `err`-shaped. It returns
   * a NEW object; the caller's original is never mutated.
   */
  formatters: {
    log: (object: Record<string, unknown>) => sanitizeForLogging(object) as Record<string, unknown>,
  },

  transport: isProduction || isTest
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:mm:ss",
          ignore: "pid,hostname",
        },
      },
};

export const logger = pino(loggerOptions);

/**
 * Create a child logger scoped to a request, carrying a requestId so every
 * log line from a single request can be correlated in aggregated logs.
 */
export function createRequestLogger(requestId: string, extra?: Record<string, unknown>) {
  return logger.child({ requestId, ...extra });
}
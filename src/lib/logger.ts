import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

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
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),

  // Never let secrets leak into logs, even if someone passes a whole
  // request/user object by accident.
  redact: {
    paths: [
      "password",
      "*.password",
      "req.headers.authorization",
      "req.headers.cookie",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.nin",
      "*.ninData",
      "*.cardNumber",
      "*.cvv",
      "*.cardToken",
      "*.authorization_code",
      "*.authorizationCode",
      "authorization_code",
      "cardToken",
    ],
    censor: "[REDACTED]",
  },

  transport: isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
});

/**
 * Create a child logger scoped to a request, carrying a requestId so every
 * log line from a single request can be correlated in aggregated logs.
 */
export function createRequestLogger(requestId: string, extra?: Record<string, unknown>) {
  return logger.child({ requestId, ...extra });
}

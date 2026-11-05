/**
 * Database-target guard for destructive maintenance scripts.
 *
 * Extracted from `tests/scripts/verifyMigrationTarget.ts`, which already
 * encoded this project's loopback / explicit-port / deny-list rules for
 * Prisma migration commands. That script is a CLI verifier: it prints, exits,
 * and is not importable as a library. This module keeps the SAME checks but
 * exposes them as a pure function so the ProductOption migration runner can
 * call it before it opens a connection.
 *
 * Design rules, matching `src/jobs/seedGuard.ts`:
 *   - Fail closed. Anything unverified is a refusal, never a fallback.
 *   - No database access, and no printing of connection strings, passwords or
 *     tokens. Only the resolved host/port are reported, and the host is
 *     reported because it is already required to be loopback.
 *   - Explicit human opt-in is separate from any target that merely *looks*
 *     like a development database.
 */

export type MigrationTargetDenialReason =
  | "MISSING_DATABASE_URL"
  | "MISSING_TEST_DATABASE_URL"
  | "URL_PARSE_FAILED"
  | "HOST_MISMATCH"
  | "DATABASE_MISMATCH"
  | "NON_LOOPBACK_HOST"
  | "MISSING_PORT"
  | "MISSING_DENY_LIST"
  | "HOST_DENIED";

export interface MigrationTargetConfig {
  /** The URL Prisma will actually connect to. */
  databaseUrl?: string;
  /** The URL of the disposable database this run is authorised to touch. */
  testDatabaseUrl?: string;
  /** Comma-separated hosts that must never be targeted. */
  deniedHosts?: string;
}

export type MigrationTargetCheck =
  | { ok: true; host: string; port: string }
  | { ok: false; reason: MigrationTargetDenialReason; message: string };

/** Lowercase, strip a trailing root dot, unwrap IPv6 brackets. */
export function normalizeHost(host: string): string {
  let out = host.trim().toLowerCase();
  while (out.endsWith(".")) out = out.slice(0, -1);
  if (out.startsWith("[") && out.endsWith("]")) out = out.slice(1, -1);
  return out;
}

/** `localhost`, `::1`, or any 127.0.0.0/8 address. */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n >= 0 && n <= 255) && octets[0] === 127;
}

/**
 * The database name from a URL path.
 *
 * `postgresql://u:p@h:5432/foodpaddi?schema=public` → `foodpaddi`.
 * A missing path (`postgresql://u:p@h:5432`) yields the empty string, which is
 * compared rather than rejected so the caller's other checks stay authoritative.
 *
 * Returns `null` for a path that cannot be decoded (malformed percent-encoding
 * such as `%zz`). `decodeURIComponent` throws a `URIError` on those inputs, and
 * letting that escape would surface as an unhandled exception with a stack
 * trace instead of a structured refusal. Fails closed: the caller turns `null`
 * into a `URL_PARSE_FAILED` denial.
 */
export function normalizeDatabaseName(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * Verify that `databaseUrl` points at the authorised disposable local database.
 *
 * Pure: performs no I/O and reads no environment itself. Callers pass the
 * values explicitly, which is what makes this unit-testable.
 *
 * Host and port AND database name must all match. Comparing only the host would
 * accept `DATABASE_URL=…/foodpaddi_dev` alongside
 * `TEST_DATABASE_URL=…/foodpaddi_test` — same server, different database — and
 * the write would land in a database nobody authorised. Comparing only host and
 * port was a real gap found by the unit tests.
 */
export function checkMigrationTarget(config: MigrationTargetConfig): MigrationTargetCheck {
  const { databaseUrl, testDatabaseUrl, deniedHosts } = config;

  if (!databaseUrl) {
    return {
      ok: false,
      reason: "MISSING_DATABASE_URL",
      message: "DATABASE_URL is not set. Refusing to run: the migration target cannot be verified.",
    };
  }
  if (!testDatabaseUrl) {
    return {
      ok: false,
      reason: "MISSING_TEST_DATABASE_URL",
      message:
        "TEST_DATABASE_URL is not set. Refusing to run: refusing to guess which database this migration is authorised to touch.",
    };
  }

  let dbUrl: URL;
  let testUrl: URL;
  try {
    dbUrl = new URL(databaseUrl);
    testUrl = new URL(testDatabaseUrl);
  } catch {
    return {
      ok: false,
      reason: "URL_PARSE_FAILED",
      message: "DATABASE_URL or TEST_DATABASE_URL is not a parsable URL. Refusing to run.",
    };
  }

  if (
    normalizeHost(dbUrl.hostname) !== normalizeHost(testUrl.hostname) ||
    dbUrl.port !== testUrl.port
  ) {
    return {
      ok: false,
      reason: "HOST_MISMATCH",
      message: "DATABASE_URL does not match TEST_DATABASE_URL host and port. Refusing to run.",
    };
  }

  // The database name is part of the identity of the target. A dev/test pair on
  // the same server must not be treated as interchangeable.
  const dbName = normalizeDatabaseName(dbUrl.pathname);
  const testName = normalizeDatabaseName(testUrl.pathname);
  if (dbName === null || testName === null) {
    return {
      ok: false,
      reason: "URL_PARSE_FAILED",
      message:
        "DATABASE_URL or TEST_DATABASE_URL has a database path that cannot be decoded. Refusing to run.",
    };
  }
  if (dbName !== testName) {
    return {
      ok: false,
      reason: "DATABASE_MISMATCH",
      message:
        "DATABASE_URL names a different database than TEST_DATABASE_URL. Refusing to run: the write must land only in the authorised database.",
    };
  }

  const host = normalizeHost(dbUrl.hostname);
  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      reason: "NON_LOOPBACK_HOST",
      message: `Target host "${host}" is not a loopback address. Refusing to run: this maintenance script must never target a remote or production database.`,
    };
  }

  const port = dbUrl.port;
  if (!port) {
    return {
      ok: false,
      reason: "MISSING_PORT",
      message: "DATABASE_URL has no explicit port. Refusing to run: an implicit port is not verifiable.",
    };
  }

  if (!deniedHosts || !deniedHosts.trim()) {
    return {
      ok: false,
      reason: "MISSING_DENY_LIST",
      message:
        "TEST_DATABASE_DENIED_HOSTS is unset. Refusing to run: the mandated deny list is a precondition, not an optional extra.",
    };
  }
  const denied = deniedHosts
    .split(",")
    .map((h) => normalizeHost(h))
    .filter(Boolean);
  if (denied.includes(host)) {
    return {
      ok: false,
      reason: "HOST_DENIED",
      message: `Target host "${host}" is on TEST_DATABASE_DENIED_HOSTS. Refusing to run.`,
    };
  }

  return { ok: true, host, port };
}

/**
 * Read the target configuration from an environment bag.
 *
 * Kept separate from `checkMigrationTarget` so tests can pass a literal
 * object instead of mutating `process.env`.
 */
export function readMigrationTargetConfig(
  env: Record<string, string | undefined>,
): MigrationTargetConfig {
  return {
    databaseUrl: env.DATABASE_URL,
    testDatabaseUrl: env.TEST_DATABASE_URL,
    deniedHosts: env.TEST_DATABASE_DENIED_HOSTS,
  };
}

/* ── explicit write opt-in ─────────────────────────────────────────────────── */

/** The only accepted opt-in value. Case-sensitive, matching `SEED_ALLOW`. */
export const MIGRATION_OPT_IN_VALUE = "yes";

/**
 * Environment variable an operator must set to permit WRITES.
 *
 * Deliberately distinct from `--apply`: the flag says which mode was
 * requested, this says a human authorised a write at all.
 */
export const MIGRATION_OPT_IN_ENV = "PRODUCT_OPTION_MIGRATION_ALLOW";

export function isMigrationWriteOptedIn(
  env: Record<string, string | undefined>,
): boolean {
  return env[MIGRATION_OPT_IN_ENV] === MIGRATION_OPT_IN_VALUE;
}
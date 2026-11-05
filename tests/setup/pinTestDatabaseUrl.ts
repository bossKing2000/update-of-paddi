/**
 * Pins the integration test workers to the validated test database.
 *
 * Why this file exists
 * --------------------
 * `globalSetup` runs in the PARENT process. Assigning process.env there is not
 * a reliable way to reach test workers, because workers are separate processes
 * with their own environment.
 *
 * The preflight's own Prisma client uses an explicit
 * `datasources: { db: { url: testUrl } }` override, while the suites it protects
 * construct a bare `new PrismaClient()` that resolves `env("DATABASE_URL")` per
 * prisma/schema.prisma. Without this file, the preflight could validate one
 * database while the tests connected to a completely different one.
 *
 * What this does
 * --------------
 * Jest runs `setupFiles` inside each worker BEFORE the test module is required.
 * Verified against Jest 30's source:
 *   - setupFiles          jest-runner/build/index.js:217
 *   - test module require jest-circus/build/runner.js:94
 *
 * Exporting a function (Jest calls it if present) lets this fail closed at that
 * point, before any `new PrismaClient()` in a suite is constructed.
 *
 * It re-runs the same purely local checks as the preflight rather than trusting
 * a value handed across a process boundary. tests/unit/testDatabaseSafety.test.ts
 * asserts both layers reach identical decisions on the same fixtures.
 *
 * Setting `process.env.DATABASE_URL` here is authoritative against
 * src/config/config.ts's `dotenv.config()`: dotenv 17 defaults `override` to
 * false, so it will not overwrite an already-populated variable. This file runs
 * before the test module imports config.ts, so the pin wins.
 *
 * Configuration rules (identical to integrationPreflight.ts)
 * ---------------------------------------------------------
 *  1. TEST_DATABASE_URL required, parseable, postgres(ql) scheme, must name a
 *     database and include a password.
 *  2. TEST_DATABASE_DENIED_HOSTS is MANDATORY. Unset, empty, or whitespace-only
 *     is a hard refusal — never silently treated as an empty denylist.
 *  3. The target host must be a LOOPBACK address. The intended integration
 *     setup is a disposable local PostgreSQL instance, so a remote host cannot
 *     be authorised merely by appearing in an allowlist.
 *  4. Port must be explicit and in range 1-65535.
 *  5. Host must be in TEST_DATABASE_ALLOWED_HOSTS; database must be in
 *     TEST_DATABASE_ALLOWED_NAMES (exact or `endswith:`).
 *  6. Database name must not match an application/shared pattern.
 *  7. Host must not be in TEST_DATABASE_DENIED_HOSTS, nor equal the host of an
 *     ambient DATABASE_URL.
 *
 * Hostnames are normalised consistently: lowercased and stripped of trailing
 * dots, so `EXAMPLE.COM.` and `example.com` cannot disagree.
 *
 * Limitations
 * -----------
 * - This guards Jest-driven runs only. Invoking a suite directly with ts-node
 *   bypasses Jest entirely, so this file never loads. Documented in
 *   tests/README.md.
 * - A suite constructing its own PrismaClient with an explicit
 *   `datasource.url` override would ignore this pin. None currently do.
 * - Passing these checks proves the target is loopback and matches the
 *   configured policy. It does NOT prove an arbitrary remote hostname is safe;
 *   a remote target is refused outright rather than judged.
 * - The preflight additionally verifies the live server identity and schema;
 *   this layer cannot connect and therefore cannot repeat those checks.
 *
 * Credentials and full connection URLs are never printed.
 */

const ALLOWLIST_UNCONFIGURED = "__unconfigured__";

const APPLICATION_NAME_PATTERN =
  /(^|[_-])(prod|production|live|main|staging|shared|app)([_-]|$)/i;

/** A bare hostname or bracketed IPv6 literal. Rejects scheme, port, path, spaces. */
const HOSTNAME_PATTERN = /^(\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f]*:[0-9A-Fa-f:]*|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

class PinError extends Error {
  constructor(message: string) {
    super(`[test-db-pin] ${message}`);
    this.name = "PinError";
  }
}

/**
 * Canonical hostname form: lowercase, trimmed, trailing dots removed, and IPv6
 * literals unwrapped from the brackets `URL.hostname` adds. Without the
 * unwrap, `identity.host` would be "[::1]" while an operator writes "::1" in
 * an allowlist, and the two could never match.
 */
function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

/**
 * Expands an IPv6 literal to its eight hextets, or null when malformed.
 * Handles the `::` compression only; embedded IPv4 is rejected.
 */
function expandIpv6(addr: string): number[] | null {
  if (addr.includes(".")) return null; // IPv4-mapped/embedded: not handled here
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - left.length - right.length;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
  } else if (fill < 0) {
    return null;
  }
  const hextets = halves.length === 1 ? left : left.concat(new Array(fill).fill("0"), right);
  if (hextets.length !== 8) return null;
  const nums = hextets.map((h) => parseInt(h, 16));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

/** True only for the IPv6 loopback address, in any textual form of `::1`. */
function isIpv6Loopback(addr: string): boolean {
  const hextets = expandIpv6(addr);
  if (!hextets) return false;
  return hextets.slice(0, 7).every((n) => n === 0) && hextets[7] === 1;
}

/**
 * Loopback only. `localhost`, any 127.0.0.0/8 address, and IPv6 ::1 (in any
 * textual form, including the expanded `0:0:0:0:0:0:0:1`).
 * Everything else — including any remote host — is refused.
 *
 * The IPv6 test is deliberately narrow: only `::1` equivalents qualify, so
 * `fe80::1`, `::2` and IPv4-mapped forms stay refused.
 */
function isLoopbackHost(host: string): boolean {
  const bare = host; // normalizeHost already removed IPv6 brackets
  if (bare === "localhost") return true;
  if (isIpv6Loopback(bare)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

function parsePostgresUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return null;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database || !url.hostname) return null;
  return {
    host: normalizeHost(url.hostname),
    rawHost: url.hostname,
    port: url.port,
    database,
    user: decodeURIComponent(url.username || ""),
    hasPassword: Boolean(url.password),
    // D4: parameters such as `socket_path` or `options` can change the
    // transport or redirect the connection, and are consumed by Prisma's
    // native engine where they cannot be verified. Recorded so callers refuse.
    hasQuery: url.search.length > 0,
  };
}

/**
 * Parses a mandatory comma-separated hostname list.
 * Returns null when unset, empty, or whitespace-only — callers must refuse.
 * Throws PinError on any entry that is not a bare hostname.
 */
function parseDeniedHosts(raw: string | undefined): Set<string> | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") {
      throw new PinError(
        "TEST_DATABASE_DENIED_HOSTS contains an empty entry. Remove it or supply a hostname.",
      );
    }
    if (!HOSTNAME_PATTERN.test(entry)) {
      throw new PinError(
        `TEST_DATABASE_DENIED_HOSTS contains an invalid entry. Entries must be bare ` +
          `hostnames with no scheme, port or path. (offending entry length: ${entry.length})`,
      );
    }
    out.add(normalizeHost(entry));
  }
  return out.size ? out : null;
}

/** Splits an allowlist into a trimmed, lowercased list; unconfigured denies all. */
function readList(raw: string | undefined): string[] {
  if (!raw) return [ALLOWLIST_UNCONFIGURED];
  const items = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? items : [ALLOWLIST_UNCONFIGURED];
}

module.exports = function pinTestDatabaseUrl(): void {
  const testUrl = process.env.TEST_DATABASE_URL;

  if (!testUrl || !testUrl.trim()) {
    throw new PinError(
      "TEST_DATABASE_URL is not set. Refusing to fall back to DATABASE_URL, which these " +
        "destructive suites could inherit from the application's .env.",
    );
  }

  const identity = parsePostgresUrl(testUrl);
  if (!identity) {
    throw new PinError(
      "TEST_DATABASE_URL is not a usable PostgreSQL URL. It must use the postgresql:// or " +
        "postgis:// scheme and name a database.",
    );
  }
  if (!identity.hasPassword) {
    throw new PinError(
      "TEST_DATABASE_URL has no password; Prisma would fall back to ambient PG* variables.",
    );
  }

  // D4: refuse any query string, matching the preflight exactly. Parameters
  // such as `socket_path` or `options` can change the transport or redirect
  // the connection and cannot be verified from here.
  if (identity.hasQuery) {
    throw new PinError(
      "TEST_DATABASE_URL must not contain query parameters. Connection parameters such as " +
        "`socket_path` or `options` can change the transport or redirect the connection. Use a " +
        "plain host:port/database URL.",
    );
  }

  // Mandatory denylist. Never degrade a missing policy into an empty denylist.
  const deniedHosts = parseDeniedHosts(process.env.TEST_DATABASE_DENIED_HOSTS);
  if (deniedHosts === null) {
    throw new PinError(
      "TEST_DATABASE_DENIED_HOSTS is required but unset, empty, or whitespace-only. Refusing " +
        "to run integration tests without an explicit deny policy — an absent policy is not " +
        "consent. Set it to the comma-separated hostnames that must never be used.",
    );
  }

  // Port must be explicit: the default is never assumed, so the documented
  // non-default local port is unambiguous.
  if (!identity.port) {
    throw new PinError(
      "TEST_DATABASE_URL must state an explicit port. The documented local setup uses 55432.",
    );
  }
  const portNumber = Number(identity.port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new PinError("TEST_DATABASE_URL has a port outside the valid range 1-65535.");
  }

  // Loopback only. A remote host is refused regardless of the allowlists, so
  // adding an arbitrary remote host to an allowlist cannot enable it.
  if (!isLoopbackHost(identity.host)) {
    throw new PinError(
      `Host "${identity.host}" is not a loopback address. Integration tests run only against a ` +
        "disposable local PostgreSQL instance (localhost, 127.0.0.0/8, or ::1). Remote targets " +
        "are refused even if they appear in the allowlists.",
    );
  }

  const allowedHosts = readList(process.env.TEST_DATABASE_ALLOWED_HOSTS);
  if (allowedHosts.includes(ALLOWLIST_UNCONFIGURED) || !allowedHosts.includes(identity.host)) {
    throw new PinError(`Host "${identity.host}" is not in TEST_DATABASE_ALLOWED_HOSTS.`);
  }

  const allowedNames = readList(process.env.TEST_DATABASE_ALLOWED_NAMES);
  const dbLower = identity.database.toLowerCase();
  const dbAllowed = allowedNames.some((entry) => {
    if (entry === ALLOWLIST_UNCONFIGURED) return false;
    if (entry.startsWith("endswith:")) {
      return dbLower.endsWith(entry.slice("endswith:".length).toLowerCase());
    }
    return entry === dbLower;
  });
  if (!dbAllowed) {
    throw new PinError(`Database "${identity.database}" is not in TEST_DATABASE_ALLOWED_NAMES.`);
  }

  if (APPLICATION_NAME_PATTERN.test(identity.database)) {
    throw new PinError(
      `Database name "${identity.database}" matches an application/shared-database pattern.`,
    );
  }

  // The ambient application host is denied too, derived at runtime so no
  // hostname is hardcoded and no credential is read.
  const ambient = process.env.DATABASE_URL ? parsePostgresUrl(process.env.DATABASE_URL) : null;
  if (ambient) deniedHosts.add(normalizeHost(ambient.rawHost));

  if (deniedHosts.has(identity.host)) {
    throw new PinError(
      `Host "${identity.host}" is listed in TEST_DATABASE_DENIED_HOSTS and must never be used ` +
        "for integration tests.",
    );
  }

  // The pin. Suites calling `new PrismaClient()` now resolve exactly the URL
  // that passed validation.
  process.env.DATABASE_URL = testUrl;
};

export {};
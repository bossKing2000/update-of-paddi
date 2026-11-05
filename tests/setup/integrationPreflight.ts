/**
 * Integration-test database preflight.
 *
 * Purpose
 * -------
 * The suites under tests/integration construct `new PrismaClient()` with no
 * datasource override, and prisma/schema.prisma hardcodes:
 *
 *     datasource db { provider = "postgresql"  url = env("DATABASE_URL") }
 *
 * Several suites transitively import src/config/config.ts, which calls
 * `dotenv.config()` and loads the application's .env into process.env.
 *
 * The consequence is that without a gate, `npm run test:integration` silently
 * targets whatever DATABASE_URL resolves to — which may be the shared
 * application/Render database. Those suites issue destructive statements
 * (deleteMany across Order, OrderItem, Payment, Product, User, and
 * CartItemOption) and create vendor rows. A name-suffix check alone is not
 * sufficient proof of isolation: a shared database can be cloned, restored
 * from a dump, reached through an alias, or resolved to a different host by
 * DNS.
 *
 * This preflight therefore verifies IDENTITY, not just a name, and refuses to
 * proceed unless every check passes.
 *
 * Guarantees
 * ----------
 * - Fails closed. Any failed check throws; no suite module is loaded and no
 *   PrismaClient is constructed.
 * - Never prints a password, a full connection URL, or any credential.
 * - Performs no writes of any kind. Read-only catalog queries only.
 * - Connection happens ONLY after host and database identity have both been
 *   validated against explicit allowlists, so a disallowed target is never
 *   contacted at all.
 */

const ALLOWLIST_UNCONFIGURED = "__unconfigured__";

/**
 * Tables the integration suites require to exist and be migrated.
 *
 * Every entry is verified against prisma/schema.prisma at run time (see
 * `assertRequiredTablesMatchSchema`). A stale name here would make every
 * integration run refuse, so the list must track the schema exactly.
 */
const REQUIRED_TABLES = [
  "User",
  "Address",
  "Product",
  "Order",
  "OrderItem",
  "Payment",
  "Cart",
  "CartItem",
  "CartItemOption",
  "OptionGroup",
  "RefundRequest",
  "Promotion",
  "PromotionUsage",
  "DeliveryAssignment",
  "DeliveryPerson",
  "RiderWithdrawal",
  "VendorPayout",
  "WebhookEvent",
];

/** Models that must have a physical table (guarded by migrationChainIntegrity). */
const REQUIRED_MIGRATION_TABLES = [
  "User",
  "Product",
  "Order",
  "OrderItem",
  "Payment",
  "Promotion",
  "RefundRequest",
  "DeliveryAssignment",
  "RiderWithdrawal",
  "VendorPayout",
  "WebhookEvent",
];

class PreflightError extends Error {
  constructor(message: string) {
    super(`[integration-preflight] ${message}`);
    this.name = "PreflightError";
  }
}

/** A bare hostname or bracketed IPv6 literal. Rejects scheme, port, path, spaces. */
const HOSTNAME_PATTERN = /^(\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f]*:[0-9A-Fa-f:]*|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * Canonical hostname form: lowercase, trimmed, trailing dots removed, and IPv6
 * literals unwrapped from the brackets `URL.hostname` adds. Without the unwrap,
 * `identity.host` would be "[::1]" while an operator writes "::1" in an
 * allowlist, and the two could never match.
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

/**
 * Parses a PostgreSQL URL into its identity components without ever logging
 * the original string. Returns null for anything unparseable so the caller
 * fails closed rather than guessing.
 */
function parsePostgresUrl(raw: string): {
  protocol: string;
  host: string;
  rawHost: string;
  port: string;
  database: string;
  user: string;
  hasPassword: boolean;
  hasQuery: boolean;
} | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return null;

  // Decode %2F etc. in the database name so identity comparisons are stable.
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) return null;
  if (!url.hostname) return null;

  return {
    protocol: url.protocol.replace(":", ""),
    host: normalizeHost(url.hostname),
    rawHost: url.hostname,
    // Kept as the raw string (possibly empty) so an unspecified port can be
    // refused rather than silently defaulted.
    port: url.port,
    database,
    user: decodeURIComponent(url.username || ""),
    hasPassword: Boolean(url.password),
    // D4: a Postgres connection URL can carry parameters that change the
    // transport or target (notably `socket_path`, and an `options` string that
    // can carry libpq connection options). Those are consumed by Prisma's
    // native engine rather than by JS we can inspect here, so they cannot be
    // verified. The flag lets callers refuse rather than silently ignore them.
    hasQuery: url.search.length > 0,
  };
}

/** Human-safe identity summary. Contains no password and no full URL. */
function describeIdentity(identity: ReturnType<typeof parsePostgresUrl>) {
  if (!identity) return "<unparseable>";
  return `${identity.user || "<no-user>"}@${identity.host}:${identity.port}/${identity.database}`;
}

/**
 * Splits a comma-separated env var into a trimmed, lowercased list.
 * Returns the unconfigured sentinel when unset or empty.
 */
function readList(raw: string | undefined): string[] {
  if (!raw) return [ALLOWLIST_UNCONFIGURED];
  const items = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? items : [ALLOWLIST_UNCONFIGURED];
}

/**
 * Parses a mandatory comma-separated hostname list.
 * Returns null when unset, empty, or whitespace-only — callers must refuse.
 * Throws PreflightError on any entry that is not a bare hostname.
 */
function parseDeniedHosts(raw: string | undefined): Set<string> | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") {
      throw new PreflightError(
        "TEST_DATABASE_DENIED_HOSTS contains an empty entry. Remove it or supply a hostname.",
      );
    }
    if (!HOSTNAME_PATTERN.test(entry)) {
      throw new PreflightError(
        `TEST_DATABASE_DENIED_HOSTS contains an invalid entry. Entries must be bare ` +
          `hostnames with no scheme, port or path. (offending entry length: ${entry.length})`,
      );
    }
    out.add(normalizeHost(entry));
  }
  return out.size ? out : null;
}

/** Exact-match allowlist check. Never treats an unconfigured list as "allow". */
function isAllowed(value: string, allowlist: string[]): boolean {
  return allowlist.includes(ALLOWLIST_UNCONFIGURED) ? false : allowlist.includes(value.toLowerCase());
}

/**
 * Reads expected table names out of prisma/schema.prisma so the check stays in
 * step with the models rather than relying on a hand-maintained list drifting.
 * Falls back to the static list when the schema cannot be read.
 */
function readModelNamesFromSchema(): string[] {
  try {
    const fs = require("fs");
    const path = require("path");
    const schemaPath = path.join(__dirname, "..", "..", "prisma", "schema.prisma");
    const schema = fs.readFileSync(schemaPath, "utf8");
    const names = new Set<string>();
    const modelRe = /^model\s+([A-Za-z0-9_]+)\s*\{/gm;
    let match: RegExpExecArray | null;
    while ((match = modelRe.exec(schema)) !== null) {
      names.add(match[1]);
    }
    return names.size ? Array.from(names) : REQUIRED_MIGRATION_TABLES;
  } catch {
    return REQUIRED_MIGRATION_TABLES;
  }
}

/** Resolves the physical table name for a model, honouring @@map. */
function physicalTableNames(modelNames: string[]): string[] {
  try {
    const fs = require("fs");
    const path = require("path");
    const schemaPath = path.join(__dirname, "..", "..", "prisma", "schema.prisma");
    const schema = fs.readFileSync(schemaPath, "utf8");
    const tables = new Set<string>();
    const modelRe = /model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\n\}/g;
    let match: RegExpExecArray | null;
    while ((match = modelRe.exec(schema)) !== null) {
      const mapMatch = match[2].match(/@@map\("([^"]+)"\)/);
      tables.add(mapMatch ? mapMatch[1] : match[1]);
    }
    return tables.size ? Array.from(tables) : modelNames;
  } catch {
    return modelNames;
  }
}

/**
 * Fails fast when REQUIRED_TABLES names something the schema does not define.
 *
 * Without this, a table removed from schema.prisma while still listed here
 * would make every integration run refuse with a misleading "not migrated"
 * message, and the real cause (a stale list) would be invisible.
 */
function assertRequiredTablesMatchSchema(): void {
  const known = new Set([
    ...readModelNamesFromSchema(),
    ...physicalTableNames(readModelNamesFromSchema()),
  ]);
  const stale = REQUIRED_TABLES.filter((t) => !known.has(t));
  if (stale.length) {
    throw new PreflightError(
      `The integration gate is misconfigured: REQUIRED_TABLES names ${stale.join(", ")}, which ` +
        "does not exist in prisma/schema.prisma. Update tests/setup/integrationPreflight.ts to " +
        "match the schema. No connection was attempted.",
    );
  }
}

module.exports = async function integrationPreflight(): Promise<void> {
  const log = (msg: string) => console.log(`[integration-preflight] ${msg}`);

  // ---------------------------------------------------------------------
  // 1. Dedicated configuration must be present.
  // ---------------------------------------------------------------------
  // Cheap local check before anything else: catches a stale gate configuration
  // without opening a connection.
  assertRequiredTablesMatchSchema();

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl || !testUrl.trim()) {
    throw new PreflightError(
      "TEST_DATABASE_URL is not set. Integration suites perform destructive writes, so they " +
        "refuse to run against an ambient DATABASE_URL. See tests/README.md for how to provision " +
        "a disposable test database.",
    );
  }

  const testIdentity = parsePostgresUrl(testUrl);
  if (!testIdentity) {
    throw new PreflightError("TEST_DATABASE_URL is not a parseable PostgreSQL URL.");
  }
  if (!testIdentity.hasPassword) {
    throw new PreflightError(
      "TEST_DATABASE_URL does not include a password. A credential-less URL would fall back to " +
        "ambient PG* variables and defeat identity verification.",
    );
  }

  // D4: refuse any query string. Connection parameters such as `socket_path`
  // or `options` can change the transport or redirect the connection, and they
  // are interpreted by Prisma's native engine where they cannot be verified.
  // No documented setup here needs one, so all of them are refused.
  if (testIdentity.hasQuery) {
    throw new PreflightError(
      "TEST_DATABASE_URL must not contain query parameters. Connection parameters such as " +
        "`socket_path` or `options` can change the transport or redirect the connection, and " +
        "cannot be verified from here. Use a plain host:port/database URL. No connection was " +
        "attempted.",
    );
  }

  // ---------------------------------------------------------------------
  // 2. It must differ from the ambient application database.
  //    Compare host + database name, not raw strings: differing credentials,
  //    ports or query parameters must not be able to disguise the same target.
  // ---------------------------------------------------------------------
  const ambientUrl = process.env.DATABASE_URL;
  let ambientIdentity = null;
  if (ambientUrl && ambientUrl.trim()) {
    ambientIdentity = parsePostgresUrl(ambientUrl);
    if (ambientIdentity) {
      const sameTarget =
        ambientIdentity.host === testIdentity.host &&
        ambientIdentity.database === testIdentity.database;
      if (sameTarget) {
        throw new PreflightError(
          "TEST_DATABASE_URL resolves to the same host and database as the ambient DATABASE_URL " +
            `(${describeIdentity(ambientIdentity)}). These suites delete rows across many tables; ` +
            "refusing to run against the application database.",
        );
      }
      log(
        `Ambient DATABASE_URL detected and correctly distinct from TEST_DATABASE_URL ` +
          `(app: ${describeIdentity(ambientIdentity)} / test: ${describeIdentity(testIdentity)}).`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // 3. Explicit allowlists. An unconfigured allowlist denies everything.
  // ---------------------------------------------------------------------
  const allowedHosts = readList(process.env.TEST_DATABASE_ALLOWED_HOSTS);
  const allowedDatabases = readList(process.env.TEST_DATABASE_ALLOWED_NAMES);

  if (!isAllowed(testIdentity.host, allowedHosts)) {
    throw new PreflightError(
      `Host "${testIdentity.host}" is not in TEST_DATABASE_ALLOWED_HOSTS. ` +
        "Set that variable to an explicit list of hosts that may be destroyed by tests. " +
        "No connection was attempted.",
    );
  }

  const dbLower = testIdentity.database.toLowerCase();
  const dbAllowed = allowedDatabases.some((entry) => {
    if (entry === ALLOWLIST_UNCONFIGURED) return false;
    if (entry.startsWith("endswith:")) {
      return dbLower.endsWith(entry.slice("endswith:".length).toLowerCase());
    }
    return entry === dbLower;
  });
  if (!dbAllowed) {
    throw new PreflightError(
      `Database "${testIdentity.database}" is not in TEST_DATABASE_ALLOWED_NAMES. ` +
        "Exact names are supported, as is the `endswith:` prefix for randomly generated " +
        "disposable databases. No connection was attempted.",
    );
  }

  // Mandatory denylist. Never degrade a missing policy into an empty denylist.
  const deniedHosts = parseDeniedHosts(process.env.TEST_DATABASE_DENIED_HOSTS);
  if (deniedHosts === null) {
    throw new PreflightError(
      "TEST_DATABASE_DENIED_HOSTS is required but unset, empty, or whitespace-only. Refusing " +
        "to run integration tests without an explicit deny policy — an absent policy is not " +
        "consent. Set it to the comma-separated hostnames that must never be used.",
    );
  }

  // Port must be explicit: the default is never assumed, so the documented
  // non-default local port is unambiguous.
  if (!testIdentity.port) {
    throw new PreflightError(
      "TEST_DATABASE_URL must state an explicit port. The documented local setup uses 55432.",
    );
  }
  const portNumber = Number(testIdentity.port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new PreflightError("TEST_DATABASE_URL has a port outside the valid range 1-65535.");
  }

  // Loopback only. The intended integration setup is a disposable local
  // PostgreSQL instance, so a remote host is refused regardless of the
  // allowlists — adding an arbitrary remote host to an allowlist cannot enable
  // it. This is deliberately stricter than the allowlists.
  if (!isLoopbackHost(testIdentity.host)) {
    throw new PreflightError(
      `Host "${testIdentity.host}" is not a loopback address. Integration tests run only ` +
        "against a disposable local PostgreSQL instance (localhost, 127.0.0.0/8, or ::1). Remote " +
        "targets are refused even if they appear in the allowlists. No connection was attempted.",
    );
  }

  // A name suffix alone is not proof of isolation, so additionally reject
  // names that look like an application database even if an allowlist entry
  // was written too permissively.
  const APPLICATION_NAME_PATTERN =
    /(^|[_-])(prod|production|live|main|staging|shared|app)([_-]|$)/i;
  if (APPLICATION_NAME_PATTERN.test(testIdentity.database)) {
    throw new PreflightError(
      `Database name "${testIdentity.database}" matches an application/shared-database pattern. ` +
        "Refusing regardless of the allowlist. No connection was attempted.",
    );
  }

  // The ambient application host is denied too, derived at runtime so no
  // hostname is hardcoded and no credential is read.
  if (ambientIdentity) deniedHosts.add(normalizeHost(ambientIdentity.rawHost));
  if (deniedHosts.has(testIdentity.host)) {
    throw new PreflightError(
      `Host "${testIdentity.host}" is listed in TEST_DATABASE_DENIED_HOSTS and must never be ` +
        "used for integration tests. No connection was attempted.",
    );
  }

  // ---------------------------------------------------------------------
  // 4. Only now, with every purely local check passed, is a connection
  //    permitted.
  // ---------------------------------------------------------------------
  log(`Target: ${describeIdentity(testIdentity)} (credentials never logged).`);

  const { PrismaClient } = require("@prisma/client");
  const client = new PrismaClient({
    datasources: { db: { url: testUrl } },
    log: [],
  });

  try {
    const rows = await client.$queryRawUnsafe(
      "SELECT current_database() AS db, current_user AS usr, " +
        // `inet_server_addr()` returns the `inet` type, whose text form
        // carries a CIDR prefix ("127.0.0.1/32"). `host()` strips it so the
        // value is comparable against a bare hostname. Verified against a
        // live PostgreSQL 16 instance, where the bare cast returned
        // "127.0.0.1/32" and made every legitimate local run refuse.
        "host(inet_server_addr())::text AS host, inet_server_port() AS port",
    ) as Array<Record<string, unknown>>;
    const actual = rows && rows[0];
    if (!actual) {
      throw new PreflightError("Could not read identity from the target database.");
    }

const actualHost = String(actual.host ?? "").toLowerCase();
      const actualDb = String(actual.db ?? "").toLowerCase();

      if (!actualDb) {
        throw new PreflightError(
          "The server returned no database name; identity could not be verified. Refusing.",
        );
      }
      if (actualDb !== dbLower) {
        throw new PreflightError(
          `Connected to database "${actualDb}" but TEST_DATABASE_URL names "${testIdentity.database}". ` +
            "Refusing to run destructive suites.",
        );
      }

      // D2: the server's own port must match the port we validated. Previously
      // inet_server_port() was selected and then never read, so a URL naming
      // one port could land on another. Missing or non-numeric is a refusal,
      // never a silent skip.
      const rawPort = (actual as Record<string, unknown>).port;
      const actualPort = Number(rawPort);
      if (rawPort === null || rawPort === undefined || !Number.isInteger(actualPort)) {
        throw new PreflightError(
          "The server returned no usable port; identity could not be verified. Refusing.",
        );
      }
      const expectedPort = Number(testIdentity.port);
      if (!Number.isInteger(expectedPort)) {
        throw new PreflightError(
          "TEST_DATABASE_URL has no valid port to compare against. Refusing.",
        );
      }
      if (actualPort !== expectedPort) {
        throw new PreflightError(
          `Connected to port ${actualPort} but TEST_DATABASE_URL names port ${expectedPort}. ` +
            "Possible port forward or redirect. Refusing to run.",
        );
      }

      // D3: host verification is no longer skipped because the URL says
      // "localhost". The target must be loopback (enforced above), so the only
      // legitimate cases are that the server reports the expected loopback
      // address, or reports a different loopback address than the URL used
      // (for example URL "localhost" resolving to 127.0.0.1, or an IPv6 URL
      // reporting 127.0.0.1). Anything else — including an unavailable or
      // unexpected server address — is refused.
      if (!actualHost) {
        // Documented technical limitation: inet_server_addr() returns NULL for
        // a unix-domain-socket connection, which carries no host identity to
        // compare. That transport is not reachable here because D4 refuses any
        // URL that could request one (socket_path), so this branch means the
        // server could not report its address at all.
        throw new PreflightError(
          "The server did not report its address (inet_server_addr was empty), so host identity " +
            "could not be verified. Refusing to run destructive suites.",
        );
      }
      const normalizedActualHost = normalizeHost(actualHost);
      const expectedHost = testIdentity.host;
      const hostMatches =
        normalizedActualHost === expectedHost ||
        (isLoopbackHost(normalizedActualHost) && isLoopbackHost(expectedHost));
      if (!hostMatches) {
        throw new PreflightError(
          `Connected to server "${normalizedActualHost}" but TEST_DATABASE_URL names ` +
            `"${expectedHost}". Possible DNS alias or redirect. Refusing to run.`,
        );
      }

      log(
        `Verified identity: database="${actualDb}", server host="${normalizedActualHost}", ` +
          `port=${actualPort}.`,
      );

    // ---------------------------------------------------------------------
    // 5. Schema must be fully migrated.
    //    Without this, destructive deleteMany calls silently affect zero rows
    //    and suites would report false green results.
    // ---------------------------------------------------------------------
    const tableNames = physicalTableNames(readModelNamesFromSchema());
    const present = new Set<string>(
      (
        (await client.$queryRawUnsafe(
          "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()",
        )) as Array<{ tablename: string }>
      ).map((r) => String(r.tablename)),
    );

    const missingRequired = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missingRequired.length) {
      throw new PreflightError(
        `Test database is missing ${missingRequired.length} required table(s): ` +
          `${missingRequired.join(", ")}. Apply migrations with \`prisma migrate deploy\` ` +
          "(never `db push`, which would rewrite the migration chain).",
      );
    }

    // Every table declared in schema.prisma must exist physically. This is the
    // check that makes a partially-migrated database fail closed rather than
    // letting suites "pass" against zero rows.
    const missingDeclared = tableNames.filter((t) => !present.has(t));
    if (missingDeclared.length) {
      throw new PreflightError(
        `Test database is missing ${missingDeclared.length} table(s) declared in schema.prisma: ` +
          `${missingDeclared.slice(0, 12).join(", ")}${missingDeclared.length > 12 ? ", ..." : ""}. ` +
          "The database is not fully migrated.",
      );
    }

    log(
      `Schema verified: ${present.size} table(s) present, all ${tableNames.length} ` +
        `declared table(s) found. Ready.`,
    );
  } finally {
    // Read-only session: never leaves a transaction open, never writes.
    await client.$disconnect().catch(() => undefined);
  }
};
export {};

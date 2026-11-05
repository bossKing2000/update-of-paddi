/**
 * Live database identity verification — D2, D3, D4.
 *
 * DATABASE-FREE BY CONSTRUCTION
 * -----------------------------
 * `@prisma/client` is mocked so that a `PrismaClient` can be constructed but
 * never connects: `$queryRawUnsafe` returns a FABRICATED identity row supplied
 * per test, and `$disconnect` is a no-op. No socket is opened, no PostgreSQL
 * server is contacted, and no `.env` is read. The only thing that varies is the
 * row the "server" reports.
 *
 * Covers:
 *   - D2: inet_server_port() must match the validated URL port; missing or
 *     non-numeric port refuses.
 *   - D3: host identity is verified for every loopback form. Verification is no
 *     longer skipped because the URL says "localhost", and an empty reported
 *     address refuses rather than skips.
 *   - D4: any query string is refused by BOTH setup modules, keeping the two
 *         safety layers equivalent.
 */
import fs from "fs";
import path from "path";

const repoRoot = path.join(__dirname, "../..");

/** Fabricated identity rows the mocked server "reports". Mutable per test. */
let fakeRow: Record<string, unknown> = {};
/** Fabricated table names returned by the mocked pg_tables query. */
let fakeTables: string[] = [];
/** Every SQL string the mocked client was asked to run. */
const sqlSeen: string[] = [];
const constructed: Array<Record<string, unknown>> = [];
const disconnected = jest.fn();

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  return {
    ...actual,
    PrismaClient: jest.fn(() => {
      constructed.push({ ctor: true });
      return {
        // SQL-aware so the post-identity schema check also gets a fabricated
        // answer instead of throwing. No connection is ever opened.
        $queryRawUnsafe: jest.fn(async (sql: string) => {
          const text = String(sql);
          sqlSeen.push(text);
          if (text.includes("pg_tables")) {
            return fakeTables.map((t) => ({ tablename: t }));
          }
          // Only the exact identity projection returns an identity row. Any
          // other query shape gets no row, so a preflight that started asking
          // something unexpected could not be handed a successful identity by
          // default.
          if (text.includes("current_database()") && text.includes("inet_server_port()")) {
            return [fakeRow];
          }
          throw new Error(`BLOCKED: unexpected SQL reached the mocked client: ${text.slice(0, 80)}`);
        }),
        // Must return a promise: the preflight calls `.catch()` on it.
        $disconnect: jest.fn(async () => undefined),
      };
    }),
  };
});

const ENV_KEYS = [
  "TEST_DATABASE_URL",
  "DATABASE_URL",
  "TEST_DATABASE_ALLOWED_HOSTS",
  "TEST_DATABASE_ALLOWED_NAMES",
  "TEST_DATABASE_DENIED_HOSTS",
];

const VALID: Record<string, string> = {
  TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/t_ab",
  TEST_DATABASE_ALLOWED_HOSTS: "localhost,127.0.0.1,::1",
  TEST_DATABASE_ALLOWED_NAMES: "t_ab",
  TEST_DATABASE_DENIED_HOSTS: "db.example.com",
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

type Outcome = { kind: "ACCEPTED" | "CONFIG-REJECT" | "IDENTITY-REJECT" | "REACHED-CONNECTION"; error: string };

async function runPreflight(env: Record<string, string | undefined>): Promise<Outcome> {
  return withEnv(env, async () => {
    jest.resetModules();
    const pf = require("../../tests/setup/integrationPreflight");
    try {
      await pf();
      return { kind: "ACCEPTED", error: "" };
    } catch (e: any) {
      const name = e?.constructor?.name;
      if (name === "PreflightError") {
        // Live-identity refusals are worded distinctly from configuration refusals.
// Classify on those markers so a test can never pass for the wrong reason.
// PreflightError prefixes its message, so the marker must not be anchored.
const IDENTITY_MARKERS =
  /Connected to (port|database|server)|The server (returned|did not report)|TEST_DATABASE_URL has no valid port/;
return {
          kind: IDENTITY_MARKERS.test(String(e.message)) ? "IDENTITY-REJECT" : "CONFIG-REJECT",
          error: String(e.message),
        };
      }
      return { kind: "REACHED-CONNECTION", error: String(e.message) };
    }
  });
}

function runPin(env: Record<string, string | undefined>): { ok: boolean; error: string } {
  return withEnv(env, () => {
    jest.resetModules();
    const pin = require("../../tests/setup/pinTestDatabaseUrl");
    try {
      pin();
      return { ok: true, error: "" };
    } catch (e: any) {
      return { ok: false, error: String(e.message) };
    }
  });
}

function setRow(over: Record<string, unknown>) {
  fakeRow = { db: "t_ab", usr: "u", host: "127.0.0.1", port: 55432, ...over };
}

describe("live identity verification (D2 / D3 / D4)", () => {
  beforeEach(() => {
    sqlSeen.length = 0;
    setRow({});
    // Mirror the real schema so the post-identity schema check passes when the
    // identity checks pass. No database is involved: these are just strings.
    const schema = fs.readFileSync(path.join(repoRoot, "prisma/schema.prisma"), "utf8");
    const models = (schema.match(/^model\s+([A-Za-z0-9_]+)/gm) || []).map((m) => m.slice(6).trim());
    const mapped = (schema.match(/@@map\("([^"]+)"\)/g) || []).map((m) => m.slice(8, -2));
    fakeTables = [...new Set(models.concat(mapped))];
  });

  describe("D2 — the server port must match the validated URL port", () => {
    it("accepts when the reported port matches", async () => {
      setRow({ port: 55432 });
      const r = await runPreflight(VALID);
      expect(r.kind).toBe("ACCEPTED");
    });

    it("refuses when the reported port differs from the URL", async () => {
      setRow({ port: 5432 });
      const r = await runPreflight(VALID);
      expect(r.kind).toBe("IDENTITY-REJECT");
      expect(r.error).toMatch(/Connected to port 5432 .*names port 55432/);
    });

    it("refuses when the port is missing", async () => {
      setRow({ port: null });
      const r = await runPreflight(VALID);
      expect(r.kind).toBe("IDENTITY-REJECT");
      expect(r.error).toMatch(/no usable port/);
    });

    it("refuses when the port is not an integer", async () => {
      setRow({ port: "abc" });
      const r = await runPreflight(VALID);
      expect(r.kind).toBe("IDENTITY-REJECT");
      expect(r.error).toMatch(/no usable port/);
    });

    it("does not skip the port check when the URL uses localhost", async () => {
      const localhostUrl = "postgresql://u:p@localhost:55432/t_ab";
      setRow({ port: 55432 });
      expect((await runPreflight({ ...VALID, TEST_DATABASE_URL: localhostUrl })).kind).toBe("ACCEPTED");
      setRow({ port: 9999 });
      expect((await runPreflight({ ...VALID, TEST_DATABASE_URL: localhostUrl })).kind).toBe(
        "IDENTITY-REJECT",
      );
    });
  });

  describe("D3 — host identity is verified for every loopback form", () => {
    it("accepts a matching loopback address", async () => {
      setRow({ host: "127.0.0.1" });
      expect((await runPreflight(VALID)).kind).toBe("ACCEPTED");
    });

    it("accepts localhost resolving to 127.0.0.1", async () => {
      setRow({ host: "127.0.0.1" });
      const r = await runPreflight({ ...VALID, TEST_DATABASE_URL: "postgresql://u:p@localhost:55432/t_ab" });
      expect(r.kind).toBe("ACCEPTED");
    });

    it("accepts an IPv6 loopback URL reporting 127.0.0.1", async () => {
      setRow({ host: "127.0.0.1" });
      const r = await runPreflight({ ...VALID, TEST_DATABASE_URL: "postgresql://u:p@[::1]:55432/t_ab" });
      expect(r.kind).toBe("ACCEPTED");
    });

    it("accepts an IPv4 loopback URL reporting ::1", async () => {
      setRow({ host: "::1" });
      const r = await runPreflight({ ...VALID, TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/t_ab" });
      expect(r.kind).toBe("ACCEPTED");
    });

    it("accepts a mixed-case and trailing-dot URL host", async () => {
      setRow({ host: "127.0.0.1" });
      const r = await runPreflight({ ...VALID, TEST_DATABASE_URL: "postgresql://u:p@LOCALHOST.:55432/t_ab" });
      expect(r.kind).toBe("ACCEPTED");
    });

    it("REFUSES an empty reported address instead of skipping", async () => {
      setRow({ host: null });
      const r = await runPreflight(VALID);
      expect(r.kind).toBe("IDENTITY-REJECT");
      expect(r.error).toMatch(/did not report its address/);
    });

    it("refuses when the server reports a non-loopback address", async () => {
      setRow({ host: "203.0.113.10" });
      const r = await runPreflight(VALID);
      expect(r.kind).toBe("IDENTITY-REJECT");
      expect(r.error).toMatch(/DNS alias or redirect/);
    });

    it("no longer contains the isLocalTarget skip", () => {
      const src = fs.readFileSync(
        path.join(repoRoot, "tests/setup/integrationPreflight.ts"),
        "utf8",
      );
      expect(src).not.toContain("isLocalTarget");
      expect(src).not.toContain('actualHost || "local"');
    });
  });

  describe("D3 — database name identity", () => {
    it("refuses a database-name mismatch", async () => {
      setRow({ db: "some_other_db" });
      const r = await runPreflight(VALID);
      expect(r.kind).toBe("IDENTITY-REJECT");
      expect(r.error).toMatch(/Connected to database "some_other_db"/);
    });

    it("refuses an empty reported database name", async () => {
      setRow({ db: null });
      const r = await runPreflight(VALID);
      expect(r.kind).toBe("IDENTITY-REJECT");
      expect(r.error).toMatch(/no database name/);
    });
  });

  describe("D4 — query parameters are refused by both layers", () => {
    const queryUrls: Array<[string, string]> = [
      ["socket_path", "postgresql://u:p@127.0.0.1:55432/t_ab?socket_path=/var/run/postgresql"],
      ["options", "postgresql://u:p@127.0.0.1:55432/t_ab?options=-c%20statement_timeout%3D1"],
      ["sslmode", "postgresql://u:p@127.0.0.1:55432/t_ab?sslmode=disable"],
      ["schema", "postgresql://u:p@127.0.0.1:55432/t_ab?schema=public"],
    ];

    for (const [label, url] of queryUrls) {
      it(`pin refuses: ${label}`, () => {
        const r = runPin({ ...VALID, TEST_DATABASE_URL: url });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/must not contain query parameters/);
      });

      it(`preflight refuses: ${label}`, async () => {
        const r = await runPreflight({ ...VALID, TEST_DATABASE_URL: url });
        expect(r.kind).toBe("CONFIG-REJECT");
        expect(r.error).toMatch(/must not contain query parameters/);
      });
    }

    it("accepts a bare '?' with no parameters, which cannot redirect anything", () => {
      // URL.search is empty for a trailing '?', so there is no parameter to
      // reject. Asserted explicitly so the boundary is documented rather than
      // assumed.
      const url = "postgresql://u:p@127.0.0.1:55432/t_ab?";
      expect(new URL(url).search).toBe("");
      expect(runPin({ ...VALID, TEST_DATABASE_URL: url }).ok).toBe(true);
    });

    it("still accepts a plain URL", () => {
      expect(runPin(VALID).ok).toBe(true);
    });

    it("the refusal never echoes the parameter value", () => {
      const r = runPin({ ...VALID, TEST_DATABASE_URL: "postgresql://u:sekret@127.0.0.1:55432/t_ab?socket_path=/x" });
      expect(r.error).not.toContain("sekret");
      expect(r.error).not.toContain("postgresql://");
      expect(r.error).not.toContain("/var/run");
    });
  });

  describe("parity between the two safety modules", () => {
    // Configurations both layers must ACCEPT (preflight may still refuse later,
    // on live identity).
    const acceptable: Array<[string, Record<string, string>]> = [
      ["valid loopback", VALID],
      ["localhost form", { ...VALID, TEST_DATABASE_URL: "postgresql://u:p@localhost:55432/t_ab" }],
      ["ipv6 form", { ...VALID, TEST_DATABASE_URL: "postgresql://u:p@[::1]:55432/t_ab" }],
    ];
    // Configurations both layers must REFUSE, each with the exact reason.
    const refused: Array<[string, Record<string, string>, RegExp]> = [
      [
        "query params",
        { ...VALID, TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/t_ab?socket_path=/x" },
        /must not contain query parameters/,
      ],
      [
        "remote host",
        { ...VALID, TEST_DATABASE_URL: "postgresql://u:p@db.example.com:55432/t_ab", TEST_DATABASE_ALLOWED_HOSTS: "db.example.com" },
        /is not a loopback address/,
      ],
      [
        "no explicit port",
        { ...VALID, TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1/t_ab" },
        /must state an explicit port/,
      ],
      [
        "no password",
        { ...VALID, TEST_DATABASE_URL: "postgresql://127.0.0.1:55432/t_ab" },
        /does not include a password|has no password/,
      ],
      [
        "denylist unset",
        { TEST_DATABASE_URL: VALID.TEST_DATABASE_URL, TEST_DATABASE_ALLOWED_HOSTS: "127.0.0.1", TEST_DATABASE_ALLOWED_NAMES: "t_ab" },
        /TEST_DATABASE_DENIED_HOSTS is required/,
      ],
    ];

    for (const [label, env] of acceptable) {
      it(`both accept: ${label}`, async () => {
        const pin = runPin(env);
        const pf = await runPreflight(env);
        expect({ label, pinOk: pin.ok }).toEqual({ label, pinOk: true });
        // The preflight may still refuse later, on live identity; configuration
        // itself must have been accepted.
        expect(pf.kind).not.toBe("CONFIG-REJECT");
      });
    }

    for (const [label, env, reason] of refused) {
      it(`both refuse for the expected reason: ${label}`, async () => {
        const pin = runPin(env);
        const pf = await runPreflight(env);
        expect({ label, pinOk: pin.ok }).toEqual({ label, pinOk: false });
        expect(pf.kind).toBe("CONFIG-REJECT");
        // Assert the specific cause, not merely some other refusal.
        expect(pf.error).toMatch(reason);
        expect(pin.error).toMatch(reason);
      });
    }
  });

  describe("connection-free guarantees", () => {
    it("never reads .env and never imports dotenv", () => {
      const src = fs.readFileSync(
        path.join(repoRoot, "tests/setup/integrationPreflight.ts"),
        "utf8",
      );
      // Comments may mention dotenv; the code must not load it.
      expect(src).not.toMatch(/require\(["']dotenv["']\)/);
      expect(src).not.toMatch(/require\(["']dotenv\/config["']\)/);
      expect(src).not.toMatch(/from ["']dotenv/);
    });

    it("the mocked client was used, so no real PrismaClient connected", async () => {
      await runPreflight(VALID);
      expect(constructed.length).toBeGreaterThan(0);
    });
  });
});
/**
 * Batch 1C regression — PostgreSQL host identity representation.
 *
 * `inet_server_addr()` returns the `inet` type, so `::text` yields a CIDR value
 * ("127.0.0.1/32"). Observed on a live PostgreSQL 16 instance: the bare cast
 * made the preflight compare "127.0.0.1/32" against "127.0.0.1" and refuse
 * every legitimate local run. The query now uses `host(...)::text`.
 *
 * These tests assert the query shape AND the behaviour for both the bare and
 * the CIDR representation, with no database connection.
 */
describe("PostgreSQL host identity representation (Batch 1C)", () => {
  const VALID_ENV: Record<string, string> = {
    TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/t_ab",
    TEST_DATABASE_ALLOWED_HOSTS: "127.0.0.1,localhost",
    TEST_DATABASE_ALLOWED_NAMES: "t_ab",
    TEST_DATABASE_DENIED_HOSTS: "db.example.com",
  };

  it("queries the address through host() so no CIDR prefix is returned", async () => {
    setRow({ host: "127.0.0.1" });
    await runPreflight(VALID_ENV);
    const identitySql = sqlSeen.find((s) => s.includes("current_database()"));
    expect(identitySql).toBeDefined();
    expect(identitySql).toMatch(/host\(inet_server_addr\(\)\)::text/);
    // The bare cast must be gone.
    expect(identitySql).not.toMatch(/(^|[^.(])inet_server_addr\(\)::text/);
  });

  it("accepts the bare representation the corrected query returns", async () => {
    setRow({ host: "127.0.0.1" });
    expect((await runPreflight(VALID_ENV)).kind).toBe("ACCEPTED");
  });

  it("still refuses a CIDR value if one were ever returned (fail-closed)", async () => {
    // normalizeHost intentionally does NOT strip "/nn": an unexpected shape
    // must refuse rather than be silently accepted.
    setRow({ host: "127.0.0.1/32" });
    const r = await runPreflight(VALID_ENV);
    expect(r.kind).toBe("IDENTITY-REJECT");
    expect(r.error).toMatch(/DNS alias or redirect/);
  });

  it("refuses a remote address", async () => {
    setRow({ host: "203.0.113.10" });
    const r = await runPreflight(VALID_ENV);
    expect(r.kind).toBe("IDENTITY-REJECT");
    expect(r.error).toMatch(/DNS alias or redirect/);
  });

  it("refuses a remote address in CIDR form too", async () => {
    setRow({ host: "203.0.113.10/32" });
    expect((await runPreflight(VALID_ENV)).kind).toBe("IDENTITY-REJECT");
  });

  it("refuses a missing address", async () => {
    setRow({ host: null });
    const r = await runPreflight(VALID_ENV);
    expect(r.kind).toBe("IDENTITY-REJECT");
    expect(r.error).toMatch(/did not report its address/);
  });

  it("refuses a non-loopback IPv6 address", async () => {
    setRow({ host: "2001:db8::1" });
    expect((await runPreflight(VALID_ENV)).kind).toBe("IDENTITY-REJECT");
  });

  it("accepts IPv6 loopback in both representations", async () => {
    setRow({ host: "::1" });
    expect((await runPreflight(VALID_ENV)).kind).toBe("ACCEPTED");
    setRow({ host: "0:0:0:0:0:0:0:1" });
    expect((await runPreflight(VALID_ENV)).kind).toBe("ACCEPTED");
  });

  it("the worker pin and preflight agree on the same target", () => {
    // The pin performs no live query, so parity is about the URL-derived
    // identity both layers normalise identically.
    expect(runPin(VALID_ENV).ok).toBe(true);
    const src = fs.readFileSync(
      path.join(repoRoot, "tests/setup/pinTestDatabaseUrl.ts"),
      "utf8",
    );
    // The pin must not need a CIDR form; it derives the host from the URL.
    expect(src).not.toMatch(/inet_server_addr/);
  });
});

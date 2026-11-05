/**
 * Phase 2B.2 — migration target guard.
 *
 * The guard is pure (no I/O, no process.env reads of its own), so every case is
 * exercised by passing literal values. No database is contacted and no
 * environment variable or connection string is printed.
 */
import {
  checkMigrationTarget,
  readMigrationTargetConfig,
  isMigrationWriteOptedIn,
  normalizeHost,
  normalizeDatabaseName,
  isLoopbackHost,
  MIGRATION_OPT_IN_ENV,
  MIGRATION_OPT_IN_VALUE,
} from "../../src/services/migrationTargetGuard";

const LOOPBACK = "postgresql://user:secret@127.0.0.1:55434/foodpaddi_test";
const DENIED = "localhost,0.0.0.0";

describe("normalizeHost / isLoopbackHost", () => {
  it("lowercases, strips a root dot, and unwraps IPv6 brackets", () => {
    expect(normalizeHost("EXAMPLE.COM.")).toBe("example.com");
    expect(normalizeHost("[::1]")).toBe("::1");
  });

  it("recognises loopback only", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.5.5.5")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("db.example.com")).toBe(false);
  });
});

describe("checkMigrationTarget — fails closed", () => {
  it("refuses when DATABASE_URL is absent", () => {
    const r = checkMigrationTarget({ testDatabaseUrl: LOOPBACK, deniedHosts: DENIED });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MISSING_DATABASE_URL");
  });

  it("refuses when TEST_DATABASE_URL is absent (never guesses the target)", () => {
    const r = checkMigrationTarget({ databaseUrl: LOOPBACK, deniedHosts: DENIED });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MISSING_TEST_DATABASE_URL");
  });

  it("refuses when DATABASE_URL points at a different host than TEST_DATABASE_URL", () => {
    const r = checkMigrationTarget({
      databaseUrl: "postgresql://u:p@127.0.0.1:5599/foodpaddi_test",
      testDatabaseUrl: LOOPBACK,
      deniedHosts: DENIED,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("HOST_MISMATCH");
  });

  it("refuses the same host and port when the DATABASE NAME differs", () => {
    // Same server, different database: the write would land somewhere the
    // operator never authorised, so host/port agreement is not enough.
    const r = checkMigrationTarget({
      databaseUrl: "postgresql://u:p@127.0.0.1:55434/foodpaddi_dev",
      testDatabaseUrl: LOOPBACK,
      deniedHosts: DENIED,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("DATABASE_MISMATCH");
  });

  it("treats a Prisma ?schema= suffix as the same database", () => {
    const r = checkMigrationTarget({
      databaseUrl: `${LOOPBACK}?schema=public`,
      testDatabaseUrl: LOOPBACK,
      deniedHosts: DENIED,
    });
    expect(r).toEqual({ ok: true, host: "127.0.0.1", port: "55434" });
  });

  it("refuses a remote/production host", () => {
    const r = checkMigrationTarget({
      databaseUrl: "postgresql://u:p@db.prod.example.com:5432/foodpaddi",
      testDatabaseUrl: "postgresql://u:p@db.prod.example.com:5432/foodpaddi",
      deniedHosts: DENIED,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("NON_LOOPBACK_HOST");
  });

  it("refuses an implicit port", () => {
    const r = checkMigrationTarget({
      databaseUrl: "postgresql://u:p@127.0.0.1/foodpaddi_test",
      testDatabaseUrl: "postgresql://u:p@127.0.0.1/foodpaddi_test",
      deniedHosts: DENIED,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MISSING_PORT");
  });

  it("refuses when the deny list is unset", () => {
    const r = checkMigrationTarget({ databaseUrl: LOOPBACK, testDatabaseUrl: LOOPBACK });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MISSING_DENY_LIST");
  });

  it("refuses a host that is on the deny list", () => {
    const r = checkMigrationTarget({
      databaseUrl: "postgresql://u:p@localhost:55434/foodpaddi_test",
      testDatabaseUrl: "postgresql://u:p@localhost:55434/foodpaddi_test",
      deniedHosts: DENIED,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("HOST_DENIED");
  });

  it("refuses an unparsable URL", () => {
    const r = checkMigrationTarget({ databaseUrl: "not-a-url", testDatabaseUrl: LOOPBACK, deniedHosts: DENIED });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("URL_PARSE_FAILED");
  });
});

describe("checkMigrationTarget — accepts a verified disposable target", () => {
  it("accepts a loopback host with an explicit port", () => {
    const r = checkMigrationTarget({ databaseUrl: LOOPBACK, testDatabaseUrl: LOOPBACK, deniedHosts: DENIED });
    expect(r).toEqual({ ok: true, host: "127.0.0.1", port: "55434" });
  });

  it("accepts localhost (not denied) with an explicit port", () => {
    const url = "postgresql://u:p@localhost:6399/foodpaddi_test";
    const r = checkMigrationTarget({ databaseUrl: url, testDatabaseUrl: url, deniedHosts: "0.0.0.0" });
    expect(r.ok).toBe(true);
  });
});

describe("guard never leaks credentials or full URLs", () => {
  it("includes no password, user, or connection string in any message", () => {
    const secretUrl = "postgresql://admin:hunter2@10.1.2.3:5432/production";
    const r = checkMigrationTarget({
      databaseUrl: secretUrl,
      testDatabaseUrl: secretUrl,
      deniedHosts: DENIED,
    });
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("admin");
    expect(text).not.toContain("postgresql://");
  });
});

describe("normalizeDatabaseName — decoding never throws (review F-6)", () => {
  it("returns null for malformed percent-encoding instead of throwing", () => {
    // `decodeURIComponent("%zz")` throws URIError; the guard must not let that
    // escape as an unhandled exception.
    expect(() => normalizeDatabaseName("/%zz")).not.toThrow();
    expect(normalizeDatabaseName("/%zz")).toBeNull();
    expect(normalizeDatabaseName("/%E0%A4%A")).toBeNull();
  });

  it("returns an empty string for a missing or slash-only path", () => {
    expect(normalizeDatabaseName("")).toBe("");
    expect(normalizeDatabaseName("/")).toBe("");
  });

  it("decodes ordinary percent-encoded names", () => {
    expect(normalizeDatabaseName("/food%20paddi")).toBe("food paddi");
    expect(normalizeDatabaseName("/FoodPaddi")).toBe("foodpaddi");
  });

  it("a malformed path yields a structured refusal, not a throw", () => {
    const malformed = "postgresql://u:p@127.0.0.1:55434/%zz";
    let result: ReturnType<typeof checkMigrationTarget>;
    expect(() => {
      result = checkMigrationTarget({
        databaseUrl: malformed,
        testDatabaseUrl: malformed,
        deniedHosts: DENIED,
      });
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    if (!result!.ok) expect(result!.reason).toBe("URL_PARSE_FAILED");
  });

  it("a malformed path in only one URL is also refused", () => {
    const r = checkMigrationTarget({
      databaseUrl: "postgresql://u:p@127.0.0.1:55434/%zz",
      testDatabaseUrl: LOOPBACK,
      deniedHosts: DENIED,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("URL_PARSE_FAILED");
  });

  it("the refusal message echoes neither the URL nor credentials", () => {
    const r = checkMigrationTarget({
      databaseUrl: "postgresql://admin:hunter2@127.0.0.1:55434/%zz",
      testDatabaseUrl: "postgresql://admin:hunter2@127.0.0.1:55434/%zz",
      deniedHosts: DENIED,
    });
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(JSON.stringify(r)).not.toContain("postgresql://");
  });
});

describe("readMigrationTargetConfig", () => {
  it("reads the three documented variables from an env bag", () => {
    expect(
      readMigrationTargetConfig({
        DATABASE_URL: LOOPBACK,
        TEST_DATABASE_URL: LOOPBACK,
        TEST_DATABASE_DENIED_HOSTS: DENIED,
      }),
    ).toEqual({ databaseUrl: LOOPBACK, testDatabaseUrl: LOOPBACK, deniedHosts: DENIED });
  });

  it("returns undefined for absent variables rather than throwing", () => {
    expect(readMigrationTargetConfig({})).toEqual({
      databaseUrl: undefined,
      testDatabaseUrl: undefined,
      deniedHosts: undefined,
    });
  });
});

describe("write opt-in is separate from the target check", () => {
  it("requires the exact opt-in value, case-sensitively", () => {
    expect(isMigrationWriteOptedIn({ [MIGRATION_OPT_IN_ENV]: MIGRATION_OPT_IN_VALUE })).toBe(true);
    expect(isMigrationWriteOptedIn({ [MIGRATION_OPT_IN_ENV]: "YES" })).toBe(false);
    expect(isMigrationWriteOptedIn({ [MIGRATION_OPT_IN_ENV]: "1" })).toBe(false);
    expect(isMigrationWriteOptedIn({})).toBe(false);
  });
});
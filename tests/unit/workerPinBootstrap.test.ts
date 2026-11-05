/**
 * FIN-07-03c.12 — regression tests for the integration worker URL pin.
 *
 * THE DEFECT THESE LOCK DOWN
 * --------------------------
 * `pinTestDatabaseUrl.ts` exported its pinning function, and Jest was
 * configured with that file as a `setupFiles` entry. Jest IMPORTS setup files
 * but never CALLS their exports, so the pin never ran. Integration workers
 * therefore inherited an unset `DATABASE_URL`, `src/config/config.ts` ran
 * `dotenv.config()` and repopulated it from the APPLICATION `.env`, and the
 * 18 integration suites — which build `new PrismaClient()` with no
 * `datasourceUrl` — connected to the application database, where 163
 * `deleteMany` call sites execute. `integrationPreflight` still passed,
 * because it validates `TEST_DATABASE_URL` in the parent process and never
 * inspects worker environment.
 *
 * These tests prove the pin now EXECUTES on module load. Each case loads the
 * real bootstrap exactly the way Jest does — `require()` the registered
 * `setupFiles` module — and asserts on the resulting `process.env`. Nothing
 * here calls the pin by hand, because that is precisely the regression.
 *
 * Pure unit tests: no PostgreSQL, no Redis, no network.
 */
const APPLY_MODULE = "../../tests/setup/pinTestDatabaseUrl.apply";

const VALID_URL = "postgresql://tester:throwaway@127.0.0.1:55432/foodpaddi_test_ee11af05";
const ENV_KEYS = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "TEST_DATABASE_ALLOWED_HOSTS",
  "TEST_DATABASE_ALLOWED_NAMES",
  "TEST_DATABASE_DENIED_HOSTS",
] as const;

/** Load the bootstrap the way Jest does, returning the outcome. */
function loadBootstrap(
  env: Record<string, string | undefined>,
  probe?: () => void,
): {
  ok: boolean;
  error: string;
  databaseUrl: string | undefined;
} {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const previous = process.env.DATABASE_URL;
  try {
    for (const k of ENV_KEYS) {
      const v = env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    jest.resetModules();
    require(APPLY_MODULE); // <- the whole point: importing must be sufficient
    // Assert inside the sandbox, before the helper restores the environment.
    probe?.();
    return { ok: true, error: "", databaseUrl: process.env.DATABASE_URL };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), databaseUrl: process.env.DATABASE_URL };
  } finally {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

const ALLOW_HOSTS = "localhost,127.0.0.1";
const ALLOW_NAMES = "endswith:_test_ee11af05";
const DENIED = "localhost";

function validEnv(over: Record<string, string | undefined> = {}) {
  return {
    TEST_DATABASE_URL: VALID_URL,
    TEST_DATABASE_ALLOWED_HOSTS: ALLOW_HOSTS,
    TEST_DATABASE_ALLOWED_NAMES: ALLOW_NAMES,
    TEST_DATABASE_DENIED_HOSTS: DENIED,
    ...over,
  };
}

describe("integration worker pin — executes on module load", () => {
  it("installs DATABASE_URL merely by being imported (no caller)", () => {
    const r = loadBootstrap(validEnv());
    expect(r.error).toBe("");
    expect(r.ok).toBe(true);
    // The pin ran on its own.
    expect(r.databaseUrl).toBe(VALID_URL);
  });

  it("pins the authorized host, port and database before Prisma can initialize", () => {
    const r = loadBootstrap(validEnv());
    expect(r.ok).toBe(true);
    const u = new URL(r.databaseUrl!);
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.port).toBe("55432");
    expect(u.pathname.slice(1)).toBe("foodpaddi_test_ee11af05");
  });

  it("overwrites an ambient DATABASE_URL pointing at the application database", () => {
    const r = loadBootstrap(
      validEnv({ DATABASE_URL: "postgresql://app:secret@localhost:5432/foodpaddi" }),
    );
    // The worker must never keep the application target, even transiently.
    expect(r.databaseUrl).toBe(VALID_URL);
    expect(new URL(r.databaseUrl!).port).toBe("55432");
  });
});

describe("integration worker pin — fails closed", () => {
  it("refuses when TEST_DATABASE_URL is missing", () => {
    const r = loadBootstrap(validEnv({ TEST_DATABASE_URL: undefined }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/TEST_DATABASE_URL is not set/i);
  });

  it("refuses a database name outside the allowlist", () => {
    const r = loadBootstrap(
      validEnv({ TEST_DATABASE_URL: VALID_URL.replace("foodpaddi_test_ee11af05", "foodpaddi") }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/TEST_DATABASE_ALLOWED_NAMES/i);
  });

  it("refuses the default PostgreSQL port 5432 (the application database's)", () => {
    // The application server is reachable at 127.0.0.1 as well as localhost,
    // so the host denylist alone cannot stop a target on 5432.
    const r = loadBootstrap(validEnv({ TEST_DATABASE_URL: VALID_URL.replace(":55432/", ":5432/") }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/default PostgreSQL port 5432/i);
  });

  it("refuses a 5432 target even when its host and name are allow-listed", () => {
    const r = loadBootstrap(
      validEnv({
        TEST_DATABASE_URL: VALID_URL.replace(":55432/", ":5432/"),
        TEST_DATABASE_ALLOWED_HOSTS: "localhost,127.0.0.1",
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("refuses a non-loopback host even when allow-listed", () => {
    const r = loadBootstrap(
      validEnv({
        TEST_DATABASE_URL: VALID_URL.replace("127.0.0.1", "db.example.com"),
        TEST_DATABASE_ALLOWED_HOSTS: "localhost,127.0.0.1,db.example.com",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/loopback/i);
  });

  it("refuses the application database target explicitly", () => {
    const r = loadBootstrap(
      validEnv({
        TEST_DATABASE_URL: "postgresql://app:secret@localhost:55432/foodpaddi_test_ee11af05",
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("refuses when the host allowlist is missing", () => {
    const r = loadBootstrap(validEnv({ TEST_DATABASE_ALLOWED_HOSTS: undefined }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/TEST_DATABASE_ALLOWED_HOSTS/i);
  });

  it("refuses when the denylist is missing — an absent policy is not consent", () => {
    const r = loadBootstrap(validEnv({ TEST_DATABASE_DENIED_HOSTS: undefined }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/TEST_DATABASE_DENIED_HOSTS/i);
  });

  it("refuses a URL carrying no password (ambient PG* fallback)", () => {
    const r = loadBootstrap(
      validEnv({ TEST_DATABASE_URL: "postgresql://127.0.0.1:55432/foodpaddi_test_ee11af05" }),
    );
    expect(r.ok).toBe(false);
  });

  it("never leaks the credential into a failure message", () => {
    const r = loadBootstrap(validEnv({ TEST_DATABASE_ALLOWED_NAMES: "nothing-matches" }));
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("throwaway");
    expect(r.error).not.toContain("postgresql://");
  });
});

describe("application config cannot overwrite the pinned target", () => {
  it("survives a later dotenv.config() with override:false (the repo default)", () => {
    const r = loadBootstrap(validEnv(), () => {
      // Reproduce src/config/config.ts behaviour: dotenv defaults override:false,
      // so an already-populated DATABASE_URL is preserved.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dotenv = require("dotenv");
      dotenv.config({ override: false, path: "/nonexistent/.env" });
      expect(process.env.DATABASE_URL).toBe(VALID_URL);
    });
    expect(r.ok).toBe(true);
    expect(r.databaseUrl).toBe(VALID_URL);
  });

  it("installs the target before a Prisma client could be constructed", () => {
    // The suites call `new PrismaClient()` at module scope; Prisma resolves
    // process.env.DATABASE_URL at construction. Assert the pin has already run.
    const r = loadBootstrap(validEnv(), () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PrismaClient } = require("@prisma/client");
      const resolved = (process.env.DATABASE_URL ?? "").includes("55432");
      expect(resolved).toBe(true);
      expect(typeof PrismaClient).toBe("function");
    });
    expect(r.ok).toBe(true);
  });
});

describe("registered Jest configuration uses the invoking bootstrap", () => {
  it("jest.integration.config.js registers the apply file, not the inert module", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const cfg = fs.readFileSync(
      path.join(__dirname, "../../jest.integration.config.js"),
      "utf8",
    );
    expect(cfg).toContain("pinTestDatabaseUrl.apply.ts");
    // The inert module must no longer be the registered setup file.
    expect(cfg).not.toContain('"<rootDir>/tests/setup/pinTestDatabaseUrl.ts"');
  });

  it("defaultConfigGuard still recognises the gate by file name", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const cfg = fs.readFileSync(
      path.join(__dirname, "../../jest.integration.config.js"),
      "utf8",
    );
    // configHasGate() matches on the substring "pinTestDatabaseUrl".
    const setupFiles = cfg.match(/setupFiles:\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(setupFiles).toContain("pinTestDatabaseUrl");
    expect(cfg).toContain("integrationPreflight");
  });
});
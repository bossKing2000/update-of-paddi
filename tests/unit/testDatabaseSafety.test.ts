/**
 * Integration-test database gate — configuration-only verification.
 *
 * NOTHING HERE CONNECTS TO A DATABASE.
 *
 * `@prisma/client` is mocked at the module boundary with a PrismaClient
 * constructor that throws, so if any code path ever reached the connection
 * stage the test would fail loudly rather than opening a socket. Every
 * assertion below exercises purely local configuration validation, which runs
 * before the preflight constructs a client.
 *
 * Covers:
 *   - TEST_DATABASE_DENIED_HOSTS is mandatory (unset / empty / whitespace-only
 *     / malformed entries) in BOTH the preflight and the worker pin.
 *   - Hostname normalisation: case and trailing dots.
 *   - Loopback-only restriction — a remote host is refused even when it appears
 *     in the allowlists.
 *   - Explicit-port requirement and range validation.
 *   - Missing / malformed TEST_DATABASE_URL.
 *   - Error messages never contain a password or a full URL.
 *   - Both layers reach the same verdict for every fixture.
 */
import fs from "fs";
import path from "path";

const repoRoot = path.join(__dirname, "../..");

/* ── Hard stop: any attempt to construct a real client fails the suite ─────── */
const connectionAttempted = jest.fn(() => {
  throw new Error("BLOCKED: a test tried to construct a PrismaClient. These tests must never connect.");
});
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  return { ...actual, PrismaClient: jest.fn(() => connectionAttempted()) };
});

const pinSrc = fs.readFileSync(path.join(repoRoot, "tests/setup/pinTestDatabaseUrl.ts"), "utf8");
const preflightSrc = fs.readFileSync(path.join(repoRoot, "tests/setup/integrationPreflight.ts"), "utf8");

type Env = Record<string, string | undefined>;

const ENV_KEYS = [
  "TEST_DATABASE_URL",
  "DATABASE_URL",
  "TEST_DATABASE_ALLOWED_HOSTS",
  "TEST_DATABASE_ALLOWED_NAMES",
  "TEST_DATABASE_DENIED_HOSTS",
];

function withEnv<T>(env: Env, fn: () => T): T {
  const saved: Env = {};
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

async function withEnvAsync<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const saved: Env = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function runPin(env: Env): { ok: boolean; error: string } {
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

/**
 * Runs the preflight and classifies the outcome. Config refusals throw
 * PreflightError; anything else means execution reached the connection stage,
 * which the mocked PrismaClient turns into a throw. We only assert on
 * PreflightError messages, never on connection behaviour.
 */
async function runPreflight(env: Env): Promise<{ kind: string; error: string }> {
  return withEnvAsync(env, async () => {
    jest.resetModules();
    const pf = require("../../tests/setup/integrationPreflight");
    try {
      await pf();
      return { kind: "ACCEPTED", error: "" };
    } catch (e: any) {
      const name = e?.constructor?.name;
      if (name === "PreflightError") return { kind: "CONFIG-REJECT", error: String(e.message) };
      return { kind: "REACHED-CONNECTION", error: String(e.message) };
    }
  });
}

const VALID: Env = {
  TEST_DATABASE_URL: "postgresql://testuser:testpass@127.0.0.1:55432/foodpaddi_test_ab12cd",
  TEST_DATABASE_ALLOWED_HOSTS: "localhost,127.0.0.1",
  TEST_DATABASE_ALLOWED_NAMES: "endswith:_test_ab12cd",
  TEST_DATABASE_DENIED_HOSTS: "db.example.com",
};

describe("integration database gate — configuration only", () => {
  afterAll(() => {
    // Every construction must have thrown BLOCKED, i.e. no socket was opened.
    // Call count is expected to be non-zero: reaching the constructor is how
    // a *valid* configuration proves it passed the local checks.
    for (const call of connectionAttempted.mock.calls) expect(call).toEqual([]);
  });

  describe("TEST_DATABASE_DENIED_HOSTS is mandatory", () => {
    const unsetCases: Array<[string, string | undefined]> = [
      ["unset", undefined],
      ["empty string", ""],
      ["whitespace only", "   "],
      ["tabs and newlines", "\t\n "],
    ];

    for (const [label, value] of unsetCases) {
      it(`the pin refuses when it is ${label}`, () => {
        const r = runPin({ ...VALID, TEST_DATABASE_DENIED_HOSTS: value });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/TEST_DATABASE_DENIED_HOSTS is required/);
      });

      it(`the preflight refuses when it is ${label}`, async () => {
        const r = await runPreflight({ ...VALID, TEST_DATABASE_DENIED_HOSTS: value });
        expect(r.kind).toBe("CONFIG-REJECT");
        expect(r.error).toMatch(/TEST_DATABASE_DENIED_HOSTS is required/);
      });
    }

    it("an absent policy is not silently treated as an empty denylist", () => {
      const r = runPin({ ...VALID, TEST_DATABASE_DENIED_HOSTS: undefined });
      expect(r.ok).toBe(false);
      // The refusal must be about the missing policy, not about some other rule.
      expect(r.error).toMatch(/unset, empty, or whitespace-only/);
    });

    it("rejects malformed denylist entries", () => {
      for (const bad of ["https://host:5432", "host:5432", "host/path", "has space", "a,,b"]) {
        const r = runPin({ ...VALID, TEST_DATABASE_DENIED_HOSTS: bad });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/TEST_DATABASE_DENIED_HOSTS contains an (invalid entry|empty entry)/);
      }
    });
  });

  describe("hostname normalisation", () => {
    it("accepts a host that differs only by case and trailing dots", () => {
      const r = runPin({
        ...VALID,
        TEST_DATABASE_URL: "postgresql://testuser:testpass@LOCALHOST.:55432/foodpaddi_test_ab12cd",
        TEST_DATABASE_ALLOWED_HOSTS: "localhost",
      });
      expect(r.ok).toBe(true);
    });

    it("a denylist entry in mixed case still denies the lowercased target", () => {
      // Loopback target, so the denylist rule is what refuses it (the loopback
      // rule is evaluated first and would otherwise mask the denylist message).
      const r = runPin({
        ...VALID,
        TEST_DATABASE_DENIED_HOSTS: "LOCALHOST",
        TEST_DATABASE_URL: "postgresql://u:p@localhost:55432/t_ab",
        TEST_DATABASE_ALLOWED_HOSTS: "localhost,127.0.0.1",
        TEST_DATABASE_ALLOWED_NAMES: "t_ab",
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/listed in TEST_DATABASE_DENIED_HOSTS/);
    });

    it("rejects a trailing-dot denylist entry rather than normalising it away", () => {
      const r = runPin({ ...VALID, TEST_DATABASE_DENIED_HOSTS: "localhost." });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/contains an invalid entry/);
    });

    it("IPv6 loopback and 127.x variants are recognised as loopback", () => {
      const cases: Array<[string, string]> = [
        ["[::1]", "::1,localhost,127.0.0.1"],
        ["127.0.0.1", "localhost,127.0.0.1,::1"],
        ["127.1.2.3", "localhost,127.0.0.1,::1,127.1.2.3"],
        ["localhost", "localhost,127.0.0.1,::1"],
      ];
      for (const [host, allow] of cases) {
        const r = runPin({
          ...VALID,
          TEST_DATABASE_URL: `postgresql://u:p@${host}:55432/t_ab`,
          TEST_DATABASE_ALLOWED_HOSTS: allow,
          TEST_DATABASE_ALLOWED_NAMES: "t_ab",
        });
        expect({ host, ok: r.ok }).toEqual({ host, ok: true });
      }
    });
  });

  describe("loopback-only restriction", () => {
    const remotes = [
      "db.example.com",
      "render-host.example.com",
      "10.0.0.5",
      "192.168.1.10",
      "8.8.8.8",
      "0.0.0.0",
    ];

    for (const host of remotes) {
      it(`refuses ${host} even when allowlisted`, () => {
        const r = runPin({
          ...VALID,
          TEST_DATABASE_URL: `postgresql://u:p@${host}:55432/t_ab`,
          // Deliberately allowlist the remote host: it must still be refused.
          TEST_DATABASE_ALLOWED_HOSTS: `${host},localhost`,
          TEST_DATABASE_ALLOWED_NAMES: "t_ab",
          TEST_DATABASE_DENIED_HOSTS: "other.example.com",
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/not a loopback address/);
      });
    }

    it("the preflight applies the same loopback rule", async () => {
      const r = await runPreflight({
        ...VALID,
        TEST_DATABASE_URL: "postgresql://u:p@db.example.com:55432/t_ab",
        TEST_DATABASE_ALLOWED_HOSTS: "db.example.com",
        TEST_DATABASE_ALLOWED_NAMES: "t_ab",
      });
      expect(r.kind).toBe("CONFIG-REJECT");
      expect(r.error).toMatch(/not a loopback address/);
    });
  });

  describe("port validation", () => {
    it("refuses a URL with no explicit port", () => {
      const r = runPin({ ...VALID, TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1/t_ab" });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/must state an explicit port/);
    });

    it("refuses an out-of-range port", () => {
      const r = runPin({ ...VALID, TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:0/t_ab" });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/port outside the valid range|must state an explicit port/);
    });

    it("accepts the documented non-default local port", () => {
      const r = runPin({
        ...VALID,
        TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/t_ab",
        TEST_DATABASE_ALLOWED_NAMES: "t_ab",
      });
      expect(r.ok).toBe(true);
    });
  });

  describe("TEST_DATABASE_URL validity", () => {
    const bad: Array<[string, string | undefined]> = [
      ["absent", undefined],
      ["empty", ""],
      ["whitespace", "   "],
      ["not a url", "not-a-url"],
      ["wrong scheme", "https://u:p@127.0.0.1:55432/t_ab"],
      ["no database", "postgresql://u:p@127.0.0.1:55432/"],
      ["no password", "postgresql://127.0.0.1:55432/t_ab"],
    ];

    for (const [label, value] of bad) {
      it(`refuses when the URL is ${label}`, () => {
        const r = runPin({ ...VALID, TEST_DATABASE_URL: value });
        expect(r.ok).toBe(false);
      });
    }

    it("refuses an application-pattern database name even when allowlisted", () => {
      const r = runPin({
        ...VALID,
        TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/foodpaddi_production",
        TEST_DATABASE_ALLOWED_NAMES: "foodpaddi_production",
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/application\/shared-database pattern/);
    });
  });

  describe("credential-safe errors", () => {
    const secret = "sup3rs3cr3t";

    it("never echoes the password or a full URL on refusal", () => {
      const cases: Env[] = [
        { ...VALID, TEST_DATABASE_URL: `postgresql://u:${secret}@db.example.com:55432/t_ab`, TEST_DATABASE_ALLOWED_HOSTS: "db.example.com" },
        { ...VALID, TEST_DATABASE_URL: `postgresql://u:${secret}@127.0.0.1/t_ab` },
        { ...VALID, TEST_DATABASE_URL: `postgresql://u:${secret}@127.0.0.1:55432/foodpaddi_production`, TEST_DATABASE_ALLOWED_NAMES: "foodpaddi_production" },
        { ...VALID, TEST_DATABASE_DENIED_HOSTS: "127.0.0.1" },
        { ...VALID, TEST_DATABASE_DENIED_HOSTS: "http://x:5432" },
      ];
      for (const env of cases) {
        const r = runPin(env);
        expect(r.ok).toBe(false);
        expect(r.error).not.toContain(secret);
        expect(r.error).not.toContain("postgresql://");
      }
    });

    it("neither source interpolates a URL or password into a message", () => {
      for (const [name, src] of [
        ["pin", pinSrc],
        ["preflight", preflightSrc],
      ] as const) {
        expect({ name, has: /\$\{testUrl\}/.test(src) }).toEqual({ name, has: false });
        expect({ name, has: /\$\{identity\.password\}/.test(src) }).toEqual({ name, has: false });
      }
    });
  });

  describe("both safety layers agree", () => {
    const fixtures: Array<[string, Env]> = [
      ["denylist unset", { ...VALID, TEST_DATABASE_DENIED_HOSTS: undefined }],
      ["denylist whitespace", { ...VALID, TEST_DATABASE_DENIED_HOSTS: "  " }],
      ["denylist malformed", { ...VALID, TEST_DATABASE_DENIED_HOSTS: "host:5432" }],
      ["remote host allowlisted", { ...VALID, TEST_DATABASE_URL: "postgresql://u:p@db.example.com:55432/t_ab", TEST_DATABASE_ALLOWED_HOSTS: "db.example.com", TEST_DATABASE_ALLOWED_NAMES: "t_ab" }],
      ["no explicit port", { ...VALID, TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1/t_ab" }],
      ["production db name", { ...VALID, TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/foodpaddi_production", TEST_DATABASE_ALLOWED_NAMES: "foodpaddi_production" }],
      ["host not allowlisted", { ...VALID, TEST_DATABASE_ALLOWED_HOSTS: "elsewhere" }],
      ["db not allowlisted", { ...VALID, TEST_DATABASE_ALLOWED_NAMES: "something_else" }],
      ["allowlists unset", { ...VALID, TEST_DATABASE_ALLOWED_HOSTS: undefined, TEST_DATABASE_ALLOWED_NAMES: undefined }],
      ["no password", { ...VALID, TEST_DATABASE_URL: "postgresql://127.0.0.1:55432/t_ab" }],
      ["target itself denylisted", { ...VALID, TEST_DATABASE_DENIED_HOSTS: "127.0.0.1" }],
      ["uppercase host on a remote target", { ...VALID, TEST_DATABASE_URL: "postgresql://u:p@DB.EXAMPLE.COM:55432/t_ab", TEST_DATABASE_ALLOWED_HOSTS: "db.example.com", TEST_DATABASE_ALLOWED_NAMES: "t_ab" }],
    ];

    for (const [label, env] of fixtures) {
      it(`both layers refuse: ${label}`, async () => {
        const pin = runPin(env);
        const pf = await runPreflight(env);
        expect({ label, pinOk: pin.ok }).toEqual({ label, pinOk: false });
        expect({ label, kind: pf.kind }).toEqual({ label, kind: "CONFIG-REJECT" });
      });
    }

    it("both layers accept the same valid loopback configuration", async () => {
      const pin = runPin(VALID);
      const pf = await runPreflight(VALID);
      expect(pin.ok).toBe(true);
      // Preflight config passes, then proceeds; the mocked client blocks any
      // real connection. Either outcome proves configuration was accepted.
// Reaching this point means the preflight got past every local check.
        // It must then have stopped at the mocked constructor, so the outcome
        // is deterministic: a real client must never appear here.
        expect(pf.kind).toBe("REACHED-CONNECTION");
        // The mocked constructor must have thrown, proving no socket was opened.
        expect(pf.error).toMatch(/BLOCKED: a test tried to construct a PrismaClient/);
        expect(connectionAttempted).toHaveBeenCalledTimes(1);
    });
  });
});
/**
 * Section 3 — IPv6 loopback normalization.
 *
 * Every IPv6 textual form of `::1` must be treated as loopback, and nothing
 * else may be. The policy is deliberately narrow: `fe80::1`, `::2` and
 * IPv4-mapped forms stay refused, so this cannot widen acceptance to a remote
 * address.
 */
describe("IPv6 loopback normalization (section 3)", () => {
  const LOOPBACK_FORMS = ["::1", "0:0:0:0:0:0:0:1", "0:0::1", "::0:1"];
  const NOT_LOOPBACK = ["::2", "fe80::1", "1::", "::ffff:7f00:1", "2001:db8::1"];

  const ALLOW = "localhost,127.0.0.1,::1,0:0:0:0:0:0:0:1,0:0::1,::0:1";
  const DENY = "db.example.com";

  function pinAccepts(url: string): boolean {
    return runPin({
      TEST_DATABASE_URL: url,
      TEST_DATABASE_ALLOWED_HOSTS: ALLOW,
      TEST_DATABASE_ALLOWED_NAMES: "t_ab",
      TEST_DATABASE_DENIED_HOSTS: DENY,
    }).ok;
  }

  for (const form of LOOPBACK_FORMS) {
    it(`accepts the IPv6 loopback form ${form}`, () => {
      expect(pinAccepts(`postgresql://u:p@[${form}]:55432/t_ab`)).toBe(true);
    });
  }

  for (const form of NOT_LOOPBACK) {
    it(`still refuses the non-loopback IPv6 form ${form}`, () => {
      expect(pinAccepts(`postgresql://u:p@[${form}]:55432/t_ab`)).toBe(false);
    });
  }

  it("the preflight applies the identical IPv6 loopback rule", async () => {
    const r = await runPreflight({
      TEST_DATABASE_URL: "postgresql://u:p@[0:0:0:0:0:0:0:1]:55432/t_ab",
      TEST_DATABASE_ALLOWED_HOSTS: ALLOW,
      TEST_DATABASE_ALLOWED_NAMES: "t_ab",
      TEST_DATABASE_DENIED_HOSTS: DENY,
    });
    // Configuration accepted: not refused at the config stage.
    expect(r.kind).not.toBe("CONFIG-REJECT");
  });

  it("the preflight still refuses a non-loopback IPv6 target at the config stage", async () => {
    const r = await runPreflight({
      TEST_DATABASE_URL: "postgresql://u:p@[fe80::1]:55432/t_ab",
      TEST_DATABASE_ALLOWED_HOSTS: `${ALLOW},fe80::1`,
      TEST_DATABASE_ALLOWED_NAMES: "t_ab",
      TEST_DATABASE_DENIED_HOSTS: DENY,
    });
    expect(r.kind).toBe("CONFIG-REJECT");
    expect(r.error).toMatch(/not a loopback address/);
  });

  it("both layers carry byte-identical IPv6 logic", () => {
    const read = (f: string) =>
      fs.readFileSync(path.join(repoRoot, "tests/setup", f), "utf8");
    const grab = (src: string, name: string) => {
      const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
      return m ? m[0] : "";
    };
    for (const name of ["expandIpv6", "isIpv6Loopback", "isLoopbackHost"]) {
      expect({ name, same: grab(read("pinTestDatabaseUrl.ts"), name) === grab(read("integrationPreflight.ts"), name) })
        .toEqual({ name, same: true });
    }
  });
});

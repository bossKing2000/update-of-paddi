/**
 * Task 7.30 — Jest configuration contract (DB-free).
 *
 * Static assertions about how the four Jest configs are wired together. Nothing
 * here loads `tests/setup/integrationPreflight.ts`, constructs a Prisma client,
 * or contacts Redis or PostgreSQL. The integration and Redis configs are read
 * as DATA — the same `require` the guards themselves perform — and only their
 * declared hook paths are inspected.
 *
 * These assertions pin the invariants that make `npm test` safe to run by
 * default; they do not, and cannot, prove the guards behave correctly at
 * runtime. That remains a separate, separately authorized runtime check.
 */
import fs from "fs";
import path from "path";

const repoRoot = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");
const cfg = (p: string) => require(path.join(repoRoot, p)) as Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-var-requires
describe("jest config contract", () => {
  describe("base config is unit-only by default", () => {
    const base = cfg("jest.config.js");

    it("matches unit tests only", () => {
      expect(base.testMatch).toEqual(["<rootDir>/tests/unit/**/*.test.ts"]);
    });

    it("cannot silently pass when no test matches a named path", () => {
      expect(base.passWithNoTests).toBe(false);
    });

    it("attaches both guard layers", () => {
      expect(String(base.globalSetup)).toContain("defaultConfigGuard");
      expect(base.setupFiles).toContain("<rootDir>/tests/setup/baseSetupGuard.ts");
    });

    it("does not attach the integration preflight itself", () => {
      expect(String(base.globalSetup)).not.toContain("integrationPreflight");
    });

    it("keeps its own testPathIgnorePatterns (a CLI flag would replace the array)", () => {
      expect(base.testPathIgnorePatterns).toEqual(["/node_modules/", "/dist/"]);
    });
  });

  describe("unit config inherits, and stays unit-only", () => {
    const unit = cfg("jest.unit.config.js");

    it("matches unit tests only", () => {
      expect(unit.testMatch).toEqual(["<rootDir>/tests/unit/**/*.test.ts"]);
    });

    it("carries the inherited guards (the doc comment records this explicitly)", () => {
      expect(unit.globalSetup).toBeDefined();
      expect(unit.setupFiles).toBeDefined();
      expect(unit.setupFiles).toContain("<rootDir>/tests/setup/baseSetupGuard.ts");
    });

    it("does not claim in its comment that no hooks are attached", () => {
      const src = read("jest.unit.config.js");
      expect(src).not.toMatch(/No globalSetup\s+and no setupFiles are attached/);
      expect(src).toMatch(/INHERITED, NOT EMPTY/);
    });

    it("retains testPathIgnorePatterns independently of the base spread", () => {
      expect(unit.testPathIgnorePatterns).toEqual(["/node_modules/", "/dist/"]);
      expect(unit.passWithNoTests).toBe(false);
    });

    it("excludes integration paths from its testMatch", () => {
      const [pattern] = unit.testMatch as string[];
      expect(pattern).not.toContain("integration");
      // The guard's own definition of "mentions integration".
      const mentionsIntegration = (p: string) =>
        p.replace(/\\/g, "/").toLowerCase().includes("integration") ||
        p.includes("tests/**") ||
        p === "**";
      expect(mentionsIntegration(pattern)).toBe(false);
    });
  });

  describe("integration config retains both safety layers", () => {
    const integration = cfg("jest.integration.config.js");

    it("matches only integration tests", () => {
      expect(integration.testMatch).toEqual(["<rootDir>/tests/integration/**/*.test.ts"]);
    });

    /**
     * Regression pin for the selection defect this config used to carry.
     *
     * `testMatch` above is RECURSIVE, so it also matched
     * tests/integration/redis/**. Those six suites are owned by
     * jest.redis-integration.config.js and need
     * setupFiles: ["<rootDir>/tests/setup/pinTestRedisUrl.apply.ts"] — the
     * fail-closed Redis gate. This config deliberately does not load it, so
     * selecting them here ran them UNGATED against an unpinned Redis client,
     * which produced real assertion failures plus cross-suite
     * "The client is closed" contamination.
     *
     * The fix is an entry in this config's OWN testPathIgnorePatterns, not a
     * narrower testMatch, because testMatch is CLI-overridable and is already
     * pinned above; and not in the base config, whose array is pinned too.
     */
    it("excludes the Redis subdirectory, which has its own config and its own pin", () => {
      const patterns = integration.testPathIgnorePatterns as string[];
      expect(patterns.some((p) => p.includes("tests/integration/redis"))).toBe(true);

      // The exclusion must not have been obtained by discarding anything else.
      expect(patterns).toContain("/node_modules/");
      expect(patterns).toContain("/dist/");
      expect(String(integration.globalSetup)).toContain("integrationPreflight");
      expect(integration.setupFiles).toContain("<rootDir>/tests/setup/pinTestDatabaseUrl.apply.ts");

      // And it must not have been "solved" by bolting the Redis pin onto the
      // PostgreSQL config. pinTestRedisUrl rewrites process.env.REDIS_URL,
      // which has no meaning for the PG suites; the two configs stay separate.
      expect(integration.setupFiles).not.toContain("<rootDir>/tests/setup/pinTestRedisUrl.apply.ts");
    });

    it("attaches the fail-closed preflight as globalSetup", () => {
      expect(String(integration.globalSetup)).toContain("integrationPreflight");
    });

    it("attaches the worker-side database URL pin as a setupFile", () => {
      expect(integration.setupFiles).toContain("<rootDir>/tests/setup/pinTestDatabaseUrl.apply.ts");
    });

    it("satisfies the parent guard's own configHasGate() predicate", () => {
      // Mirrors tests/setup/defaultConfigGuard.ts configHasGate().
      const globalSetup = String(integration.globalSetup ?? "");
      const setupFiles: unknown[] = Array.isArray(integration.setupFiles)
        ? integration.setupFiles
        : [];
      expect(globalSetup.includes("integrationPreflight")).toBe(true);
      expect(setupFiles.some((f) => String(f).includes("pinTestDatabaseUrl"))).toBe(true);
    });

    it("raises the timeout multi-step flows need", () => {
      expect(integration.testTimeout).toBeGreaterThanOrEqual(60000);
    });
  });

  describe("redis integration config keeps its own separate boundary", () => {
    const redis = cfg("jest.redis-integration.config.js");

    it("matches only the redis integration subdirectory", () => {
      expect(redis.testMatch).toEqual(["<rootDir>/tests/integration/redis/**/*.test.ts"]);
    });

    it("carries NO postgres preflight, by design", () => {
      expect(String(redis.globalSetup ?? "")).not.toContain("integrationPreflight");
    });

    it("registers the redis URL pin before the inherited guards, preserving order", () => {
      expect(redis.setupFiles[0]).toBe("<rootDir>/tests/setup/pinTestRedisUrl.apply.ts");
      expect(redis.setupFiles).toContain("<rootDir>/tests/setup/baseSetupGuard.ts");
      expect(redis.setupFiles.indexOf("<rootDir>/tests/setup/pinTestRedisUrl.apply.ts")).toBeLessThan(
        redis.setupFiles.indexOf("<rootDir>/tests/setup/baseSetupGuard.ts"),
      );
    });

    it("is distinguishable by basename, which both guards key on", () => {
      expect(path.basename(redis.displayName === "redis-integration" ? "jest.redis-integration.config.js" : "")).toBe(
        "jest.redis-integration.config.js",
      );
    });
  });

  describe("guard modules are wired for Jest 30's loader contract", () => {
    /**
     * Verified against installed Jest 30.4.2 source:
     *  - setupFiles  (jest-runner/build/index.js:222-225)
     *      const setupFile = runtime.requireModule(path);
     *      if (typeof setupFile === 'function') { await setupFile(); }
     *  - globalSetup (@jest/core/build/index.js:3174-3179)
     *      if (typeof globalModule !== 'function') throw new TypeError(...)
     *      await globalModule(globalConfig, projectConfig);
     *
     * Both loaders REQUIRE the module export to be the function itself. These
     * assertions pin that shape so a future refactor to `export default` or to a
     * namespace object fails here rather than silently disabling a guard.
     */
    it("baseSetupGuard exports the guard function as module.exports", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../setup/baseSetupGuard");
      expect(typeof mod).toBe("function");
    });

    it("baseSetupGuard keeps its pure helper attached for unit tests", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../setup/baseSetupGuard");
      expect(typeof mod.integrationSelectionReasons).toBe("function");
    });

    it("defaultConfigGuard exports the globalSetup function as module.exports", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../setup/defaultConfigGuard");
      expect(typeof mod).toBe("function");
    });

    it("defaultConfigGuard keeps its pure helpers attached", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../setup/defaultConfigGuard");
      expect(typeof mod.selectionOffenders).toBe("function");
      expect(typeof mod.selectionMatchesWhitelist).toBe("function");
    });

    it("baseSetupGuard does NOT self-invoke — Jest 30 calls the export", () => {
      // Requiring it under a safe argv must be a no-op and must not throw.
      // If the module ever gained a top-level invocation, this require would
      // execute it; the assertion below documents that the call belongs to Jest.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../setup/baseSetupGuard");
      expect(typeof mod).toBe("function");
      expect(read("tests/setup/baseSetupGuard.ts")).not.toMatch(/^\s*baseSetupGuard\(\);/m);
    });
  });
});
/**
 * Task 7.30 — the worker pin bootstrap is a SIDE-EFFECT module.
 *
 * `pinTestDatabaseUrl.apply.ts` must run at module-evaluation time. It is NOT
 * loaded here: requiring it would execute the pin, which throws when
 * TEST_DATABASE_URL is absent. These assertions inspect the source instead, so
 * they stay DB-free and environment-independent.
 */
describe("worker database pin bootstrap", () => {
  const src = read("tests/setup/pinTestDatabaseUrl.apply.ts");

  it("invokes the pin at module top level, not inside an exported function", () => {
    expect(src).toMatch(/^\s*pinTestDatabaseUrl\(\);/m);
  });

  it("invokes the default-port refusal before pinning", () => {
    const refuseAt = src.indexOf("refuseDefaultPostgresPort();");
    const pinAt = src.indexOf("pinTestDatabaseUrl();");
    expect(refuseAt).toBeGreaterThan(-1);
    expect(pinAt).toBeGreaterThan(refuseAt);
  });

  it("exports nothing, so Jest cannot mistake it for a callable setup file", () => {
    // Strip comments first: the file's WHY block quotes `module.exports = ...`
    // when describing the sibling pin module, and that prose must not be
    // mistaken for real code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/module\.exports\s*=/);
    expect(code).toMatch(/^\s*pinTestDatabaseUrl\(\);/m);
  });

  it("does not restate the disproved claim that Jest never calls setup exports", () => {
    expect(src).not.toMatch(/never CALLS a module's exported functions/);
  });

  it("leaves the fail-closed pin module itself unmodified in shape", () => {
    const pin = read("tests/setup/pinTestDatabaseUrl.ts");
    expect(pin).toMatch(/module\.exports\s*=\s*(async\s+)?function/);
  });

  it("is named so defaultConfigGuard's configHasGate() recognises it", () => {
    // configHasGate() matches setupFiles entries containing "pinTestDatabaseUrl".
    const setupFiles = cfg("jest.integration.config.js").setupFiles as string[];
    expect(setupFiles.some((f) => String(f).includes("pinTestDatabaseUrl"))).toBe(true);
  });
});

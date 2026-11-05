/**
 * Phase 1E.1 — `defaultConfigGuard` argv parsing.
 *
 * The parser previously consumed the token after ANY `--flag` as its value,
 * so a positional test path after a valueless flag such as `--runInBand`
 * vanished from the integration-path safety scan. These tests assert the
 * guard's actual decision (`selectionOffenders`: one entry per suspicious
 * flag value or positional path, empty when clean) across flag placements.
 *
 * Pure string inspection: no Jest run, no services, no side effects.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { selectionOffenders } = require("../setup/defaultConfigGuard") as {
  selectionOffenders: (argv: string[]) => string[];
};

export {};

const A = "tests/integration/orderSnapshotPersistence.test.ts";
const B = "tests/integration/cartItemOptionConstraint.test.ts";
const REDIS = "tests/integration/redis/phoneOtpRedis.integration.test.ts";
const UNIT = "tests/unit/phone.test.ts";

describe("selectionOffenders — positional discovery regardless of flag placement", () => {
  it("1. finds a single integration path immediately after --runInBand", () => {
    // The reported defect: this path used to be swallowed as --runInBand's value.
    const found = selectionOffenders(["--config", "jest.redis-integration.config.js", "--runInBand", A]);
    expect(found).toEqual([`test path ${A}`]);
  });

  it("2. finds two integration paths after --runInBand", () => {
    expect(selectionOffenders(["--config", "jest.redis-integration.config.js", "--runInBand", A, B])).toEqual([
      `test path ${A}`,
      `test path ${B}`,
    ]);
  });

  it("3. never treats boolean flags as value-taking, before or after positionals", () => {
    expect(selectionOffenders(["--runInBand", "--verbose", "--ci", "--silent", UNIT])).toEqual([]);
    expect(selectionOffenders([UNIT, "--silent", "--ci", "--bail"])).toEqual([]);
    expect(selectionOffenders(["--runInBand", A, "--silent"])).toEqual([`test path ${A}`]);
  });

  it("4. consumes documented values of value-taking flags exactly once", () => {
    expect(selectionOffenders(["--config", "jest.unit.config.js", "--runInBand", UNIT])).toEqual([]);
    expect(selectionOffenders(["-c", "jest.unit.config.js", UNIT])).toEqual([]);
    expect(selectionOffenders(["--maxWorkers", "2", UNIT])).toEqual([]);
    expect(selectionOffenders(["-w", "2", UNIT])).toEqual([]);
  });

  it("5. handles --flag=value syntax", () => {
    expect(selectionOffenders(["--testPathPattern=tests/unit", "--config=jest.unit.config.js"])).toEqual([]);
    expect(selectionOffenders(["--testPathPattern=tests/integration"])).toEqual([
      "--testpathpattern tests/integration",
    ]);
  });

  it("6. treats everything after -- as positional", () => {
    expect(selectionOffenders(["--config", "jest.unit.config.js", "--", A])).toEqual([`test path ${A}`]);
    expect(selectionOffenders(["--", UNIT])).toEqual([]);
  });

  it("7. refuses mixed unit and integration paths", () => {
    expect(selectionOffenders([UNIT, B])).toEqual([`test path ${B}`]);
  });

  it("8. finds an integration path hidden among several flags", () => {
    expect(
      selectionOffenders(["--config", "jest.unit.config.js", "--silent", "--ci", "--verbose", B, "--bail"]),
    ).toEqual([`test path ${B}`]);
  });

  it("9. fails closed on unknown, ambiguous, and wildcard selections", () => {
    // Unknown flags are valueless, so a following path stays visible...
    expect(selectionOffenders(["--frobnicate", B])).toEqual([`test path ${B}`]);
    // ...and bare wildcards are refused outright.
    expect(selectionOffenders(["--testPathPattern", "**"])).toEqual(["--testpathpattern **"]);
    expect(selectionOffenders(["tests/**"])).toEqual(["test path tests/**"]);
    // Task 7.30: `-t` / `--testNamePattern` filter by TEST NAME, not by path,
    // so they cannot pull an integration FILE into a run. The guard consumes
    // them via SINGLE_VALUE_FLAGS (so the value is never misread as a
    // positional test path) but deliberately does not scan them as file
    // selectors — see SELECTION_FLAGS in tests/setup/defaultConfigGuard.ts.
    // Scanning them refused legitimate unit invocations such as
    // `jest -t "integration"` for no safety benefit.
    expect(selectionOffenders(["-t", "integration"])).toEqual([]);
    expect(selectionOffenders(["-t", "phone otp"])).toEqual([]);
  });

  it("10. existing safe unit-test invocations keep working", () => {
    expect(selectionOffenders(["--config", "jest.unit.config.js", "--runInBand"])).toEqual([]);
    expect(selectionOffenders([])).toEqual([]);
    expect(selectionOffenders([UNIT])).toEqual([]);
  });

  it("scans values of newly covered selection flags", () => {
    // --runTestsByPath takes exact paths: without scanning its value, an
    // integration selection would vanish from the guard entirely.
    expect(selectionOffenders(["--runTestsByPath", B])).toEqual([`--runtestsbypath ${B}`]);
    expect(selectionOffenders(["--runTestsByPath", UNIT])).toEqual([]);
    expect(selectionOffenders(["--roots", "tests/integration"])).toEqual(["--roots tests/integration"]);
  });

  it("documents the consequence for redis-config positional runs", () => {
    // Phase 1E.2 policy: with parsing fixed, a redis-subdir path is VISIBLE
    // to the scan — and permitted, but ONLY under the dedicated Redis
    // integration configuration, whose suites carry their own runtime gate.
    // Everywhere else the same path is still refused.
    const argv = ["--config", "jest.redis-integration.config.js", "--runInBand", REDIS];
    expect(selectionOffenders(argv)).toEqual([]);
    expect(selectionOffenders(["--config", "jest.unit.config.js", "--runInBand", REDIS])).toEqual([
      `test path ${REDIS}`,
    ]);
    expect(selectionOffenders(["--runInBand", REDIS])).toEqual([`test path ${REDIS}`]);
  });

  it("redis-config policy: allows redis-subdir selections, refuses everything else", () => {
    const RC = "jest.redis-integration.config.js";
    const REFRESH_A = "tests/integration/redis/refreshRotationRedis.integration.test.ts";
    const REFRESH_B = "tests/integration/redis/refreshControllerRedis.integration.test.ts";
    const PG = "tests/integration/vendorStatusCas.test.ts";
    // Single OTP path, both refresh paths: allowed.
    expect(selectionOffenders(["--config", RC, "--runInBand", REDIS])).toEqual([]);
    expect(selectionOffenders(["--config", RC, "--runInBand", REFRESH_A, REFRESH_B])).toEqual([]);
    // PostgreSQL paths: refused with or without the Redis config...
    expect(selectionOffenders(["--config", RC, "--runInBand", PG])).toEqual([`test path ${PG}`]);
    expect(selectionOffenders(["--config", "jest.unit.config.js", "--runInBand", PG])).toEqual([
      `test path ${PG}`,
    ]);
    // ...as are mixed selections (the Redis member is fine; the PG one is not).
    expect(selectionOffenders(["--config", RC, "--runInBand", REDIS, PG])).toEqual([`test path ${PG}`]);
    // Ambiguous selections stay fail-closed even under the Redis config: a
    // bare directory could span PG-backed suites.
    expect(selectionOffenders(["--config", RC, "--runInBand", "tests/integration"])).toEqual([
      "test path tests/integration",
    ]);
    // A redis-subdir --testPathPattern is explicitly supported.
    expect(
      selectionOffenders(["--config", RC, "--testPathPattern", "tests/integration/redis/phoneOtp"]),
    ).toEqual([]);
    // Unknown config: nothing may select outside tests/unit.
    expect(selectionOffenders(["--config", "jest.evil.config.js", "--runInBand", REDIS])).toEqual([
      `test path ${REDIS}`,
    ]);
  });
});

/**
 * Phase 1E.2 — `baseSetupGuard` selection policy (worker layer).
 *
 * Mirrors the parent-process `defaultConfigGuard` decisions: the corrected
 * parser never lets positional paths hide behind valueless flags, and the
 * Redis-subdir exception applies only under the dedicated Redis integration
 * configuration. PostgreSQL integration selections always require the
 * preflight-backed config.
 *
 * Pure string inspection: no Jest run, no services, no side effects.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseGuard = require("../setup/baseSetupGuard") as {
  integrationSelectionReasons: (argv: string[]) => string[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parentGuard = require("../setup/defaultConfigGuard") as {
  selectionOffenders: (argv: string[]) => string[];
};

const { integrationSelectionReasons } = baseGuard;

export {};

const RC = "jest.redis-integration.config.js";
const REDIS = "tests/integration/redis/phoneOtpRedis.integration.test.ts";
const REFRESH_A = "tests/integration/redis/refreshRotationRedis.integration.test.ts";
const REFRESH_B = "tests/integration/redis/refreshControllerRedis.integration.test.ts";
const PG = "tests/integration/vendorStatusCas.test.ts";
const UNIT = "tests/unit/phone.test.ts";

describe("integrationSelectionReasons — parser never hides positionals", () => {
  it("finds an integration path after --runInBand", () => {
    expect(integrationSelectionReasons(["--config", "jest.unit.config.js", "--runInBand", PG])).toEqual([
      `test path ${PG}`,
    ]);
  });

  it("finds two integration paths after --runInBand", () => {
    expect(
      integrationSelectionReasons(["--config", "jest.unit.config.js", "--runInBand", PG, UNIT.replace("unit", "integration")]),
    ).toEqual([`test path ${PG}`, `test path ${UNIT.replace("unit", "integration")}`]);
  });

  it("treats unknown flags as valueless so neighbours stay visible", () => {
    expect(integrationSelectionReasons(["--frobnicate", PG])).toEqual([`test path ${PG}`]);
  });

  it("treats everything after -- as positional", () => {
    expect(integrationSelectionReasons(["--config", "jest.unit.config.js", "--", PG])).toEqual([
      `test path ${PG}`,
    ]);
  });

  it("leaves ordinary unit invocations alone", () => {
    expect(integrationSelectionReasons(["--config", "jest.unit.config.js", "--runInBand"])).toEqual([]);
    expect(integrationSelectionReasons([UNIT])).toEqual([]);
    expect(integrationSelectionReasons([])).toEqual([]);
  });
});

describe("integrationSelectionReasons — redis-config policy", () => {
  it("allows a single approved Redis path under the Redis config", () => {
    expect(integrationSelectionReasons(["--config", RC, "--runInBand", REDIS])).toEqual([]);
  });

  it("allows both refresh paths under the Redis config", () => {
    expect(integrationSelectionReasons(["--config", RC, "--runInBand", REFRESH_A, REFRESH_B])).toEqual([]);
  });

  it("refuses the same paths under the unit config and by default", () => {
    expect(integrationSelectionReasons(["--config", "jest.unit.config.js", "--runInBand", REDIS])).toEqual([
      `test path ${REDIS}`,
    ]);
    expect(integrationSelectionReasons(["--runInBand", REDIS])).toEqual([`test path ${REDIS}`]);
  });

  it("refuses PostgreSQL paths even under the Redis config", () => {
    expect(integrationSelectionReasons(["--config", RC, "--runInBand", PG])).toEqual([`test path ${PG}`]);
  });

  it("refuses mixed Redis and PostgreSQL selections", () => {
    expect(integrationSelectionReasons(["--config", RC, "--runInBand", REDIS, PG])).toEqual([
      `test path ${PG}`,
    ]);
  });

  it("keeps ambiguous selections fail-closed", () => {
    expect(integrationSelectionReasons(["--config", RC, "--runInBand", "tests/integration"])).toEqual([
      "test path tests/integration",
    ]);
  });
});

describe("both guards decide consistently", () => {
  const matrix: string[][] = [
    ["--config", RC, "--runInBand", REDIS],
    ["--config", RC, "--runInBand", REFRESH_A, REFRESH_B],
    ["--config", RC, "--runInBand", PG],
    ["--config", RC, "--runInBand", REDIS, PG],
    ["--config", "jest.unit.config.js", "--runInBand", REDIS],
    ["--config", "jest.unit.config.js", "--runInBand", PG],
    ["--config", "jest.unit.config.js", "--runInBand", UNIT],
    ["--runInBand", PG],
    ["--testPathPattern=tests/integration"],
  ];
  it.each(matrix)("parent and worker agree on %p", (...argv: string[]) => {
    expect(integrationSelectionReasons(argv)).toEqual(parentGuard.selectionOffenders(argv));
  });
});

/* ── Task 7.30: test-name patterns are NOT file selectors ────────────────── */
describe("integrationSelectionReasons — -t / --testNamePattern are name filters", () => {
  it("does not treat `-t <name containing integration>` as an integration selection", () => {
    expect(
      integrationSelectionReasons(["--config", "jest.unit.config.js", "-t", "integration"]),
    ).toEqual([]);
  });

  it("does not treat `--testNamePattern <name containing integration>` as a selection", () => {
    expect(
      integrationSelectionReasons([
        "--config",
        "jest.unit.config.js",
        "--testNamePattern",
        "integration",
      ]),
    ).toEqual([]);
  });

  it("still flags a genuine integration path passed alongside a name filter", () => {
    expect(
      integrationSelectionReasons(["--config", "jest.unit.config.js", "-t", "integration", PG]),
    ).toEqual([`test path ${PG}`]);
  });

  it("still flags --testMatch, which IS a file selector", () => {
    expect(
      integrationSelectionReasons([
        "--config",
        "jest.unit.config.js",
        "--testMatch",
        "**/tests/integration/**/*.test.ts",
      ]),
    ).toEqual(["--testmatch **/tests/integration/**/*.test.ts"]);
  });

  it("still flags --runTestsByPath with an integration path", () => {
    expect(
      integrationSelectionReasons(["--config", "jest.unit.config.js", "--runTestsByPath", PG]),
    ).toEqual(["--runtestsbypath " + PG]);
  });
});

describe("defaultConfigGuard selectionOffenders — same test-name policy", () => {
  const { selectionOffenders } = parentGuard;

  it("does not treat -t as an integration file selector", () => {
    expect(selectionOffenders(["--config", "jest.unit.config.js", "-t", "integration"])).toEqual([]);
  });

  it("does not treat --testNamePattern as an integration file selector", () => {
    expect(
      selectionOffenders(["--config", "jest.unit.config.js", "--testNamePattern", "integration"]),
    ).toEqual([]);
  });

  it("still flags a genuine integration positional path", () => {
    expect(selectionOffenders(["--config", "jest.unit.config.js", PG])).toEqual([`test path ${PG}`]);
  });

  it("still flags --testRegex", () => {
    expect(
      selectionOffenders(["--config", "jest.unit.config.js", "--testRegex", "integration/.*\\.ts$"]),
    ).toEqual(["--testregex integration/.*\\.ts$"]);
  });
});

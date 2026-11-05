/**
 * Default-configuration guard.
 *
 * Why this exists
 * ---------------
 * Batch 0.5 found that `jest.config.js` — the config Jest auto-discovers — was
 * safe only while nobody passed a flag. Because `testMatch` is CLI-overridable,
 * passing a `--testMatch` glob covering the integration directory selected all
 * 13 database-writing suites while the base config has no `globalSetup` and no
 * `setupFiles`, i.e. with no preflight and no worker pin at all.
 *
 * Design
 * ------
 * This module is the `globalSetup` of `jest.config.js`. It runs in the parent
 * process, before any worker starts, so anything it throws stops the run before
 * a suite module is loaded, a `beforeAll` runs, or a `PrismaClient` is built.
 *
 * The guard fails CLOSED ON AMBIGUITY. It does not try to prove that an
 * invocation is safe; it refuses whenever it cannot cheaply prove the
 * invocation stays inside the unit selection. The safe path (no selection
 * flags) is the normal path, so this costs nothing in ordinary use.
 *
 * Precise boundary — what this does NOT protect against
 * ---------------------------------------------------
 * The guard inspects `process.argv` and the configuration files it names. It is
 * therefore defeated by anything that changes what Jest runs *without* being
 * visible there. Deliberately out of scope, and NOT claimed as protected:
 *
 *   - `--globalSetup <file>` (replaces this guard, including the pin/preflight)
 *   - `--setupFiles <file>` (adds files; cannot remove the base guard)
 *   - `--config <file>` pointing at a config with no globalSetup, if that path
 *     cannot be read or is outside the repository
 *   - a `--config` file edited to remove `globalSetup`
 *   - `node`/`ts-node` execution of a suite, which bypasses Jest entirely
 *   - any future Jest feature that selects tests from a source not covered here
 *
 * The gate is a defence-in-depth layer, not a sandbox. The authoritative
 * protection for integration testing remains `npm run test:integration`, which
 * attaches BOTH the preflight and the worker pin.
 */

const KNOWN_SAFE_CONFIGS = [
  "jest.config.js",
  "jest.unit.config.js",
  "jest.integration.config.js",
  "jest.redis-integration.config.js",
];

/**
 * Batch 1D.39 (F4): configs that are allowed to select OUTSIDE tests/unit
 * without carrying the Postgres preflight, together with the ONLY testMatch
 * each is permitted to use.
 *
 * jest.redis-integration.config.js exists because the OTP Lua suite needs a
 * real Redis but no database, and coupling it to integrationPreflight would
 * mean it could only ever run on a machine that also has a validated test
 * Postgres. It carries no database-backed suite, and it has its own runtime
 * gate (tests/helpers/localRedisTarget.ts) that refuses to connect to
 * anything but a loopback, non-default, non-production Redis.
 *
 * This is deliberately NOT a blanket allowlist entry: the testMatch below is
 * asserted on every run, so editing the config to widen its selection fails
 * closed rather than silently unlocking the database suites.
 */
const CONFIG_SELECTION_WHITELIST: Record<string, RegExp> = {
  "jest.redis-integration.config.js": /^<rootDir>\/tests\/integration\/redis\/\*\*\/\*\.test\.ts$/,
};

/** Reads a repo config, or null when it cannot be read. */
function readConfig(configPath: string): Record<string, unknown> | null {
  try {
    const path = require("path") as typeof import("path");
    const fs = require("fs") as typeof import("fs");
    const repoRoot = path.resolve(__dirname, "..", "..");
    const absolute = path.isAbsolute(configPath)
      ? normalizePath(configPath)
      : path.resolve(repoRoot, configPath);
    if (!fs.existsSync(absolute)) return null;
    return require(absolute) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * True only when the config's testMatch consists solely of `allowed`.
 *
 * Exported so this decision can be unit-tested against fabricated configs
 * rather than by editing a file on disk. An absent or empty testMatch is a
 * REFUSAL: a config with no selection constraint must not inherit trust.
 */
function selectionMatchesWhitelist(
  config: Record<string, unknown> | null,
  allowed: RegExp,
): boolean {
  if (!config) return false;
  const raw = config.testMatch;
  const patterns: string[] = Array.isArray(raw)
    ? raw.map(String)
    : raw
      ? [String(raw)]
      : [];
  return patterns.length > 0 && patterns.every((p) => allowed.test(p));
}

/**
 * The dedicated Redis integration configuration. Its suites (tests/integration/redis/)
 * carry their own runtime gate (tests/helpers/localRedisTarget.ts), construct no
 * PrismaClient against the application database, and never touch PostgreSQL —
 * so positional selection confined to that directory does not need the Postgres
 * preflight. Everywhere else, integration selections still require it.
 */
const REDIS_CONFIG_BASE = "jest.redis-integration.config.js";

/**
 * True only for selections confined to the approved Redis integration-test
 * directory. Deliberately path-scoped, not name-scoped: a file is not exempt
 * merely because its name contains `redis`.
 */
function redisSubdirSelected(selection: string): boolean {
  const p = normalizePath(selection).toLowerCase();
  return p.includes("tests/integration/redis/") || p === "tests/integration/redis";
}

/** Flags that can change which tests are selected. */
const SELECTION_FLAGS = new Set([  "--testmatch",
  "--testregex",
  "--testpathpattern",
  "--testpathpatterns",
  "--selectprojects",
  "--projects",
  "-c",
  "--config",
  "--roots",
  "--runpathsbysuffix",
  // Selects tests by exact path: without this entry its value would be
  // consumed yet never scanned, hiding an integration selection.
  "--runtestsbypath",
  // Deliberately NOT here: `-t` / `--testNamePattern` filter by TEST NAME,
  // not by path, so they cannot select an integration FILE. They are consumed
  // via SINGLE_VALUE_FLAGS below (so their value is not misread as a positional
  // path) but never scanned as path selectors.
]);

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when a pattern could select something under tests/integration. */
function patternMentionsIntegration(pattern: string): boolean {
  const p = normalizePath(pattern).toLowerCase();
  if (!p) return false;
  return p.includes("integration") || p.includes("tests/**") || p === "**";
}

/** Flags that take exactly one separate value (never `--flag=value` form). */
const SINGLE_VALUE_FLAGS = new Set([
  "-c",
  "--config",
  // Test-name filters: consumed so their value is never mistaken for a
  // positional test path, but NOT scanned as path selectors.
  "-t",
  "--testnamepattern",
  "-w",
  "--maxworkers",
  "--rootdir",
  "--runtestsbypath", // selection-affecting; scanned via SELECTION_FLAGS
  "--testtimeout",
  "--cachedirectory",
  "--reporters",
]);

/** Flags that accept several consecutive values; every value is scanned. */
const MULTI_VALUE_FLAGS = new Set([
  "--testmatch",
  "--testregex",
  "--testpathpattern",
  "--testpathpatterns",
  "--roots",
  "--projects",
  "--selectprojects",
]);

/** Reads argv into a flag->value map plus positional args. */
function parseArgv(argv: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // Everything after a bare `--` is positional (Jest/yargs semantics).
    if (token === "--") {
      onlyPositional = true;
      continue;
    }
    if (onlyPositional || !token.startsWith("-") || token === "-") {
      positional.push(token);
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      flags.set(token.slice(0, eq).toLowerCase(), token.slice(eq + 1));
      continue;
    }
    const lower = token.toLowerCase();
    if (SINGLE_VALUE_FLAGS.has(lower) || MULTI_VALUE_FLAGS.has(lower)) {
      const multi = MULTI_VALUE_FLAGS.has(lower);
      const values: string[] = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith("-")) {
        values.push(argv[j]);
        j++;
        if (!multi) break;
      }
      flags.set(lower, values.join(" "));
      i = j - 1;
    } else {
      // Unknown or valueless flag: NEVER consume the next token. A positional
      // test path after a boolean flag such as `--runInBand` stays positional
      // and is judged on its own content — previously it was swallowed as the
      // flag's value and vanished from the safety scan. Erring here keeps
      // unknown flags' neighbours visible, which is the fail-closed direction.
      flags.set(lower, "");
    }
  }
  return { flags, positional };
}

/**
 * Does the given config file carry the real INTEGRATION gate?
 *
 * Presence of `globalSetup` + `setupFiles` is NOT sufficient: the base config
 * attaches these guards too, and mistaking them for the integration gate would
 * make this guard stand down exactly when it is needed. Require the preflight
 * and the worker pin specifically, by file name.
 */
function configHasGate(configPath: string): boolean {
  const cfg = readConfig(configPath);
  if (!cfg) return false;
  const globalSetup = String(cfg.globalSetup ?? "");
  if (!globalSetup.includes("integrationPreflight")) return false;

  const setupFiles: unknown[] = Array.isArray(cfg.setupFiles) ? cfg.setupFiles : [];
  return setupFiles.some((f) => String(f).includes("pinTestDatabaseUrl"));
}

module.exports = async function defaultConfigGuard(): Promise<void> {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgv(argv);

  // Resolve which config Jest will use.
  const configFlag = flags.get("--config") ?? flags.get("-c") ?? "";
  const configPath = configFlag || "jest.config.js";
  const baseName = normalizePath(configPath).split("/").pop() ?? configPath;

  // An unknown config outside the known set: we cannot prove anything about it.
  if (!KNOWN_SAFE_CONFIGS.includes(baseName)) {
    throw new Error(
      `[default-config-guard] Refusing to run with configuration "${configPath}". Only ` +
        `${KNOWN_SAFE_CONFIGS.join(", ")} are recognised. Use \`npm test\` for unit tests or ` +
        "`npm run test:integration` for database-backed tests.",
    );
  }

  const gatePresent = configHasGate(configPath);

  // If the selected config already attaches both safety layers, the run is
  // governed by those layers and this guard has nothing to add.
  if (gatePresent) return;

  // Batch 1D.39: a recognised config with no Postgres gate may select outside
  // tests/unit, but ONLY when its own testMatch is exactly the one pattern
  // this guard knows to be safe. Widening it fails closed.
  const whitelisted = CONFIG_SELECTION_WHITELIST[baseName];
  if (whitelisted && !selectionMatchesWhitelist(readConfig(configPath), whitelisted)) {
    throw new Error(
      `[default-config-guard] Refusing to run "${configPath}". This configuration has no Postgres ` +
        `preflight, so it may only select ${whitelisted.source}.`,
    );
  }

  // Otherwise the selection must provably stay inside tests/unit.
  const offenders = selectionOffenders(argv);

  if (offenders.length) {
    throw new Error(
      `[default-config-guard] Refusing to run: ${offenders.join(", ")} could select database-backed ` +
        "integration suites, but this configuration has no integration preflight and no worker pin.\n" +
        "Integration tests must run through `npm run test:integration`, which attaches both safety " +
        "layers. Unit-only runs need no flags: `npm test`.",
    );
  }
};

/**
 * Pure offender scan over an argv array (no process access): returns one entry
 * per flag value or positional path that could select tests/integration.
 * Exported so unit tests can assert the guard's actual decision — including
 * which paths it discovered — without spawning Jest.
 */
function selectionOffenders(argv: string[]): string[] {
  const { flags, positional } = parseArgv(argv);
  // The Redis exception applies only when the dedicated Redis integration
  // configuration is active. Under every other config (unit default,
  // Postgres integration, unknown) there is no change: any integration
  // selection is an offender.
  const configFlag = flags.get("--config") ?? flags.get("-c") ?? "";
  const configPath = configFlag || "jest.config.js";
  const redisActive =
    (normalizePath(configPath).split("/").pop() ?? configPath) === REDIS_CONFIG_BASE;
  const offenders: string[] = [];

  for (const [flag, value] of flags) {
    if (!SELECTION_FLAGS.has(flag)) continue;
    if (flag === "-c" || flag === "--config") continue; // handled above
    if (patternMentionsIntegration(value)) {
      if (redisActive && redisSubdirSelected(value)) continue;
      offenders.push(`${flag} ${value}`.trim());
    }
  }
  for (const p of positional) {
    if (patternMentionsIntegration(p)) {
      if (redisActive && redisSubdirSelected(p)) continue;
      offenders.push(`test path ${p}`);
    }
  }
  return offenders;
}

// Exported for unit testing of the F4 selection whitelist, which cannot be
// probed by mutating a config on disk (the guard re-requires it fresh after
// jest.resetModules()).
module.exports.selectionMatchesWhitelist = selectionMatchesWhitelist;
// Exported for unit testing of the argv parser: asserts the guard's actual
// decision and the exact positional paths it discovers.
module.exports.selectionOffenders = selectionOffenders;

export {};
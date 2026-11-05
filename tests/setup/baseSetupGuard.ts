/**
 * Worker-level guard — second layer for the Jest test gate.
 *
 * Why this exists
 * ---------------
 * `tests/setup/defaultConfigGuard.ts` runs as `globalSetup`. Jest lets a CLI
 * `--globalSetup <path>` REPLACE that value outright, so overriding it removes
 * the only parent-process guard. Combined with an integration `--testMatch`
 * override, that would select the database-writing integration suites with
 * neither the preflight nor the worker URL pin.
 *
 * No Jest hook is un-overridable: `globalSetup`, `setupFiles`,
 * `setupFilesAfterEnv`, `testRunner`, `testEnvironment` and `testSequencer`
 * can all be replaced from the CLI. This layer therefore does not "close" the
 * bypass — it makes a single-flag override insufficient. Getting past it now
 * requires overriding BOTH `globalSetup` and `setupFiles`.
 *
 * Why argv is a sound source here
 * -------------------------------
 * `setupFiles` runs inside the worker before the test module is required, and
 * at that point Jest has not injected its globals (`expect` is `undefined` and
 * no test path is reachable), but `process.argv` is inherited from the parent
 * and still carries the user's CLI arguments. That is what this guard reads.
 *
 * It is deliberately cheap and side-effect free: pure string inspection, no
 * module loading, no I/O, no network.
 *
 * Precise remaining boundary — NOT claimed as protected
 * -----------------------------------------------------
 *   - `--setupFiles <path>` overrides this guard too.
 *   - `--globalSetup <path>` together with `--setupFiles <path>` bypasses both.
 *   - `node` / `npx ts-node` execution of a suite bypasses Jest entirely.
 *   - `--listTests` does not execute `globalSetup` or `setupFiles`; it only
 *     enumerates paths. Discovery is not execution.
 *
 * Closing this properly needs an execution boundary outside Jest — a wrapper
 * binary, a container, or a separate process that owns the test run — not
 * another Jest hook.
 */

const SELECTION_FLAGS = new Set([
  "--testmatch",
  "--testregex",
  "--testpathpattern",
  "--testpathpatterns",
  "--selectprojects",
  "--projects",
  "--roots",
  // Selects tests by exact path: without this entry its value would be
  // consumed yet never scanned, hiding an integration selection.
  "--runtestsbypath",
  // Deliberately NOT here: `-t` / `--testNamePattern`. Those filter by TEST
  // NAME, not by path, so their value can never pull an integration FILE into a
  // run. Scanning them refused legitimate unit invocations such as
  // `jest -t "integration"` for no safety benefit. They are still listed in
  // SINGLE_VALUE_FLAGS below so their value is consumed rather than misread as
  // a positional test path.
]);

/**
 * The dedicated Redis integration configuration (mirrors
 * tests/setup/defaultConfigGuard.ts — keep the two in sync). Its suites carry
 * their own runtime gate, construct no PrismaClient against the application
 * database, and never touch PostgreSQL, so positional selection confined to
 * that directory needs no Postgres preflight. Everywhere else, integration
 * selections still require it.
 */
const REDIS_CONFIG_BASE = "jest.redis-integration.config.js";

/**
 * True only for selections confined to the approved Redis integration-test
 * directory. Path-scoped, not name-scoped: a file is not exempt merely
 * because its name contains `redis`.
 */
function redisSubdirSelected(selection: string): boolean {
  const p = (selection || "").replace(/\\/g, "/").toLowerCase();
  return p.includes("tests/integration/redis/") || p === "tests/integration/redis";
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

function patternMentionsIntegration(pattern: string): boolean {
  const p = (pattern || "").replace(/\\/g, "/").toLowerCase();
  if (!p) return false;
  return p.includes("integration") || p === "tests/**" || p === "**";
}

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
      // Unknown or valueless flag: never consume the next token. A positional
      // test path after a boolean flag such as `--runInBand` stays positional
      // and is judged on its own content. This is the fail-closed direction.
      flags.set(lower, "");
    }
  }
  return { flags, positional };
}

/**
 * Exported for testing. Pure: takes an argv array, returns the list of reasons
 * the run should be refused (empty means "nothing suspicious found"). The
 * active configuration is read from `--config`/`-c` (default jest.config.js):
 * only under the dedicated Redis integration configuration are selections
 * confined to tests/integration/redis/ permitted; PostgreSQL integration
 * paths still require the preflight-backed config.
 */
function integrationSelectionReasons(argv: string[]): string[] {
  const { flags, positional } = parseArgv(argv);
  const configFlag = flags.get("--config") ?? flags.get("-c") ?? "";
  const configPath = configFlag || "jest.config.js";
  const redisActive =
    (configPath.replace(/\\/g, "/").split("/").pop() ?? configPath) === REDIS_CONFIG_BASE;
  const offenders: string[] = [];
  for (const [flag, value] of flags) {
    if (!SELECTION_FLAGS.has(flag)) continue;
    if (flag === "-c" || flag === "--config") continue;
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

module.exports = function baseSetupGuard(): void {
  // Runs on EVERY unit test too, so it must be a no-op for ordinary runs.
  const reasons = integrationSelectionReasons(process.argv.slice(2));
  if (!reasons.length) return;
  throw new Error(
    `[base-setup-guard] Refusing to run: ${reasons.join(", ")} could select database-backed ` +
      "integration suites, but the worker safety guard has been overridden for this run.\n" +
      "Integration tests must run through `npm run test:integration`, which attaches both the " +
      "preflight and the worker URL pin. Unit-only runs need no flags: `npm test`.",
  );
};

module.exports.integrationSelectionReasons = integrationSelectionReasons;

export {};
/**
 * Jest `setupFiles` bootstrap that actually INVOKES the worker pin.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `pinTestDatabaseUrl.ts` is written as `module.exports = function
 * pinTestDatabaseUrl() {...}`, with the `process.env.DATABASE_URL = testUrl`
 * assignment inside that function. Under the INSTALLED Jest (30.4.2) a
 * `setupFiles` module whose export is a function IS called by the loader —
 * jest-runner/build/index.js does
 *   const setupFile = runtime.requireModule(path);
 *   if (typeof setupFile === 'function') { await setupFile(); }
 * — so registering `pinTestDatabaseUrl.ts` directly would also work today.
 *
 * This wrapper is nonetheless kept, for two reasons that do not depend on
 * loader behaviour:
 *   1. `tests/setup/defaultConfigGuard.ts`'s `configHasGate()` decides whether
 *      a configuration carries the real gate by looking for a setupFile whose
 *      name contains "pinTestDatabaseUrl". This file satisfies that check.
 *   2. It performs the work at module-evaluation time rather than relying on
 *      the loader calling an export, and it adds the default-port refusal
 *      (see below) without editing the exhaustively unit-tested pin module.
 *
 * It is deliberately a side-effect module: it calls the pin at import time and
 * exports nothing, so the pin is installed before any test module is required.
 *
 * The consequence had been severe: when the pin did not run, integration
 * workers inherited an unset `DATABASE_URL`, `src/config/config.ts` ran
 * `dotenv.config()` and repopulated it from the APPLICATION `.env`, and the
 * integration suites — which construct `new PrismaClient()` with no
 * `datasourceUrl` — connected to the application database, where `deleteMany`
 * call sites execute. `integrationPreflight` still passed, because it validates
 * `TEST_DATABASE_URL` in the parent process and never inspects the worker
 * environment. The gate reported success while the destructive suites targeted
 * production-shaped data.
 *
 * THE FIX
 * -------
 * `pinTestDatabaseUrl.ts` is left completely unchanged: its validation logic is
 * fail-closed and is exhaustively unit-tested in
 * `tests/unit/testDatabaseSafety.test.ts`, which calls the exported function
 * directly. Mutating that file to self-invoke would break those tests, which
 * `require()` it and then invoke the result themselves.
 *
 * Instead this file is the registered `setupFiles` entry. Jest loads it before
 * the test module is required, it calls the pin immediately, and the name
 * contains "pinTestDatabaseUrl" so
 * `tests/setup/defaultConfigGuard.ts`'s `configHasGate()` check keeps passing.
 *
 * ORDERING GUARANTEE
 * -------------------
 * Jest runs `setupFiles` to completion, in order, before requiring the test
 * file. Every integration suite constructs its Prisma client at module scope,
 * so the pinned URL is installed before any `dotenv.config()` call and before
 * any `new PrismaClient()` in every worker.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pinTestDatabaseUrl = require("./pinTestDatabaseUrl");

// Residual hole closed here (FIN-07-03c.12).
//
// `pinTestDatabaseUrl` validates the host against the denylist, the database
// name against the allowlist, and requires an explicit in-range port. It does
// NOT require a particular port. `TEST_DATABASE_DENIED_HOSTS=localhost` alone is
// therefore insufficient: the application database is equally reachable at
// 127.0.0.1, which the host allowlist normally permits, so a TEST_DATABASE_URL
// of `postgresql://…@127.0.0.1:5432/<allowed-name>` would satisfy both the
// preflight and the pin while landing every worker on the application server.
//
// The guard belongs in this bootstrap rather than in `pinTestDatabaseUrl.ts`,
// whose validation is exhaustively unit-tested in
// `tests/unit/testDatabaseSafety.test.ts`; changing it would rewrite those
// expectations. The disposable integration database must never sit on the
// PostgreSQL default port, which is also the port AGENTS.md bars for this
// workflow.
const DEFAULT_POSTGRES_PORT = "5432";

function refuseDefaultPostgresPort(): void {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !raw.trim()) return; // the pin below reports this properly
  let port: string;
  try {
    port = new URL(raw).port;
  } catch {
    return; // malformed URL: the pin below reports this properly
  }
  if (port === DEFAULT_POSTGRES_PORT) {
    throw new Error(
      "REFUSING TO PIN: TEST_DATABASE_URL names the default PostgreSQL port " +
        `${DEFAULT_POSTGRES_PORT}, which is the application database's port and is reachable ` +
        "at 127.0.0.1 as well as localhost. The disposable integration database must listen " +
        "on a non-default port.",
    );
  }
}

// Throws (fail-closed) on a missing/invalid target, which aborts the worker
// before any application config or Prisma client initializes. Error text names
// the failing condition only — never a credential or a complete URL.
refuseDefaultPostgresPort();
pinTestDatabaseUrl();

export {};
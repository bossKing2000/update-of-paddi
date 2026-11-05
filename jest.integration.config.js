const base = require("./jest.config.js");

/**
 * Integration test configuration — `npm run test:integration`.
 *
 * Selects ONLY suites under tests/integration. Unit suites are excluded by a
 * positive testMatch, so they cannot run here.
 *
 * Every suite in tests/integration constructs `new PrismaClient()` with no
 * datasource override, and prisma/schema.prisma declares:
 *
 *     datasource db { provider = "postgresql"  url = env("DATABASE_URL") }
 *
 * src/config/config.ts also calls `dotenv.config()`, which can load the
 * application's .env into process.env. Without the gate below, these suites
 * would run their deleteMany/create calls against whichever database
 * DATABASE_URL resolves to — possibly the shared application database.
 *
 * The gate has two parts, both required:
 *
 *   1. globalSetup -> tests/setup/integrationPreflight.ts
 *      Runs in the PARENT process, once, before any worker starts. Validates
 *      the target against explicit allowlists, verifies the live identity, and
 *      aborts the whole run if anything is wrong. No worker is ever started.
 *
 *   2. setupFiles -> tests/setup/pinTestDatabaseUrl.apply.ts
 *      Runs inside each WORKER, before the test module is required. Exports a
 *      function that pins process.env.DATABASE_URL to the validated
 *      TEST_DATABASE_URL, so the clients the suites actually construct resolve
 *      to the database that passed validation rather than to ambient config.
 *
 * Verified execution order, from Jest 30's own source:
 *   - globalSetup            parent process
 *   - setupFiles             jest-runner/build/index.js:217
 *   - setupFilesAfterEnv     jest-circus/build/runner.js:80
 *   - test module require    jest-circus/build/runner.js:94
 *   - beforeAll / destructive hooks
 */
module.exports = {
  ...base,
  displayName: "integration",
  testMatch: ["<rootDir>/tests/integration/**/*.test.ts"],
  // The glob above is RECURSIVE, so it also matched tests/integration/redis/**.
  // Those six suites are owned by jest.redis-integration.config.js and depend on
  // the Redis pin at tests/setup/pinTestRedisUrl.apply.ts being registered ahead
  // of them; this config deliberately does NOT register it, because pinning
  // process.env.REDIS_URL is that config's job and means nothing for the
  // PostgreSQL suites. Selecting them here ran them WITHOUT their fail-closed
  // Redis gate against an unpinned client, which produced real failures plus
  // cross-suite "The client is closed" contamination.
  //
  // The exclusion lives here, in the config file, because a CLI
  // --testPathIgnorePatterns flag REPLACES this array rather than merging into
  // it — the same reason the other entries are restated rather than inherited.
  //
  // NOTE: keep this comment free of a literal "setupFiles:" followed by "[".
  // tests/unit/workerPinBootstrap.test.ts scrapes the first
  // /setupFiles:\s*\[([^\]]*)\]/ match out of this file's raw text to assert the
  // guard is still nameable, so a comment shaped like a config assignment would
  // shadow the real one and fail that test.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "/tests/integration/redis/",
  ],
  passWithNoTests: false,
  globalSetup: "<rootDir>/tests/setup/integrationPreflight.ts",
  setupFiles: ["<rootDir>/tests/setup/pinTestDatabaseUrl.apply.ts"],
  // Integration suites perform multi-step business flows against a real
  // database and need far more than Jest's 5s default.
  testTimeout: 60000,
};
const base = require("./jest.config.js");

/**
 * Real-Redis integration tests (Batch 1D.39 / F4).
 *
 * Deliberately SEPARATE from jest.integration.config.js: the suites under
 * tests/integration are gated by tests/setup/integrationPreflight.ts, which
 * exists to protect a destructive POSTGRESQL database. The OTP Lua suite
 * needs no database at all, and coupling it to that gate would mean it could
 * only ever run on a machine that also has a validated test Postgres.
 *
 * This config has NO database preflight. It DOES register setupFiles (below).
 * The safety gate for
 * this suite lives in tests/helpers/localRedisTarget.ts and is enforced at
 * runtime by the suite itself, which FAILS (rather than skips) when the
 * target is not a proven local disposable Redis.
 *
 * Run with:
 *   OTP_TEST_REDIS_URL=redis://127.0.0.1:6399/15 npm run test:redis-integration
 *
 * It never falls back to the application's REDIS_URL.
 */
module.exports = {
  ...base,
  displayName: "redis-integration",
  // FIN-07-05e: Jest runs setupFiles to completion, in order, BEFORE it
  // requires any test module. Registering the pin first means src/lib/redis.ts
  // evaluates with a gate-validated disposable endpoint instead of throwing at
  // import time on a missing REDIS_URL. It calls the existing
  // evaluateDisposableRedisTarget gate unchanged and fails closed. Inherited
  // setup entries are preserved, in their original order, after it.
  setupFiles: [
    "<rootDir>/tests/setup/pinTestRedisUrl.apply.ts",
    ...(base.setupFiles || []),
  ],
  testMatch: ["<rootDir>/tests/integration/redis/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  passWithNoTests: false,
  testTimeout: 30000,
};
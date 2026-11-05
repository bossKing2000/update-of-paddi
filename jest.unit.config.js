const base = require("./jest.config.js");

/**
 * Unit test configuration — `npm test`.
 *
 * Selects ONLY suites under tests/unit, using a positive testMatch so a new
 * directory such as tests/integration can never be swept in by accident.
 *
 * INHERITED, NOT EMPTY: this config spreads the base config, so it also
 * inherits `globalSetup` (tests/setup/defaultConfigGuard.ts) and `setupFiles`
 * (tests/setup/baseSetupGuard.ts). Both are inherited deliberately and both are
 * inert for an ordinary unit run — they inspect argv and return without
 * throwing when nothing integration-shaped is selected. They are guards against
 * a CLI override widening the selection, NOT a sandbox: an invocation that
 * replaces both hooks can still reach the integration suites. The authoritative
 * protection for database tests remains `npm run test:integration`, which
 * attaches the preflight and the worker URL pin.
 *
 * No database connection is attempted from this configuration.
 */
module.exports = {
  ...base,
  displayName: "unit",
  testMatch: ["<rootDir>/tests/unit/**/*.test.ts"],
  // Explicitly retained from the base config. A CLI --testPathIgnorePatterns
  // flag REPLACES this array rather than merging into it, so these must live
  // here to survive any future CLI override.
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  passWithNoTests: false,
};
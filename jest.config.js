/**
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  // This base config is the DEFAULT that Jest auto-discovers. It is therefore
  // configured to be safe rather than convenient: it selects UNIT TESTS ONLY.
  //
  // Bare `npx jest`, `npx jest --config jest.config.js`, and
  // `npx jest <path-to-integration-file>` all resolve here. Because testMatch
  // cannot match tests/integration, none of those can execute a
  // database-writing suite. With passWithNoTests: false, naming an
  // integration path fails with exit code 1 rather than quietly running it.
  //
  // Integration tests are reachable ONLY through
  // jest.integration.config.js, which adds the matching testMatch plus the
  // two-part safety gate:
  //   1. globalSetup  -> tests/setup/integrationPreflight.ts
  //   2. setupFiles   -> tests/setup/pinTestDatabaseUrl.ts
  //
  // Both derived configs also keep their own copy of testPathIgnorePatterns,
  // because a CLI --testPathIgnorePatterns flag REPLACES that array instead of
  // merging into it.
  testMatch: ["<rootDir>/tests/unit/**/*.test.ts"],
  clearMocks: true,
  verbose: true,
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  passWithNoTests: false,
  // Refuses any invocation that could pull in tests/integration without the
  // integration preflight and worker pin. A CLI --testMatch override could
  // otherwise select all 13 database-writing suites under this base config,
  // which attaches neither layer. See tests/setup/defaultConfigGuard.ts for the
  // precise scope, including what this deliberately does not protect against.
  globalSetup: "<rootDir>/tests/setup/defaultConfigGuard.ts",
  // Second, independent layer. globalSetup alone is replaceable from the CLI
  // via --globalSetup; this one lives in a different hook, so a single-flag
  // override is no longer sufficient. It is a no-op for ordinary unit runs.
  // See tests/setup/baseSetupGuard.ts for the residual boundary.
  setupFiles: ["<rootDir>/tests/setup/baseSetupGuard.ts"],
};
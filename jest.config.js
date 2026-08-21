/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  clearMocks: true,
  verbose: true,
  // Unit tests should be self-contained and fast — no live DB/Redis
  // required. Integration tests that need real infra live under
  // tests/integration and are run separately (see tests/README.md).
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};

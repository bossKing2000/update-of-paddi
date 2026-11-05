/**
 * Structural guard for the Phase 1 auth error-logging remediation.
 *
 * `authErrorLogging.test.ts` proves the *behaviour* of four representative
 * handlers at runtime. This file proves the *shape* of the whole change, which
 * a runtime test cannot see:
 *
 *   1. All 10 migrated catch blocks call the shared logger with the error under
 *      the `err` key (so the allowlist serializer handles it).
 *   2. No raw error object is still passed to a console call anywhere in the
 *      controller — i.e. no `console.error(<err object>)` survives.
 *   3. The audited low-risk sites were deliberately left alone. This is the
 *      important negative assertion: the remediation must not creep into the
 *      message-only and already-masked sites, and must not add new logging.
 *
 * Source-scanning is the right tool here — it is deterministic, needs no module
 * mocking, and covers sites whose runtime harness would require a different
 * mock surface for every handler.
 */
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.join(__dirname, "../../src/controllers/auth.controller.ts"),
  "utf8",
);

/** The 10 catch blocks migrated in this batch, with their log message. */
const MIGRATED: Array<[handler: string, message: string]> = [
  ["forgotPassword", "forgotPassword failed"],
  ["getProfile", "getProfile failed"],
  ["selectRole", "selectRole failed"],
  ["verifyCode", "verifyCode failed"],
  ["verifyEmail", "verifyEmail failed"],
  ["googleLogin", "googleLogin failed"],
  ["createAddress", "createAddress failed"],
  ["getAllAddresses", "getAllAddresses failed"],
  ["updateAddress", "updateAddress failed"],
  ["deleteAddress", "deleteAddress failed"],
];

/**
 * Sites the audit classified low-risk and the brief explicitly excluded. If any
 * of these disappear or change, the change has exceeded its authorized scope.
 */
const LEFT_ALONE = [
  'console.error("Login error:", err.message);',
  'console.error("Refresh token error:", err.message);',
  'console.error("Logout error:", err.message);',
  'console.error("Secure reset password error:", err.message);',
  'console.error("[resendVerificationEmail]", err.message);',
  'console.error("[Google Token Verification Failed]", verr.message);',
  'console.log(\'Verify email called with token:\', \'***\');',
  'console.log("Invalid token format");',
  'console.log("No user found with this token");',
  'console.log(\'Email verified for user:\', \'***\');',
];

describe("auth.controller — migrated error logging (structural)", () => {
  /** Text immediately preceding a given log message, wide enough to clear a comment. */
  const before = (message: string) => {
    const idx = SRC.indexOf(`"${message}"`);
    expect(idx).toBeGreaterThan(-1);
    return SRC.slice(Math.max(0, idx - 400), idx);
  };

  it.each(MIGRATED)("%s logs its error through the shared logger under `err`", (_h, message) => {
    // exactly one occurrence: no duplicate log entries
    expect(SRC.split(`"${message}"`).length - 1).toBe(1);
    // the error object is passed under `err` for the allowlist serializer
    expect(before(message)).toMatch(/logger\.error\(\{\s*err(: error)?\s*[,}]/);
    // never interpolated into the message string
    expect(before(message)).not.toMatch(/logger\.error\(`|logger\.(error|warn)\([^)]*\$\{/);
  });

  it("does not replace errors with String(error)/message to dodge serialization", () => {
    for (const [, message] of MIGRATED) {
      expect(before(message)).not.toMatch(/String\((err|error)\)|\.(message|stack)\b/);
    }
  });

  it("leaves no raw error object on any console call", () => {
    const rawObjectCalls = SRC.match(
      /console\.(error|warn|log)\([^)]*,\s*(err|error)\s*\);|console\.error\((err|error)\);/g,
    );
    expect(rawObjectCalls ?? []).toEqual([]);
  });

  it.each(LEFT_ALONE)("preserves out-of-scope site: %s", (snippet) => {
    expect(SRC).toContain(snippet);
  });
});
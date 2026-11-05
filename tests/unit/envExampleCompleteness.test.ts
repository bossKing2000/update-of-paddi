/**
 * Phase 1F — environment/secrets requirements review.
 *
 * `src/config/config.ts` refuses to boot without a set of required
 * variables. `.env.example` is the operator's only local guide to that set,
 * so every hard-required key must be documented there. A missing entry
 * (previously `ENCRYPTION_KEY`) meant a fresh checkout copied from the
 * example crashed on boot with no guidance.
 *
 * The required-key list below mirrors the boot guards in
 * `src/config/config.ts`; if a guard is added there, add the key here too.
 * Key names only — this test never reads `.env` and asserts no values.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Boot guards: config.ts throws when any of these is missing (ENCRYPTION_KEY
// additionally requires exactly 32 characters). PHONE_OTP_SECRET is required
// in production.
const REQUIRED_KEYS = [
  "JWT_SECRET",
  "JWT_RESET_SECRET",
  "SERVER_URL",
  "CLOUDINARY_URL",
  "OPENSEARCH_NODE",
  "ENCRYPTION_KEY",
  "PHONE_OTP_SECRET",
];

function exampleKeys(): Set<string> {
  const file = path.resolve(__dirname, "..", "..", ".env.example");
  const parsed = dotenv.parse(fs.readFileSync(file, "utf8"));
  return new Set(Object.keys(parsed));
}

describe(".env.example documents every boot-required variable", () => {
  it.each(REQUIRED_KEYS)("documents %s", (key) => {
    expect(exampleKeys().has(key)).toBe(true);
  });

  it("documents ENCRYPTION_KEY alongside its 32-character requirement", () => {
    const file = path.resolve(__dirname, "..", "..", ".env.example");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(/^ENCRYPTION_KEY=/m);
    // The requirement, not a value: the example must carry no real secret.
    expect(text).toMatch(/32 characters/);
  });
});

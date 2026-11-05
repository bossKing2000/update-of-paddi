import crypto from "crypto";

/**
 * Digests for password-reset credentials at rest (Batch 1D.51).
 *
 * The six-character reset code and the reset JWT are bearer credentials: raw
 * values must never reach the database, where backups, replicas, admin
 * tooling, or an injection flaw elsewhere could expose them. Both are stored
 * as HMAC-SHA256 digests and compared by re-digesting the presented value.
 *
 * This mirrors `otpDigest` in src/services/phoneOtp.service.ts, but is a
 * separate function with its own domain separators rather than a new
 * `OtpPurpose`: reset credentials live in Postgres (not Redis), are keyed by
 * account email (not E.164 phone), and belong to the password-reset domain.
 *
 * Secret: callers pass `config.jwtResetSecret`, which config.ts requires at
 * startup in every environment — so there is no new configuration, no
 * fallback, and no silent-plaintext path. Reusing the reset domain's own
 * secret as an HMAC key is safe here because each digest input carries a
 * distinct domain prefix, keeping it separate from the JWT signatures cut
 * with the same secret.
 */

/** Domain separators keep the two digest kinds (and JWT signatures) apart. */
const CODE_DOMAIN = "password-reset-code";
const JWT_DOMAIN = "password-reset-jwt";

function hmacHex(secret: string, input: string): string {
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

/**
 * Canonical account identity for digest binding. The reset lookup itself is
 * unchanged (out of scope), but two textual spellings of one mailbox must
 * not produce different digests for the same code.
 */
function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** HMAC digest of a reset code, bound to the account's canonical email. */
export function resetCodeDigest(secret: string, email: string, code: string): string {
  return hmacHex(secret, `${CODE_DOMAIN}:${canonicalEmail(email)}:${code}`);
}

/**
 * True when `code` matches `storedDigest`. Timing-safe; any stored value
 * that is not a 64-hex digest (including legacy plaintext rows written
 * before digests existed) fails closed rather than throwing.
 */
export function resetCodeMatches(
  storedDigest: unknown,
  secret: string,
  email: string,
  code: string,
): boolean {
  if (typeof storedDigest !== "string") return false;
  const expected = resetCodeDigest(secret, email, code);
  const a = Buffer.from(storedDigest, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** HMAC digest of a reset JWT, so the bearer value never rests in the DB. */
export function resetJwtDigest(secret: string, jwt: string): string {
  return hmacHex(secret, `${JWT_DOMAIN}:${jwt}`);
}

/**
 * True when `jwt` matches `storedDigest`. Same fail-closed semantics as
 * `resetCodeMatches`: unknown shapes and legacy plaintext rows never match.
 */
export function resetJwtMatches(storedDigest: unknown, secret: string, jwt: string): boolean {
  if (typeof storedDigest !== "string") return false;
  const expected = resetJwtDigest(secret, jwt);
  const a = Buffer.from(storedDigest, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

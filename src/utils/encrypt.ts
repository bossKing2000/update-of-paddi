import crypto from "crypto";

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  // config.ts fails fast at boot when the key is missing/misshapen, so
  // this is a second line of defence for direct/CLI usage (e.g. ts-node
  // scripts that never import config).
  if (!raw || Buffer.from(raw).length !== 32) {
    throw new Error("ENCRYPTION_KEY must be set to exactly 32 characters");
  }
  return Buffer.from(raw);
}

/**
 * Detects the `ivHex:cipherHex` envelope produced by encrypt().
 * Anything else (legacy plaintext rows written before encryption existed,
 * NULL/empty) is NOT treated as encrypted.
 */
export function isEncryptedFormat(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = value.split(":");
  return parts.length === 2 && /^[0-9a-f]{32}$/.test(parts[0]) && /^[0-9a-f]+$/.test(parts[1]);
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

/**
 * Decrypts values written by encrypt(). Legacy plaintext rows pass through
 * unchanged instead of throwing a raw crypto error into payout flows —
 * callers (transfers, masked display) work with either form.
 */
export function decrypt(text: string): string {
  if (!isEncryptedFormat(text)) return text;
  const [ivHex, encryptedHex] = text.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    getKey(),
    Buffer.from(ivHex, "hex")
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString();
}

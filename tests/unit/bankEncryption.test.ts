/**
 * Bank encryption: round-trip, legacy passthrough, format detection.
 */
process.env.ENCRYPTION_KEY = "test-only-32-char-key-abcdef1234";

import { encrypt, decrypt, isEncryptedFormat } from "../../src/utils/encrypt";

describe("bank encryption", () => {
  it("round-trips an account number", () => {
    const enc = encrypt("0123456789");
    expect(enc).not.toBe("0123456789");
    expect(isEncryptedFormat(enc)).toBe(true);
    expect(decrypt(enc)).toBe("0123456789");
  });

  it("produces a fresh IV per call", () => {
    expect(encrypt("0123456789")).not.toBe(encrypt("0123456789"));
  });

  it("passes legacy plaintext through instead of throwing", () => {
    expect(isEncryptedFormat("0123456789")).toBe(false);
    expect(decrypt("0123456789")).toBe("0123456789");
    expect(isEncryptedFormat(null)).toBe(false);
    expect(isEncryptedFormat("")).toBe(false);
    expect(isEncryptedFormat("not:hex:at:all:extra")).toBe(false);
  });
});

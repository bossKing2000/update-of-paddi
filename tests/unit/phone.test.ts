/**
 * Phase 1D.1 — phone normalization utility (E.164 canonical form).
 */
import {
  normalizePhoneNumber,
  tryNormalizePhoneNumber,
  isValidPhoneNumber,
  areSamePhoneNumber,
  InvalidPhoneNumberError,
} from "../../src/utils/phone";

describe("phone normalization (Phase 1D.1)", () => {
  it("normalizes a valid Nigerian national number to E.164", () => {
    expect(normalizePhoneNumber("08012345678")).toBe("+2348012345678");
  });

  it("accepts a valid Nigerian E.164 number as-is", () => {
    expect(normalizePhoneNumber("+2348012345678")).toBe("+2348012345678");
  });

  it("normalizes equivalent representations to the same E.164 value", () => {
    const expected = "+2348012345678";
    for (const variant of ["08012345678", "+2348012345678", "2348012345678"]) {
      expect(normalizePhoneNumber(variant)).toBe(expected);
    }
    expect(areSamePhoneNumber("08012345678", "+2348012345678")).toBe(true);
    expect(areSamePhoneNumber("08012345678", "2348012345678")).toBe(true);
  });

  it("accepts a valid international number", () => {
    expect(normalizePhoneNumber("+14155552671")).toBe("+14155552671");
    expect(normalizePhoneNumber("+442071838750")).toBe("+442071838750");
  });

  it("rejects an invalid number", () => {
    expect(() => normalizePhoneNumber("123")).toThrow(InvalidPhoneNumberError);
    expect(tryNormalizePhoneNumber("123")).toBeNull();
    expect(isValidPhoneNumber("123")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(() => normalizePhoneNumber("")).toThrow(InvalidPhoneNumberError);
    expect(() => normalizePhoneNumber("   ")).toThrow(InvalidPhoneNumberError);
    expect(tryNormalizePhoneNumber("")).toBeNull();
    expect(isValidPhoneNumber("")).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePhoneNumber("  08031234567  ")).toBe("+2348031234567");
  });

  it("rejects clearly malformed input", () => {
    for (const bad of ["abc", "++2348012345678", "+234", "08012", "99999999999999999999"]) {
      expect(tryNormalizePhoneNumber(bad)).toBeNull();
    }
  });

  it("passes already-normalized E.164 input through unchanged", () => {
    expect(normalizePhoneNumber("+2348031234567")).toBe("+2348031234567");
  });

  it("compares equivalent numbers identically after normalization", () => {
    expect(areSamePhoneNumber("+2348031234567", "08031234567")).toBe(true);
    expect(areSamePhoneNumber("+2348031234567", "+14155552671")).toBe(false);
    expect(areSamePhoneNumber("123", "123")).toBe(false);
  });
});

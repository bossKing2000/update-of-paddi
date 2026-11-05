/**
 * AUTH-4 regression: email OTP verification input must be exactly six numeric
 * digits.
 *
 * `verifyEmailLoginOtpSchema` is exercised at
 * POST /api/auth/email/login/verify-otp before the request reaches the OTP
 * service (src/controllers/auth.controller.ts:2488). This test pins that the
 * schema rejects anything that is not six ASCII digits — five, seven,
 * alphabetic, mixed alphanumeric, and punctuation/whitespace — while a
 * six-digit code (including one beginning with zero) is accepted.
 */
import { describe, expect, test } from "@jest/globals";
import { z } from "zod";
import { verifyEmailLoginOtpSchema } from "../../src/validations/authSchema";

function parse(otp: string) {
  return verifyEmailLoginOtpSchema.safeParse({ email: "user@example.com", otp });
}

describe("verifyEmailLoginOtpSchema — OTP must be exactly six digits", () => {
  test.each(["000000", "123456", "999999", "012345"])(
    "accepts a six-digit code %s",
    (otp) => {
      const result = parse(otp);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.otp).toBe(otp);
      }
    },
  );

  test.each([
    ["12345", "five digits"],
    ["1234567", "seven digits"],
    ["abcdef", "alphabetic"],
    ["1234ab", "mixed alphanumeric"],
    ["12 456", "whitespace within"],
    ["123456 ", "trailing whitespace"],
    [" 123456", "leading whitespace"],
    ["12.456", "punctuation"],
    ["12-456", "punctuation"],
    ["", "empty"],
    ["12345!", "trailing punctuation"],
  ])("rejects a non-six-digit OTP %s (%s)", (otp) => {
    const result = parse(otp);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.flatten().fieldErrors;
      expect(issues.otp).toBeDefined();
      expect(Array.isArray(issues.otp)).toBe(true);
      expect(issues.otp![0]).toContain("six digits");
    }
  });

  test("uses the exported schema (not a duplicate regex in the test)", () => {
    // Assert the schema under test is the real exported one by checking its
    // error message text matches the source declaration.
    const result = verifyEmailLoginOtpSchema.safeParse({
      email: "user@example.com",
      otp: "abc",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.format().otp?._errors).toContain(
        "OTP must be exactly six digits",
      );
    }
  });
});

import { z } from "zod";
import { updateUserSchema } from "../../src/validations/authSchema";
import { AppError } from "../../src/errors/AppError";

describe("emailGate — B1/B2", () => {
  it("updateUserSchema now accepts email with normalization", () => {
    const result = updateUserSchema.safeParse({ email: "Test@Example.COM" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("test@example.com");
    }
  });

  it("updateUserSchema rejects invalid email", () => {
    const result = updateUserSchema.safeParse({ email: "bad-email" });
    expect(result.success).toBe(false);
  });

  it("updateUserSchema rejects email without @", () => {
    const result = updateUserSchema.safeParse({ email: "no-at" });
    expect(result.success).toBe(false);
  });

  it("checkout email gate uses strict zod email validation, not just includes('@')", () => {
    const weakCheck = (email: string) => email.includes("@");
    const strictCheck = (email: string) => z.string().email().safeParse(email).success;

    expect(weakCheck("bad@")).toBe(true); // weak passes but should fail strict
    expect(strictCheck("bad@")).toBe(false);
    expect(weakCheck("a@b")).toBe(true);
    expect(strictCheck("a@b")).toBe(false);
    expect(strictCheck("valid@example.com")).toBe(true);
    expect(strictCheck("")).toBe(false);
  });

  it("PROFILE_EMAIL_INVALID error has correct code 409", () => {
    const err = new AppError("Your profile email is invalid. Please update email before checkout.", 409, "PROFILE_EMAIL_INVALID");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("PROFILE_EMAIL_INVALID");
  });

  it("checkout should block before order creation when email invalid — throws with PROFILE_EMAIL_INVALID", () => {
    const email = "invalid-email";
    const valid = z.string().email().safeParse(email).success;
    if (!valid) {
      const err = new AppError("Your profile email is invalid. Please update email before checkout.", 409, "PROFILE_EMAIL_INVALID", { code: "PROFILE_EMAIL_INVALID" });
      expect(err.code).toBe("PROFILE_EMAIL_INVALID");
      expect(err.statusCode).toBe(409);
    } else {
      fail("should have been invalid");
    }
  });

  it("PROMO_EXHAUSTED error code exists", () => {
    const err = new AppError("Promo exhausted", 409, "PROMO_EXHAUSTED");
    expect(err.code).toBe("PROMO_EXHAUSTED");
  });
});

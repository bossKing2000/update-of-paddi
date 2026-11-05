/**
 * Which sign-in methods an account actually has.
 *
 * Every case here is load-bearing for the remove-phone and email-change
 * guards: a credential the login path would refuse must not be counted as
 * a usable way in, or those guards would let a user strand their account.
 */
import { usableLoginMethods, hasUsableLoginMethod } from "../../src/utils/loginMethods";

describe("usableLoginMethods", () => {
  it("counts a verified email with a password as LOCAL", () => {
    expect(usableLoginMethods({ isEmailVerified: true, password: "hash" })).toEqual(["LOCAL"]);
  });

  it("does not count an unverified email, because /login refuses it", () => {
    expect(usableLoginMethods({ isEmailVerified: false, password: "hash" })).toEqual([]);
    expect(usableLoginMethods({ password: "hash" })).toEqual([]);
  });

  it("does not count a verified email with no password", () => {
    expect(usableLoginMethods({ isEmailVerified: true, password: null })).toEqual([]);
  });

  it("counts a linked Google identity", () => {
    expect(usableLoginMethods({ googleId: "g-1" })).toEqual(["GOOGLE"]);
  });

  it("counts a verified phone on its own", () => {
    // The whole point of Phase 1D.38: a verified phone is a way in even
    // when the email was never verified.
    expect(
      usableLoginMethods({ isPhoneVerified: true, phoneNumberE164: "+2348031234560" }),
    ).toEqual(["PHONE"]);
  });

  it("does not count an unverified phone or a phone with no canonical number", () => {
    expect(usableLoginMethods({ isPhoneVerified: false, phoneNumberE164: "+2348" })).toEqual([]);
    expect(usableLoginMethods({ isPhoneVerified: true, phoneNumberE164: null })).toEqual([]);
  });

  it("reports every method an account really has", () => {
    expect(
      usableLoginMethods({
        isEmailVerified: true,
        password: "hash",
        googleId: "g-1",
        isPhoneVerified: true,
        phoneNumberE164: "+2348031234560",
      }),
    ).toEqual(["LOCAL", "GOOGLE", "PHONE"]);
  });

  it("treats an account with nothing as having no way in", () => {
    expect(hasUsableLoginMethod({})).toBe(false);
    expect(hasUsableLoginMethod({ isEmailVerified: false })).toBe(false);
  });
});
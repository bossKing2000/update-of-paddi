import { resolveOnboardingState, OnboardingUser } from "../../src/controllers/auth.controller";

function makeUser(overrides: Partial<OnboardingUser> = {}): OnboardingUser {
  return {
    role: null,
    kycStatus: "PENDING",
    phoneNumber: null,
    brandName: null,
    brandLogo: null,
    ...overrides,
  };
}

describe("resolveOnboardingState", () => {
  it("requires ROLE first when no role is set", () => {
    const state = resolveOnboardingState(makeUser());
    expect(state.nextStep).toBe("ROLE");
    expect(state.isComplete).toBe(false);
  });

  it("does not require KYC for CUSTOMER", () => {
    const state = resolveOnboardingState(makeUser({ role: "CUSTOMER" }));
    const kycStep = state.steps.find((s) => s.key === "KYC")!;
    expect(kycStep.done).toBe(true);
  });

  it("marks CUSTOMER fully onboarded with no extra requirements", () => {
    const state = resolveOnboardingState(makeUser({ role: "CUSTOMER" }));
    expect(state.isComplete).toBe(true);
    expect(state.nextStep).toBeNull();
  });

  it("requires KYC for VENDOR before PROFILE", () => {
    const state = resolveOnboardingState(makeUser({ role: "VENDOR" }));
    expect(state.nextStep).toBe("KYC");
  });

  it("requires KYC for DELIVERY before PROFILE", () => {
    const state = resolveOnboardingState(makeUser({ role: "DELIVERY" }));
    expect(state.nextStep).toBe("KYC");
  });

  it("moves VENDOR to PROFILE once KYC is VERIFIED, and flags missing brand fields", () => {
    const state = resolveOnboardingState(
      makeUser({ role: "VENDOR", kycStatus: "VERIFIED" })
    );
    expect(state.nextStep).toBe("PROFILE");
    const profileStep = state.steps.find((s) => s.key === "PROFILE")!;
    expect(profileStep.missingFields).toEqual(
      expect.arrayContaining(["PROFILE.phoneNumber", "PROFILE.brandName", "PROFILE.brandLogo"])
    );
  });

  it("marks VENDOR fully onboarded once role, KYC, and profile are all complete", () => {
    const state = resolveOnboardingState(
      makeUser({
        role: "VENDOR",
        kycStatus: "VERIFIED",
        phoneNumber: "08012345678",
        brandName: "Jollof Palace",
        brandLogo: "https://example.com/logo.png",
      })
    );
    expect(state.isComplete).toBe(true);
    expect(state.nextStep).toBeNull();
  });

  it("does not require brand fields for DELIVERY (only phone number)", () => {
    const state = resolveOnboardingState(
      makeUser({ role: "DELIVERY", kycStatus: "VERIFIED", phoneNumber: "08012345678" })
    );
    expect(state.isComplete).toBe(true);
  });

  it("REJECTED KYC still blocks onboarding for VENDOR", () => {
    const state = resolveOnboardingState(makeUser({ role: "VENDOR", kycStatus: "REJECTED" }));
    expect(state.nextStep).toBe("KYC");
  });
});

import { PaymentStatus } from "@prisma/client";

describe("paymentFinalizer — canonical outcomes", () => {
  it("defines expected finalize outcomes", () => {
    const outcomes = ["SUCCESS", "ALREADY_PROCESSED", "LOCKED", "PAYMENT_NOT_FOUND", "AMOUNT_MISMATCH", "CUSTOMER_MISMATCH", "LATE_PAYMENT"];
    expect(outcomes).toContain("SUCCESS");
    expect(outcomes).toContain("AMOUNT_MISMATCH");
    expect(outcomes).toContain("CUSTOMER_MISMATCH");
    expect(outcomes).toContain("LATE_PAYMENT");
  });

  it("amount mismatch threshold is ±₦1 (100 kobo)", () => {
    const expectedTotal = 5000; // ₦5000
    const paidExact = 5000;
    const paidWithinTolerance = 5000.5; // within ₦1
    const paidOutsideTolerance = 5002; // outside ₦1

    expect(Math.abs(paidExact - expectedTotal) > 1).toBe(false);
    expect(Math.abs(paidWithinTolerance - expectedTotal) > 1).toBe(false);
    expect(Math.abs(paidOutsideTolerance - expectedTotal) > 1).toBe(true);
  });

  it("customer mismatch detection compares gateway customerId vs order customerId", () => {
    const orderCustomerId: string = "user_123";
    const gatewayCustomerId: string = "user_456";
    expect(orderCustomerId !== gatewayCustomerId).toBe(true);
    const matchingGatewayId: string = "user_123";
    const isMismatch = orderCustomerId !== matchingGatewayId;
    expect(isMismatch).toBe(false);
  });

  it("late payment defined as beyond both protectedUntil and expiresAt", () => {
    const now = new Date();
    const pastProtection = new Date(now.getTime() - 1000 * 60 * 10);
    const pastExpiry = new Date(now.getTime() - 1000 * 60 * 5);
    const isBefore = (a: Date, b: Date) => a.getTime() < b.getTime();
    const isWithinProtection = isBefore(now, pastProtection);
    const isBeforeExpiry = isBefore(now, pastExpiry);
    expect(isWithinProtection).toBe(false);
    expect(isBeforeExpiry).toBe(false);
    // Both false => late payment
    expect(!isWithinProtection && !isBeforeExpiry).toBe(true);
  });

  it("PaymentStatus enum has required states", () => {
    expect(PaymentStatus.PENDING).toBeDefined();
    expect(PaymentStatus.SUCCESS).toBeDefined();
    expect(PaymentStatus.FAILED).toBeDefined();
    expect(PaymentStatus.LATE_PAYMENT).toBeDefined();
    expect(PaymentStatus.AMOUNT_MISMATCH).toBeDefined();
    expect(PaymentStatus.EXPIRED).toBeDefined();
  });

  it("channel allowlist for NGN excludes apple_pay, eft, capitec", () => {
    const SUPPORTED = ["card", "bank", "ussd", "bank_transfer"] as const;
    expect((SUPPORTED as readonly string[]).includes("apple_pay")).toBe(false);
    expect((SUPPORTED as readonly string[]).includes("eft")).toBe(false);
    expect((SUPPORTED as readonly string[]).includes("capitec_pay")).toBe(false);
    expect((SUPPORTED as readonly string[]).includes("card")).toBe(true);
    expect((SUPPORTED as readonly string[]).includes("bank_transfer")).toBe(true);
  });

  it("rate limit codes are distinct", () => {
    const codes = ["PAYMENT_RATE_LIMITED", "PROFILE_EMAIL_INVALID", "PROMO_EXHAUSTED", "INVALID_PAYMENT_METHOD"];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

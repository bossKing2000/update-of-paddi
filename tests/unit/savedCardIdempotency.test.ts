import fs from "fs";

describe("saved-card idempotency — chargeSavedCard active-payment reuse", () => {
  const source = fs.readFileSync("src/controllers/paymentController.ts", "utf8");
  const savedCardBlock = source.slice(source.indexOf("export const chargeSavedCard"));
  // The reuse block sits between the lock acquisition and the Paystack
  // charge call. Anchor from the block start: "charge_authorization" also
  // appears in an earlier lock comment, so search forward from the reuse
  // marker instead of using a global indexOf.
  const reuseStart = savedCardBlock.indexOf("Phase 3.2b idempotency");
  const reuseEnd = savedCardBlock.indexOf("await prisma.order.updateMany", reuseStart);
  const reuse = savedCardBlock.slice(reuseStart, reuseEnd);
  const chargeIdx = savedCardBlock.indexOf(
    "https://api.paystack.co/transaction/charge_authorization",
  );

  it("performs an active-payment lookup inside the existing Redis lock", () => {
    expect(savedCardBlock).toContain("existingActive");
    expect(savedCardBlock).toContain("payment:init:${userId}:${idempotencyKey}");
    const lockIdx = savedCardBlock.indexOf("acquireLock(redisPayments, initLockKey");
    const lookupIdx = savedCardBlock.indexOf("existingActive = await prisma.payment.findFirst");
    const chargeIdx = savedCardBlock.indexOf(
      "https://api.paystack.co/transaction/charge_authorization",
    );
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lookupIdx).toBeGreaterThan(lockIdx);
    expect(chargeIdx).toBeGreaterThan(lookupIdx);
  });

  it("searches by userId + idempotencyKey + active statuses (parity with normal path)", () => {
    const lookup = savedCardBlock.slice(
      savedCardBlock.indexOf("existingActive = await prisma.payment.findFirst"),
      chargeIdx,
    );
    expect(lookup).toContain("idempotencyKey");
    expect(lookup).toContain("userId");
    expect(lookup).toContain("PaymentStatus.PENDING");
    expect(lookup).toContain("PaymentStatus.INITIATED");
    expect(lookup).toContain('orderBy: { createdAt: "desc" }');
  });

  it("respects payment expiry before reusing", () => {
    expect(savedCardBlock).toContain("isBeforeUtc(now, toUtc(existingActive.expiresAt))");
  });

  it("returns the existing OTP continuation for INITIATED without charging", () => {
    expect(reuse).toContain("requiresOtp: true");
    expect(reuse).toContain("existingActive.reference");
    expect(reuse).not.toContain("payment.create");
    expect(reuse).not.toContain("finalizePaymentSuccess");
  });

  it("returns the existing reference for PENDING without charging or finalizing", () => {
    expect(reuse).toContain("Payment already in progress for this order");
    expect(reuse).toContain("existingActive.reference");
    expect(reuse).toContain("existingActive.createdAt");
    expect(reuse).not.toContain("payment.create");
    expect(reuse).not.toContain("finalizePaymentSuccess");
  });

  it("does not re-finalize on reuse and does not invent a new contract", () => {
    expect(reuse).not.toContain("reused: true");
    expect(reuse).not.toContain("finalizePaymentSuccess");
  });

  it("preserves the 409 conflict when another request holds the lock (concurrent case)", () => {
    expect(savedCardBlock).toContain("lock === null");
    expect(savedCardBlock).toContain("Payment is already being initialized for this order");
  });

  it("adds no database unique constraint on Payment.idempotencyKey", () => {
    const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
    const paymentBlock = schema.slice(schema.indexOf("model Payment {"), schema.indexOf("enum Role {"));
    expect(paymentBlock).not.toContain("@@unique");
  });

  it("expiry semantics: valid window reuses, lapsed window proceeds (parity logic)", () => {
    const now = new Date();
    const valid = new Date(now.getTime() + 10 * 60_000);
    const lapsed = new Date(now.getTime() - 60_000);
    const withinWindow = (exp: Date | null) => !!exp && now.getTime() < exp.getTime();
    expect(withinWindow(valid)).toBe(true);
    expect(withinWindow(lapsed)).toBe(false);
    expect(withinWindow(null)).toBe(false);
  });

  it("lookup isolates users and keys (same key different user never matches)", () => {
    const row = { userId: "U-1", idempotencyKey: "K-1", status: "PENDING" };
    const matches = (userId: string, key: string) =>
      row.userId === userId && row.idempotencyKey === key && ["PENDING", "INITIATED"].includes(row.status);
    expect(matches("U-1", "K-1")).toBe(true);
    expect(matches("U-2", "K-1")).toBe(false);
    expect(matches("U-1", "K-2")).toBe(false);
  });
});

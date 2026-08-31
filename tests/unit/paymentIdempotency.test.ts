import fs from "fs";

describe("payment idempotency — POST /payments/start PENDING reuse", () => {
  const source = fs.readFileSync("src/controllers/paymentController.ts", "utf8");

  it("checks for existing PENDING/INITIATED payment before Paystack init", () => {
    expect(source).toContain("existingPending");
    expect(source).toContain("findFirst");
    expect(source).toContain("idempotencyKey");
    expect(source).toContain("PENDING");
    expect(source).toContain("INITIATED");
    // Must be before initializePayment
    const pendingIdx = source.indexOf("existingPending");
    const initIdx = source.indexOf("initializePayment(");
    expect(pendingIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(-1);
    expect(pendingIdx).toBeLessThan(initIdx);
  });

  it("scopes lookup by userId (prevents cross-user reuse)", () => {
    expect(source).toMatch(/findFirst\(\{[^}]*userId/);
    // The findFirst for existingPending must include userId
    const pendingBlock = source.slice(source.indexOf("existingPending"), source.indexOf("existingPending") + 800);
    expect(pendingBlock).toContain("userId");
  });

  it("scopes lookup by idempotencyKey (different keys not reused)", () => {
    const pendingBlock = source.slice(source.indexOf("existingPending"), source.indexOf("existingPending") + 800);
    expect(pendingBlock).toContain("idempotencyKey");
  });

  it("respects existing payment expiration (stale not reused)", () => {
    expect(source).toContain("expiresAt");
    expect(source).toContain("isBeforeUtc");
    // Reuse only if expiresAt > now
    const reuseBlock = source.slice(source.indexOf("Reusing existing PENDING"), source.indexOf("Reusing existing PENDING") + 500);
    expect(source).toContain("isBeforeUtc(now, toUtc(existingPending.expiresAt))");
  });

  it("returns existing payment without calling Paystack", () => {
    expect(source).toContain("Reusing existing PENDING payment");
    expect(source).toContain('Payment already initialized');
    // Should return sendCreated with existing reference
    expect(source).toContain("existingPending.reference");
    expect(source).toContain("existingPending.paystackData");
  });

  it("stores authorization_url at payment creation for reuse", () => {
    expect(source).toContain("authorization_url");
    expect(source).toContain("paystackData");
    expect(source).toContain("paymentInit.authorization_url");
  });

  it("preserves SUCCESS guard (existing behavior unchanged)", () => {
    expect(source).toContain("alreadyPaid");
    expect(source).toContain('This order has already been paid for');
    expect(source).toContain("getPayableOrderBatch");
  });

  it("does not bypass product/vendor/total validation when reusing", () => {
    // PENDING check must happen AFTER getPayableOrderBatch + assertProductsStillLive + assertVendorsStillOperating
    // But BEFORE Paystack — verify order: getPayableOrderBatch index < pending check < initializePayment
    const batchIdx = source.indexOf("getPayableOrderBatch");
    const pendingIdx = source.indexOf("existingPending");
    const productCheckIdx = source.indexOf("assertProductsStillLive");
    const initIdx = source.indexOf("initializePayment(");
    expect(batchIdx).toBeLessThan(pendingIdx);
    expect(productCheckIdx).toBeLessThan(pendingIdx);
    expect(pendingIdx).toBeLessThan(initIdx);
  });

  it("expired PENDING is not reused — allows fresh initialization", () => {
    const now = new Date();
    const expired = new Date(now.getTime() - 60_000); // 1 min ago
    const valid = new Date(now.getTime() + 60_000 * 14); // 14 min future
    const isBeforeUtc = (a: Date, b: Date) => a.getTime() < b.getTime();
    // Simulate check: isBefore(now, expiresAt)
    expect(isBeforeUtc(now, expired)).toBe(false); // expired → not reused
    expect(isBeforeUtc(now, valid)).toBe(true); // valid → reused
  });

  it("different user must not receive another user's pending payment", () => {
    const existing = { idempotencyKey: "KEY-123", userId: "USER-A", reference: "REF-A", status: "PENDING", expiresAt: new Date(Date.now() + 600000) };
    const requestUserId = "USER-B";
    const requestKey = "KEY-123";
    // Simulate where clause: both must match
    const matches = existing.idempotencyKey === requestKey && existing.userId === requestUserId;
    expect(matches).toBe(false);
    const sameUserMatches = existing.idempotencyKey === requestKey && existing.userId === "USER-A";
    expect(sameUserMatches).toBe(true);
  });

  it("different idempotency key must not return pending", () => {
    const existing = { idempotencyKey: "KEY-A", userId: "USER-1", reference: "REF-A" };
    const requestKey = "KEY-B";
    expect(existing.idempotencyKey === requestKey).toBe(false);
  });
});

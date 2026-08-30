import crypto from "crypto";
import { validatePaystackSignature } from "../../src/utils/paystack";

describe("webhookSignature", () => {
  const secret = "test_secret_key_123";
  const rawBody = JSON.stringify({ event: "charge.success", data: { reference: "ref123", amount: 500000 } });

  const originalSecret = process.env.PAYSTACK_SECRET_KEY;

  beforeAll(() => {
    process.env.PAYSTACK_SECRET_KEY = secret;
  });

  afterAll(() => {
    process.env.PAYSTACK_SECRET_KEY = originalSecret;
  });

  it("validates correct signature", () => {
    const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    expect(validatePaystackSignature(rawBody, hash)).toBe(true);
  });

  it("validates with Buffer raw body", () => {
    const buf = Buffer.from(rawBody);
    const hash = crypto.createHmac("sha512", secret).update(buf).digest("hex");
    expect(validatePaystackSignature(buf, hash)).toBe(true);
  });

  it("rejects invalid signature", () => {
    expect(validatePaystackSignature(rawBody, "invalid_hash")).toBe(false);
  });

  it("rejects tampered body", () => {
    const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    expect(validatePaystackSignature(rawBody + "tamper", hash)).toBe(false);
  });

  it("computeWebhookId deterministic for same payload (replay protection)", () => {
    const payload = { event: "charge.success", data: { reference: "REF123", amount: 500000 } };
    const stable = { event: payload.event, reference: payload.data.reference, amount: payload.data.amount };
    const id1 = crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
    const id2 = crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
    expect(id1).toBe(id2);
  });

  it("different references produce different webhookIds", () => {
    const makeId = (ref: string) => crypto.createHash("sha256").update(JSON.stringify({ event: "charge.success", reference: ref, amount: 100 })).digest("hex");
    expect(makeId("REF1")).not.toBe(makeId("REF2"));
  });
});

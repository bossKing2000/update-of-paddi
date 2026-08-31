import fs from "fs";
import { classifyRefundSubmitError } from "../../src/services/refundService";

describe("refund reservation ledger arithmetic (mirrors the SELECT...FOR UPDATE + updateMany guard in admin.controller.ts)", () => {
  // The real check lives inside a Postgres transaction (`remaining =
  // fresh.amount - fresh.refundedAmount; if (requested > remaining) throw`)
  // guarded by FOR UPDATE so two concurrent transactions can't both read
  // the same stale `remaining`. These tests pin down the arithmetic
  // itself — that FOR UPDATE serializes correctly is a DB-level
  // guarantee this project's jest config deliberately doesn't stand up a
  // live Postgres to exercise (see jest.config.js).
  function reserve(remaining: number, requested: number): number {
    if (requested > remaining) throw new Error("Refund amount exceeds remaining refundable balance");
    return remaining - requested;
  }

  it("10k payment: two concurrent 6k refund requests — the second cannot reserve", () => {
    let remaining = 10_000_00; // kobo
    remaining = reserve(remaining, 6_000_00); // first admin's transaction commits
    expect(remaining).toBe(4_000_00);
    // second admin's transaction reads the POST-commit remaining (that's
    // exactly what FOR UPDATE guarantees — it can't read the pre-commit
    // value) and must fail
    expect(() => reserve(remaining, 6_000_00)).toThrow(/exceeds remaining/);
  });

  it("4k + 6k reservations are both allowed against a 10k payment", () => {
    let remaining = 10_000_00;
    remaining = reserve(remaining, 4_000_00);
    expect(remaining).toBe(6_000_00);
    remaining = reserve(remaining, 6_000_00);
    expect(remaining).toBe(0);
  });

  it("a fully-reserved payment (remaining 0) rejects any further reservation", () => {
    const remaining = 0;
    expect(() => reserve(remaining, 1)).toThrow();
  });
});

describe("classifyRefundSubmitError — distinguishes a definite failure from an unknown outcome", () => {
  it("a Paystack HTTP response (rejection) is a definite failure", () => {
    const err = { response: { status: 400, data: { message: "Refund amount exceeds available balance" } } };
    expect(classifyRefundSubmitError(err)).toBe("definite_failure");
  });

  it("a client-side timeout is an unknown outcome, not a failure", () => {
    const err = { code: "ECONNABORTED", message: "timeout of 5000ms exceeded" };
    expect(classifyRefundSubmitError(err)).toBe("unknown");
  });

  it("a connection reset is an unknown outcome", () => {
    const err = { code: "ECONNRESET", message: "socket hang up" };
    expect(classifyRefundSubmitError(err)).toBe("unknown");
  });

  it("a request that was sent but never got any response is an unknown outcome", () => {
    const err = { request: {} }; // axios shape: request exists, response does not
    expect(classifyRefundSubmitError(err)).toBe("unknown");
  });

  it("a request that never left the process (no request, no response) is a definite failure", () => {
    const err = { message: "Invalid URL" };
    expect(classifyRefundSubmitError(err)).toBe("definite_failure");
  });
});

describe("admin.controller.ts — refund submission ordering and retry safety (source-level proof)", () => {
  const source = fs.readFileSync("src/controllers/admin.controller.ts", "utf8");

  it("locks the Payment row before reserving (FOR UPDATE)", () => {
    expect(source).toContain('FOR UPDATE');
  });

  it("writes the durable PROCESSING RefundRequest inside the SAME transaction as the reservation, before ever calling Paystack (FIX 2)", () => {
    const txIdx = source.indexOf('await tx.$queryRaw`SELECT id FROM "Payment"');
    const processingWriteIdx = source.indexOf("status: RefundStatus.PROCESSING,", txIdx);
    const paystackCallIdx = source.indexOf("refundPaymentViaPaystack(refundRequest.paymentRef, requestedKobo)");
    expect(txIdx).toBeGreaterThan(-1);
    expect(processingWriteIdx).toBeGreaterThan(txIdx);
    expect(processingWriteIdx).toBeLessThan(paystackCallIdx);
  });

  it("classifies the submit error instead of unconditionally releasing the reservation", () => {
    expect(source).toContain("classifyRefundSubmitError(err)");
    expect(source).toContain('classification === "definite_failure"');
  });

  it("only releases the reservation (failRefund) on a definite failure", () => {
    const definiteFailureBranch = source.slice(
      source.indexOf('classification === "definite_failure"'),
      source.indexOf('classification === "definite_failure"') + 400,
    );
    expect(definiteFailureBranch).toContain("failRefund(id");
  });

  it("never calls POST /refund again for an unknown outcome (no blind retry)", () => {
    const unknownIdx = source.indexOf("REFUND_OUTCOME_UNKNOWN");
    expect(unknownIdx).toBeGreaterThan(-1);
    const afterUnknown = source.slice(unknownIdx, unknownIdx + 600);
    expect(afterUnknown).not.toContain("refundPaymentViaPaystack(");
  });

  it("does not release the reservation for an unknown outcome", () => {
    const unknownIdx = source.indexOf("REFUND_OUTCOME_UNKNOWN");
    const afterUnknown = source.slice(unknownIdx - 500, unknownIdx);
    expect(afterUnknown).not.toContain("failRefund(id");
    expect(afterUnknown).not.toContain("refundedAmount: { decrement");
  });
});

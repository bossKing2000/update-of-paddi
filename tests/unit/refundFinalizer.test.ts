jest.mock("../../src/lib/prisma", () => {
  const mockPrisma: any = {
    refundRequest: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
    },
    payment: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    order: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  // $transaction in this project's real usage hands the callback a
  // scoped `tx` client. Since our mocked model methods are shared
  // jest.fn()s anyway, just hand the callback this same mock object.
  mockPrisma.$transaction = jest.fn(async (fn: any) => fn(mockPrisma));
  return { __esModule: true, default: mockPrisma };
});

jest.mock("../../src/utils/auditLog.service", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

import prisma from "../../src/lib/prisma";
import { matchRefundRequest, completeRefund, failRefund } from "../../src/services/refundFinalizer.service";

const rr = (prisma as any).refundRequest;
const pay = (prisma as any).payment;
const ord = (prisma as any).order;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("matchRefundRequest (FIX 5/6 — webhook matching)", () => {
  it("prefers an exact match on Paystack's own refund id, regardless of current status", async () => {
    rr.findFirst.mockResolvedValueOnce({ id: "rr1", paymentRef: "TXN1", paystackRefundId: "PSR1", status: "COMPLETED", requestedAmountKobo: 4000 });
    const result = await matchRefundRequest({ transactionReference: "TXN1", refundReference: "PSR1", amountKobo: 4000 });
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") expect(result.request.id).toBe("rr1");
  });

  it("does not arbitrarily pick between two same-amount PROCESSING candidates (ambiguous)", async () => {
    rr.findFirst.mockResolvedValueOnce(null);
    rr.findMany.mockResolvedValueOnce([
      { id: "rrA", requestedAmountKobo: 4000, paystackRefundId: null, status: "PROCESSING" },
      { id: "rrB", requestedAmountKobo: 4000, paystackRefundId: null, status: "PROCESSING" },
    ]);
    const result = await matchRefundRequest({ transactionReference: "TXN1", amountKobo: 4000 });
    expect(result.kind).toBe("ambiguous");
  });

  it("flags an amount mismatch instead of matching a different-amount candidate", async () => {
    rr.findFirst.mockResolvedValueOnce(null);
    rr.findMany.mockResolvedValueOnce([{ id: "rrA", requestedAmountKobo: 4000, paystackRefundId: null, status: "PROCESSING" }]);
    const result = await matchRefundRequest({ transactionReference: "TXN1", amountKobo: 9999 });
    expect(result.kind).toBe("amount_mismatch");
  });

  it("returns not_found when there is nothing PROCESSING for this payment", async () => {
    rr.findFirst.mockResolvedValueOnce(null);
    rr.findMany.mockResolvedValueOnce([]);
    const result = await matchRefundRequest({ transactionReference: "TXN1", amountKobo: 4000 });
    expect(result.kind).toBe("not_found");
  });
});

describe("completeRefund (FIX 4 — only REFUNDED once COMPLETED sum reaches the payment amount)", () => {
  it("first partial completion (4k of 10k) does NOT mark the payment REFUNDED", async () => {
    rr.findUnique.mockResolvedValueOnce({ id: "rrA", status: "PROCESSING", paymentRef: "TXN1", requestedAmountKobo: 4000 });
    pay.findUnique.mockResolvedValueOnce({ id: "pay1", reference: "TXN1", amount: 10000, status: "SUCCESS", idempotencyKey: "K1", orderId: "o1" });
    rr.aggregate.mockResolvedValueOnce({ _sum: { requestedAmountKobo: 4000 } }); // only this one completed so far

    const result = await completeRefund("rrA", { source: "webhook" });

    expect(result.outcome).toBe("SUCCESS");
    expect((result as any).fullyRefunded).toBe(false);
    expect(pay.update).not.toHaveBeenCalled();
    expect(ord.updateMany).not.toHaveBeenCalled();
  });

  it("second completion reaching the full amount (4k + 6k = 10k) marks the payment REFUNDED and cancels orders", async () => {
    rr.findUnique.mockResolvedValueOnce({ id: "rrB", status: "PROCESSING", paymentRef: "TXN1", requestedAmountKobo: 6000 });
    pay.findUnique.mockResolvedValueOnce({ id: "pay1", reference: "TXN1", amount: 10000, status: "SUCCESS", idempotencyKey: "K1", orderId: "o1" });
    rr.aggregate.mockResolvedValueOnce({ _sum: { requestedAmountKobo: 10000 } }); // 4k + 6k both COMPLETED now
    ord.findMany.mockResolvedValueOnce([{ id: "o1" }]);

    const result = await completeRefund("rrB", { source: "webhook" });

    expect((result as any).fullyRefunded).toBe(true);
    expect(pay.update).toHaveBeenCalledWith({ where: { id: "pay1" }, data: { status: "REFUNDED" } });
    expect(ord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED", paymentStatus: "REFUNDED" }) }),
    );
  });

  it("a partially-completed refund leaves the Payment status untouched (still SUCCESS)", async () => {
    rr.findUnique.mockResolvedValueOnce({ id: "rrA", status: "PROCESSING", paymentRef: "TXN1", requestedAmountKobo: 4000 });
    pay.findUnique.mockResolvedValueOnce({ id: "pay1", reference: "TXN1", amount: 10000, status: "SUCCESS", idempotencyKey: "K1", orderId: "o1" });
    rr.aggregate.mockResolvedValueOnce({ _sum: { requestedAmountKobo: 4000 } });

    await completeRefund("rrA", { source: "webhook" });

    expect(pay.update).not.toHaveBeenCalled(); // payment.status is never touched → stays SUCCESS
  });

  it("duplicate refund.processed webhook is idempotent — completing an already-COMPLETED request is a no-op", async () => {
    rr.findUnique.mockResolvedValueOnce({ id: "rr1", status: "COMPLETED", paymentRef: "TXN1", requestedAmountKobo: 4000 });

    const result = await completeRefund("rr1", { source: "webhook" });

    expect(result.outcome).toBe("ALREADY_COMPLETED");
    expect(rr.update).not.toHaveBeenCalled();
    expect(pay.update).not.toHaveBeenCalled();
  });
});

describe("failRefund (releases only its own reservation)", () => {
  it("releases exactly the reserved amount for the failed request, not the whole payment", async () => {
    rr.findUnique.mockResolvedValueOnce({ id: "rrB", status: "PROCESSING", paymentRef: "TXN1", requestedAmountKobo: 6000 });

    const result = await failRefund("rrB", { source: "webhook" });

    expect(result.outcome).toBe("SUCCESS");
    expect(pay.updateMany).toHaveBeenCalledWith({
      where: { reference: "TXN1" },
      data: { refundedAmount: { decrement: 6000 } },
    });
    expect(rr.update).toHaveBeenCalledWith({ where: { id: "rrB" }, data: { status: "FAILED" } });
  });

  it("failing one refund does not touch a sibling refund's reservation (4k completes, 6k fails → refundedAmount ends at 4k)", async () => {
    // This is the accounting invariant, not the call itself: failRefund
    // only ever decrements by ITS OWN requestedAmountKobo (6000 here),
    // leaving whatever the 4k reservation already contributed intact.
    rr.findUnique.mockResolvedValueOnce({ id: "rrB", status: "PROCESSING", paymentRef: "TXN1", requestedAmountKobo: 6000 });
    await failRefund("rrB", { source: "webhook" });
    expect(pay.updateMany).toHaveBeenCalledWith({
      where: { reference: "TXN1" },
      data: { refundedAmount: { decrement: 6000 } }, // NOT 10000, NOT 4000
    });
  });

  it("duplicate refund.failed webhook is idempotent — failing an already-FAILED request does not double-decrement", async () => {
    rr.findUnique.mockResolvedValueOnce({ id: "rrB", status: "FAILED", paymentRef: "TXN1", requestedAmountKobo: 6000 });

    const result = await failRefund("rrB", { source: "webhook" });

    expect(result.outcome).toBe("ALREADY_FAILED");
    expect(pay.updateMany).not.toHaveBeenCalled();
    expect(rr.update).not.toHaveBeenCalled();
  });
});

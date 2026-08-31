import fs from "fs";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    refundRequest: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../src/services/refundService", () => ({
  fetchRefundById: jest.fn(),
  listRefundsForTransaction: jest.fn(),
}));

jest.mock("../../src/services/refundFinalizer.service", () => ({
  completeRefund: jest.fn().mockResolvedValue({ outcome: "SUCCESS" }),
  failRefund: jest.fn().mockResolvedValue({ outcome: "SUCCESS" }),
}));

import prisma from "../../src/lib/prisma";
import { fetchRefundById, listRefundsForTransaction } from "../../src/services/refundService";
import { completeRefund, failRefund } from "../../src/services/refundFinalizer.service";
import { verifyPendingRefunds } from "../../src/jobs/payment/worker/verifyPendingRefunds";

const rr = (prisma as any).refundRequest;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("verifyPendingRefunds — reconciliation against Paystack's own records", () => {
  it("marks a refund COMPLETED when Paystack's Fetch Refund reports 'processed'", async () => {
    rr.findMany.mockResolvedValueOnce([
      { id: "rr1", paymentRef: "TXN1", paystackRefundId: "PSR1", requestedAmountKobo: 4000, resolvedAt: new Date() },
    ]);
    (fetchRefundById as jest.Mock).mockResolvedValueOnce({ id: "PSR1", status: "processed", amount: 4000 });

    await verifyPendingRefunds();

    expect(fetchRefundById).toHaveBeenCalledWith("PSR1");
    expect(completeRefund).toHaveBeenCalledWith("rr1", expect.objectContaining({ source: "reconciliation" }));
    expect(failRefund).not.toHaveBeenCalled();
  });

  it("marks a refund FAILED when Paystack's Fetch Refund reports 'failed'", async () => {
    rr.findMany.mockResolvedValueOnce([
      { id: "rr2", paymentRef: "TXN2", paystackRefundId: "PSR2", requestedAmountKobo: 6000, resolvedAt: new Date() },
    ]);
    (fetchRefundById as jest.Mock).mockResolvedValueOnce({ id: "PSR2", status: "failed", amount: 6000 });

    await verifyPendingRefunds();

    expect(failRefund).toHaveBeenCalledWith("rr2", expect.objectContaining({ source: "reconciliation" }));
    expect(completeRefund).not.toHaveBeenCalled();
  });

  it("leaves a still-pending/processing refund untouched", async () => {
    rr.findMany.mockResolvedValueOnce([
      { id: "rr3", paymentRef: "TXN3", paystackRefundId: "PSR3", requestedAmountKobo: 5000, resolvedAt: new Date() },
    ]);
    (fetchRefundById as jest.Mock).mockResolvedValueOnce({ id: "PSR3", status: "processing", amount: 5000 });

    await verifyPendingRefunds();

    expect(completeRefund).not.toHaveBeenCalled();
    expect(failRefund).not.toHaveBeenCalled();
  });

  it("crash case (no recorded paystackRefundId yet): falls back to List Refunds and matches by amount", async () => {
    rr.findMany.mockResolvedValueOnce([
      { id: "rr4", paymentRef: "TXN4", paystackRefundId: null, requestedAmountKobo: 7000, resolvedAt: new Date() },
    ]);
    (listRefundsForTransaction as jest.Mock).mockResolvedValueOnce([
      { id: "PSR4", status: "processed", amount: 7000 },
      { id: "PSR-other", status: "processed", amount: 1000 }, // unrelated refund, different amount
    ]);

    await verifyPendingRefunds();

    expect(listRefundsForTransaction).toHaveBeenCalledWith("TXN4");
    expect(completeRefund).toHaveBeenCalledWith("rr4", expect.objectContaining({ paystackRefundId: "PSR4", source: "reconciliation" }));
  });

  it("crash case with an ambiguous amount match: does not guess, leaves PROCESSING", async () => {
    rr.findMany.mockResolvedValueOnce([
      { id: "rr5", paymentRef: "TXN5", paystackRefundId: null, requestedAmountKobo: 5000, resolvedAt: new Date() },
    ]);
    (listRefundsForTransaction as jest.Mock).mockResolvedValueOnce([
      { id: "PSR-a", status: "processed", amount: 5000 },
      { id: "PSR-b", status: "processed", amount: 5000 },
    ]);

    await verifyPendingRefunds();

    expect(completeRefund).not.toHaveBeenCalled();
    expect(failRefund).not.toHaveBeenCalled();
  });

  it("never calls Paystack's create-refund endpoint (no automatic retry) — source-level proof", () => {
    const source = fs.readFileSync("src/jobs/payment/worker/verifyPendingRefunds.ts", "utf8");
    expect(source).not.toContain("refundPaymentViaPaystack");
    expect(source).toContain("This job NEVER calls POST /refund");
  });
});

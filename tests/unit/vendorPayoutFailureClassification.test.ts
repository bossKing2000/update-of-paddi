/**
 * Batch B (P3.2-03) — vendor payout initiation failure classification.
 *
 * The vendor path branched on the legacy `retryable` flag
 * (`retryable: !err?.response`), so a Paystack 5xx (which HAS a response)
 * settled the payout FAILED and released its order claims while the
 * transfer might exist — a theoretical double-pay. It now branches on the
 * authoritative `outcome` from `classifyTransferInitiationError`, matching
 * the rider withdrawal path: only REJECTED closes the payout; anything
 * ambiguous keeps PROCESSING with claims held for webhook/reconciliation.
 *
 * These tests drive the REAL `processPayout` retry path (mocked Prisma and
 * provider only). Provider errors are built with the REAL classifier so the
 * wiring — not just the branch — is exercised. Paystack is never contacted.
 */
import { UpstreamServiceError } from "../../src/errors/AppError";
import {
  classifyTransferInitiationError,
  initiateTransfer,
} from "../../src/services/payoutService";
import { settleVendorPayoutFailed } from "../../src/services/vendorPayoutSettlement.service";
import { processPayout } from "../../src/controllers/admin.controller";
import prisma from "../../src/lib/prisma";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), updateMany: jest.fn() },
    vendorPayout: { findUnique: jest.fn(), updateMany: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === "function" ? arg(require("../../src/lib/prisma").default) : arg,
    ),
  },
}));

jest.mock("../../src/services/payoutService", () => {
  const actual = jest.requireActual("../../src/services/payoutService");
  return {
    __esModule: true,
    ...actual,
    createTransferRecipient: jest.fn(async () => "RCP_test"),
    initiateTransfer: jest.fn(),
  };
});

jest.mock("../../src/services/vendorPayoutSettlement.service", () => ({
  __esModule: true,
  settleVendorPayoutPaid: jest.fn(),
  settleVendorPayoutFailed: jest.fn(async () => ({ outcome: "SETTLED", releasedOrders: 2 })),
}));

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedInitiateTransfer = initiateTransfer as jest.Mock;
const mockedSettleFailed = settleVendorPayoutFailed as jest.Mock;

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

const vendor = () => ({
  id: "v-1",
  roles: ["VENDOR"],
  vendorStatus: "ACTIVE",
  bankName: "Test Bank",
  bankCode: "999",
  bankAccountNumber: "enc",
  paystackRecipientCode: "RCP_test",
});

const failedPayout = () => ({
  id: "po-1",
  vendorId: "v-1",
  vendor: vendor(),
  status: "FAILED",
  reference: "vendor_payout_po-1",
  amount: 850,
  orderCount: 2,
  _count: { orders: 2 },
});

/** Build the exact error `initiateTransfer` throws, via the REAL classifier. */
function providerError(status?: number) {
  const err: any = status === undefined ? new Error("socket hangup") : new Error(`status ${status}`);
  if (status !== undefined) err.response = { status, data: { message: `paystack ${status}` } };
  const outcome = classifyTransferInitiationError(err);
  return new UpstreamServiceError("Paystack", `transfer failed (${status ?? "no-response"})`, {
    retryable: !err?.response,
    outcome,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.vendorPayout.findUnique.mockResolvedValue(failedPayout());
  db.vendorPayout.updateMany.mockResolvedValue({ count: 1 });
});

function failedWrites() {
  return db.vendorPayout.updateMany.mock.calls.filter(
    (c) => c[0].data?.status === "FAILED",
  );
}

describe("Batch B — vendor payout initiation failure classification", () => {
  it("1. definitive 4xx rejection closes the payout FAILED and releases claims", async () => {
    mockedInitiateTransfer.mockRejectedValueOnce(providerError(400));

    await expect(
      processPayout({ user: { id: "admin-1" }, body: { payoutId: "po-1" } } as never, res()),
    ).rejects.toThrow(/correct the payout details and retry/);

    expect(mockedSettleFailed).toHaveBeenCalledTimes(1);
    expect(mockedSettleFailed).toHaveBeenCalledWith("po-1", expect.any(String));
  });

  it("2. timeout (no provider response) keeps PROCESSING with claims held", async () => {
    mockedInitiateTransfer.mockRejectedValueOnce(providerError(undefined));

    const err = await processPayout(
      { user: { id: "admin-1" }, body: { payoutId: "po-1" } } as never,
      res(),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(UpstreamServiceError);
    expect(err.details?.outcome ?? err.message).toBeDefined();
    expect(mockedSettleFailed).not.toHaveBeenCalled();
    expect(failedWrites()).toHaveLength(0);
    expect(String(err.message)).toMatch(/await paystack confirmation/i);
  });

  it("3. provider 5xx keeps PROCESSING (must NOT fail-and-release)", async () => {
    // KEY regression: the legacy flag treated any response as definite.
    mockedInitiateTransfer.mockRejectedValueOnce(providerError(500));

    await expect(
      processPayout({ user: { id: "admin-1" }, body: { payoutId: "po-1" } } as never, res()),
    ).rejects.toThrow(/await paystack confirmation/i);

    expect(mockedSettleFailed).not.toHaveBeenCalled();
    expect(failedWrites()).toHaveLength(0);
  });

  it("4. retry after an ambiguous outcome reuses the same provider reference", async () => {
    mockedInitiateTransfer.mockResolvedValueOnce({ status: true, reference: "vendor_payout_po-1" });

    await processPayout(
      { user: { id: "admin-1" }, body: { payoutId: "po-1" } } as never,
      res(),
    );

    // No blind second transfer: the retry carries the original reference
    // so Paystack-side idempotency and the reconciler can resolve it.
    expect(mockedInitiateTransfer).toHaveBeenCalledTimes(1);
    expect(mockedInitiateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "vendor_payout_po-1" }),
    );
    expect(mockedSettleFailed).not.toHaveBeenCalled();
  });
});

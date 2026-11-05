/**
 * Stage H (E-03) — controlled handling of Prisma P2034 / PostgreSQL 40001
 * serialization failures during concurrent VendorPayout claiming.
 *
 * The Serializable transaction is preserved (one winner, no double-claim).
 * These tests prove the LOSER gets a controlled outcome:
 *   - transient P2034 is retried (bounded, P2034-only, no external side
 *     effects inside the retried transaction),
 *   - persistent contention becomes 409 ConflictError with the existing
 *     payout contention message — never a generic 500, never false success.
 */
import { Prisma } from "@prisma/client";
import { processPayout } from "../../src/controllers/admin.controller";
import prisma from "../../src/lib/prisma";
import { ConflictError, ValidationError } from "../../src/errors/AppError";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), updateMany: jest.fn() },
    order: { findMany: jest.fn(), updateMany: jest.fn() },
    vendorPayout: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
  },
}));

// Paystack money movement must never run inside the retried transaction —
// mock it and assert call counts to prove no duplicate transfer.
jest.mock("../../src/services/payoutService", () => ({
  createTransferRecipient: jest.fn(async () => "RCP_TEST"),
  initiateTransfer: jest.fn(async () => ({ status: true })),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  createAuditLog: jest.fn(async () => ({})),
}));

import {
  createTransferRecipient,
  initiateTransfer,
} from "../../src/services/payoutService";

const db = prisma as unknown as {
  user: { findUnique: jest.Mock; updateMany: jest.Mock };
  vendorPayout: {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

function p2034() {
  return new Prisma.PrismaClientKnownRequestError(
    "Write conflict; transaction was aborted (PostgreSQL 40001)",
    { code: "P2034", clientVersion: "test" },
  );
}

const bankedVendor = {
  id: "v-1",
  roles: ["VENDOR"],
  commissionRate: 0.15,
  bankName: "GTB",
  bankCode: "058",
  bankAccountNumber: "0123456789",
  bankAccountName: "Vendor",
  paystackRecipientCode: "RCP_1",
  vendorStatus: "ACTIVE",
};

const claimedPayout = {
  id: "po-1",
  vendorId: "v-1",
  grossRevenue: 8500,
  commission: 1275,
  amount: 7225,
  orderCount: 2,
  status: "PENDING",
  reference: null,
};

function mockReq(body: object) {
  return {
    user: { id: "admin-1" },
    body,
    headers: {},
    params: {},
    query: {},
  } as never;
}

function mockRes() {
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnThis(), json } as never;
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.user.findUnique.mockResolvedValue(bankedVendor);
  // initiateVendorPayoutTransfer claim: PENDING/FAILED -> PROCESSING
  db.vendorPayout.updateMany.mockResolvedValue({ count: 1 });
  db.vendorPayout.findUnique.mockResolvedValue({
    ...claimedPayout,
    status: "PROCESSING",
  });
});

describe("E-03 payout serialization handling", () => {
  it("A. transient P2034 is retried: first attempt conflicts, retry claims exactly once", async () => {
    db.$transaction
      .mockRejectedValueOnce(p2034())
      .mockResolvedValueOnce(claimedPayout);
    const { res, json } = mockRes();
    await processPayout(mockReq({ vendorId: "v-1" }), res);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    // Serializable isolation preserved on every attempt.
    for (const call of db.$transaction.mock.calls) {
      expect(call[1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    }
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0].success).toBe(true);
    // Exactly one money movement after the single successful commit.
    expect(initiateTransfer).toHaveBeenCalledTimes(1);
    expect(createTransferRecipient).not.toHaveBeenCalled();
  });

  it("B/C. persistent P2034 becomes controlled 409, never 500/false success, no transfer", async () => {
    db.$transaction.mockRejectedValue(p2034());
    const { res } = mockRes();
    const err = await processPayout(mockReq({ vendorId: "v-1" }), res).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/claimed one or more orders/i);
    // Bounded: 1 initial + 2 retries, then stop.
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(initiateTransfer).not.toHaveBeenCalled();
    expect(createTransferRecipient).not.toHaveBeenCalled();
  });

  it("D. non-serialization Prisma error is NOT swallowed or retried", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test" },
    );
    db.$transaction.mockRejectedValue(p2002);
    await expect(
      processPayout(
        mockReq({ vendorId: "v-1" }),
        mockRes().res,
      ),
    ).rejects.toBe(p2002);
    // No retry for non-P2034 errors.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(initiateTransfer).not.toHaveBeenCalled();
  });

  it("E. already-claimed payout keeps the existing business rule (no eligible orders -> 400)", async () => {
    const noEligible = new ValidationError(
      "This vendor has no eligible orders to pay out",
    );
    db.$transaction.mockRejectedValue(noEligible);
    await expect(
      processPayout(
        mockReq({ vendorId: "v-1" }),
        mockRes().res,
      ),
    ).rejects.toBe(noEligible);
    // Business-state errors are not serialization conflicts: no retry.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(initiateTransfer).not.toHaveBeenCalled();
  });

  it("E2. in-transaction count-guard conflict is not retried and stays 409", async () => {
    const guard = new ConflictError(
      "Another payout process claimed one or more orders; retry this request",
    );
    db.$transaction.mockRejectedValue(guard);
    await expect(
      processPayout(
        mockReq({ vendorId: "v-1" }),
        mockRes().res,
      ),
    ).rejects.toBe(guard);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(initiateTransfer).not.toHaveBeenCalled();
  });
});

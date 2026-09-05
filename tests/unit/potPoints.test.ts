import {
  POT_POINTS_PER_ORDER,
  creditPotPointsForCompletedOrder,
  getPotPointsBalance,
} from "../../src/services/potPoints.service";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    potPointTransaction: { findFirst: jest.fn(), create: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import prisma from "../../src/lib/prisma";

const mockedFindFirst = (prisma as any).potPointTransaction
  .findFirst as jest.Mock;
const mockedFindUnique = (prisma as any).user.findUnique as jest.Mock;
const mockedUpdate = (prisma as any).user.update as jest.Mock;
const mockedCreate = (prisma as any).potPointTransaction.create as jest.Mock;
const mockedTx = (prisma as any).$transaction as jest.Mock;

describe("Pot Points", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("earns a fixed, deterministic amount per completed order", () => {
    expect(POT_POINTS_PER_ORDER).toBe(50);
  });

  it("credits once and increments the balance", async () => {
    mockedFindFirst.mockResolvedValue(null);
    mockedTx.mockImplementation(async (ops: any[]) => {
      // create result + updated user
      return [{ id: "tx-1" }, { potPointsBalance: 150 }];
    });

    const result = await creditPotPointsForCompletedOrder(
      "order-1",
      "customer-1",
    );

    expect(result).toEqual({ credited: true, balance: 150 });
    expect(mockedTx).toHaveBeenCalledTimes(1);
    // The ledger insert is built eagerly as a $transaction op.
    expect(mockedCreate).toHaveBeenCalledWith({
      data: {
        userId: "customer-1",
        points: POT_POINTS_PER_ORDER,
        type: "EARN",
        reason: "Order completed — Pot Points earned",
        orderId: "order-1",
      },
    });
  });

  it("is idempotent per order (double completion credits once)", async () => {
    mockedFindFirst.mockResolvedValue({ id: "existing-tx" });
    mockedFindUnique.mockResolvedValue({ potPointsBalance: 150 });

    const result = await creditPotPointsForCompletedOrder(
      "order-1",
      "customer-1",
    );

    expect(result).toEqual({ credited: false, balance: 150 });
    expect(mockedTx).not.toHaveBeenCalled();
  });

  it("reads balance as 0 for unknown users", async () => {
    mockedFindUnique.mockResolvedValue(null);
    await expect(getPotPointsBalance("ghost")).resolves.toBe(0);
  });

  it("never exposes a client-submitted points path", async () => {
    // The service module exposes only fixed-rule credit + reads.
    const mod = await import("../../src/services/potPoints.service");
    expect(typeof mod.creditPotPointsForCompletedOrder).toBe("function");
    expect(typeof mod.getPotPointsBalance).toBe("function");
    expect(typeof mod.getPotPointsHistory).toBe("function");
    expect((mod as any).setPotPointsBalance).toBeUndefined();
    expect((mod as any).addPotPoints).toBeUndefined();
  });
});

import {
  assertQuantityAvailable,
  reserveStockForItems,
  restoreStockForOrders,
} from "../../src/services/inventory.service";
import { ValidationError, ConflictError } from "../../src/errors/AppError";

const makeTx = () => ({
  product: { updateMany: jest.fn() },
  order: { findMany: jest.fn() },
});

describe("assertQuantityAvailable — read-model UX check", () => {
  it("passes for untracked products regardless of stock", () => {
    expect(() =>
      assertQuantityAvailable({ productId: "p1", quantity: 99, trackInventory: false, stock: 0 }),
    ).not.toThrow();
    expect(() =>
      assertQuantityAvailable({ productId: "p1", quantity: 99 }),
    ).not.toThrow();
  });

  it("passes when enough portions remain", () => {
    expect(() =>
      assertQuantityAvailable({ productId: "p1", quantity: 3, trackInventory: true, stock: 10 }),
    ).not.toThrow();
  });

  it("rejects quantities above remaining stock", () => {
    expect(() =>
      assertQuantityAvailable({
        productId: "p1",
        productName: "Jollof",
        quantity: 4,
        trackInventory: true,
        stock: 3,
      }),
    ).toThrow(ValidationError);
  });

  it("reports sold out distinctly at zero", () => {
    try {
      assertQuantityAvailable({
        productId: "p1",
        productName: "Jollof",
        quantity: 1,
        trackInventory: true,
        stock: 0,
      });
      fail("expected ValidationError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(ValidationError);
      expect(e.message).toMatch(/sold out/i);
    }
  });
});

describe("reserveStockForItems — atomic reservation", () => {
  it("decrements once per product with the aggregated quantity", async () => {
    const tx = makeTx();
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await reserveStockForItems(tx as any, [
      { productId: "p1", quantity: 2, trackInventory: true, stock: 10 },
      { productId: "p1", quantity: 1, trackInventory: true, stock: 10 },
      { productId: "p2", quantity: 1, trackInventory: false },
    ]);

    // Same product across lines aggregates to a single conditional update.
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "p1",
          trackInventory: true,
          stock: { gte: 3 },
        }),
        data: { stock: { decrement: 3 } },
      }),
    );
  });

  it("skips untracked products entirely", async () => {
    const tx = makeTx();
    await reserveStockForItems(tx as any, [
      { productId: "p1", quantity: 5, trackInventory: false },
    ]);
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("throws ConflictError when the conditional update matches nothing (lost race)", async () => {
    const tx = makeTx();
    tx.product.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      reserveStockForItems(tx as any, [
        { productId: "p1", productName: "Jollof", quantity: 1, trackInventory: true, stock: 1 },
      ]),
    ).rejects.toThrow(ConflictError);
  });
});

describe("restoreStockForOrders — reservation release", () => {
  it("increments tracked products by ordered quantities", async () => {
    const tx = makeTx();
    tx.order.findMany.mockResolvedValue([
      { items: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 1 }] },
      { items: [{ productId: "p1", quantity: 1 }] },
    ]);
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await restoreStockForOrders(tx as any, ["o1", "o2"]);

    expect(tx.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1", trackInventory: true },
        data: { stock: { increment: 3 } },
      }),
    );
    expect(tx.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p2", trackInventory: true },
        data: { stock: { increment: 1 } },
      }),
    );
  });

  it("does nothing for an empty order list", async () => {
    const tx = makeTx();
    await restoreStockForOrders(tx as any, []);
    expect(tx.order.findMany).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
});

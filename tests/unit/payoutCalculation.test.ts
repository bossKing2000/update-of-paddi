import { calculatePayoutAmounts } from "../../src/controllers/vendorDashboard.service";

describe("calculatePayoutAmounts", () => {
  it("excludes delivery fee from gross revenue", () => {
    const orders = [{ totalPrice: 5000, deliveryFee: 500 }];
    const { grossRevenue } = calculatePayoutAmounts(orders, 0.15);
    expect(grossRevenue).toBe(4500);
  });

  it("sums across multiple orders", () => {
    const orders = [
      { totalPrice: 5000, deliveryFee: 500 },
      { totalPrice: 3000, deliveryFee: 300 },
    ];
    const { grossRevenue } = calculatePayoutAmounts(orders, 0.15);
    expect(grossRevenue).toBe(4500 + 2700);
  });

  it("computes commission as a percentage of gross (not total)", () => {
    const orders = [{ totalPrice: 10000, deliveryFee: 0 }];
    const { commission, netAvailable } = calculatePayoutAmounts(orders, 0.15);
    expect(commission).toBe(1500);
    expect(netAvailable).toBe(8500);
  });

  it("returns zero for an empty order list", () => {
    const result = calculatePayoutAmounts([], 0.15);
    expect(result).toEqual({ grossRevenue: 0, commission: 0, netAvailable: 0 });
  });

  it("gross + net always accounts for the full commission (no money lost to rounding)", () => {
    const orders = [{ totalPrice: 1999, deliveryFee: 99 }];
    const { grossRevenue, commission, netAvailable } = calculatePayoutAmounts(orders, 0.15);
    expect(Number((commission + netAvailable).toFixed(2))).toBe(grossRevenue);
  });
});

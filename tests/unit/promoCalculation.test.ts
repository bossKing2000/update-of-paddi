import { calculateDiscountAllocation } from "../../src/services/promoService";
import { DiscountType } from "@prisma/client";

describe("calculateDiscountAllocation", () => {
  it("PERCENTAGE: applies value% of the eligible subtotal to a single vendor", () => {
    const result = calculateDiscountAllocation(DiscountType.PERCENTAGE, 10, null, [{ vendorId: "v1", subtotal: 1000, deliveryFee: 300 }]);
    expect(result.vendorDiscounts.v1).toBe(100);
    expect(result.totalDiscount).toBe(100);
  });

  it("PERCENTAGE: caps at maxDiscount even if the percentage would exceed it", () => {
    const result = calculateDiscountAllocation(DiscountType.PERCENTAGE, 50, 200, [{ vendorId: "v1", subtotal: 1000, deliveryFee: 0 }]);
    expect(result.totalDiscount).toBe(200); // 50% of 1000 = 500, capped to 200
  });

  it("FIXED: never exceeds the eligible subtotal (can't go negative)", () => {
    const result = calculateDiscountAllocation(DiscountType.FIXED, 5000, null, [{ vendorId: "v1", subtotal: 1000, deliveryFee: 0 }]);
    expect(result.totalDiscount).toBe(1000);
  });

  it("allocates proportionally across multiple vendors by subtotal share", () => {
    const groups = [
      { vendorId: "v1", subtotal: 3000, deliveryFee: 0 },
      { vendorId: "v2", subtotal: 1000, deliveryFee: 0 },
    ];
    const result = calculateDiscountAllocation(DiscountType.FIXED, 400, null, groups);
    // v1 has 75% share, v2 has 25% share
    expect(result.vendorDiscounts.v1).toBe(300);
    expect(result.vendorDiscounts.v2).toBe(100);
    expect(result.totalDiscount).toBe(400);
  });

  it("allocated discounts across vendors always sum to the total (no money lost to rounding)", () => {
    const groups = [
      { vendorId: "v1", subtotal: 999, deliveryFee: 0 },
      { vendorId: "v2", subtotal: 333, deliveryFee: 0 },
      { vendorId: "v3", subtotal: 111, deliveryFee: 0 },
    ];
    const result = calculateDiscountAllocation(DiscountType.PERCENTAGE, 15, null, groups);
    const sumOfAllocations = Object.values(result.vendorDiscounts).reduce((a, b) => a + b, 0);
    // Allow a tiny rounding tolerance (each allocation is independently rounded to 2dp)
    expect(Math.abs(sumOfAllocations - result.totalDiscount)).toBeLessThan(0.05);
  });

  it("DELIVERY: discounts delivery fee, not subtotal, capped per vendor's own fee", () => {
    const groups = [
      { vendorId: "v1", subtotal: 1000, deliveryFee: 300 },
      { vendorId: "v2", subtotal: 1000, deliveryFee: 800 },
    ];
    const result = calculateDiscountAllocation(DiscountType.DELIVERY, 500, null, groups);
    expect(result.vendorDeliveryDiscounts.v1).toBe(300); // capped at v1's own fee
    expect(result.vendorDeliveryDiscounts.v2).toBe(500); // full 500 available
    expect(result.vendorDiscounts).toEqual({}); // never touches subtotal
  });

  it("returns zero discount for an empty eligible-groups list", () => {
    const result = calculateDiscountAllocation(DiscountType.PERCENTAGE, 10, null, []);
    expect(result.totalDiscount).toBe(0);
  });
});

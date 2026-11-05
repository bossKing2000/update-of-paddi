import { calculateDiscountAllocation } from "../../src/services/promoService";
import { DiscountType } from "@prisma/client";

describe("calculateDiscountAllocation (integer kobo)", () => {
  it("PERCENTAGE: applies value% of the eligible subtotal to a single vendor", () => {
    // subtotal 100000 kobo (₦1,000), value 10% → 10000 kobo (₦100).
    const result = calculateDiscountAllocation(DiscountType.PERCENTAGE, 10, null, [
      { vendorId: "v1", subtotal: 100000, deliveryFee: 30000 },
    ]);
    expect(result.vendorDiscounts.v1).toBe(10000);
    expect(result.totalDiscount).toBe(10000);
  });

  it("PERCENTAGE: caps at maxDiscount even if the percentage would exceed it", () => {
    // subtotal 100000 kobo (₦1,000), value 50% → 50000 kobo, capped to
    // maxDiscount 20000 kobo (₦200).
    const result = calculateDiscountAllocation(DiscountType.PERCENTAGE, 50, 20000, [
      { vendorId: "v1", subtotal: 100000, deliveryFee: 0 },
    ]);
    expect(result.totalDiscount).toBe(20000);
  });

  it("FIXED: never exceeds the eligible subtotal (can't go negative)", () => {
    // subtotal 100000 kobo (₦1,000), value ₦5,000 → 500000 kobo, capped to
    // subtotal 100000 kobo.
    const result = calculateDiscountAllocation(DiscountType.FIXED, 5000, null, [
      { vendorId: "v1", subtotal: 100000, deliveryFee: 0 },
    ]);
    expect(result.totalDiscount).toBe(100000);
  });

  it("allocates proportionally across multiple vendors by subtotal share", () => {
    // v1 300000 kobo (75%), v2 100000 kobo (25%). value ₦400 → 40000 kobo.
    const groups = [
      { vendorId: "v1", subtotal: 300000, deliveryFee: 0 },
      { vendorId: "v2", subtotal: 100000, deliveryFee: 0 },
    ];
    const result = calculateDiscountAllocation(DiscountType.FIXED, 400, null, groups);
    // v1 has 75% share, v2 has 25% share
    expect(result.vendorDiscounts.v1).toBe(30000);
    expect(result.vendorDiscounts.v2).toBe(10000);
    expect(result.totalDiscount).toBe(40000);
  });

  it("allocated discounts across vendors always sum to the total (no money lost to rounding)", () => {
    const groups = [
      { vendorId: "v1", subtotal: 99900, deliveryFee: 0 },
      { vendorId: "v2", subtotal: 33300, deliveryFee: 0 },
      { vendorId: "v3", subtotal: 11100, deliveryFee: 0 },
    ];
    const result = calculateDiscountAllocation(DiscountType.PERCENTAGE, 15, null, groups);
    const sumOfAllocations = Object.values(result.vendorDiscounts).reduce((a, b) => a + b, 0);
    // Allow a tiny rounding tolerance (each allocation is independently rounded)
    expect(Math.abs(sumOfAllocations - result.totalDiscount)).toBeLessThan(0.05);
  });

  it("DELIVERY: discounts delivery fee, not subtotal, capped per vendor's own fee", () => {
    // value ₦500 → 50000 kobo. v1 fee 30000 kobo → capped at 30000.
    // v2 fee 80000 kobo → full 50000 available.
    const groups = [
      { vendorId: "v1", subtotal: 100000, deliveryFee: 30000 },
      { vendorId: "v2", subtotal: 100000, deliveryFee: 80000 },
    ];
    const result = calculateDiscountAllocation(DiscountType.DELIVERY, 500, null, groups);
    expect(result.vendorDeliveryDiscounts.v1).toBe(30000); // capped at v1's own fee
    expect(result.vendorDeliveryDiscounts.v2).toBe(50000); // full 50000 available
    expect(result.vendorDiscounts).toEqual({}); // never touches subtotal
  });

  it("returns zero discount for an empty eligible-groups list", () => {
    const result = calculateDiscountAllocation(DiscountType.PERCENTAGE, 10, null, []);
    expect(result.totalDiscount).toBe(0);
  });
});

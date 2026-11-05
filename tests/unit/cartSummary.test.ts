import { cartSummaryService } from "../../src/services/cartSummary.service";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    cart: { findFirst: jest.fn() },
    promotion: { findMany: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(async () => null), set: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/services/deliveryFee.service", () => ({
  calculateDeliveryFee: jest.fn(),
}));

import prisma from "../../src/lib/prisma";
import { calculateDeliveryFee } from "../../src/services/deliveryFee.service";
import { DiscountType, PromotionScope } from "@prisma/client";

const mockedPromotionFindMany = (prisma as any).promotion.findMany as jest.Mock;
// No automatic promotions by default — each auto-discount test opts in.
mockedPromotionFindMany.mockResolvedValue([]);

const mockedFindFirst = (prisma as any).cart.findFirst as jest.Mock;
const mockedDeliveryFee = calculateDeliveryFee as jest.Mock;

const LEGACY_ACTIVE_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_INACTIVE_ID = "22222222-2222-4222-8222-222222222222";
const LEGACY_MISSING_ID = "33333333-3333-4333-8333-333333333333";
const OPTION_GROUP_ITEM_ID = "44444444-4444-4444-8444-444444444444";

function makeCartItem(overrides: any = {}) {
  return {
    id: "item-1",
    productId: "prod-1",
    quantity: 2,
    // Phase 3A: unitPrice is integer kobo (₦1,000 = 100000 kobo).
    unitPrice: 100000,
    ...overrides,
    product: {
      id: "prod-1",
      name: "Jollof Rice",
      images: ["img.png"],
      archived: false,
      vendorId: "vendor-1",
      // Fixtures default to an operating vendor so the
      // marketplace-availability gate passes unless a test opts out.
      vendor: { name: "Mama Put", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } },
      ...(overrides.product || {}),
    },
  };
}

describe("cartSummaryService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPromotionFindMany.mockResolvedValue([]);
  });

  it("returns an empty summary when there is no cart", async () => {
    mockedFindFirst.mockResolvedValue(null);
    const result = await cartSummaryService({ userId: "user-1" });
    expect(result.vendorBreakdown).toEqual([]);
    expect(result.finalTotal).toBe(0);
  });

  it("excludes archived items and reports the count", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({ id: "a" }),
        makeCartItem({ id: "b", product: { archived: true } }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });
    expect(result.excludedOfflineItemCount).toBe(1);
    expect(result.vendorBreakdown[0].items).toHaveLength(1);
  });

  it("Vendor Live: excludes items whose vendor went offline or paused orders, keeping the item count honest", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({ id: "a" }),
        makeCartItem({ id: "b", product: { vendorId: "vendor-2", vendor: { name: "Closed Kitchen", isLive: false } } }),
        makeCartItem({ id: "c", product: { vendorId: "vendor-3", vendor: { name: "Paused Kitchen", deliveryPreferences: { acceptingOrders: false } } } }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });
    expect(result.excludedOfflineItemCount).toBe(2);
    expect(result.vendorBreakdown).toHaveLength(1);
    expect(result.vendorBreakdown[0].items).toHaveLength(1);
  });

  it("groups items by vendor and sums subtotals correctly", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        // vendor-1: 2 × 100000 kobo (₦2,000)
        makeCartItem({ id: "a", quantity: 2, unitPrice: 100000 }),
        // vendor-2: 1 × 50000 kobo (₦500)
        makeCartItem({
          id: "b",
          quantity: 1,
          unitPrice: 50000,
          product: { vendorId: "vendor-2", vendor: { name: "Suya Spot", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } } },
        }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });
    expect(result.vendorBreakdown).toHaveLength(2);
    // Phase 3A: subtotal is integer kobo: 200000 + 50000 = 250000.
    expect(result.subtotal).toBe(250000);

    const vendor1 = result.vendorBreakdown.find((v) => v.vendorId === "vendor-1")!;
    expect(vendor1.subtotal).toBe(200000);
  });

  it("computes delivery fee per vendor only when addressId is provided", async () => {
    mockedFindFirst.mockResolvedValue({ items: [makeCartItem()] });
    // Phase 3A: delivery fee and vendor subtotal are integer kobo.
    mockedDeliveryFee.mockResolvedValue({ fee: 45000, distanceKm: 3.2, withinRange: true, freeDelivery: false });

    const result = await cartSummaryService({ userId: "user-1", addressId: "addr-1" });
    expect(mockedDeliveryFee).toHaveBeenCalledWith("vendor-1", "addr-1", 200000);
    expect(result.deliveryFee).toBe(45000);
    expect(result.finalTotal).toBe(245000);
  });

  it("skips delivery fee calculation entirely when no addressId is given", async () => {
    mockedFindFirst.mockResolvedValue({ items: [makeCartItem()] });

    const result = await cartSummaryService({ userId: "user-1" });
    expect(mockedDeliveryFee).not.toHaveBeenCalled();
    expect(result.deliveryFee).toBe(0);
  });

  it("surfaces a warning when a vendor is out of delivery range", async () => {
    mockedFindFirst.mockResolvedValue({ items: [makeCartItem()] });
    mockedDeliveryFee.mockResolvedValue({ fee: 300000, distanceKm: 45, withinRange: false, freeDelivery: false });

    const result = await cartSummaryService({ userId: "user-1", addressId: "addr-1" });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Mama Put");
  });

  it("applies an automatic vendor-wide percentage discount with no promo code", async () => {
    mockedPromotionFindMany.mockResolvedValue([
      {
        id: "promo-wide",
        code: null,
        type: DiscountType.PERCENTAGE,
        value: 10,
        maxDiscount: null,
        scope: PromotionScope.VENDOR_WIDE,
        isActive: true,
        startsAt: null,
        expiresAt: null,
        usageLimit: null,
        usedCount: 0,
        vendorId: "vendor-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        products: [],
      },
    ]);
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({
          id: "a",
          quantity: 1,
          // Phase 3A: unitPrice is integer kobo (₦5,000 = 500000 kobo).
          unitPrice: 500000,
          productId: "prod-1",
          product: { id: "prod-1", price: 500000, vendorId: "vendor-1" },
        }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });
    // Phase 3A: discount and totals are integer kobo: 10% of 500000 = 50000 kobo (₦500).
    expect(result.autoDiscount).toBe(50000);
    expect(result.codeDiscount).toBe(0);
    expect(result.discount).toBe(50000);
    expect(result.finalTotal).toBe(450000);
    expect(result.vendorBreakdown[0].autoDiscount).toBe(50000);
    expect(result.vendorBreakdown[0].items[0].effectiveUnitPrice).toBe(450000);
    expect(result.vendorBreakdown[0].items[0].promotionId).toBe("promo-wide");
  });

  it("single-product automatic promos discount only the linked product", async () => {
    mockedPromotionFindMany.mockResolvedValue([
      {
        id: "promo-single",
        code: null,
        type: DiscountType.FIXED,
        // Phase 3A: Promotion.value for FIXED is fixed naira (₦500).
        value: 500,
        maxDiscount: null,
        scope: PromotionScope.SINGLE_PRODUCT,
        isActive: true,
        startsAt: null,
        expiresAt: null,
        usageLimit: null,
        usedCount: 0,
        vendorId: "vendor-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        products: [{ id: "prod-1" }],
      },
    ]);
    mockedFindFirst.mockResolvedValue({
      items: [
        // prod-1: 500000 kobo (₦5,000); prod-2: 300000 kobo (₦3,000).
        makeCartItem({ id: "a", quantity: 1, unitPrice: 500000, productId: "prod-1", product: { id: "prod-1", price: 500000, vendorId: "vendor-1" } }),
        makeCartItem({ id: "b", quantity: 1, unitPrice: 300000, productId: "prod-2", product: { id: "prod-2", price: 300000, vendorId: "vendor-1" } }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });
    // Phase 3A: all totals are integer kobo.
    expect(result.subtotal).toBe(800000);
    expect(result.autoDiscount).toBe(50000); // ₦500 fixed → 50000 kobo off prod-1 only
    expect(result.finalTotal).toBe(750000);
    const lines = result.vendorBreakdown[0].items;
    expect(lines.find((l) => l.productId === "prod-1")!.effectiveUnitPrice).toBe(450000);
    expect(lines.find((l) => l.productId === "prod-2")!.effectiveUnitPrice).toBe(300000);
  });

  it("includes an active legacy option surcharge in the customer quote", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({
          id: "active-line",
          quantity: 1,
          // Phase 3A: unitPrice is integer kobo (₦2,100 = 210000 kobo).
          unitPrice: 210000,
          productId: "prod-1",
          product: { id: "prod-1", price: 200000, vendorId: "vendor-1" },
          options: [{
            id: "cio-active",
            cartItemId: "active-line",
            productOptionId: LEGACY_ACTIVE_ID,
            optionGroupItemId: null,
            name: "Extra Meat",
            // Phase 3A: option price is integer kobo (₦100 = 10000 kobo).
            price: 10000,
            productOption: { id: LEGACY_ACTIVE_ID, isActive: true },
          }],
        }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });

    expect(result.subtotal).toBe(210000);
    expect(result.finalTotal).toBe(210000);
    expect(result.warnings).toEqual([]);
    expect(result.unavailableLegacyOptions).toEqual([]);
    expect(result.vendorBreakdown[0].items[0]).toMatchObject({
      productId: "prod-1",
      unitPrice: 210000,
      subtotal: 210000,
      originalUnitPrice: 210000,
      effectiveUnitPrice: 210000,
    });
  });

  it("excludes an inactive legacy option from every quoted total and preserves its identifiers", async () => {
    const staleOption = {
      id: "cio-stale",
      cartItemId: "stale-line",
      productOptionId: LEGACY_INACTIVE_ID,
      optionGroupItemId: null,
      name: "Retired Extra",
      // Phase 3A: option price is integer kobo (₦100 = 10000 kobo).
      price: 10000,
      productOption: { id: LEGACY_INACTIVE_ID, isActive: false },
    };
    const staleLine = makeCartItem({
      id: "stale-line",
      quantity: 1,
      // Phase 3A: unitPrice is integer kobo (₦2,100 = 210000 kobo).
      unitPrice: 210000,
      productId: "prod-1",
      product: { id: "prod-1", price: 200000, vendorId: "vendor-1" },
      options: [staleOption],
    });
    const validLine = makeCartItem({
      id: "valid-line",
      quantity: 1,
      // Phase 3A: unitPrice is integer kobo (₦2,000 = 200000 kobo).
      unitPrice: 200000,
      productId: "prod-2",
      product: { id: "prod-2", name: "Suya", price: 200000, vendorId: "vendor-1" },
    });
    const optionsBefore = JSON.parse(JSON.stringify(staleLine.options));

    mockedFindFirst.mockResolvedValue({ items: [staleLine, validLine] });
    mockedDeliveryFee.mockResolvedValue({
      fee: 45000,
      distanceKm: 3.2,
      withinRange: true,
      freeDelivery: false,
    });

    const result = await cartSummaryService({ userId: "user-1", addressId: "addr-1" });

    // Phase 3A: totals are integer kobo; valid line only (200000 kobo).
    expect(result.subtotal).toBe(200000);
    expect(result.finalTotal).toBe(245000);
    expect(result.vendorBreakdown[0].subtotal).toBe(200000);
    expect(result.vendorBreakdown[0].items).toHaveLength(1);
    expect(result.vendorBreakdown[0].items[0]).toMatchObject({
      productId: "prod-2",
      unitPrice: 200000,
      subtotal: 200000,
    });
    expect(mockedDeliveryFee).toHaveBeenCalledWith("vendor-1", "addr-1", 200000);
    expect(result.unavailableLegacyOptions).toEqual([{
      cartItemId: "stale-line",
      cartItemOptionId: "cio-stale",
      productOptionId: LEGACY_INACTIVE_ID,
      name: "Retired Extra",
      reason: "INACTIVE",
    }]);
    expect(result.warnings).toEqual([expect.stringContaining("Retired Extra")]);
    expect(staleLine.options).toEqual(optionsBefore);
    expect(staleOption.price).toBe(10000);
  });

  it("does not include stale legacy lines in automatic promotion bases", async () => {
    mockedPromotionFindMany.mockResolvedValue([
      {
        id: "promo-wide",
        code: null,
        type: DiscountType.PERCENTAGE,
        value: 10,
        maxDiscount: null,
        scope: PromotionScope.VENDOR_WIDE,
        isActive: true,
        startsAt: null,
        expiresAt: null,
        usageLimit: null,
        usedCount: 0,
        vendorId: "vendor-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        products: [],
      },
    ]);
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({
          id: "stale-line",
          quantity: 1,
          // Phase 3A: unitPrice is integer kobo (₦2,100 = 210000 kobo).
          unitPrice: 210000,
          productId: "prod-1",
          product: { id: "prod-1", price: 200000, vendorId: "vendor-1" },
          options: [{
            id: "cio-stale",
            cartItemId: "stale-line",
            productOptionId: LEGACY_INACTIVE_ID,
            optionGroupItemId: null,
            name: "Retired Extra",
            // Phase 3A: option price is integer kobo (₦100 = 10000 kobo).
            price: 10000,
            productOption: { id: LEGACY_INACTIVE_ID, isActive: false },
          }],
        }),
        makeCartItem({
          id: "valid-line",
          quantity: 1,
          // Phase 3A: unitPrice is integer kobo (₦2,000 = 200000 kobo).
          unitPrice: 200000,
          productId: "prod-2",
          product: { id: "prod-2", name: "Suya", price: 200000, vendorId: "vendor-1" },
        }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });

    // Phase 3A: totals are integer kobo; valid line only (200000 kobo).
    expect(result.subtotal).toBe(200000);
    expect(result.autoDiscount).toBe(20000); // 10% of 200000 = 20000 kobo
    expect(result.finalTotal).toBe(180000);
    expect(result.vendorBreakdown[0].items).toHaveLength(1);
  });

  it("preserves stale-option information when no purchasable lines remain", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({
          id: "stale-line",
          quantity: 1,
          // Phase 3A: unitPrice is integer kobo (₦2,100 = 210000 kobo).
          unitPrice: 210000,
          productId: "prod-1",
          product: { id: "prod-1", price: 200000, vendorId: "vendor-1" },
          options: [{
            id: "cio-stale",
            cartItemId: "stale-line",
            productOptionId: LEGACY_INACTIVE_ID,
            optionGroupItemId: null,
            name: "Retired Extra",
            // Phase 3A: option price is integer kobo (₦100 = 10000 kobo).
            price: 10000,
            productOption: { id: LEGACY_INACTIVE_ID, isActive: false },
          }],
        }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });

    expect(result.vendorBreakdown).toEqual([]);
    expect(result.subtotal).toBe(0);
    expect(result.finalTotal).toBe(0);
    expect(result.deliveryFee).toBe(0);
    expect(result.excludedOfflineItemCount).toBe(0);
    expect(result.promo.meta).toMatchObject({ reason: "No purchasable items" });
    expect(result.unavailableLegacyOptions).toHaveLength(1);
    expect(result.unavailableLegacyOptions[0]).toMatchObject({
      name: "Retired Extra",
      productOptionId: LEGACY_INACTIVE_ID,
    });
    expect(result.warnings[0]).toContain("Retired Extra");
  });

  it("treats a missing legacy option relation as unavailable instead of trusting its snapshot", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({
          id: "missing-line",
          quantity: 1,
          // Phase 3A: unitPrice is integer kobo (₦2,075 = 207500 kobo).
          unitPrice: 207500,
          productId: "prod-1",
          product: { id: "prod-1", price: 200000, vendorId: "vendor-1" },
          options: [{
            id: "cio-missing",
            cartItemId: "missing-line",
            productOptionId: LEGACY_MISSING_ID,
            optionGroupItemId: null,
            name: "Deleted Extra",
            // Phase 3A: option price is integer kobo (₦75 = 7500 kobo).
            price: 7500,
            productOption: null,
          }],
        }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });

    expect(result.subtotal).toBe(0);
    expect(result.vendorBreakdown).toEqual([]);
    expect(result.unavailableLegacyOptions).toEqual([{
      cartItemId: "missing-line",
      cartItemOptionId: "cio-missing",
      productOptionId: LEGACY_MISSING_ID,
      name: "Deleted Extra",
      reason: "MISSING",
    }]);
    expect(result.warnings[0]).toContain("Deleted Extra");
  });

  it("leaves the new OptionGroupItem summary path unchanged", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({
          id: "new-line",
          quantity: 1,
          // Phase 3A: unitPrice is integer kobo (₦2,500 = 250000 kobo).
          unitPrice: 250000,
          productId: "prod-1",
          product: { id: "prod-1", price: 200000, vendorId: "vendor-1" },
          options: [{
            id: "cio-new",
            cartItemId: "new-line",
            productOptionId: null,
            optionGroupItemId: OPTION_GROUP_ITEM_ID,
            name: "Chicken",
            // Phase 3A: option price is integer kobo (₦500 = 50000 kobo).
            price: 50000,
            productOption: null,
          }],
        }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });

    // Phase 3A: totals are integer kobo.
    expect(result.subtotal).toBe(250000);
    expect(result.finalTotal).toBe(250000);
    expect(result.warnings).toEqual([]);
    expect(result.unavailableLegacyOptions).toEqual([]);
    expect(result.vendorBreakdown[0].items[0]).toMatchObject({
      productId: "prod-1",
      unitPrice: 250000,
      subtotal: 250000,
      originalUnitPrice: 250000,
      effectiveUnitPrice: 250000,
    });
  });
});

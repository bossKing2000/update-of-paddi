/**
 * Canonical promotion resolution (promotionPricing.service).
 *
 * The same promotion must produce the same effective price on Home,
 * product detail, cart and checkout — these tests pin the single
 * resolver every surface delegates to.
 */

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: { promotion: { findMany: jest.fn() } },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

import prisma from "../../src/lib/prisma";
import { redisProducts } from "../../src/lib/redis";
import { DiscountType, PromotionScope } from "@prisma/client";
import {
  attachPromotions,
  computeDiscountedPrice,
  isPromoInWindow,
  loadActiveProductPromos,
  resolveEffectivePromotionForProduct,
  type LoadedProductPromo,
} from "../../src/services/promotionPricing.service";

const db = prisma as unknown as { promotion: { findMany: jest.Mock } };
const cache = redisProducts as unknown as {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};

const promo = (overrides: Partial<LoadedProductPromo> = {}): LoadedProductPromo => ({
  id: "promo-1",
  code: null,
  type: DiscountType.PERCENTAGE,
  value: 10,
  maxDiscount: null,
  scope: PromotionScope.SINGLE_PRODUCT,
  isActive: true,
  startsAt: null,
  expiresAt: null,
  usageLimit: null,
  usedCount: 0,
  vendorId: "vendor-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  productIds: ["prod-1"],
  ...overrides,
});

const product = (overrides = {}) => ({
  id: "prod-1",
  price: 5000,
  vendorId: "vendor-1",
  archived: false,
  ...overrides,
});

describe("computeDiscountedPrice", () => {
  it("PERCENTAGE: ₦5,000 at 10% OFF is ₦4,500", () => {
    expect(
      computeDiscountedPrice({ type: DiscountType.PERCENTAGE, value: 10, maxDiscount: null, originalPrice: 5000 }),
    ).toBe(4500);
  });

  it("PERCENTAGE: caps the naira discount at maxDiscount", () => {
    expect(
      computeDiscountedPrice({ type: DiscountType.PERCENTAGE, value: 50, maxDiscount: 200, originalPrice: 1000 }),
    ).toBe(800);
  });

  it("FIXED: ₦5,000 with ₦500 OFF is ₦4,500 and never goes negative", () => {
    expect(
      computeDiscountedPrice({ type: DiscountType.FIXED, value: 500, maxDiscount: null, originalPrice: 5000 }),
    ).toBe(4500);
    expect(
      computeDiscountedPrice({ type: DiscountType.FIXED, value: 9000, maxDiscount: null, originalPrice: 5000 }),
    ).toBe(0);
  });

  it("DELIVERY never discounts a product price", () => {
    expect(
      computeDiscountedPrice({ type: DiscountType.DELIVERY, value: 500, maxDiscount: null, originalPrice: 5000 }),
    ).toBe(5000);
  });
});

describe("isPromoInWindow", () => {
  it("rejects inactive, not-yet-started, expired and exhausted promos", () => {
    const base = promo();
    expect(isPromoInWindow({ ...base, isActive: false })).toBe(false);
    expect(isPromoInWindow({ ...base, startsAt: new Date(Date.now() + 3600_000) })).toBe(false);
    expect(isPromoInWindow({ ...base, expiresAt: new Date(Date.now() - 1000) })).toBe(false);
    expect(isPromoInWindow({ ...base, usageLimit: 5, usedCount: 5 })).toBe(false);
    expect(isPromoInWindow(base)).toBe(true);
  });
});

describe("resolveEffectivePromotionForProduct", () => {
  it("SINGLE_PRODUCT applies to exactly the linked product", () => {
    const p = promo({ scope: PromotionScope.SINGLE_PRODUCT, productIds: ["prod-1"] });
    const hit = resolveEffectivePromotionForProduct({ product: product(), promos: [p] });
    expect(hit?.discountedPrice).toBe(4500);
    expect(hit?.discountAmount).toBe(500);
    expect(hit?.requiresCode).toBe(false);
    const miss = resolveEffectivePromotionForProduct({ product: product({ id: "prod-2" }), promos: [p] });
    expect(miss).toBeNull();
  });

  it("SELECTED_PRODUCTS covers each selected product and nothing else", () => {
    const p = promo({ scope: PromotionScope.SELECTED_PRODUCTS, productIds: ["prod-1", "prod-3"] });
    expect(
      resolveEffectivePromotionForProduct({ product: product({ id: "prod-3" }), promos: [p] })?.discountedPrice,
    ).toBe(4500);
    expect(resolveEffectivePromotionForProduct({ product: product({ id: "prod-9" }), promos: [p] })).toBeNull();
  });

  it("VENDOR_WIDE covers every product of the vendor only", () => {
    const p = promo({ scope: PromotionScope.VENDOR_WIDE, productIds: [] });
    expect(
      resolveEffectivePromotionForProduct({ product: product({ id: "anything" }), promos: [p] })?.discountedPrice,
    ).toBe(4500);
    expect(
      resolveEffectivePromotionForProduct({
        product: product({ id: "anything", vendorId: "vendor-2" }),
        promos: [p],
      }),
    ).toBeNull();
  });

  it("VENDOR_WIDE FIXED: ₦5,000 with ₦500 OFF EVERYTHING is ₦4,500", () => {
    const p = promo({ scope: PromotionScope.VENDOR_WIDE, type: DiscountType.FIXED, value: 500, productIds: [] });
    const hit = resolveEffectivePromotionForProduct({ product: product({ id: "any-new-product" }), promos: [p] });
    expect(hit?.discountedPrice).toBe(4500);
    expect(hit?.discountType).toBe(DiscountType.FIXED);
  });

  it("a product created after a vendor-wide promo automatically qualifies", () => {
    const p = promo({ scope: PromotionScope.VENDOR_WIDE, productIds: [] });
    const hit = resolveEffectivePromotionForProduct({
      product: product({ id: "prod-created-later" }),
      promos: [p],
    });
    expect(hit?.promotionId).toBe("promo-1");
  });

  it("ignores expired, inactive and archived combinations", () => {
    expect(
      resolveEffectivePromotionForProduct({
        product: product(),
        promos: [promo({ expiresAt: new Date(Date.now() - 1000) })],
      }),
    ).toBeNull();
    expect(
      resolveEffectivePromotionForProduct({ product: product(), promos: [promo({ isActive: false })] }),
    ).toBeNull();
    expect(resolveEffectivePromotionForProduct({ product: product({ archived: true }), promos: [promo()] })).toBeNull();
  });

  it("never resolves DELIVERY promos to a product price", () => {
    const p = promo({ type: DiscountType.DELIVERY, value: 500, scope: PromotionScope.VENDOR_WIDE, productIds: [] });
    expect(resolveEffectivePromotionForProduct({ product: product(), promos: [p] })).toBeNull();
  });

  it("marks code-gated campaigns as requiring a code", () => {
    const p = promo({ code: "WELCOME500" });
    const hit = resolveEffectivePromotionForProduct({ product: product(), promos: [p] });
    expect(hit?.requiresCode).toBe(true);
    expect(hit?.code).toBe("WELCOME500");
  });

  it("conflict rule: product-specific beats vendor-wide", () => {
    const wide = promo({
      id: "wide",
      scope: PromotionScope.VENDOR_WIDE,
      value: 20,
      productIds: [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const specific = promo({
      id: "specific",
      scope: PromotionScope.SINGLE_PRODUCT,
      value: 10,
      productIds: ["prod-1"],
      createdAt: new Date("2026-06-01T00:00:00Z"),
    });
    const hit = resolveEffectivePromotionForProduct({ product: product(), promos: [wide, specific] });
    expect(hit?.promotionId).toBe("specific");
    expect(hit?.discountedPrice).toBe(4500);
  });

  it("conflict tie-break: larger discount wins at the same specificity", () => {
    const small = promo({ id: "small", scope: PromotionScope.VENDOR_WIDE, value: 10, productIds: [] });
    const big = promo({ id: "big", scope: PromotionScope.VENDOR_WIDE, value: 25, productIds: [] });
    const hit = resolveEffectivePromotionForProduct({ product: product(), promos: [small, big] });
    expect(hit?.promotionId).toBe("big");
    expect(hit?.discountedPrice).toBe(3750);
  });

  it("ignores promos whose computed discount is zero", () => {
    const p = promo({ value: 0 });
    expect(resolveEffectivePromotionForProduct({ product: product(), promos: [p] })).toBeNull();
  });
});

describe("attachPromotions", () => {
  it("attaches the same effective promotion batch-wide (one source, no per-surface math)", () => {
    const p = promo({ scope: PromotionScope.VENDOR_WIDE, productIds: [] });
    const [a, b] = attachPromotions([product({ id: "a" }), product({ id: "b", vendorId: "vendor-2" })], [p]);
    expect(a.promotion?.discountedPrice).toBe(4500);
    expect(b.promotion).toBeNull();
  });
});

describe("loadActiveProductPromos", () => {
  beforeEach(() => jest.clearAllMocks());

  it("serves the cached list without hitting the database", async () => {
    const cached = [promo()];
    cache.get.mockResolvedValue(JSON.stringify(cached));
    const result = await loadActiveProductPromos();
    expect(db.promotion.findMany).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("promo-1");
    expect(result[0].startsAt).toBeNull();
  });

  it("loads from DB, drops exhausted promos, maps product ids, and caches", async () => {
    cache.get.mockResolvedValue(null);
    db.promotion.findMany.mockResolvedValue([
      { ...promo({ id: "live" }), products: [{ id: "prod-1" }] },
      { ...promo({ id: "spent", usageLimit: 2, usedCount: 2 }), products: [] },
    ]);
    const result = await loadActiveProductPromos();
    expect(result.map((p) => p.id)).toEqual(["live"]);
    expect(result[0].productIds).toEqual(["prod-1"]);
    expect(cache.set).toHaveBeenCalled();
  });

  it("degrades to an empty list when the database is unavailable", async () => {
    cache.get.mockResolvedValue(null);
    db.promotion.findMany.mockRejectedValue(new Error("db down"));
    await expect(loadActiveProductPromos()).resolves.toEqual([]);
  });
});

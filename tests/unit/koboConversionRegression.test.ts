/**
 * Regression tests for Phase 3A kobo conversion defects.
 *
 * These tests pin the corrected behaviour so the defects identified in the
 * post-implementation review cannot regress:
 *
 * 1. cartController.ts checkout persisted PromotionUsage.discount as
 *    `Math.round(freshSummary.discount * 100)` — double-converting kobo
 *    already in kobo. Corrected to pass kobo through unchanged.
 * 2. cartController.ts checkout persisted auto-promo discount as
 *    `Math.round((autoDiscountByPromo.get(...) ?? 0) * 100)` — same
 *    double-conversion. Corrected to pass kobo through unchanged.
 * 3. promoService.ts applyPromoService minOrderAmount check compared
 *    `Math.round(eligibleSubtotal * 100)` (kobo * 100) against
 *    `promo.minOrderAmount` (kobo). Corrected to compare kobo directly.
 */

import { DiscountType, PromotionScope } from "@prisma/client";
import { computeDiscountedPrice } from "../../src/services/promotionPricing.service";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findMany: jest.fn(), create: jest.fn() },
    cart: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    product: { findMany: jest.fn(), findUnique: jest.fn() },
    optionGroup: { findMany: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    address: { findFirst: jest.fn() },
    cartSummarySnapshot: { findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
    cartItem: { deleteMany: jest.fn() },
    cartItemOption: { deleteMany: jest.fn() },
    orderItem: { create: jest.fn() },
    promotion: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    promotionUsage: { count: jest.fn(), create: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  redisPayments: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
  },
  redisProducts: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
  ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
}));

jest.mock("../../src/services/cartSummary.service", () => ({
  cartSummaryService: jest.fn(),
}));

jest.mock("../../src/services/deliveryFee.service", () => ({
  calculateDeliveryFee: jest.fn(),
}));

jest.mock("../../src/services/inventory.service", () => ({
  reserveStockForItems: jest.fn(async () => []),
  assertQuantityAvailable: jest.fn(),
}));

import { cartSummaryService } from "../../src/services/cartSummary.service";
import { applyPromoService } from "../../src/services/promoService";
import prisma from "../../src/lib/prisma";
import { checkoutCart } from "../../src/controllers/cartController";

const db = prisma as unknown as {
  order: { findMany: jest.Mock; create: jest.Mock };
  cart: {
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  product: { findMany: jest.Mock; findUnique: jest.Mock };
  optionGroup: { findMany: jest.Mock };
  user: { findUnique: jest.Mock; findMany: jest.Mock };
  address: { findFirst: jest.Mock };
  cartSummarySnapshot: { findUnique: jest.Mock; create: jest.Mock; delete: jest.Mock };
  auditLog: { create: jest.Mock };
  cartItem: { deleteMany: jest.Mock };
  cartItemOption: { deleteMany: jest.Mock };
  orderItem: { create: jest.Mock };
  promotion: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
  promotionUsage: { count: jest.Mock; create: jest.Mock };
  $transaction: jest.Mock;
};

const mockedCartSummaryService = cartSummaryService as jest.Mock;

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json } as any;
}

function makeReq(overrides: any = {}) {
  return {
    user: { id: "customer-1" },
    headers: { "idempotency-key": "idem-key-1" },
    body: { summaryId: "summary-1", addressId: "addr-1" },
    ...overrides,
  } as any;
}

function makeCartItem(overrides: any = {}) {
  return {
    id: "item-1",
    cartId: "cart-1",
    productId: "prod-1",
    quantity: 1,
    unitPrice: 500000, // kobo (₦5,000)
    subtotal: 500000, // kobo
    options: [],
    product: {
      id: "prod-1",
      name: "Jollof Rice",
      images: ["img.png"],
      archived: false,
      vendorId: "vendor-1",
      vendor: {
        name: "Mama Put",
        isLive: true,
        vendorStatus: "ACTIVE",
        deliveryPreferences: { acceptingOrders: true },
      },
      ...(overrides.product || {}),
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  // Default: no existing orders for the idempotency key
  (db.order.findMany as jest.Mock).mockResolvedValue([]);
  // Cart with one item
  (db.cart.findFirst as jest.Mock).mockResolvedValue({
    id: "cart-1",
    customerId: "customer-1",
    items: [makeCartItem()],
  });
  // Customer exists (for customer ID lookups)
  (db.user.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
    if (where.id === "vendor-1") {
      return {
        id: "vendor-1",
        isLive: true,
        vendorStatus: "ACTIVE",
        deliveryPreferences: { acceptingOrders: true },
        kycStatus: null,
      };
    }
    return { id: "customer-1", email: "customer@example.com" };
  });
  // Vendor rates for commission calculation
  (db.user.findMany as jest.Mock).mockResolvedValue([
    { id: "vendor-1", commissionRate: 0.15 },
  ]);
  // Address exists
  (db.address.findFirst as jest.Mock).mockResolvedValue({ id: "addr-1", userId: "customer-1" });
  // No active promotions
  (db.promotion.findMany as jest.Mock).mockResolvedValue([]);
  // No option groups
  (db.optionGroup.findMany as jest.Mock).mockResolvedValue([]);
  // Product exists with kobo price
  (db.product.findMany as jest.Mock).mockResolvedValue([
    {
      id: "prod-1",
      name: "Jollof Rice",
      price: 500000, // kobo
      archived: false,
      trackInventory: false,
      stock: null,
      vendorId: "vendor-1",
      options: [],
    },
  ]);
  (db.product.findUnique as jest.Mock).mockResolvedValue({
    id: "prod-1",
    name: "Jollof Rice",
    price: 500000,
    archived: false,
    trackInventory: false,
    stock: null,
    vendorId: "vendor-1",
    options: [],
  });
  // Audit log create succeeds
  (db.auditLog.create as jest.Mock).mockResolvedValue({});
  // Snapshot exists with valid vendorBreakdown (kobo values)
  (db.cartSummarySnapshot.findUnique as jest.Mock).mockResolvedValue({
    id: "summary-1",
    userId: "customer-1",
    snapshot: {
      vendorBreakdown: [
        {
          vendorId: "vendor-1",
          vendorName: "Mama Put",
          items: [
            {
              productId: "prod-1",
              name: "Jollof Rice",
              image: null,
              quantity: 1,
              unitPrice: 500000,
              subtotal: 500000,
              originalUnitPrice: 500000,
              effectiveUnitPrice: 500000,
              unitDiscount: 0,
              promotionId: null,
            },
          ],
          subtotal: 500000,
          discount: 0,
          autoDiscount: 0,
          codeDiscount: 0,
          deliveryFee: 0,
          final: 500000,
        },
      ],
      discount: 0,
      autoDiscount: 0,
      codeDiscount: 0,
      deliveryFee: 0,
      finalTotal: 500000,
      promo: { code: null, applied: false, promoId: null, meta: null },
    },
    createdAt: new Date(),
  });
  // Cart lock succeeds
  (db.cart.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  // Order create succeeds
  (db.order.create as jest.Mock).mockResolvedValue({ id: "order-1" });
  // PromotionUsage create succeeds
  (db.promotionUsage.create as jest.Mock).mockResolvedValue({ id: "usage-1" });
  // Snapshot delete succeeds
  (db.cartSummarySnapshot.delete as jest.Mock).mockResolvedValue({});
  // $transaction passes through to the mock db
  (db.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
    cb(db),
  );
});

describe("cartController checkout — discount persisted in kobo (no double conversion)", () => {
  it("persists code-promo discount as kobo (₦500 = 50000 kobo, not 5000000)", async () => {
    (mockedCartSummaryService as jest.Mock).mockResolvedValue({
      vendorBreakdown: [
        {
          vendorId: "vendor-1",
          vendorName: "Mama Put",
          items: [
            {
              productId: "prod-1",
              name: "Jollof Rice",
              image: null,
              quantity: 1,
              unitPrice: 500000,
              subtotal: 500000,
              originalUnitPrice: 500000,
              effectiveUnitPrice: 450000,
              unitDiscount: 50000,
              promotionId: "promo-1",
            },
          ],
          subtotal: 500000,
          discount: 50000, // kobo (₦500) — NOT naira
          autoDiscount: 0,
          codeDiscount: 50000,
          deliveryFee: 0,
          final: 450000,
        },
      ],
      discount: 50000, // kobo
      autoDiscount: 0,
      codeDiscount: 50000,
      deliveryFee: 0,
      finalTotal: 450000,
      promo: {
        code: "SAVE500",
        applied: true,
        promoId: "promo-1",
        meta: { discountType: "FIXED", reason: null },
      },
      excludedOfflineItemCount: 0,
      unavailableLegacyOptions: [],
      warnings: [],
    });

    // Promotion exists and is eligible
    (db.promotion.findUnique as jest.Mock).mockResolvedValue({
      id: "promo-1",
      code: "SAVE500",
      vendorId: "vendor-1",
      isActive: true,
      startsAt: null,
      expiresAt: null,
      usageLimit: null,
      usedCount: 0,
      maxUsesPerUser: 1,
    });
    (db.promotionUsage.count as jest.Mock).mockResolvedValue(0);
    (db.promotion.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    // Snapshot must match fresh summary for price comparison to pass
    (db.cartSummarySnapshot.findUnique as jest.Mock).mockResolvedValue({
      id: "summary-1",
      userId: "customer-1",
      snapshot: {
        vendorBreakdown: [
          {
            vendorId: "vendor-1",
            vendorName: "Mama Put",
            items: [
              {
                productId: "prod-1",
                name: "Jollof Rice",
                image: null,
                quantity: 1,
                unitPrice: 500000,
                subtotal: 500000,
                originalUnitPrice: 500000,
                effectiveUnitPrice: 450000,
                unitDiscount: 50000,
                promotionId: "promo-1",
              },
            ],
            subtotal: 500000,
            discount: 50000,
            autoDiscount: 0,
            codeDiscount: 50000,
            deliveryFee: 0,
            final: 450000,
          },
        ],
        discount: 50000,
        autoDiscount: 0,
        codeDiscount: 50000,
        deliveryFee: 0,
        finalTotal: 450000,
        promo: {
          code: "SAVE500",
          applied: true,
          promoId: "promo-1",
          meta: { discountType: "FIXED", reason: null },
        },
      },
      createdAt: new Date(),
    });

    const res = makeRes();
    await checkoutCart(makeReq(), res);

    // Verify promotionUsage.create was called with discount = 50000 kobo,
    // NOT discount = 50000 * 100 = 5000000.
    expect(db.promotionUsage.create).toHaveBeenCalledTimes(1);
    const call = (db.promotionUsage.create as jest.Mock).mock.calls[0][0];
    expect(call.data.discount).toBe(50000);
    expect(call.data.discount).not.toBe(5000000);
    expect(call.data.promoCode).toBe("SAVE500");
  });

  it("persists auto-promo discount as kobo (₦500 = 50000 kobo, not 5000000)", async () => {
    // freshSummary reports an automatic promo (applied: false), so promoClaimed
    // stays false and the auto-promotion path runs. Cart items carry promotionId
    // "promo-auto", which populates autoDiscountByPromo. The code-promo path
    // (promoClaimed && freshSummary.promo?.promoId) is skipped because applied
    // is false.
    (mockedCartSummaryService as jest.Mock).mockResolvedValue({
      vendorBreakdown: [
        {
          vendorId: "vendor-1",
          vendorName: "Mama Put",
          items: [
            {
              productId: "prod-1",
              name: "Jollof Rice",
              image: null,
              quantity: 1,
              unitPrice: 500000,
              subtotal: 500000,
              originalUnitPrice: 500000,
              effectiveUnitPrice: 450000,
              unitDiscount: 50000, // kobo (₦500)
              promotionId: "promo-auto",
            },
          ],
          subtotal: 500000,
          discount: 50000,
          autoDiscount: 50000,
          codeDiscount: 0,
          deliveryFee: 0,
          final: 450000,
        },
      ],
      discount: 50000,
      autoDiscount: 50000,
      codeDiscount: 0,
      deliveryFee: 0,
      finalTotal: 450000,
      promo: null, // no promo applied → promoClaimed stays false
      excludedOfflineItemCount: 0,
      unavailableLegacyOptions: [],
      warnings: [],
    });

    // No code promo to claim; promoClaimed stays false.
    (db.promotion.findUnique as jest.Mock).mockResolvedValue({
      id: "promo-auto",
      code: null,
      vendorId: "vendor-1",
      isActive: true,
      startsAt: null,
      expiresAt: null,
      usageLimit: null,
      usedCount: 0,
      maxUsesPerUser: 1,
    });
    (db.promotionUsage.count as jest.Mock).mockResolvedValue(0);
    (db.promotion.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    // Snapshot must match fresh summary for price comparison to pass.
    (db.cartSummarySnapshot.findUnique as jest.Mock).mockResolvedValue({
      id: "summary-1",
      userId: "customer-1",
      snapshot: {
        vendorBreakdown: [
          {
            vendorId: "vendor-1",
            vendorName: "Mama Put",
            items: [
              {
                productId: "prod-1",
                name: "Jollof Rice",
                image: null,
                quantity: 1,
                unitPrice: 500000,
                subtotal: 500000,
                originalUnitPrice: 500000,
                effectiveUnitPrice: 450000,
                unitDiscount: 50000,
                promotionId: "promo-auto",
              },
            ],
            subtotal: 500000,
            discount: 50000,
            autoDiscount: 50000,
            codeDiscount: 0,
            deliveryFee: 0,
            final: 450000,
          },
        ],
        discount: 50000,
        autoDiscount: 50000,
        codeDiscount: 0,
        deliveryFee: 0,
        finalTotal: 450000,
        promo: null,
      },
      createdAt: new Date(),
    });

    const res = makeRes();
    await checkoutCart(makeReq(), res);

    // Verify promotionUsage.create was called with discount = 50000 kobo,
    // NOT discount = 50000 * 100 = 5000000.
    expect(db.promotionUsage.create).toHaveBeenCalledTimes(1);
    const call = (db.promotionUsage.create as jest.Mock).mock.calls[0][0];
    expect(call.data.discount).toBe(50000);
    expect(call.data.discount).not.toBe(5000000);
    expect(call.data.promoCode).toBe("AUTO"); // automatic promo — no code
  });
});

describe("promoService applyPromoService — minOrderAmount compares kobo directly", () => {
  const basePromo = {
    id: "promo-1",
    code: "TEST500",
    type: DiscountType.FIXED,
    value: 500, // naira value for FIXED type (converted to kobo at boundary)
    maxDiscount: null,
    scope: PromotionScope.VENDOR_WIDE,
    vendorId: null,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    usageLimit: null,
    usedCount: 0,
    maxUsesPerUser: 1,
    products: [],
    minOrderAmount: 50000, // kobo (₦500)
  };

  const vendorGroups = [
    { vendorId: "vendor-1", subtotal: 50000, deliveryFee: 0 }, // kobo (₦500)
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    (db.promotion.findFirst as jest.Mock).mockResolvedValue(basePromo);
    (db.promotionUsage.count as jest.Mock).mockResolvedValue(0);
    (db.promotion.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  it("subtotal below minOrderAmount kobo threshold is ineligible", async () => {
    const belowThresholdGroups = [
      { vendorId: "vendor-1", subtotal: 49999, deliveryFee: 0 }, // kobo
    ];

    const result = await applyPromoService({
      userId: "customer-1",
      promoCode: "TEST500",
      vendorGroups: belowThresholdGroups,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toContain("minimum order");
  });

  it("subtotal at minOrderAmount kobo threshold is eligible", async () => {
    const atThresholdGroups = [
      { vendorId: "vendor-1", subtotal: 50000, deliveryFee: 0 }, // kobo
    ];

    const result = await applyPromoService({
      userId: "customer-1",
      promoCode: "TEST500",
      vendorGroups: atThresholdGroups,
    });

    expect(result.applied).toBe(true);
    expect(result.totalDiscount).toBe(50000); // kobo (₦500 fixed, capped at subtotal)
  });

  it("subtotal above minOrderAmount kobo threshold is eligible", async () => {
    const aboveThresholdGroups = [
      { vendorId: "vendor-1", subtotal: 75000, deliveryFee: 0 }, // kobo
    ];

    const result = await applyPromoService({
      userId: "customer-1",
      promoCode: "TEST500",
      vendorGroups: aboveThresholdGroups,
    });

    expect(result.applied).toBe(true);
  });
});

describe("computeDiscountedPrice — integer kobo boundaries", () => {
  // These tests pin the kobo conversion at the promo pricing boundary:
  // FIXED type converts naira → kobo via Math.round(value * 100);
  // PERCENTAGE type uses value as-is (no * 100).
  // All prices are integer kobo (Product.price is kobo in the schema).

  it("FIXED: whole naira converts exactly (₦500 → 50000 kobo)", () => {
    const result = computeDiscountedPrice({
      type: DiscountType.FIXED,
      value: 500,
      maxDiscount: null,
      originalPrice: 100000, // kobo (₦1,000)
    });
    expect(result).toBe(50000); // ₦500 discount
  });

  it("FIXED: fractional naira rounds to nearest kobo (₦500.50 → 50050 kobo)", () => {
    const result = computeDiscountedPrice({
      type: DiscountType.FIXED,
      value: 500.5,
      maxDiscount: null,
      originalPrice: 100000, // kobo (₦1,000)
    });
    expect(result).toBe(49950); // original - discount = 100000 - 50050 = 49950
  });

  it("FIXED: discount capped at original price (never below zero)", () => {
    const result = computeDiscountedPrice({
      type: DiscountType.FIXED,
      value: 2000, // ₦2,000 → 200000 kobo, more than original price
      maxDiscount: null,
      originalPrice: 100000, // kobo (₦1,000)
    });
    expect(result).toBe(0);
  });

  it("PERCENTAGE: value is percentage, not multiplied by 100 (10% → valueKobo = 10)", () => {
    const result = computeDiscountedPrice({
      type: DiscountType.PERCENTAGE,
      value: 10,
      maxDiscount: null,
      originalPrice: 100000, // kobo (₦1,000)
    });
    // 10% of 100000 = 10000 kobo discount → discounted price = 90000
    expect(result).toBe(90000);
  });

  it("PERCENTAGE: capped at maxDiscount when percentage would exceed it", () => {
    const result = computeDiscountedPrice({
      type: DiscountType.PERCENTAGE,
      value: 50, // 50%
      maxDiscount: 20000, // kobo (₦200)
      originalPrice: 100000, // kobo (₦1,000)
    });
    // 50% of 100000 = 50000, capped to 20000 → discounted price = 80000
    expect(result).toBe(80000);
  });

  it("no double conversion: FIXED value already in kobo range is NOT *100 again", () => {
    // value = 0.50 (naira) → Math.round(0.50 * 100) = 50 kobo
    // If someone accidentally passed kobo as naira (e.g., 50000), it would be
    // Math.round(50000 * 100) = 5000000 — this test ensures the boundary
    // expects naira input, not kobo.
    const result = computeDiscountedPrice({
      type: DiscountType.FIXED,
      value: 0.5, // ₦0.50 → 50 kobo
      maxDiscount: null,
      originalPrice: 100000, // kobo (₦1,000)
    });
    expect(result).toBe(99950); // 100000 - 50 = 99950
  });
});

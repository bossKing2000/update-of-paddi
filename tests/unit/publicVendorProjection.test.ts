/**
 * B-1 — public vendor projection.
 *
 * The catalog used to spread the raw Prisma vendor row into anonymous
 * responses, which leaked internal moderation state (`vendorStatus`,
 * `vendorStatusReason`) and the vendor's internal delivery settings
 * (`deliveryPreferences` -> `baseDeliveryFee`, `deliveryRadiusKm`,
 * `preparationTimeMinutes`).
 *
 * These tests pin:
 *   - the projection itself (what it keeps, what it drops);
 *   - the canonical product-card mapper (browse/search/detail share it);
 *   - the executable prohibited-key list the response must satisfy.
 */
import {
  toPublicVendor,
  projectPublicVendorList,
  findProhibitedPublicVendorKeys,
  PUBLIC_VENDOR_SELECT,
  PROHIBITED_PUBLIC_VENDOR_KEYS,
} from "../../src/services/publicVendor.service";
import { buildProductCard } from "../../src/services/product.service";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn(), count: jest.fn() },
    productReview: { aggregate: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

const RAW_VENDOR = {
  id: "vendor-1",
  name: "Mama Put",
  brandName: "Mama Put Kitchen",
  brandLogo: "https://cdn.example/logo.png",
  avatarUrl: "https://cdn.example/avatar.png",
  // Everything below must be dropped by the projection.
  isLive: true,
  vendorStatus: "ACTIVE",
  vendorStatusReason: "manual review",
  deliveryPreferences: {
    acceptingOrders: true,
    baseDeliveryFee: 500,
    deliveryRadiusKm: 12,
    preparationTimeMinutes: 45,
  },
  serviceAreas: ["Yaba"],
  kycStatus: "VERIFIED",
  email: "vendor@example.com",
  phoneNumber: "+2348000000000",
  bankAccountNumber: "0123456789",
  commissionRate: 0.15,
};

describe("public vendor projection", () => {
  it("keeps identity only", () => {
    expect(toPublicVendor(RAW_VENDOR)).toEqual({
      id: "vendor-1",
      name: "Mama Put",
      brandName: "Mama Put Kitchen",
      brandLogo: "https://cdn.example/logo.png",
      avatarUrl: "https://cdn.example/avatar.png",
    });
  });

  it("drops every prohibited field", () => {
    const projected = toPublicVendor(RAW_VENDOR);
    expect(findProhibitedPublicVendorKeys(projected)).toEqual([]);
    for (const key of [
      "isLive",
      "vendorStatus",
      "vendorStatusReason",
      "deliveryPreferences",
      "serviceAreas",
      "kycStatus",
      "email",
      "phoneNumber",
      "bankAccountNumber",
      "commissionRate",
    ]) {
      expect(projected).not.toHaveProperty(key);
    }
  });

  it("never returns a raw deliveryPreferences object", () => {
    const projected = toPublicVendor(RAW_VENDOR) as unknown as Record<string, unknown>;
    expect(projected.deliveryPreferences).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("baseDeliveryFee");
    expect(JSON.stringify(projected)).not.toContain("deliveryRadiusKm");
    expect(JSON.stringify(projected)).not.toContain("preparationTimeMinutes");
  });

  it("degrades safely for a missing vendor row", () => {
    expect(toPublicVendor(null)).toEqual({
      id: "",
      name: "",
      brandName: null,
      brandLogo: null,
      avatarUrl: null,
    });
  });

  it("the Prisma select contains identity fields only", () => {
    expect(Object.keys(PUBLIC_VENDOR_SELECT).sort()).toEqual([
      "avatarUrl",
      "brandLogo",
      "brandName",
      "id",
      "name",
    ]);
    for (const key of PROHIBITED_PUBLIC_VENDOR_KEYS) {
      expect(PUBLIC_VENDOR_SELECT).not.toHaveProperty(key);
    }
  });

  it("re-projects a list whose cached entries still carry the raw vendor", () => {
    const projected = projectPublicVendorList([
      { id: "p1", vendor: RAW_VENDOR },
      { id: "p2", vendor: { id: "v2", name: "Second" } },
      { id: "p3" },
    ]);

    expect(projected[0].vendor).toEqual({
      id: "vendor-1",
      name: "Mama Put",
      brandName: "Mama Put Kitchen",
      brandLogo: "https://cdn.example/logo.png",
      avatarUrl: "https://cdn.example/avatar.png",
    });
    expect(findProhibitedPublicVendorKeys(projected[0].vendor)).toEqual([]);
    expect(projected[1].vendor).toEqual({
      id: "v2",
      name: "Second",
      brandName: null,
      brandLogo: null,
      avatarUrl: null,
    });
    // An item without a vendor key is left untouched.
    expect(projected[2]).toEqual({ id: "p3" });
  });
});

describe("canonical product card (shared by browse, search and the rails)", () => {
  const row = {
    id: "prod-1",
    name: "Jollof",
    price: 2000,
    dishType: { id: "JOLLOF", name: "Jollof" },
    thumbnail: "https://cdn.example/jollof.png",
    images: ["https://cdn.example/jollof.png", "https://cdn.example/other.png"],
    popularityPercent: 42,
    averageRating: 4.5,
    reviewCount: 7,
    portionLabel: "Family Pack",
    trackInventory: true,
    stock: 3,
    archived: false,
    vendor: RAW_VENDOR,
  };

  it("exposes the canonical customer-facing fields", () => {
    const card = buildProductCard(row);

    expect(card).toMatchObject({
      id: "prod-1",
      name: "Jollof",
      price: 2000,
      dishType: { id: "JOLLOF", name: "Jollof" },
      images: ["https://cdn.example/jollof.png"],
      popularityPercent: 42,
      averageRating: 4.5,
      reviewCount: 7,
      portionLabel: "Family Pack",
      trackInventory: true,
      stock: 3,
      soldOut: false,
      vendorOperating: true,
      orderable: true,
    });
  });

  it("exposes the vendor through the public projection only", () => {
    const card = buildProductCard(row);
    expect(findProhibitedPublicVendorKeys(card.vendor)).toEqual([]);
    expect(card.vendor).toEqual({
      id: "vendor-1",
      name: "Mama Put",
      brandName: "Mama Put Kitchen",
      brandLogo: "https://cdn.example/logo.png",
      avatarUrl: "https://cdn.example/avatar.png",
    });
  });

  it("uses card image semantics (thumbnail first, then the first image)", () => {
    expect(buildProductCard({ ...row, thumbnail: null }).images).toEqual([
      "https://cdn.example/jollof.png",
    ]);
    expect(
      buildProductCard({ ...row, thumbnail: null, images: [] }).images,
    ).toEqual([]);
  });

  it("reports sold out for a tracked product with no stock", () => {
    const card = buildProductCard({ ...row, stock: 0 });
    expect(card.soldOut).toBe(true);
    expect(card.orderable).toBe(false);
    expect(card.vendorOperating).toBe(true);
  });

  it("hides the stock of an untracked product", () => {
    const card = buildProductCard({ ...row, trackInventory: false, stock: 9 });
    expect(card.stock).toBeNull();
    expect(card.soldOut).toBe(false);
    expect(card.orderable).toBe(true);
  });

  it("is not orderable for an offline, suspended or paused vendor", () => {
    expect(buildProductCard({ ...row, vendor: { ...RAW_VENDOR, isLive: false } })).toMatchObject({
      vendorOperating: false,
      orderable: false,
    });
    expect(
      buildProductCard({ ...row, vendor: { ...RAW_VENDOR, vendorStatus: "SUSPENDED" } }),
    ).toMatchObject({ vendorOperating: false, orderable: false });
    expect(
      buildProductCard({
        ...row,
        vendor: {
          ...RAW_VENDOR,
          deliveryPreferences: { ...RAW_VENDOR.deliveryPreferences, acceptingOrders: false },
        },
      }),
    ).toMatchObject({ vendorOperating: false, orderable: false });
  });

  it("is not orderable for an archived product", () => {
    expect(buildProductCard({ ...row, archived: true })).toMatchObject({
      vendorOperating: true,
      orderable: false,
    });
  });

  it("never leaks an internal vendor field through the card", () => {
    const card = buildProductCard(row);
    expect(findProhibitedPublicVendorKeys(card.vendor)).toEqual([]);
    expect(JSON.stringify(card)).not.toContain("baseDeliveryFee");
    expect(JSON.stringify(card)).not.toContain("deliveryRadiusKm");
    expect(JSON.stringify(card)).not.toContain("preparationTimeMinutes");
    expect(JSON.stringify(card)).not.toContain("vendorStatus");
  });
});

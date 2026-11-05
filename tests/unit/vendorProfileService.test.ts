/**
 * B-2 — public vendor profile service.
 *
 * The Vendor Profile screen needs a public, read-only view of a vendor.
 * These tests pin the visibility rules and the exact fields the response
 * may carry:
 *
 *   - a malformed id is a 400 (VALIDATION_ERROR), not a 404;
 *   - an unknown / non-vendor / blocked / suspended vendor is a 404;
 *   - an offline but discoverable vendor is served with isOpen = false;
 *   - no moderation, settings, money or account field is ever returned.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    vendorReview: { aggregate: jest.fn() },
    vendorFollower: { count: jest.fn() },
    product: { count: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

import prisma from "../../src/lib/prisma";
import { loadPublicVendorProfile } from "../../src/services/vendorProfile.service";
import { ValidationError, NotFoundError } from "../../src/errors/AppError";
import { findProhibitedPublicVendorKeys } from "../../src/services/publicVendor.service";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const VENDOR_ID = "11111111-2222-4333-8444-555555555555";

const vendorRow = (overrides: Record<string, unknown> = {}) => ({
  id: VENDOR_ID,
  name: "Mama Put",
  brandName: "Mama Put Kitchen",
  brandLogo: "https://cdn.example/logo.png",
  avatarUrl: "https://cdn.example/avatar.png",
  bio: "Real home cooking, served hot.",
  isLive: true,
  vendorStatus: "ACTIVE",
  deliveryPreferences: {
    acceptingOrders: true,
    baseDeliveryFee: 500,
    deliveryRadiusKm: 12,
    preparationTimeMinutes: 45,
  },
  role: "VENDOR",
  roles: ["VENDOR"],
  isBlocked: false,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.user.findUnique.mockResolvedValue(vendorRow());
  db.vendorReview.aggregate.mockResolvedValue({
    _avg: { rating: 4.5 },
    _count: { rating: 6 },
  });
  db.vendorFollower.count.mockResolvedValue(23);
  db.product.count.mockResolvedValue(9);
});

describe("loadPublicVendorProfile — happy path", () => {
  it("returns the public profile fields", async () => {
    const profile = await loadPublicVendorProfile(VENDOR_ID);

    expect(profile).toEqual({
      id: VENDOR_ID,
      name: "Mama Put",
      brandName: "Mama Put Kitchen",
      brandLogo: "https://cdn.example/logo.png",
      avatarUrl: "https://cdn.example/avatar.png",
      bio: "Real home cooking, served hot.",
      isOpen: true,
      averageRating: 4.5,
      reviewCount: 6,
      followerCount: 23,
      productCount: 9,
    });
  });

  it("exposes no internal field", async () => {
    const profile = await loadPublicVendorProfile(VENDOR_ID);
    expect(findProhibitedPublicVendorKeys(profile)).toEqual([]);
    const serialised = JSON.stringify(profile);
    expect(serialised).not.toContain("baseDeliveryFee");
    expect(serialised).not.toContain("deliveryRadiusKm");
    expect(serialised).not.toContain("preparationTimeMinutes");
    expect(serialised).not.toContain("vendorStatus");
  });

  it("counts non-archived products only", async () => {
    await loadPublicVendorProfile(VENDOR_ID);
    expect(db.product.count).toHaveBeenCalledWith({
      where: { vendorId: VENDOR_ID, archived: false },
    });
  });

  it("reads the rating from the vendor reviews", async () => {
    await loadPublicVendorProfile(VENDOR_ID);
    expect(db.vendorReview.aggregate).toHaveBeenCalledWith({
      where: { vendorId: VENDOR_ID },
      _avg: { rating: true },
      _count: { rating: true },
    });
  });

  it("reports null rating and zero counts for a vendor with no reviews yet", async () => {
    db.vendorReview.aggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { rating: 0 },
    });
    db.vendorFollower.count.mockResolvedValue(0);
    db.product.count.mockResolvedValue(0);

    const profile = await loadPublicVendorProfile(VENDOR_ID);
    expect(profile.averageRating).toBeNull();
    expect(profile.reviewCount).toBe(0);
    expect(profile.followerCount).toBe(0);
    expect(profile.productCount).toBe(0);
  });
});

describe("loadPublicVendorProfile — operating state", () => {
  it("an offline vendor is discoverable but not open", async () => {
    db.user.findUnique.mockResolvedValue(vendorRow({ isLive: false }));
    const profile = await loadPublicVendorProfile(VENDOR_ID);
    expect(profile.isOpen).toBe(false);
  });

  it("a paused vendor is discoverable but not open", async () => {
    db.user.findUnique.mockResolvedValue(
      vendorRow({ deliveryPreferences: { acceptingOrders: false } }),
    );
    const profile = await loadPublicVendorProfile(VENDOR_ID);
    expect(profile.isOpen).toBe(false);
  });

  it("a vendor that is not ACTIVE is not open", async () => {
    db.user.findUnique.mockResolvedValue(vendorRow({ vendorStatus: "NEW" }));
    const profile = await loadPublicVendorProfile(VENDOR_ID);
    expect(profile.isOpen).toBe(false);
  });
});

describe("loadPublicVendorProfile — visibility rules", () => {
  it("rejects a malformed id with a 400", async () => {
    await expect(loadPublicVendorProfile("not-a-uuid")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an empty id with a 400", async () => {
    await expect(loadPublicVendorProfile("")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("404s an unknown vendor", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await expect(loadPublicVendorProfile(VENDOR_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("404s an account that does not hold the vendor role", async () => {
    db.user.findUnique.mockResolvedValue(
      vendorRow({ role: "CUSTOMER", roles: ["CUSTOMER"] }),
    );
    await expect(loadPublicVendorProfile(VENDOR_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("404s a blocked account", async () => {
    db.user.findUnique.mockResolvedValue(vendorRow({ isBlocked: true }));
    await expect(loadPublicVendorProfile(VENDOR_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("404s a suspended vendor", async () => {
    db.user.findUnique.mockResolvedValue(vendorRow({ vendorStatus: "SUSPENDED" }));
    await expect(loadPublicVendorProfile(VENDOR_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("accepts a vendor whose legacy `role` column is VENDOR", async () => {
    db.user.findUnique.mockResolvedValue(
      vendorRow({ role: "VENDOR", roles: [] }),
    );
    const profile = await loadPublicVendorProfile(VENDOR_ID);
    expect(profile.id).toBe(VENDOR_ID);
  });
});

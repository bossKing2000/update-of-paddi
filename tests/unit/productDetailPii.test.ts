/**
 * Phase 2C PII fix -- public product detail must not expose vendor
 * account PII (email / username / role).
 *
 * Covers GET /api/product/:id (getProductById): the Prisma vendor select,
 * the response payload, the cached payload, and availability behavior
 * using the restricted vendor shape.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findFirst: jest.fn() },
    productReview: { aggregate: jest.fn() },
    vendorReview: { aggregate: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/services/product.service", () => ({
  __esModule: true,
  trackProductView: jest.fn(async () => {}),
}));

jest.mock("../../src/jobs/workers jobs/redis-baseQueue", () => ({
  __esModule: true,
  productIndexQueue: { add: jest.fn(async () => {}) },
}));

// Real isVendorOperating / isProductCurrentlyAvailable (pure functions) so
// Test 3 proves availability works on the restricted vendor shape.
jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  loadActiveProductPromos: jest.fn(async () => []),
  attachPromotions: jest.fn((items: unknown[]) => items),
}));

import prisma from "../../src/lib/prisma";
import { redisProducts } from "../../src/lib/redis";
import { getProductById } from "../../src/controllers/productController";
import {
  PROHIBITED_PUBLIC_VENDOR_KEYS,
  findProhibitedPublicVendorKeys,
} from "../../src/services/publicVendor.service";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedGet = redisProducts.get as unknown as jest.Mock;
const mockedSet = redisProducts.set as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const req = (): any =>
  ({
    headers: {},
    body: {},
    params: { id: "prod-1" },
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
  }) as any;

const dataOf = (r: any) => r.json.mock.calls[0][0].data;

// Vendor row as the restricted Prisma select returns it: availability +
// display fields only, no account PII.
const PUBLIC_VENDOR = {
  id: "vendor-1",
  name: "Mama Put",
  brandName: "Mama Put Kitchen",
  brandLogo: "https://cdn.example/logo.png",
  avatarUrl: "https://cdn.example/avatar.png",
  isLive: true,
  vendorStatus: "ACTIVE",
  deliveryPreferences: { acceptingOrders: true },
};

function productRow(vendor: Record<string, unknown>) {
  return {
    id: "prod-1",
    name: "Jollof",
    description: "Smoky party jollof",
    price: 2000,
    images: ["https://cdn.example/jollof.png"],
    thumbnail: "https://cdn.example/jollof.png",
    video: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    totalViews: 10,
    dishType: { id: "JOLLOF", name: "Jollof", description: "Rice" },
    portionLabel: null,
    trackInventory: false,
    stock: null,
    popularityScore: 0,
    popularityPercent: 0,
    isNew: false,
    archived: false,
    vendorId: "vendor-1",
    vendor,
    options: [
      { id: "opt-1", name: "Extra Meat", price: 500 },
      { id: "opt-2", name: "Retired", price: 100 },
    ],
    optionGroups: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockResolvedValue(null);
  mockedSet.mockResolvedValue("OK");
  db.productReview.aggregate.mockResolvedValue({ _avg: { rating: 4 }, _count: { _all: 2 } });
  db.vendorReview.aggregate.mockResolvedValue({ _avg: { rating: 5 }, _count: { rating: 1 } });
});

describe("GET /api/product/:id -- vendor PII", () => {
  it("Test 1: Prisma vendor select requests no account PII", async () => {
    db.product.findFirst.mockResolvedValue(productRow({ ...PUBLIC_VENDOR }));

    await getProductById(req(), res());

    expect(db.product.findFirst).toHaveBeenCalledTimes(1);
    const vendorSelect = db.product.findFirst.mock.calls[0][0].select.vendor.select;
    expect(vendorSelect).toBeDefined();
    // `avatarUrl` is NOT in this list any more: it is part of the PUBLIC
    // vendor projection (identity only) and is safe to serve. The account
    // PII fields below still must never be selected.
    for (const pii of ["email", "username", "role", "bio"]) {
      expect(vendorSelect).not.toHaveProperty(pii);
    }
  });

  it("Test 1b: response and cached payload contain no PII", async () => {
    db.product.findFirst.mockResolvedValue(productRow({ ...PUBLIC_VENDOR }));

    const r = res();
    await getProductById(req(), r);

    const vendor = dataOf(r).vendor as Record<string, unknown>;
    for (const pii of ["email", "username", "role"]) {
      expect(vendor).not.toHaveProperty(pii);
    }
    const cached = JSON.parse(mockedSet.mock.calls[0][1]);
    for (const pii of ["email", "username", "role"]) {
      expect(cached.vendor).not.toHaveProperty(pii);
    }
    // No PII anywhere else in either payload either.
    for (const payload of [dataOf(r), cached]) {
      expect(JSON.stringify(payload)).not.toContain("vendor@example.com");
    }
  });

  it("Test 2: legitimate public vendor fields remain available", async () => {
    db.product.findFirst.mockResolvedValue(productRow({ ...PUBLIC_VENDOR }));

    const r = res();
    await getProductById(req(), r);

    // B-1: the public vendor projection — identity only.
    expect(dataOf(r).vendor).toEqual({
      id: "vendor-1",
      name: "Mama Put",
      brandName: "Mama Put Kitchen",
      brandLogo: "https://cdn.example/logo.png",
      avatarUrl: "https://cdn.example/avatar.png",
    });
  });

  it("Test 2b: internal moderation and settings fields are absent from the response and the cached payload", async () => {
    db.product.findFirst.mockResolvedValue(productRow({ ...PUBLIC_VENDOR }));

    const r = res();
    await getProductById(req(), r);

    const cached = JSON.parse(mockedSet.mock.calls[0][1]);

    for (const payload of [dataOf(r).vendor, cached.vendor]) {
      // The executable prohibited-key list (src/services/publicVendor.service).
      expect(findProhibitedPublicVendorKeys(payload)).toEqual([]);
      for (const key of [
        "vendorStatus",
        "vendorStatusReason",
        "deliveryPreferences",
        "baseDeliveryFee",
        "deliveryRadiusKm",
        "preparationTimeMinutes",
        "isLive",
      ]) {
        expect(payload).not.toHaveProperty(key);
      }
    }

    // The internal availability snapshot is CACHE-ONLY: it must exist in
    // the cached payload (so the HIT path can recompute availability) and
    // must NOT exist in the response.
    expect(cached.__vendorAvailability).toEqual({
      isLive: true,
      vendorStatus: "ACTIVE",
      acceptingOrders: true,
    });
    expect(dataOf(r)).not.toHaveProperty("__vendorAvailability");
    expect(JSON.stringify(dataOf(r))).not.toContain("__vendorAvailability");
  });

  it("Test 2c: the prohibited-key list is the one the implementation documents", () => {
    // Guards against the list silently shrinking to nothing.
    expect(PROHIBITED_PUBLIC_VENDOR_KEYS.length).toBeGreaterThan(20);
    expect(PROHIBITED_PUBLIC_VENDOR_KEYS).toContain("vendorStatus");
    expect(PROHIBITED_PUBLIC_VENDOR_KEYS).toContain("deliveryPreferences");
    expect(PROHIBITED_PUBLIC_VENDOR_KEYS).toContain("baseDeliveryFee");
    expect(PROHIBITED_PUBLIC_VENDOR_KEYS).toContain("deliveryRadiusKm");
    expect(PROHIBITED_PUBLIC_VENDOR_KEYS).toContain("preparationTimeMinutes");
    expect(PROHIBITED_PUBLIC_VENDOR_KEYS).toContain("vendorStatusReason");
  });

  it("Test 3: availability still resolves on the restricted shape", async () => {
    db.product.findFirst.mockResolvedValue(productRow({ ...PUBLIC_VENDOR }));
    const open = res();
    await getProductById(req(), open);
    expect(dataOf(open).vendorOperating).toBe(true);
    expect(dataOf(open).orderable).toBe(true);

    jest.clearAllMocks();
    mockedGet.mockResolvedValue(null);
    db.product.findFirst.mockResolvedValue(
      productRow({ ...PUBLIC_VENDOR, isLive: false }),
    );
    const closed = res();
    await getProductById(req(), closed);
    expect(dataOf(closed).vendorOperating).toBe(false);
    expect(dataOf(closed).orderable).toBe(false);
  });

  it("Test 4: unrelated detail behavior intact (options filter, media, cache MISS)", async () => {
    // Legacy options arrive unfiltered from DB; only active ones are served.
    // (The controller filters isActive !== false on the pre-warm path; the
    // DB select itself scopes to active rows.)
    db.product.findFirst.mockResolvedValue(productRow({ ...PUBLIC_VENDOR }));

    const r = res();
    await getProductById(req(), r);

    const body = r.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.message).toBe("Product retrieved successfully.");
    expect(dataOf(r).id).toBe("prod-1");
    expect(dataOf(r).price).toBe(2000);
    expect(dataOf(r).images).toEqual(["https://cdn.example/jollof.png"]);
    expect(r.setHeader).toHaveBeenCalledWith("X-Cache", "MISS");
    expect(mockedSet).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/product/:id -- cache-HIT availability (Phase 2.6)", () => {
  // The HIT path recomputes availability from the cached vendor object
  // (which carries vendorStatus from the MISS select). Stale cached flags
  // must be overwritten, never trusted.
  const hitPayload = (vendor: Record<string, unknown>, product: Record<string, unknown> = {}) => ({
    ...productRow(vendor),
    ...product,
    // Poison the cached flags: the handler must recompute them.
    vendorOperating: false,
    orderable: false,
  });

  const hit = async (payload: unknown) => {
    mockedGet.mockResolvedValueOnce(JSON.stringify(payload));
    const r = res();
    await getProductById(req(), r);
    return r;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSet.mockResolvedValue("OK");
  });

  it("HIT for an active, operating vendor reports operating/orderable", async () => {
    const r = await hit(hitPayload({ ...PUBLIC_VENDOR }));
    expect(dataOf(r).vendorOperating).toBe(true);
    expect(dataOf(r).orderable).toBe(true);
    expect(r.setHeader).toHaveBeenCalledWith("X-Cache", "HIT");
    expect(db.product.findFirst).not.toHaveBeenCalled();
  });

  it("HIT for an offline active vendor stays discoverable but not orderable", async () => {
    const r = await hit(hitPayload({ ...PUBLIC_VENDOR, isLive: false }));
    expect(dataOf(r).vendorOperating).toBe(false);
    expect(dataOf(r).orderable).toBe(false);
    expect(dataOf(r).id).toBe("prod-1");
  });

  it("HIT never reports a suspended vendor as operating, even with a stale live flag", async () => {
    const r = await hit(
      hitPayload({ ...PUBLIC_VENDOR, vendorStatus: "SUSPENDED", isLive: true }),
    );
    expect(dataOf(r).vendorOperating).toBe(false);
    expect(dataOf(r).orderable).toBe(false);
  });

  it("HIT keeps archived or out-of-stock products not orderable", async () => {
    const archived = await hit(hitPayload({ ...PUBLIC_VENDOR }, { archived: true }));
    expect(dataOf(archived).vendorOperating).toBe(true);
    expect(dataOf(archived).orderable).toBe(false);

    const soldOut = await hit(
      hitPayload({ ...PUBLIC_VENDOR }, { trackInventory: true, stock: 0 }),
    );
    expect(dataOf(soldOut).vendorOperating).toBe(true);
    expect(dataOf(soldOut).orderable).toBe(false);
  });

  it("HIT stays fail-closed when the cached status is missing", async () => {
    const { id, name, brandName, brandLogo, isLive, deliveryPreferences } = PUBLIC_VENDOR;
    const r = await hit(
      hitPayload({ id, name, brandName, brandLogo, isLive, deliveryPreferences }),
    );
    expect(dataOf(r).vendorOperating).toBe(false);
    expect(dataOf(r).orderable).toBe(false);
  });

  it("HIT preserves the response contract (envelope, message, no PII)", async () => {
    const r = await hit(hitPayload({ ...PUBLIC_VENDOR }));
    const body = r.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.message).toBe("Product retrieved successfully.");
    expect(dataOf(r).id).toBe("prod-1");
    for (const pii of ["email", "username", "role"]) {
      expect(dataOf(r).vendor).not.toHaveProperty(pii);
    }
  });

  it("HIT re-projects a legacy cached vendor onto the public projection", async () => {
    // A cache entry written BEFORE the public vendor projection existed still
    // carries the raw vendor object for the remaining TTL. The read path must
    // strip it, or a cache hit would re-introduce a removed field.
    const r = await hit(hitPayload({ ...PUBLIC_VENDOR }));

    expect(dataOf(r).vendor).toEqual({
      id: "vendor-1",
      name: "Mama Put",
      brandName: "Mama Put Kitchen",
      brandLogo: "https://cdn.example/logo.png",
      avatarUrl: "https://cdn.example/avatar.png",
    });
    expect(findProhibitedPublicVendorKeys(dataOf(r).vendor)).toEqual([]);
  });

  it("HIT keeps the availability flags correct after re-projecting", async () => {
    const r = await hit(hitPayload({ ...PUBLIC_VENDOR }));
    expect(dataOf(r).vendorOperating).toBe(true);
    expect(dataOf(r).orderable).toBe(true);
  });
});

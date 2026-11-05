/**
 * B-3 — search results carry the canonical product-card shape.
 *
 * The search endpoint used to return the RAW SQL row: no rating, no portion,
 * no stock, no availability flags and no vendor identity. A customer card
 * therefore rendered differently in search than in browse.
 *
 * These tests pin:
 *   - the canonical fields are present on a search result;
 *   - the search-specific fields the endpoint always returned are preserved;
 *   - the vendor is the public projection (B-1);
 *   - availability semantics match the canonical rules;
 *   - the envelope and the nested pagination shape are unchanged.
 *
 * Prisma and Redis are MOCKED. The raw-SQL text is asserted too, because the
 * selected columns ARE the contract.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    product: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
    tag: { findMany: jest.fn() },
    dishType: { findMany: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(async () => []),
}));

jest.mock("../../src/jobs/workers jobs/redis-baseQueue", () => ({
  __esModule: true,
  productIndexQueue: { add: jest.fn(async () => {}) },
}));

jest.mock("../../src/controllers/vendorDashboard.service", () => ({
  __esModule: true,
  VendorDashboardService: jest.fn().mockImplementation(() => ({
    invalidateCache: jest.fn(async () => {}),
  })),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => ({ ok: true, failures: [] })),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => ({ ok: true, failures: [] })),
  invalidateProductRatingCaches: jest.fn(async () => ({ ok: true, failures: [] })),
}));

jest.mock("../../src/AI/localSearchCorrect", () => ({
  __esModule: true,
  correctQuery: jest.fn((q: string) => q),
}));

// The REAL promotion resolver is used here so the promotion mapping is
// proven end to end, not mocked away.
jest.mock("../../src/services/promotionPricing.service", () => {
  const actual = jest.requireActual("../../src/services/promotionPricing.service");
  return {
    __esModule: true,
    ...actual,
    loadActiveProductPromos: jest.fn(async () => []),
  };
});

import prisma from "../../src/lib/prisma";
import { redisSearch } from "../../src/lib/redis";
import { searchProducts } from "../../src/controllers/productController";
import { DiscountType, PromotionScope } from "@prisma/client";
import { findProhibitedPublicVendorKeys } from "../../src/services/publicVendor.service";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedRaw = db.$queryRawUnsafe as unknown as jest.Mock;
const mockedSearchGet = redisSearch.get as unknown as jest.Mock;
const mockedSearchSet = redisSearch.set as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const searchReq = (query: Record<string, unknown>): any =>
  ({
    headers: {},
    body: {},
    params: {},
    query,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
  }) as any;

const searchRow = (overrides: Record<string, unknown> = {}) => ({
  id: "prod-1",
  name: "Smoky Party Jollof",
  description: "The classic party jollof.",
  price: 2500,
  vendorId: "vendor-1",
  images: ["https://cdn.example/jollof.png", "https://cdn.example/second.png"],
  thumbnail: "https://cdn.example/jollof.png",
  archived: false,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-02T00:00:00Z"),
  dishTypeId: "JOLLOF",
  dishType: { id: "JOLLOF", name: "Jollof" },
  portionLabel: "Family Pack — serves 4–5",
  trackInventory: true,
  stock: 4,
  popularityPercent: 63,
  averageRating: 4.5,
  reviewCount: 12,
  vendor_id: "vendor-1",
  vendor_name: "Mama Put",
  vendor_brandName: "Mama Put Kitchen",
  vendor_brandLogo: "https://cdn.example/logo.png",
  vendor_avatarUrl: "https://cdn.example/avatar.png",
  vendor_isLive: true,
  vendor_vendorStatus: "ACTIVE",
  vendor_deliveryPreferences: { acceptingOrders: true, baseDeliveryFee: 500 },
  rank: 0.42,
  exact_match: true,
  dish_match: false,
  category_match: false,
  tag_match: false,
  orderable: true,
  ...overrides,
});

const bodyOf = (r: any) => r.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  mockedSearchGet.mockResolvedValue(null);
  mockedSearchSet.mockResolvedValue("OK");
  db.$executeRawUnsafe.mockResolvedValue(0);
  db.tag.findMany.mockResolvedValue([]);
  mockedRaw.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (s.includes("COUNT(*)")) {
      // The full-text pool holds one row; the fuzzy-only pool holds none.
      return s.includes("similarity(") ? [{ total: 0n }] : [{ total: 1n }];
    }
    if (s.includes("similarity(")) return [];
    return [searchRow()];
  });

  // The promotion loader is a mock; reset it so one test's promotion does
  // not leak into the next.
  const pricing = jest.requireMock("../../src/services/promotionPricing.service");
  pricing.loadActiveProductPromos.mockResolvedValue([]);
});

describe("search result shape — canonical product card", () => {
  it("carries every canonical customer-facing field", async () => {
    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);

    const result = bodyOf(r).data.results[0];
    expect(result).toMatchObject({
      id: "prod-1",
      name: "Smoky Party Jollof",
      price: 2500,
      dishType: { id: "JOLLOF", name: "Jollof" },
      images: ["https://cdn.example/jollof.png"],
      popularityPercent: 63,
      averageRating: 4.5,
      reviewCount: 12,
      portionLabel: "Family Pack — serves 4–5",
      trackInventory: true,
      stock: 4,
      soldOut: false,
      vendorOperating: true,
      orderable: true,
      vendor: {
        id: "vendor-1",
        name: "Mama Put",
        brandName: "Mama Put Kitchen",
        brandLogo: "https://cdn.example/logo.png",
        avatarUrl: "https://cdn.example/avatar.png",
      },
    });
  });

  it("keeps the search-specific fields the endpoint always returned", async () => {
    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);

    const result = bodyOf(r).data.results[0];
    expect(result.description).toBe("The classic party jollof.");
    expect(result.vendorId).toBe("vendor-1");
    expect(result.archived).toBe(false);
    expect(result.dishTypeId).toBe("JOLLOF");
    expect(result.rank).toBe(0.42);
    expect(result.exact_match).toBe(true);
    expect(result.createdAt).toBeDefined();
  });

  it("exposes the vendor through the public projection only", async () => {
    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);

    const result = bodyOf(r).data.results[0];
    expect(findProhibitedPublicVendorKeys(result.vendor)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("baseDeliveryFee");
    expect(JSON.stringify(result)).not.toContain("vendorStatus");
    expect(result.vendor).not.toHaveProperty("vendorStatus");
    expect(result.vendor).not.toHaveProperty("deliveryPreferences");
    expect(result.vendor).not.toHaveProperty("isLive");
  });

  it("keeps the envelope and the nested pagination shape", async () => {
    const r = res();
    await searchProducts(searchReq({ q: "jollof", page: "2", limit: "10" }), r);

    const body = bodyOf(r);
    expect(body.success).toBe(true);
    expect(body.message).toBe("Products fetched successfully");
    expect(body.data.corrected).toBe("jollof");
    expect(body.data.pagination).toEqual({
      total: 1,
      page: 2,
      limit: 10,
      totalPages: 1,
    });
    expect(Array.isArray(body.data.results)).toBe(true);
  });
});

describe("search result shape — availability semantics", () => {
  it("is not orderable for an offline vendor", async () => {
    mockedRaw.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("COUNT(*)")) return [{ total: 1n }];
      if (s.includes("similarity(")) return [];
      return [searchRow({ vendor_isLive: false })];
    });

    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);
    const result = bodyOf(r).data.results[0];
    expect(result.vendorOperating).toBe(false);
    expect(result.orderable).toBe(false);
  });

  it("is not orderable for a suspended vendor", async () => {
    mockedRaw.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("COUNT(*)")) return [{ total: 1n }];
      if (s.includes("similarity(")) return [];
      return [searchRow({ vendor_vendorStatus: "SUSPENDED" })];
    });

    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);
    const result = bodyOf(r).data.results[0];
    expect(result.vendorOperating).toBe(false);
    expect(result.orderable).toBe(false);
  });

  it("is not orderable for a vendor that paused orders", async () => {
    mockedRaw.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("COUNT(*)")) return [{ total: 1n }];
      if (s.includes("similarity(")) return [];
      return [
        searchRow({
          vendor_deliveryPreferences: { acceptingOrders: false },
        }),
      ];
    });

    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);
    const result = bodyOf(r).data.results[0];
    expect(result.vendorOperating).toBe(false);
    expect(result.orderable).toBe(false);
  });

  it("is sold out — and not orderable — for a tracked product with no stock", async () => {
    mockedRaw.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("COUNT(*)")) return [{ total: 1n }];
      if (s.includes("similarity(")) return [];
      return [searchRow({ stock: 0 })];
    });

    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);
    const result = bodyOf(r).data.results[0];
    expect(result.soldOut).toBe(true);
    expect(result.orderable).toBe(false);
    expect(result.vendorOperating).toBe(true);
  });
});

describe("search result shape — promotion mapping", () => {
  it("attaches the effective promotion resolved by the canonical resolver", async () => {
    const { loadActiveProductPromos } = jest.requireActual(
      "../../src/services/promotionPricing.service",
    ) as { loadActiveProductPromos: jest.Mock };
    // The mocked module keeps the real resolver but replaces the loader.
    const pricing = jest.requireMock("../../src/services/promotionPricing.service");
    pricing.loadActiveProductPromos.mockResolvedValue([
      {
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
        createdAt: new Date("2026-10-01"),
        productIds: ["prod-1"],
      },
    ]);

    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);

    const result = bodyOf(r).data.results[0];
    expect(result.promotion).toMatchObject({
      promotionId: "promo-1",
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      originalPrice: 2500,
      discountedPrice: 2250,
      discountAmount: 250,
      requiresCode: false,
    });
    expect(typeof loadActiveProductPromos).toBe("function");
  });

  it("attaches a null promotion when no promotion applies", async () => {
    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);
    expect(bodyOf(r).data.results[0].promotion).toBeNull();
  });
});

describe("search SQL — the selected columns are the contract", () => {
  it("selects the canonical card columns on the full-text page query", async () => {
    await searchProducts(searchReq({ q: "jollof" }), res());
    const sql = String(mockedRaw.mock.calls[0][0]);
    for (const column of [
      'p.thumbnail',
      'p."portionLabel"',
      'p."trackInventory"',
      'p.stock',
      'p."popularityPercent"',
      'p."averageRating"',
      'p."reviewCount"',
      'v."brandName"',
      'v."brandLogo"',
      'v."avatarUrl"',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it("selects the canonical card columns on the fuzzy page query", async () => {
    await searchProducts(searchReq({ q: "jollof" }), res());
    const fuzzySql = mockedRaw.mock.calls.find((c) =>
      String(c[0]).includes("similarity("),
    );
    expect(fuzzySql).toBeDefined();
    const sql = String(fuzzySql![0]);
    expect(sql).toContain('p."averageRating"');
    expect(sql).toContain('p."portionLabel"');
    expect(sql).toContain('v."brandLogo"');
  });

  it("keeps the deterministic ordering and the id tiebreaker", async () => {
    await searchProducts(searchReq({ q: "jollof" }), res());
    const sql = String(mockedRaw.mock.calls[0][0]);
    expect(sql).toContain(
      "ORDER BY exact_match DESC, dish_match DESC, category_match DESC, tag_match DESC, orderable DESC, rank DESC",
    );
    expect(sql).toContain('p."id" ASC');
  });

  it("caches the mapped results with a card-shape version marker", async () => {
    await searchProducts(searchReq({ q: "jollof" }), res());
    const cached = JSON.parse(mockedSearchSet.mock.calls[0][1]);
    expect(cached.__cardVersion).toBe(2);
    expect(cached.results[0].averageRating).toBe(4.5);
    expect(cached.results[0].vendor.vendorStatus).toBeUndefined();
  });

  it("ignores a cached entry written before the canonical card shape", async () => {
    mockedSearchGet.mockResolvedValueOnce(
      JSON.stringify({
        corrected: "jollof",
        results: [{ id: "legacy-1", name: "Old shape" }],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      }),
    );

    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);

    // The stale entry is not served; the database is re-read.
    expect(bodyOf(r).data.results[0].id).toBe("prod-1");
    expect(bodyOf(r).data.fromCache).toBeUndefined();
  });
});

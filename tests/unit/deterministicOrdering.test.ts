/**
 * Phase 2D deterministic-pagination fix -- every customer product ordering
 * must end with the unique `id ASC` tiebreaker so offset pagination cannot
 * duplicate or skip rows when primary keys tie.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn(), count: jest.fn() },
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
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
  clearProductCache: jest.fn(async () => {}),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/services/product.service", () => {
  const actual = jest.requireActual("../../src/services/product.service");
  return {
    __esModule: true,
    ...actual,
    assertActiveDishType: jest.fn(async () => {}),
  };
});

jest.mock("../../src/AI/localSearchCorrect", () => ({
  __esModule: true,
  correctQuery: jest.fn((q: string) => q),
}));

jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  loadActiveProductPromos: jest.fn(async () => []),
  attachPromotions: jest.fn((items: unknown[]) => items),
}));

import prisma from "../../src/lib/prisma";
import { redisSearch } from "../../src/lib/redis";
import {
  fetchProductPage,
  fetchMostPopularProducts,
  fetchNewProducts,
  fetchLiveProducts,
} from "../../src/services/product.service";
import { searchProducts } from "../../src/controllers/productController";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedFindMany = db.product.findMany as unknown as jest.Mock;
const mockedRawUnsafe = db.$queryRawUnsafe as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const req = (query: Record<string, unknown>): any =>
  ({
    headers: {},
    body: {},
    params: {},
    query,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
  }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockedFindMany.mockResolvedValue([]);
  db.product.count.mockResolvedValue(0);
  (redisSearch.get as unknown as jest.Mock).mockResolvedValue(null);
  (redisSearch.set as unknown as jest.Mock).mockResolvedValue("OK");
  db.$queryRawUnsafe.mockImplementation(async (sql: string) =>
    String(sql).includes("COUNT") ? [{ total: 0n }] : [],
  );
  db.$executeRawUnsafe.mockResolvedValue(0);
});

describe("browse ordering -- id ASC final tiebreaker", () => {
  it.each([
    ["popularity", [{ popularityScore: "desc" }, { createdAt: "desc" }, { id: "asc" }]],
    ["priceAsc", [{ price: "asc" }, { createdAt: "desc" }, { id: "asc" }]],
    ["priceDesc", [{ price: "desc" }, { createdAt: "desc" }, { id: "asc" }]],
    ["rating", [{ averageRating: "desc" }, { reviewCount: "desc" }, { createdAt: "desc" }, { id: "asc" }]],
    ["newest", [{ createdAt: "desc" }, { id: "asc" }]],
    [undefined, [{ createdAt: "desc" }, { id: "asc" }]],
  ])("fetchProductPage sortBy=%s ends with id ASC", async (sortBy, expected) => {
    await fetchProductPage({ skip: 0, take: 20, sortBy: sortBy as string | undefined });
    expect(mockedFindMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: expected }));
  });

  it("fetchMostPopularProducts orders popularityScore DESC, id ASC", async () => {
    await fetchMostPopularProducts({ skip: 0, take: 20 });
    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ popularityScore: "desc" }, { id: "asc" }] }),
    );
  });

  it("fetchLiveProducts orders popularityScore DESC, createdAt DESC, id ASC", async () => {
    await fetchLiveProducts({ take: 20 });
    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ popularityScore: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      }),
    );
  });

  it("fetchNewProducts orders createdAt DESC, id ASC", async () => {
    await fetchNewProducts({ take: 20 });
    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: "desc" }, { id: "asc" }] }),
    );
  });
});

describe("search ordering -- p.id ASC final tiebreaker", () => {
  it.each([
    ["relevance", "exact_match DESC, dish_match DESC, category_match DESC, tag_match DESC, orderable DESC, rank DESC"],
    ["priceAsc", "price ASC"],
    ["priceDesc", "price DESC"],
    ["popularity", '"popularityScore" DESC'],
    ["rating", '"averageRating" DESC'],
    ["newest", '"createdAt" DESC'],
  ])("sortBy=%s keeps ranking, appends p.id ASC to both queries", async (sortBy) => {
    await searchProducts(req({ q: "burger", sortBy, limit: "20" }), res());

    const statements: string[] = mockedRawUnsafe.mock.calls.map((c: unknown[]) => String(c[0]));
    const pageQueries = statements.filter((s) => s.includes("LIMIT $3 OFFSET $4"));
    expect(pageQueries).toHaveLength(2); // full-text + trigram fallback
    for (const sql of pageQueries) {
      expect(sql).toContain('p."id" ASC');
      // Tiebreaker closes the ORDER BY: only LIMIT/OFFSET follow it.
      expect(sql).toMatch(/p\."id" ASC\s*\n\s*LIMIT/);
    }
    // Primary ranking clauses (checked on the full-text query). Phase 2 M4
    // inserts the category_match/tag_match tiers between dish_match and
    // orderable — text relevance still outranks availability.
    const fullText = pageQueries.find((s) => s.includes("exact_match"))!;
    expect(fullText).toContain(
      "ORDER BY exact_match DESC, dish_match DESC, category_match DESC, tag_match DESC, orderable DESC, rank DESC",
    );
  });
});

describe("pagination stability under timestamp ties", () => {
  // Mirrors the declared contract (createdAt DESC, id ASC) over tied rows:
  // pages must partition the set with no duplicates and repeat identically.
  const orderTied = (rows: { id: string; createdAt: number }[]) =>
    [...rows].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));

  const tied = [
    { id: "c", createdAt: 100 },
    { id: "a", createdAt: 100 },
    { id: "b", createdAt: 100 },
    { id: "e", createdAt: 100 },
    { id: "d", createdAt: 100 },
  ];

  it("pages partition the tied set with no duplicates, deterministically", () => {
    const run = () => {
      const ordered = orderTied(tied);
      return [ordered.slice(0, 2).map((r) => r.id), ordered.slice(2, 4).map((r) => r.id)];
    };
    const [p1a, p2a] = run();
    const [p1b, p2b] = run();
    expect([...p1a, ...p2a].sort()).toEqual(["a", "b", "c", "d"]);
    expect(new Set([...p1a, ...p2a]).size).toBe(4);
    expect([p1a, p2a]).toEqual([p1b, p2b]);
  });
});

/**
 * Phase 2 M4 — search relevance + suggestion/new-rail eligibility.
 *
 * Covers: category/tag matching in full-text, fuzzy and count queries;
 * ranking tiers; combined text + tag filter; deterministic ordering;
 * suggestion vendor eligibility + vocabulary matching + response shape;
 * new-rail vendor eligibility; orderable accuracy; fail-safe behavior.
 *
 * All infrastructure is mocked (Prisma, Redis); assertions target
 * observable behavior (SQL predicates, where-clauses, responses).
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    product: { findMany: jest.fn(), count: jest.fn() },
    tag: { findMany: jest.fn() },
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
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

// Real query cores (fetchNewProducts under test); only the dish-type
// vocabulary check is stubbed.
jest.mock("../../src/services/product.service", () => {
  const actual = jest.requireActual("../../src/services/product.service");
  return {
    __esModule: true,
    ...actual,
    assertActiveDishType: jest.fn(async () => {}),
    clearProductFromCarts: jest.fn(async () => {}),
  };
});

jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  loadActiveProductPromos: jest.fn(async () => []),
  attachPromotions: jest.fn((items: unknown[]) => items),
}));

jest.mock("../../src/AI/localSearchCorrect", () => ({
  __esModule: true,
  correctQuery: jest.fn((q: string) => q),
}));

import prisma from "../../src/lib/prisma";
import { redisSearch } from "../../src/lib/redis";
import { searchProducts, getSearchSuggestions } from "../../src/controllers/productController";
import { fetchNewProducts } from "../../src/services/product.service";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedSearchGet = redisSearch.get as unknown as jest.Mock;
const mockedRaw = db.$queryRawUnsafe as unknown as jest.Mock;

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

// Page queries return rows; the COUNT query returns a bigint total.
const mockSearchDb = (rows: unknown[] = [], total = 0n) => {
  mockedRaw.mockImplementation(async (sql: string) =>
    String(sql).includes("COUNT") ? [{ total }] : rows,
  );
};

const pageSql = () =>
  mockedRaw.mock.calls.map((c) => String(c[0])).find((s) => s.includes("LIMIT $3") && !s.includes("similarity(")) ?? "";
const fuzzySql = () =>
  mockedRaw.mock.calls.map((c) => String(c[0])).find((s) => s.includes("similarity(")) ?? "";
const countSql = () =>
  mockedRaw.mock.calls.map((c) => String(c[0])).find((s) => s.includes("COUNT")) ?? "";

beforeEach(() => {
  jest.clearAllMocks();
  mockedSearchGet.mockResolvedValue(null);
  db.$executeRawUnsafe.mockResolvedValue(0);
  db.tag.findMany.mockResolvedValue([]);
  db.product.findMany.mockResolvedValue([]);
  db.product.count.mockResolvedValue(0);
  mockSearchDb();
});

describe("search relevance — category and tag matching", () => {
  it("joins Category and matches its name without excluding tagless products", async () => {
    await searchProducts(searchReq({ q: "rice" }), res());

    const sql = pageSql();
    expect(sql).toContain('LEFT JOIN "Category"');
    expect(sql).toContain('c."name" ILIKE $2');
    // Tag matching is EXISTS-based (never an inner join), so products
    // without tags keep matching by name/description/dish/category.
    expect(sql).toContain('EXISTS (SELECT 1 FROM "ProductTag"');
    expect(sql).not.toContain('INNER JOIN "ProductTag"');
    expect(sql).not.toContain('JOIN "ProductTag" p');
  });

  it("matches assigned active tag names and ids", async () => {
    await searchProducts(searchReq({ q: "vegan" }), res());

    const sql = pageSql();
    expect(sql).toContain('t."isActive" = true');
    expect(sql).toContain('t."name" ILIKE $2');
    expect(sql).toContain('t."id" ILIKE $2');
  });

  it("ranks exact > dish > category > tag > orderable > text rank", async () => {
    await searchProducts(searchReq({ q: "jollof" }), res());

    const orderBy = pageSql().split("ORDER BY")[1] ?? "";
    const idx = (s: string) => orderBy.indexOf(s);
    for (const tier of ["exact_match", "dish_match", "category_match", "tag_match", "orderable", "rank"]) {
      expect(idx(tier)).toBeGreaterThanOrEqual(0);
    }
    expect(idx("exact_match")).toBeLessThan(idx("dish_match"));
    expect(idx("dish_match")).toBeLessThan(idx("category_match"));
    expect(idx("category_match")).toBeLessThan(idx("tag_match"));
    expect(idx("tag_match")).toBeLessThan(idx("orderable"));
    expect(idx("orderable")).toBeLessThan(idx("rank"));
  });

  it("mirrors the vocabulary predicate in the count query", async () => {
    await searchProducts(searchReq({ q: "rice" }), res());

    const sql = countSql();
    expect(sql).toContain('LEFT JOIN "Category"');
    expect(sql).toContain('c."name" ILIKE $2');
    expect(sql).toContain('EXISTS (SELECT 1 FROM "ProductTag"');
  });

  it("extends the fuzzy pool with category and tag vocabulary", async () => {
    await searchProducts(searchReq({ q: "vegn" }), res());

    const sql = fuzzySql();
    expect(sql).toContain('COALESCE(c."name", \'\')');
    expect(sql).toContain("string_agg");
    expect(sql).toContain('"ProductTag"');
  });

  it("unknown terms return empty results with valid pagination", async () => {
    const r = res();
    await searchProducts(searchReq({ q: "zzzzqqqq" }), r);

    const body = r.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.results).toEqual([]);
    expect(body.data.pagination).toMatchObject({ total: 0, page: 1 });
  });

  it("keeps the tag filter predicate alongside tag-name matching", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    await searchProducts(searchReq({ q: "jollof", tags: "SPICY" }), res());

    const sql = pageSql();
    // Filter: ANY-match over resolved ids…
    expect(sql).toContain('"tagId" = ANY(');
    // …plus relevance matching over tag names.
    expect(sql).toContain('t."name" ILIKE $2');
    const params = mockedRaw.mock.calls[0].slice(1);
    expect(params).toContainEqual(["SPICY"]);
  });

  it("ends page and fuzzy queries with the deterministic id tiebreaker", async () => {
    await searchProducts(searchReq({ q: "jollof" }), res());

    // Fuzzy runs (full-text came back short) and keeps the tiebreaker too.
    expect(pageSql()).toContain('p."id" ASC');
    expect(fuzzySql()).toContain('p."id" ASC');
  });
});

describe("suggestions — eligibility and vocabulary", () => {
  it("excludes ineligible vendors but keeps offline ACTIVE vendors", async () => {
    db.product.findMany.mockResolvedValue([]);
    await getSearchSuggestions(searchReq({ q: "jollof" }), res());

    const where = db.product.findMany.mock.calls[0][0].where;
    expect(where.archived).toBe(false);
    // Status-only: suspended/ineligible hidden, paused-but-ACTIVE kept.
    expect(where.vendor).toEqual({ vendorStatus: "ACTIVE" });
    expect(where.vendor).not.toHaveProperty("isLive");
  });

  it("matches category and tag vocabulary per word", async () => {
    db.product.findMany.mockResolvedValue([]);
    await getSearchSuggestions(searchReq({ q: "red oil" }), res());

    const where = db.product.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(2);
    for (const wordClause of where.AND) {
      const keys = wordClause.OR.map((c: any) => Object.keys(c)[0]).sort();
      expect(keys).toEqual(["category", "dishType", "name", "tags"]);
    }
  });

  it("ranks vocabulary matches above plain name matches and keeps the response shape", async () => {
    db.product.findMany.mockResolvedValue([
      {
        id: "p-name",
        name: "Nice Spicy Pot",
        dishType: { id: "D1", name: "Other" },
        category: { name: "Soups" },
        tags: [],
      },
      {
        id: "p-tag",
        name: "Mild Pot",
        dishType: { id: "D1", name: "Other" },
        category: { name: "Soups" },
        tags: [{ tag: { name: "Spicy" } }],
      },
    ]);
    const r = res();
    await getSearchSuggestions(searchReq({ q: "spicy" }), r);

    const results = r.json.mock.calls[0][0].data.results;
    // Neither name starts with "spicy"; the tag match outranks the
    // name-contains match.
    expect(results.map((p: any) => p.id)).toEqual(["p-tag", "p-name"]);
    for (const item of results) {
      expect(Object.keys(item).sort()).toEqual(["dishType", "id", "name"]);
    }
  });
});

describe("new rail — vendor eligibility", () => {
  it("excludes ineligible vendors while keeping offline ACTIVE ones", async () => {
    db.product.findMany.mockResolvedValue([]);
    await fetchNewProducts({ take: 10 });

    const where = db.product.findMany.mock.calls[0][0].where;
    expect(where.archived).toBe(false);
    expect(where.isNew).toBe(true);
    expect(where.vendor).toEqual({ vendorStatus: "ACTIVE" });
    expect(where.vendor).not.toHaveProperty("isLive");
  });
});

describe("orderable accuracy and fail-safe behavior", () => {
  it("computes orderable with the full rule including ACTIVE status", async () => {
    await searchProducts(searchReq({ q: "jollof" }), res());

    expect(pageSql()).toContain(`v."vendorStatus" = 'ACTIVE'`);
  });

  it("propagates search-cache failures fail-closed (existing behavior)", async () => {
    // searchProducts awaits the cache read without a degrade path, so a
    // Redis outage surfaces instead of silently serving stale-or-empty
    // results. Explicitly pinned: changing this is a separate decision.
    mockedSearchGet.mockRejectedValueOnce(new Error("redis down"));
    await expect(searchProducts(searchReq({ q: "jollof" }), res())).rejects.toThrow("redis down");
  });

  it("surfaces database failures instead of silent empty results", async () => {
    mockedRaw.mockRejectedValue(new Error("db down"));
    await expect(searchProducts(searchReq({ q: "jollof" }), res())).rejects.toThrow("db down");
  });
});

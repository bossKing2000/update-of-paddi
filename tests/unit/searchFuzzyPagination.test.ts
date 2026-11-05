/**
 * Phase 2.6 — fuzzy-search union pagination correctness.
 *
 * Covers: exact total = full-text total + fuzzy-only total; merged pages
 * never exceed `limit`; SQL-level exclusion of full-text hits from the
 * fuzzy pool (disjoint pools, no duplicates); per-pool offsets across
 * pages; filters enforced on all four queries; ordering and envelope
 * preserved.
 *
 * All infrastructure is mocked (Prisma, Redis); the mock routes each raw
 * query by its SQL shape (page vs COUNT, full-text vs fuzzy).
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
import { searchProducts } from "../../src/controllers/productController";

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

const row = (id: string) => ({ id });

// Fixtures routed by SQL shape: full-text page, full-text COUNT,
// fuzzy page (similarity), fuzzy-only COUNT (COUNT + similarity).
const fixtures = {
  ftRows: [] as unknown[],
  ftTotal: 0n as bigint,
  fuzzyRows: [] as unknown[],
  fuzzyOnlyTotal: 0n as bigint,
};

const callsWith = (fragment: string) =>
  mockedRaw.mock.calls.filter((c) => String(c[0]).includes(fragment));
const ftPageCalls = () =>
  mockedRaw.mock.calls.filter(
    (c) => String(c[0]).includes("LIMIT $3") && !String(c[0]).includes("similarity("),
  );
const fuzzyPageCalls = () =>
  mockedRaw.mock.calls.filter(
    (c) => String(c[0]).includes("LIMIT $3") && String(c[0]).includes("similarity("),
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockedSearchGet.mockResolvedValue(null);
  db.$executeRawUnsafe.mockResolvedValue(0);
  db.tag.findMany.mockResolvedValue([]);
  fixtures.ftRows = [];
  fixtures.ftTotal = 0n;
  fixtures.fuzzyRows = [];
  fixtures.fuzzyOnlyTotal = 0n;
  mockedRaw.mockImplementation(async (sql: string) => {
    const s = String(sql);
    const isCount = s.includes("COUNT(*)");
    const isFuzzy = s.includes("similarity(");
    if (isCount && isFuzzy) return [{ total: fixtures.fuzzyOnlyTotal }];
    if (isCount) return [{ total: fixtures.ftTotal }];
    if (isFuzzy) return fixtures.fuzzyRows;
    return fixtures.ftRows;
  });
});

const bodyOf = (r: any) => r.json.mock.calls[0][0];

describe("fuzzy union pagination (Phase 2.6)", () => {
  it("audit case: 3 full-text + 25 fuzzy-only hits at limit 20 → 20 results, total 28, 2 pages", async () => {
    fixtures.ftRows = [row("ft-1"), row("ft-2"), row("ft-3")];
    fixtures.ftTotal = 3n;
    fixtures.fuzzyRows = Array.from({ length: 20 }, (_, i) => row(`fz-${i + 1}`));
    fixtures.fuzzyOnlyTotal = 25n;

    const r = res();
    await searchProducts(searchReq({ q: "jolof" }), r);

    const body = bodyOf(r);
    expect(body.success).toBe(true);
    // Page capped at the requested limit: 3 full-text + 17 fuzzy.
    expect(body.data.results).toHaveLength(20);
    expect(body.data.results.map((p: any) => p.id)).toEqual([
      "ft-1",
      "ft-2",
      "ft-3",
      ...Array.from({ length: 17 }, (_, i) => `fz-${i + 1}`),
    ]);
    // Exact union total drives the metadata.
    expect(body.data.pagination).toMatchObject({ total: 28, page: 1, limit: 20, totalPages: 2 });
    // Fuzzy page fills only the remainder: LIMIT 17 OFFSET 0.
    const fuzzyCalls = fuzzyPageCalls();
    expect(fuzzyCalls).toHaveLength(1);
    expect(fuzzyCalls[0][3]).toBe(17);
    expect(fuzzyCalls[0][4]).toBe(0);
  });

  it("excludes full-text hits from the fuzzy pool at SQL level (disjoint, no duplicates)", async () => {
    fixtures.ftRows = [row("ft-1")];
    fixtures.ftTotal = 1n;
    fixtures.fuzzyRows = [row("fz-1")];
    fixtures.fuzzyOnlyTotal = 1n;

    await searchProducts(searchReq({ q: "jolof" }), res());

    for (const call of [...fuzzyPageCalls(), ...callsWith("COUNT(*)").filter((c) => String(c[0]).includes("similarity("))]) {
      expect(String(call[0])).toContain("AND NOT (");
    }
    // The fuzzy LIKE operand reuses the query text, not the threshold.
    expect(fuzzyPageCalls()[0][0]).toContain("('%' || $1 || '%')");
  });

  it("advances only the fuzzy pool on later pages (page 2 offsets past the full-text pool)", async () => {
    fixtures.ftRows = [];
    fixtures.ftTotal = 3n;
    fixtures.fuzzyRows = Array.from({ length: 8 }, (_, i) => row(`fz-${i + 18}`));
    fixtures.fuzzyOnlyTotal = 25n;

    const r = res();
    await searchProducts(searchReq({ q: "jolof", page: "2" }), r);

    // offset 20 sits 17 rows into the fuzzy-only pool (past 3 full-text).
    expect(fuzzyPageCalls()[0][4]).toBe(17);
    const body = bodyOf(r);
    expect(body.data.results).toHaveLength(8);
    expect(body.data.pagination).toMatchObject({ total: 28, page: 2, limit: 20, totalPages: 2 });
    const ids = body.data.results.map((p: any) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("skips fuzzy work entirely when the full-text page is full", async () => {
    fixtures.ftRows = Array.from({ length: 20 }, (_, i) => row(`ft-${i + 1}`));
    fixtures.ftTotal = 50n;

    const r = res();
    await searchProducts(searchReq({ q: "jollof" }), r);

    expect(fuzzyPageCalls()).toHaveLength(0);
    expect(bodyOf(r).data.results).toHaveLength(20);
    expect(bodyOf(r).data.pagination).toMatchObject({ total: 50, totalPages: 3 });
  });

  it("enforces filters on all four queries (category, dish-type, tag, availability, vendor)", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    fixtures.ftRows = [row("ft-1")];
    fixtures.ftTotal = 1n;

    await searchProducts(
      searchReq({ q: "jollof", tags: "SPICY", availableOnly: "true", minPrice: "100" }),
      res(),
    );

    // FT page + FT count + fuzzy page + fuzzy-only count.
    expect(mockedRaw.mock.calls).toHaveLength(4);
    for (const call of mockedRaw.mock.calls) {
      const params = call.slice(1);
      expect(params).toContainEqual(["SPICY"]);
      expect(String(call[0])).toContain('v."vendorStatus"');
    }
  });

  it("preserves relevance ordering, deterministic tiebreakers, and the envelope", async () => {
    fixtures.ftRows = [row("ft-1")];
    fixtures.ftTotal = 1n;
    fixtures.fuzzyRows = [row("fz-1")];
    fixtures.fuzzyOnlyTotal = 1n;

    const r = res();
    await searchProducts(searchReq({ q: "jollof", sortBy: "priceAsc" }), r);

    const ftSql = ftPageCalls()[0][0] as string;
    expect(ftSql).toContain(
      "ORDER BY exact_match DESC, dish_match DESC, category_match DESC, tag_match DESC, orderable DESC, rank DESC",
    );
    const fuzzySql = fuzzyPageCalls()[0][0] as string;
    expect(fuzzySql).toContain("ORDER BY orderable DESC, sim_score DESC");
    for (const sql of [ftSql, fuzzySql]) {
      expect(sql).toContain('p."id" ASC');
    }
    const body = bodyOf(r);
    expect(body.success).toBe(true);
    expect(body.data.corrected).toBe("jollof");
    expect(body.data.pagination).toMatchObject({ total: 2, page: 1, limit: 20, totalPages: 1 });
  });

  it("empty pools stay empty with zeroed metadata", async () => {
    const r = res();
    await searchProducts(searchReq({ q: "zzzzqqqq" }), r);

    expect(bodyOf(r).data.results).toEqual([]);
    expect(bodyOf(r).data.pagination).toMatchObject({ total: 0, totalPages: 0 });
  });
});

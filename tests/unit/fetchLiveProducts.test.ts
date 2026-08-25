/**
 * Tests for fetchLiveProducts — the schedule-aware live listing behind the
 * home feed's LIVE NOW section.
 *
 * The SQL predicate itself runs against Postgres; here we mock prisma and
 * verify (a) the generated predicate is correct, and (b) the JS-side
 * liveness recheck (computeIsLiveFromSchedule semantics) keeps/drops rows
 * according to the project's existing live rules:
 *
 *   Test 1  stored isLive=false + active window          → returned as live
 *   Test 2  expired window + stored isLive=true (stale)  → dropped
 *           no schedule at all + stored isLive=true      → kept (existing rule)
 *   Test 3  archived product                             → excluded by SQL
 *   Test 4  popularProducts path unchanged               → fetchMostPopularProducts
 *           still uses the stored-column-only filter (separate test below)
 */

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: jest.fn(),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn() },
  redisTotalViews: { get: jest.fn() },
  ShopCartRedis: {},
}));

import prisma from "../../src/lib/prisma";
import {
  fetchLiveProducts,
  fetchMostPopularProducts,
} from "../../src/services/product.service";

const mockedQuery = prisma.$queryRawUnsafe as unknown as jest.Mock;

const now = new Date();
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "Palm Nut Soup",
  price: 1200,
  images: [],
  averageRating: 4.5,
  reviewCount: 3,
  popularityScore: 10,
  popularityPercent: 40,
  totalViews: 12,
  category: "DINNER",
  isLive: false,
  archived: false,
  goLiveAt: minutes(-30), // went live 30 min ago
  takeDownAt: minutes(60), // takes down in 60 min
  graceMinutes: 0,
  ...overrides,
});

beforeEach(() => {
  mockedQuery.mockReset();
  // First call = page query, second = COUNT query.
  mockedQuery.mockImplementation((sql: string) =>
    /COUNT\(\*\)/i.test(sql) ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]),
  );
});

describe("fetchLiveProducts (schedule-aware)", () => {
  it("Test 1: returns a product whose stored flag is false but whose schedule window is active", async () => {
    mockedQuery.mockImplementation((sql: string) =>
      /COUNT\(\*\)/i.test(sql)
        ? Promise.resolve([{ count: 1 }])
        : Promise.resolve([row()]),
    );

    const { products, total } = await fetchLiveProducts({ take: 12 });

    expect(total).toBe(1);
    expect(products).toHaveLength(1);
    expect(products[0].isLive).toBe(true); // computed from the active window
    expect(products[0].goLiveAt).toEqual(minutes(-30));
    expect((products[0] as any).takeDownAt).toEqual(minutes(60));
  });

  it("Test 2a: drops a row whose window has fully expired even if the stored flag is stale-true", async () => {
    mockedQuery.mockImplementation((sql: string) =>
      /COUNT\(\*\)/i.test(sql)
        ? Promise.resolve([{ count: 0 }])
        : Promise.resolve([
            row({ id: "stale", isLive: true, goLiveAt: minutes(-120), takeDownAt: minutes(-90), graceMinutes: 5 }),
          ]),
    );

    const { products } = await fetchLiveProducts({ take: 12 });
    expect(products).toHaveLength(0); // grace (5min) < elapsed (90min) → not live
  });

  it("Test 2b: keeps a stored-live row with NO schedule (existing stored-flag rule)", async () => {
    mockedQuery.mockImplementation((sql: string) =>
      /COUNT\(\*\)/i.test(sql)
        ? Promise.resolve([{ count: 1 }])
        : Promise.resolve([row({ id: "noschedule", isLive: true, goLiveAt: null, takeDownAt: null, graceMinutes: null })]),
    );

    const { products } = await fetchLiveProducts({ take: 12 });
    expect(products).toHaveLength(1);
    expect(products[0].isLive).toBe(true); // computeIsLive falls back to stored flag
  });

  it("Test 3: never includes archived products — the SQL excludes them before mapping", async () => {
    let capturedSql = "";
    mockedQuery.mockImplementation((sql: string) => {
      if (!/COUNT\(\*\)/i.test(sql)) capturedSql = sql;
      return /COUNT\(\*\)/i.test(sql) ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]);
    });

    await fetchLiveProducts({ take: 12 });

    expect(capturedSql).toMatch(/p\."archived" = false/);
  });

  it("uses an OR of the stored flag and the grace-extended schedule window in its predicate", async () => {
    let capturedSql = "";
    mockedQuery.mockImplementation((sql: string) => {
      if (!/COUNT\(\*\)/i.test(sql)) capturedSql = sql;
      return /COUNT\(\*\)/i.test(sql) ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]);
    });

    await fetchLiveProducts({ take: 12 });

    expect(capturedSql).toMatch(/p\."isLive" = true\s+OR/s);
    expect(capturedSql).toMatch(/s\."goLiveAt" <= NOW\(\)/);
    expect(capturedSql).toMatch(
      /s\."takeDownAt" \+ \(COALESCE\(s\."graceMinutes", 0\) \* INTERVAL '1 minute'\) >= NOW\(\)/,
    );
  });

  it("applies an optional category filter to both page and count queries", async () => {
    const calls: string[] = [];
    mockedQuery.mockImplementation((sql: string) => {
      calls.push(sql);
      return /COUNT\(\*\)/i.test(sql) ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]);
    });

    await fetchLiveProducts({ take: 12, category: "DINNER" });

    const pageSql = calls.find((s) => !/COUNT\(\*\)/i.test(s))!;
    const countSql = calls.find((s) => /COUNT\(\*\)/i.test(s))!;
    expect(pageSql).toContain('$2');
    expect(countSql).toContain('$1');
  });
});

describe("fetchMostPopularProducts (popularity ranking)", () => {
  it("Test 4: legacy mirror branch retained AND weekly branch evaluated live", async () => {
    let capturedSql = "";
    mockedQuery.mockImplementation((sql: string) => {
      if (!/COUNT\(\*\)/i.test(sql)) capturedSql = sql;
      return /COUNT\(\*\)/i.test(sql) ? Promise.resolve([{ count: 7 }]) : Promise.resolve([]);
    });

    const result = await fetchMostPopularProducts({ skip: 0, take: 50 });

    expect(result.total).toBe(7);
    expect(capturedSql).toMatch(/ORDER BY p\."popularityScore" DESC/);
    // legacy: unscheduled / ONE_TIME products still come from the stored mirror
    expect(capturedSql).toMatch(
      /\(s\."id" IS NULL OR s\."type" = 'ONE_TIME'\)\s*AND p\."isLive" = true/,
    );
    // recurring: WEEKLY schedules are evaluated time-driven in SQL
    expect(capturedSql).toMatch(/s\."type" = 'WEEKLY'/);
    expect(capturedSql).toMatch(/NOW\(\)/);
    expect(capturedSql).toMatch(/ProductScheduleWindow/);
  });
});

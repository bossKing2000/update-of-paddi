/**
 * Phase 2B.6 follow-up — shared discovery-cache invalidation.
 *
 * ROOT CAUSE (confirmed from source before this fix):
 *   `invalidateMarketplaceDiscoveryCaches` swept the seven discovery patterns
 *   against **redisProducts only**. But `search:*` and `suggestions:*` are
 *   written to the **redisSearch** instance (productController.ts writes them
 *   with `redisSearch.set`), so those two namespaces were never invalidated by
 *   any of the 18 call sites — they stayed stale for their full TTL (3 h and
 *   30 m) after a vendor-live, promotion, schedule or taxonomy change.
 *
 *   The same helper also had no failure isolation: one failing SCAN abandoned
 *   every remaining pattern, and the exception escaped the helper, turning a
 *   committed database mutation into an HTTP 500.
 *
 * WHAT THESE TESTS DO
 *   - Drive the REAL `invalidateMarketplaceDiscoveryCaches` against an
 *     in-memory Redis double, so "the key is really gone" is an observation.
 *   - Prove both clients are swept, per-pattern and per-client failure
 *     isolation, accurate partial-failure reporting, and that unrelated keys
 *     survive.
 *
 * DATABASE-INDEPENDENT: `src/lib/prisma` is mocked; no PostgreSQL or live
 * Redis is contacted.
 */
process.env.ENCRYPTION_KEY = "test-only-32-char-key-abcdef1234";

jest.mock("../../src/lib/redis", () => {
  const globToRegExp = (pattern: string) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  };
  const makeClient = (database: number, store: Map<string, string>) => ({
    options: { database },
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      let removed = 0;
      for (const key of list) if (store.delete(key)) removed++;
      return removed;
    }),
    scan: jest.fn(async (_cursor: string, opts?: { MATCH?: string; COUNT?: number }) => {
      const match = opts?.MATCH;
      const found = match
        ? [...store.keys()].filter((k) => globToRegExp(match).test(k))
        : [...store.keys()];
      return { cursor: "0", keys: found };
    }),
  });

  // The stores live INSIDE the factory so jest's module hoisting never sees an
  // out-of-scope variable. They are exposed for the test to inspect.
  const stores = {
    products: new Map<string, string>(),
    search: new Map<string, string>(),
  };

  return {
    __esModule: true,
    __stores: stores,
    redisProducts: makeClient(0, stores.products),
    redisNotifications: makeClient(1, new Map()),
    redisSearch: makeClient(2, stores.search),
    redisTotalViews: makeClient(3, new Map()),
    redisUsersSessions: makeClient(4, new Map()),
    ShopCartRedis: makeClient(5, new Map()),
  };
});

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  prisma: { user: { update: jest.fn(), findUnique: jest.fn() }, order: { count: jest.fn() } },
  default: { user: { update: jest.fn(), findUnique: jest.fn() }, order: { count: jest.fn() } },
}));

import * as redisModule from "../../src/lib/redis";
import { invalidateMarketplaceDiscoveryCaches } from "../../src/services/clearCaches";

const { products: productsStore, search: searchStore } = (
  redisModule as unknown as {
    __stores: { products: Map<string, string>; search: Map<string, string> };
  }
).__stores;

const redisProducts = (redisModule as unknown as { redisProducts: { del: jest.Mock; scan: jest.Mock } })
  .redisProducts;
const redisSearch = (redisModule as unknown as { redisSearch: { del: jest.Mock; scan: jest.Mock } })
  .redisSearch;

/** Seed one key per discovery namespace, in the client that actually stores it. */
function seedDiscoveryCaches() {
  productsStore.set("home:feed:guest:u1:lat:6.5:lng:3.4:dishtype:JOLLOF:limit:20", "[]");
  productsStore.set("products:mostPopular:page=1:limit=20", "[]");
  productsStore.set("products:all:page=1:limit=20", "[]");
  productsStore.set("products:new:limit=20:dishtype=JOLLOF", "[]");
  productsStore.set("products:category:rice-dishes:page=1:limit=20:ALL", "[]");
  // search + suggestions live in the redisSearch instance.
  searchStore.set("search:jollof:relevance:all:1:20", "[]");
  searchStore.set("suggestions:joll", "[]");
  // Unrelated key -- must survive.
  productsStore.set("orders:open", "[]");
}

// The factory's own implementations, captured before any test replaces them.
// `jest.clearAllMocks()` clears call history but NOT implementations, so a
// deliberately-failing mock would otherwise leak into the next test.
const originalProductsScan = redisProducts.scan.getMockImplementation()!;
const originalProductsDel = redisProducts.del.getMockImplementation()!;
const originalSearchScan = redisSearch.scan.getMockImplementation()!;
const originalSearchDel = redisSearch.del.getMockImplementation()!;

beforeEach(() => {
  jest.clearAllMocks();
  redisProducts.scan.mockImplementation(originalProductsScan);
  redisProducts.del.mockImplementation(originalProductsDel);
  redisSearch.scan.mockImplementation(originalSearchScan);
  redisSearch.del.mockImplementation(originalSearchDel);
  productsStore.clear();
  searchStore.clear();
});

describe("discovery sweep covers both Redis clients", () => {
  it("invalidates a search:* key held in redisSearch", async () => {
    seedDiscoveryCaches();
    await invalidateMarketplaceDiscoveryCaches();
    expect(searchStore.has("search:jollof:relevance:all:1:20")).toBe(false);
  });

  it("invalidates a suggestions:* key held in redisSearch", async () => {
    seedDiscoveryCaches();
    await invalidateMarketplaceDiscoveryCaches();
    expect(searchStore.has("suggestions:joll")).toBe(false);
  });

  it("still invalidates the redisProducts discovery namespaces", async () => {
    seedDiscoveryCaches();
    await invalidateMarketplaceDiscoveryCaches();

    expect(productsStore.has("home:feed:guest:u1:lat:6.5:lng:3.4:dishtype:JOLLOF:limit:20")).toBe(false);
    expect(productsStore.has("products:mostPopular:page=1:limit=20")).toBe(false);
    expect(productsStore.has("products:all:page=1:limit=20")).toBe(false);
    expect(productsStore.has("products:new:limit=20:dishtype=JOLLOF")).toBe(false);
    expect(productsStore.has("products:category:rice-dishes:page=1:limit=20:ALL")).toBe(false);
  });

  it("an unrelated key survives the sweep", async () => {
    seedDiscoveryCaches();
    await invalidateMarketplaceDiscoveryCaches();
    expect(productsStore.has("orders:open")).toBe(true);
  });
});

describe("failure isolation", () => {
  it("a failed pattern does not stop the remaining patterns on the same client", async () => {
    seedDiscoveryCaches();
    // Make ONE pattern fail on redisProducts.
    const realScan = redisProducts.scan.getMockImplementation()!;
    redisProducts.scan.mockImplementation(async (cursor: string, opts?: { MATCH?: string }) => {
      if (opts?.MATCH === "products:new:*") throw new Error("scan failed");
      return realScan(cursor, opts);
    });

    const result = await invalidateMarketplaceDiscoveryCaches();

    // The pattern that failed is reported, and the others were still attempted.
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.scope.includes("products:new:*"))).toBe(true);
    // The later patterns on the SAME client were still swept.
    expect(productsStore.has("products:category:rice-dishes:page=1:limit=20:ALL")).toBe(false);
    expect(productsStore.has("products:all:page=1:limit=20")).toBe(false);
  });

  it("a failure on one client does not stop the other client", async () => {
    seedDiscoveryCaches();
    const realScan = redisProducts.scan.getMockImplementation()!;
    redisProducts.scan.mockImplementation(async (cursor: string, opts?: { MATCH?: string }) => {
      if (opts?.MATCH === "home:feed:*") throw new Error("scan failed");
      return realScan(cursor, opts);
    });

    const result = await invalidateMarketplaceDiscoveryCaches();

    expect(result.ok).toBe(false);
    // redisSearch was still swept in full.
    expect(searchStore.has("search:jollof:relevance:all:1:20")).toBe(false);
    expect(searchStore.has("suggestions:joll")).toBe(false);
  });

  it("a failed delete is reported and does not stop the remaining patterns", async () => {
    seedDiscoveryCaches();
    // `products:all:*` is held in redisProducts, so this delete IS attempted.
    const realDel = redisProducts.del.getMockImplementation()!;
    redisProducts.del.mockImplementation(async (keys: string | string[]) => {
      if (Array.isArray(keys) && keys.some((k) => k.startsWith("products:all:"))) {
        throw new Error("del failed");
      }
      return realDel(keys);
    });

    const result = await invalidateMarketplaceDiscoveryCaches();

    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    // The failure names the client (database) and the operation.
    expect(result.failures[0]).toHaveProperty("database");
    expect(result.failures[0].scope).toContain("pattern:");
    expect(result.failures[0].scope).toContain("products:all:*");
    // The patterns after the failed one were still attempted on that client.
    expect(productsStore.has("products:category:rice-dishes:page=1:limit=20:ALL")).toBe(false);
    expect(productsStore.has("products:mostPopular:page=1:limit=20")).toBe(false);
  });

  it("reports ok:true and no failures when every sweep succeeds", async () => {
    const result = await invalidateMarketplaceDiscoveryCaches();
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("never throws, so a committed mutation is not turned into an HTTP failure", async () => {
    redisProducts.scan.mockImplementation(async () => {
      throw new Error("redis down");
    });
    await expect(invalidateMarketplaceDiscoveryCaches()).resolves.toBeDefined();
  });
});

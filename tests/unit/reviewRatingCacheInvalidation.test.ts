/**
 * B-5 — a review write must not leave a stale rating in the catalog caches.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `refreshProductRatingStats` updated the product's denormalized
 * `averageRating` / `reviewCount` columns, but nothing dropped the cached
 * copies of those numbers:
 *
 *   - the product-detail cache (`product:<id>:detail`, 5-hour TTL) baked
 *     `averageRating` / `reviewCount` into its payload;
 *   - the product-list caches (`products:all:*`, `products:category:*`,
 *     `products:mostPopular:*`, `products:new:*`, `home:feed:*`) baked the
 *     same columns into every card;
 *   - the search cache (`search:*`, 3-hour TTL) baked them into every row.
 *
 * So a new review was invisible for hours. The fix invalidates exactly
 * those namespaces on every review create / update / delete.
 *
 * WHAT IS ASSERTED
 *   - the affected keys really disappear (observed on an in-memory Redis
 *     double, not asserted against a mock call);
 *   - unrelated namespaces (suggestions, carts, orders) survive;
 *   - Redis is never flushed wholesale;
 *   - a failing invalidation is REPORTED and never throws, so a stale
 *     window can never be silent.
 *
 * DATABASE-INDEPENDENT: `src/lib/prisma` is mocked; no PostgreSQL and no
 * live Redis is contacted.
 */
jest.mock("../../src/lib/redis", () => {
  const globToRegExp = (pattern: string) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
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
    scan: jest.fn(
      async (_cursor: string, opts?: { MATCH?: string; COUNT?: number }) => {
        const match = opts?.MATCH;
        const found = match
          ? [...store.keys()].filter((k) => globToRegExp(match).test(k))
          : [...store.keys()];
        return { cursor: "0", keys: found };
      },
    ),
    flushDb: jest.fn(async () => "OK"),
  });

  const stores = {
    products: new Map<string, string>(),
    search: new Map<string, string>(),
    carts: new Map<string, string>(),
  };

  return {
    __esModule: true,
    __stores: stores,
    redisProducts: makeClient(1, stores.products),
    redisNotifications: makeClient(0, new Map()),
    redisSearch: makeClient(2, stores.search),
    redisTotalViews: makeClient(3, new Map()),
    redisUsersSessions: makeClient(4, new Map()),
    ShopCartRedis: makeClient(5, stores.carts),
  };
});

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { update: jest.fn(), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    productReview: { aggregate: jest.fn() },
  },
}));

import * as redisModule from "../../src/lib/redis";
import prisma from "../../src/lib/prisma";
import { invalidateProductRatingCaches } from "../../src/services/clearCaches";
import { refreshProductRatingStats } from "../../src/services/product.service";

const { products: productsStore, search: searchStore, carts: cartsStore } = (
  redisModule as unknown as {
    __stores: {
      products: Map<string, string>;
      search: Map<string, string>;
      carts: Map<string, string>;
    };
  }
).__stores;

const redisProducts = (
  redisModule as unknown as { redisProducts: { del: jest.Mock; scan: jest.Mock } }
).redisProducts;
const redisSearch = (
  redisModule as unknown as { redisSearch: { del: jest.Mock; scan: jest.Mock } }
).redisSearch;

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const PRODUCT_ID = "prod-1";

/** Every cache entry a rating change can make stale, plus unrelated ones. */
function seedCaches() {
  // Product detail (redisProducts).
  productsStore.set(`product:${PRODUCT_ID}:detail`, JSON.stringify({ id: PRODUCT_ID }));
  productsStore.set(`product:${PRODUCT_ID}`, JSON.stringify({ id: PRODUCT_ID }));
  productsStore.set(`api:product:${PRODUCT_ID}`, JSON.stringify({ id: PRODUCT_ID }));
  // Catalog list caches (redisProducts).
  productsStore.set("products:all:dishtype=ALL:page=1:limit=20", "[]");
  productsStore.set("products:category:rice-dishes:page=1:limit=20", "[]");
  productsStore.set("products:mostPopular:page=1:limit=20", "[]");
  productsStore.set("products:new:page=1:limit=20:dishtype=ALL", "[]");
  productsStore.set("home:feed:anon:u1:lat=-:lng=-:dishtype=ALL:limit=20", "{}");
  // Vendor dashboard caches (redisProducts).
  productsStore.set(
    "vendor:vendor-1:dashboardSummary:v2",
    JSON.stringify({ stats: { rating: { value: "4.5" } } }),
  );
  productsStore.set(
    "vendor:vendor-1:products:page:1:limit=20",
    JSON.stringify({ products: [{ id: PRODUCT_ID, averageRating: 4.5 }] }),
  );
  // Search cache (redisSearch).
  searchStore.set("search:jollof:relevance:all:1:20", "[]");
  // Unrelated keys — must survive.
  searchStore.set("suggestions:joll", "[]");
  productsStore.set("orders:open", "[]");
  cartsStore.set("cart:user:1:abc", "[]");
  // Another vendor's dashboard — must survive (scoped to affected vendor only).
  productsStore.set(
    "vendor:vendor-9:dashboardSummary:v2",
    JSON.stringify({ stats: { rating: { value: "3.0" } } }),
  );
  productsStore.set(
    "vendor:vendor-9:products:page:1:limit=20",
    JSON.stringify({ products: [] }),
  );
}

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
  cartsStore.clear();
  db.productReview.aggregate.mockResolvedValue({
    _avg: { rating: 4.5 },
    _count: { _all: 3 },
  });
  db.product.update.mockResolvedValue({ id: PRODUCT_ID });
  // Resolve the product's vendor so dashboard invalidation is scoped correctly.
  db.product.findUnique.mockResolvedValue({ id: PRODUCT_ID, vendorId: "vendor-1" });
});

describe("invalidateProductRatingCaches — what it drops", () => {
  it("drops the product's own detail cache entries", async () => {
    seedCaches();
    await invalidateProductRatingCaches(PRODUCT_ID);

    expect(productsStore.has(`product:${PRODUCT_ID}:detail`)).toBe(false);
    expect(productsStore.has(`product:${PRODUCT_ID}`)).toBe(false);
    expect(productsStore.has(`api:product:${PRODUCT_ID}`)).toBe(false);
  });

  it("drops every rating-bearing catalog list cache", async () => {
    seedCaches();
    await invalidateProductRatingCaches(PRODUCT_ID);

    expect(productsStore.has("products:all:dishtype=ALL:page=1:limit=20")).toBe(false);
    expect(productsStore.has("products:category:rice-dishes:page=1:limit=20")).toBe(false);
    expect(productsStore.has("products:mostPopular:page=1:limit=20")).toBe(false);
    expect(productsStore.has("products:new:page=1:limit=20:dishtype=ALL")).toBe(false);
    expect(productsStore.has("home:feed:anon:u1:lat=-:lng=-:dishtype=ALL:limit=20")).toBe(false);
  });

  it("drops the search cache, which holds the rating too", async () => {
    seedCaches();
    await invalidateProductRatingCaches(PRODUCT_ID);

    expect(searchStore.has("search:jollof:relevance:all:1:20")).toBe(false);
  });

  it("leaves unrelated namespaces alone", async () => {
    seedCaches();
    await invalidateProductRatingCaches(PRODUCT_ID);

    // Suggestions carry names, never a rating.
    expect(searchStore.has("suggestions:joll")).toBe(true);
    expect(productsStore.has("orders:open")).toBe(true);
    expect(cartsStore.has("cart:user:1:abc")).toBe(true);
  });

  it("does not flush Redis wholesale", async () => {
    seedCaches();
    await invalidateProductRatingCaches(PRODUCT_ID);

    const flushed = [
      ...Object.values(
        redisModule as unknown as Record<string, { flushDb?: jest.Mock }>,
      ),
    ].some((client) => client?.flushDb?.mock.calls.length);
    expect(flushed).toBe(false);
  });

  it("does not touch another product's detail entry", async () => {
    productsStore.set("product:prod-2:detail", "{}");
    await invalidateProductRatingCaches(PRODUCT_ID);
    expect(productsStore.has("product:prod-2:detail")).toBe(true);
  });

  it("drops the affected vendor's dashboard summary cache key", async () => {
    seedCaches();
    await invalidateProductRatingCaches(PRODUCT_ID);

    expect(
      productsStore.has("vendor:vendor-1:dashboardSummary:v2"),
    ).toBe(false);
  });

  it("drops the affected vendor's paginated product list cache keys", async () => {
    seedCaches();
    await invalidateProductRatingCaches(PRODUCT_ID);

    expect(
      productsStore.has("vendor:vendor-1:products:page:1:limit=20"),
    ).toBe(false);
  });

  it("does not touch another vendor's dashboard caches (vendor-scoped invalidation)", async () => {
    seedCaches();
    await invalidateProductRatingCaches(PRODUCT_ID);

    expect(
      productsStore.has("vendor:vendor-9:dashboardSummary:v2"),
    ).toBe(true);
    expect(
      productsStore.has("vendor:vendor-9:products:page:1:limit=20"),
    ).toBe(true);
  });

  it("leaves unrelated namespaces alone (suggestions, orders, carts)", async () => {
    seedCaches();
    await invalidateProductRatingCaches(PRODUCT_ID);

    expect(searchStore.has("suggestions:joll")).toBe(true);
    expect(productsStore.has("orders:open")).toBe(true);
    expect(cartsStore.has("cart:user:1:abc")).toBe(true);
  });
});

describe("invalidateProductRatingCaches — failure handling", () => {
  it("reports a failure and never throws", async () => {
    seedCaches();
    redisProducts.scan.mockImplementation(async () => {
      throw new Error("redis down");
    });

    const result = await invalidateProductRatingCaches(PRODUCT_ID);

    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toHaveProperty("database");
    expect(result.failures[0]).toHaveProperty("scope");
  });

  it("a failure on one pattern does not abandon the remaining patterns", async () => {
    seedCaches();
    const realScan = redisProducts.scan.getMockImplementation()!;
    redisProducts.scan.mockImplementation(
      async (cursor: string, opts?: { MATCH?: string }) => {
        if (opts?.MATCH === "products:new:*") throw new Error("scan failed");
        return realScan(cursor, opts);
      },
    );

    const result = await invalidateProductRatingCaches(PRODUCT_ID);

    expect(result.ok).toBe(false);
    expect(productsStore.has("products:all:dishtype=ALL:page=1:limit=20")).toBe(false);
    expect(productsStore.has("products:category:rice-dishes:page=1:limit=20")).toBe(false);
  });

  it("reports ok:true when everything succeeded", async () => {
    const result = await invalidateProductRatingCaches(PRODUCT_ID);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe("invalidateProductRatingCaches — dashboard vendor lookup failure", () => {
  it("reports a database failure without throwing when the product lookup fails", async () => {
    seedCaches();
    db.product.findUnique.mockRejectedValue(new Error("db down"));

    const result = await invalidateProductRatingCaches(PRODUCT_ID);

    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.scope === "vendor-lookup")).toBe(true);
    // The detail keys are still dropped even though the dashboard lookup failed.
    expect(productsStore.has(`product:${PRODUCT_ID}:detail`)).toBe(false);
  });
});

describe("refreshProductRatingStats — the review write path", () => {
  it("recomputes the stored rating stats", async () => {
    await refreshProductRatingStats(PRODUCT_ID);

    expect(db.productReview.aggregate).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID },
      _avg: { rating: true },
      _count: { _all: true },
    });
    expect(db.product.update).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID },
      data: { averageRating: 4.5, reviewCount: 3 },
    });
  });

  it("drops the cached rating copies as part of the same write", async () => {
    seedCaches();
    await refreshProductRatingStats(PRODUCT_ID);

    expect(productsStore.has(`product:${PRODUCT_ID}:detail`)).toBe(false);
    expect(productsStore.has("products:all:dishtype=ALL:page=1:limit=20")).toBe(false);
    expect(productsStore.has("products:category:rice-dishes:page=1:limit:20")).toBe(false);
    expect(productsStore.has("products:mostPopular:page=1:limit=20")).toBe(false);
    expect(productsStore.has("home:feed:anon:u1:lat=-:lng=-:dishtype=ALL:limit=20")).toBe(false);
    expect(searchStore.has("search:jollof:relevance:all:1:20")).toBe(false);
  });

  it("never throws when Redis is down, so the committed review is not lost", async () => {
    redisProducts.scan.mockImplementation(async () => {
      throw new Error("redis down");
    });
    redisProducts.del.mockImplementation(async () => {
      throw new Error("redis down");
    });

    await expect(refreshProductRatingStats(PRODUCT_ID)).resolves.toBeUndefined();
    // The database write still happened.
    expect(db.product.update).toHaveBeenCalled();
  });

  it("leaves the unrelated namespaces in place", async () => {
    seedCaches();
    await refreshProductRatingStats(PRODUCT_ID);

    expect(searchStore.has("suggestions:joll")).toBe(true);
    expect(productsStore.has("orders:open")).toBe(true);
  });
});

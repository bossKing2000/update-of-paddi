/**
 * Phase 2B.6 — tag cache invalidation.
 *
 * ROOT CAUSE (confirmed from source before this fix):
 *   The three admin tag mutations called only
 *   `invalidateMarketplaceDiscoveryCaches()`, whose pattern list does NOT
 *   include the `tags:all` namespace, and which never touches product-detail
 *   payloads. `GET /api/product/tags` (catalogController.ts) caches the active
 *   tag list under `tags:all` for 60 minutes, and `updateProduct` writes
 *   `product:{id}:detail` from a re-read that embeds tag objects — so a renamed
 *   or deactivated tag kept being served until its TTL expired.
 *
 * WHAT THESE TESTS DO
 *   - Drive the REAL admin handlers and the REAL `clearTagCache` against an
 *     in-memory Redis double, so the cache behaviour is OBSERVED (a key is
 *     really gone from the store) rather than asserted from a call list.
 *   - Prove a tag-list request after a mutation cannot serve the old cached
 *     list.
 *   - Prove failures are REPORTED (never thrown) and that unrelated keys
 *     survive.
 *
 * DATABASE-INDEPENDENT: `src/lib/prisma` is mocked; no PostgreSQL or live Redis
 * is contacted.
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

jest.mock("../../src/lib/prisma", () => {
  // The real module exports BOTH a named `prisma` and a default export.
  // `clearCaches.ts` reaches it with a DYNAMIC import and destructures the
  // NAMED export, so the mock must provide both.
  const prisma = {
    tag: {
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
    },
    productTag: { findMany: jest.fn(async () => []) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  return { __esModule: true, prisma, default: prisma };
});

import prisma from "../../src/lib/prisma";
import * as redisModule from "../../src/lib/redis";
import { redisSearch } from "../../src/lib/redis";
import { createTag, updateTag, deactivateTag } from "../../src/controllers/admin.controller";
import { getTags } from "../../src/controllers/catalogController";
import { clearTagCache } from "../../src/services/clearCaches";

// The mock factory exposes its in-memory stores for the test to inspect; the
// real module has no such export, so the namespace is narrowed explicitly.
const { products: productsStore, search: searchStore } = (
  redisModule as unknown as {
    __stores: { products: Map<string, string>; search: Map<string, string> };
  }
).__stores;

const db = prisma as unknown as {
  tag: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  productTag: { findMany: jest.Mock };
  auditLog: { create: jest.Mock };
};

const res = (): any => {
  const r: Record<string, unknown> = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const adminReq = (overrides: Record<string, unknown> = {}) =>
  ({
    body: {},
    params: {},
    query: {},
    headers: {},
    user: { id: "admin-1", role: "ADMIN" },
    get: () => undefined,
    ip: "127.0.0.1",
    ...overrides,
  }) as never;

const TAG = "SPICY";

beforeEach(() => {
  jest.clearAllMocks();
  productsStore.clear();
  searchStore.clear();
  db.tag.findFirst.mockResolvedValue(null);
  db.tag.findUnique.mockResolvedValue({ id: TAG, name: "Spicy", type: "CUISINE", isActive: true });
  db.tag.findMany.mockResolvedValue([{ id: TAG, name: "Spicy", type: "CUISINE" }]);
  db.tag.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: args.data.id,
    ...args.data,
  }));
  db.tag.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: TAG,
    ...args.data,
  }));
  db.productTag.findMany.mockResolvedValue([{ productId: "prod-1" }]);
});

/** Seed the caches a tag change should reach, plus one unrelated key. */
function seedTagDependantCaches() {
  productsStore.set("tags:all", JSON.stringify([{ id: TAG, name: "Spicy" }]));
  productsStore.set("product:prod-1:detail", JSON.stringify({ id: "prod-1", tags: [{ name: "Spicy" }] }));
  productsStore.set("products:all:page=1:limit=20", "[]");
  productsStore.set("products:category:rice-dishes:page=1:limit=20", "[]");
  productsStore.set("orders:open", "[]"); // unrelated -- must survive
  // search + suggestions live in the redisSearch instance.
  searchStore.set("search:spicy:relevance:all:1:20", "[]");
  searchStore.set("suggestions:spic", "[]");
}

describe("Phase 2B.6 — tag mutations invalidate tag-dependent caches", () => {
  it("createTag invalidates the tag list and the dependent caches", async () => {
    seedTagDependantCaches();
    await createTag(adminReq({ body: { name: "Mild", type: "CUISINE" } }), res());

    expect(productsStore.has("tags:all")).toBe(false);
    expect(productsStore.has("product:prod-1:detail")).toBe(false);
    expect(productsStore.has("products:all:page=1:limit=20")).toBe(false);
    expect(productsStore.has("products:category:rice-dishes:page=1:limit=20")).toBe(false);
    // search/suggestions are held in the redisSearch instance.
    expect(searchStore.has("search:spicy:relevance:all:1:20")).toBe(false);
    expect(searchStore.has("suggestions:spic")).toBe(false);
  });

  it("updateTag (rename) invalidates the same caches", async () => {
    seedTagDependantCaches();
    await updateTag(
      adminReq({ params: { id: TAG }, body: { name: "Zesty" } }),
      res(),
    );

    expect(productsStore.has("tags:all")).toBe(false);
    expect(productsStore.has("product:prod-1:detail")).toBe(false);
    expect(productsStore.has("products:all:page=1:limit=20")).toBe(false);
    expect(searchStore.has("search:spicy:relevance:all:1:20")).toBe(false);
    expect(searchStore.has("suggestions:spic")).toBe(false);
  });

  it("deactivateTag invalidates the same caches", async () => {
    seedTagDependantCaches();
    await deactivateTag(adminReq({ params: { id: TAG } }), res());

    expect(productsStore.has("tags:all")).toBe(false);
    expect(productsStore.has("product:prod-1:detail")).toBe(false);
    expect(productsStore.has("products:all:page=1:limit=20")).toBe(false);
    expect(searchStore.has("search:spicy:relevance:all:1:20")).toBe(false);
    expect(searchStore.has("suggestions:spic")).toBe(false);
  });

  it("an unrelated cache key survives the invalidation", async () => {
    seedTagDependantCaches();
    await createTag(adminReq({ body: { name: "Mild", type: "CUISINE" } }), res());

    expect(productsStore.has("orders:open")).toBe(true);
  });
});

describe("Phase 2B.6 — the cached tag list cannot be served after a mutation", () => {
  it("getTags re-reads the database instead of returning the stale cached list", async () => {
    // 1. First request populates the cache.
    db.tag.findMany.mockResolvedValue([{ id: TAG, name: "Spicy", type: "CUISINE" }]);
    const first = res();
    await getTags({} as never, first);
    expect(first.setHeader).toHaveBeenCalledWith("X-Cache", "MISS");
    expect(productsStore.get("tags:all")).toBeTruthy();

    // 2. A tag mutation invalidates it.
    await createTag(adminReq({ body: { name: "Mild", type: "CUISINE" } }), res());
    expect(productsStore.has("tags:all")).toBe(false);

    // 3. The next request must re-read the database and see the new tag.
    db.tag.findMany.mockResolvedValue([
      { id: TAG, name: "Spicy", type: "CUISINE" },
      { id: "MILD", name: "Mild", type: "CUISINE" },
    ]);
    const second = res();
    await getTags({} as never, second);
    expect(second.setHeader).toHaveBeenCalledWith("X-Cache", "MISS");
    const body = second.json.mock.calls[0][0];
    expect(body.data.tags.map((t: { name: string }) => t.name).sort()).toEqual(["Mild", "Spicy"]);
  });
});

describe("Phase 2B.6 — failure reporting contract", () => {
  it("clearTagCache reports failures instead of throwing, and the mutation still succeeds", async () => {
    seedTagDependantCaches();
    // Make one instance's del fail.
    const broken = redisSearch as unknown as { del: jest.Mock };
    broken.del.mockRejectedValueOnce(new Error("redis down"));

    const result = await clearTagCache(TAG);
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toHaveProperty("database");
    expect(result.failures[0]).toHaveProperty("scope");

    // A cache outage must not turn a committed mutation into a failed response.
    await createTag(adminReq({ body: { name: "Mild", type: "CUISINE" } }), res());
    expect(db.tag.create).toHaveBeenCalled();
  });

  it("clearTagCache reports ok:true when every deletion succeeds", async () => {
    const result = await clearTagCache(TAG);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("a failure to list the tag's products is reported, not thrown", async () => {
    db.productTag.findMany.mockRejectedValueOnce(new Error("db down"));
    const result = await clearTagCache(TAG);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.scope)).toContain("product-lookup");
  });
});

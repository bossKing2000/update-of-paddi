/**
 * Phase 2D suggestion-cache fix -- clearProductCache must sweep the
 * `suggestions:` namespace alongside the other discovery namespaces.
 *
 * All product mutation paths (update / archive / delete / option-group /
 * option-item / admin) funnel through clearProductCache, so covering the
 * helper covers every caller. Suggestion rows carry only product name +
 * dish-type name (see getSearchSuggestions), hence option mutations cannot
 * change suggestion content -- but they share the same sweep harmlessly.
 */
jest.mock("../../src/lib/redis", () => {
  const client = (database: number) => ({
    options: { database },
    scan: jest.fn(async () => ({ cursor: "0", keys: [] as string[] })),
    del: jest.fn(async () => 1),
  });
  return {
    __esModule: true,
    redisProducts: client(0),
    redisNotifications: client(1),
    redisSearch: client(2),
    redisTotalViews: client(3),
    redisUsersSessions: client(4),
    ShopCartRedis: client(5),
  };
});

import {
  redisProducts,
  redisNotifications,
  redisSearch,
  redisTotalViews,
  redisUsersSessions,
  ShopCartRedis,
} from "../../src/lib/redis";
import { clearProductCache } from "../../src/services/clearCaches";

type MockClient = {
  scan: jest.Mock;
  del: jest.Mock;
  options: { database: number };
};

const clients = () =>
  [
    redisProducts,
    redisNotifications,
    redisSearch,
    redisTotalViews,
    redisUsersSessions,
    ShopCartRedis,
  ] as unknown as MockClient[];

// Keys as they exist in Redis across instances.
const SCANNED_KEYS = [
  "suggestions:burger",
  "suggestions:jollof",
  "search:burger:relevance:all:1:20:f=ALL",
  "products:all:page=1:limit=20",
  "products:mostPopular:page=1:limit=20",
  "product:prod-1:detail",
  "category:cat-1",
  "vendor:vendor-1:products:page:1",
  "orders:open", // unrelated -- must never be deleted
];

const deletedKeys = (c: MockClient): string[] =>
  c.del.mock.calls.flatMap((args) => args[0] as string[]);

beforeEach(() => {
  jest.clearAllMocks();
  for (const c of clients()) {
    c.scan.mockResolvedValue({ cursor: "0", keys: [...SCANNED_KEYS] });
  }
});

describe("clearProductCache -- suggestions namespace", () => {
  it("Test 1/2/3: update/archive/delete paths (via clearProductCache) sweep suggestion keys", async () => {
    // Product update, archive, and delete all call
    // clearProductCache(productId, vendorId) -- one shared sweep.
    await clearProductCache("prod-1", "vendor-1");

    for (const c of clients()) {
      const deleted = deletedKeys(c);
      expect(deleted).toContain("suggestions:burger");
      expect(deleted).toContain("suggestions:jollof");
    }
  });

  it("Test 4: option mutations inherit the sweep via the same helper", async () => {
    // OptionGroup/OptionGroupItem mutations call
    // clearProductCache(productId, vendorId) (optionGroup.service.ts).
    // Suggestion rows contain only { id, name, dishType } -- option
    // names/prices never appear there -- so no option-specific logic is
    // needed; the shared sweep reaching suggestions: is the whole fix.
    await clearProductCache("prod-1", "vendor-1");

    const deleted = deletedKeys(redisSearch as unknown as MockClient);
    expect(deleted).toContain("suggestions:burger");
  });

  it("Test 5: existing detail/list/search/category invalidation preserved, unrelated keys untouched", async () => {
    await clearProductCache("prod-1", "vendor-1");

    for (const c of clients()) {
      const deleted = deletedKeys(c);
      // Fixed detail keys.
      expect(deleted).toContain("product:prod-1:detail");
      // Pre-existing pattern namespaces still swept.
      expect(deleted).toContain("products:all:page=1:limit=20");
      expect(deleted).toContain("products:mostPopular:page=1:limit=20");
      expect(deleted).toContain("search:burger:relevance:all:1:20:f=ALL");
      expect(deleted).toContain("category:cat-1");
      // Unrelated namespaces must never be swept.
      expect(deleted).not.toContain("orders:open");
    }
    // Vendor paginated lists are swept on the products instance only.
    expect(deletedKeys(redisProducts as unknown as MockClient)).toContain(
      "vendor:vendor-1:products:page:1",
    );
  });
});

describe("clearProductCache result contract — failures are reported, never thrown", () => {
  it("returns ok:true with no failures when every instance succeeds", async () => {
    const result = await clearProductCache("prod-1");

    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("reports a fixed-keys failure with database + scope and still sweeps the other instances", async () => {
    // redisSearch (database 2 in this double) fails its fixed-key delete.
    (redisSearch as unknown as MockClient).del.mockRejectedValueOnce(
      new Error("connection reset"),
    );

    const result = await clearProductCache("prod-1");

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ database: "2", scope: "fixed-keys" }]);
    // The failure on one instance must not block the others.
    for (const c of [redisProducts, redisNotifications, redisTotalViews, redisUsersSessions, ShopCartRedis] as unknown as MockClient[]) {
      expect(c.del).toHaveBeenCalled();
    }
  });

  it("reports a pattern-sweep failure with database + scope and resolves", async () => {
    // redisTotalViews (database 3) fails mid-sweep; SCAN itself throws.
    (redisTotalViews as unknown as MockClient).scan.mockRejectedValueOnce(
      new Error("read-only replica"),
    );

    const result = await clearProductCache("prod-1");

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ database: "3", scope: "pattern-sweep" }]);
  });

  it("reports a vendor-page-sweep failure distinctly from pattern sweeps", async () => {
    (redisProducts as unknown as MockClient).scan.mockRejectedValueOnce(
      new Error("timeout"),
    );

    const result = await clearProductCache("prod-1", "vendor-1");

    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual({ database: "0", scope: "vendor-page-sweep" });
  });

  it("logs failures through the structured logger with database, scope, and ids — and never secrets", async () => {
    const { logger } = require("../../src/lib/logger");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      (redisNotifications as unknown as MockClient).del.mockRejectedValueOnce(
        new Error("boom"),
      );

      const result = await clearProductCache("prod-9", "vendor-9");

      expect(result.ok).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      const payload = JSON.stringify(warnSpy.mock.calls);
      expect(payload).toContain("prod-9");
      expect(payload).toContain("fixed-keys");
      for (const secret of ["password", "token", "authorization", "secret", "apikey", "cookie"]) {
        expect(payload.toLowerCase()).not.toContain(secret);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("clearProductCache result contract — multiple independent failures", () => {
  it("accumulates every failure with its own database + scope instead of overwriting", async () => {
    // Two independent operations fail in one invocation: the fixed-key
    // delete on redisSearch (database 2) and the pattern sweep on
    // redisTotalViews (database 3). Neither may overwrite the other, and
    // the remaining instances must still be swept.
    (redisSearch as unknown as MockClient).del.mockRejectedValueOnce(
      new Error("connection reset"),
    );
    (redisTotalViews as unknown as MockClient).scan.mockRejectedValueOnce(
      new Error("read-only replica"),
    );

    const result = await clearProductCache("prod-1", "vendor-1");

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures).toContainEqual({ database: "2", scope: "fixed-keys" });
    expect(result.failures).toContainEqual({ database: "3", scope: "pattern-sweep" });
    // The helper keeps processing independent operations after a failure:
    // every other instance still attempted both its fixed-key delete and
    // its pattern sweep.
    for (const c of [redisProducts, redisNotifications, redisTotalViews, redisUsersSessions, ShopCartRedis] as unknown as MockClient[]) {
      expect(c.del).toHaveBeenCalled();
    }
    for (const c of [redisProducts, redisNotifications, redisSearch, redisUsersSessions, ShopCartRedis] as unknown as MockClient[]) {
      expect(c.scan).toHaveBeenCalled();
    }
  });
});

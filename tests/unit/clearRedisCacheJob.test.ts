/**
 * Focused tests for src/jobs/clearRedisCache.ts (Task 7.45).
 *
 * DB-free: src/lib/redis is mocked with in-memory fake clients, so no Redis
 * server is contacted. src/lib/redisScan.ts is NOT mocked — the real SCAN
 * cursor loop is exercised, because cursor handling is part of what is being
 * verified.
 *
 * The property under test is the safety one: this maintenance script must never
 * perform a database-wide delete, and must only ever delete keys inside the
 * cache namespaces it explicitly declares.
 */
import type { RedisClientType } from "redis";

/** Keys that must survive regardless of which sweep runs. */
const PROTECTED_KEYS = [
  "bull:productIndex:1",
  "bull:productIndex:1:lock",
  "bull:vendorFollowNotifications:waiting",
  "notifications:user-1:page:1:limit:20",
  "notif:unread:user-1",
  "session:user:user-1:sess-1",
  "session:refresh:jti:user-1:sess-1",
  "search:rice:hits",
  "product:prod-9:views:total",
  // Deliberately retained even though they live in a swept database
  // (INTENTIONALLY_RETAINED in the script).
  "global:popularity:max",
  "cart:product:prod-9:users",
  "job:popularity:progress",
  // Same namespace family as the approved promotion cache, but NOT approved:
  // proves the allow-list uses the full key, not a bare `promotions:` prefix.
  "promotions:admin:lock",
];

const PRODUCT_CACHE_KEYS = [
  "products:all:page=1:limit=20",
  "product:prod-1:detail",
  "categories:all",
  "tags:all",
  "dishtypes:all",
  "home:pot",
  "home:feed:guest::_:lat=-:lng=-:dishtype=all:limit=20",
  "vendor:vendor-1:products:page:1",
  // Task 7.47: confirmed disposable (promotionPricing.service.ts:50, TTL 60s,
  // rebuilt from prisma.promotion.findMany on miss).
  "promotions:active:product",
];

const CART_CACHE_KEYS = [
  "cart:user:user-1",
  "cart:user:user-2",
  "cart:user:v2:user-1",
  "cart:user:v2:user-2",
];

/**
 * In-memory stand-in implementing only what this script and redisScan use:
 * isOpen/connect/quit/scan/del, plus flushDb/flushAll spies that must stay
 * untouched. Pagination is emulated so the cursor loop is really exercised.
 */
function makeFakeClient(keys: string[], pageSize = 3) {
  const present = new Set(keys);
  const deleted: string[] = [];
  const scans: string[] = [];
  const flushDb = jest.fn();
  const flushAll = jest.fn();

  const client = {
    isOpen: false,
    flushDb,
    flushAll,
    connect: jest.fn(async function (this: { isOpen: boolean }) {
      this.isOpen = true;
    }),
    quit: jest.fn(async function (this: { isOpen: boolean }) {
      this.isOpen = false;
    }),
    // Fallbacks used by the script when quit() rejects. close() mirrors the real
    // client: it settles the socket and isOpen becomes false. destroy() is the
    // synchronous last resort.
    close: jest.fn(async function (this: { isOpen: boolean }) {
      this.isOpen = false;
    }),
    destroy: jest.fn(function (this: { isOpen: boolean }) {
      this.isOpen = false;
    }),
    scan: jest.fn(async (_cursor: string, opts?: { MATCH?: string; COUNT?: number }) => {
      const pattern = opts?.MATCH ?? "*";
      const count = opts?.COUNT ?? 10;
      scans.push(pattern);
      const all = [...present];
      const matched = all.filter((k) => matchesGlob(k, pattern));
      const offset = Number(_cursor ?? "0");
      const page = matched.slice(offset, offset + Math.min(count, pageSize));
      const next = offset + page.length;
      const cursor = next >= matched.length ? "0" : String(next);
      return { cursor, keys: page };
    }),
    del: jest.fn(async (input: string | string[]) => {
      const list = Array.isArray(input) ? input : [input];
      let n = 0;
      for (const k of list) {
        if (present.delete(k)) {
          deleted.push(k);
          n += 1;
        }
      }
      return n;
    }),
  };

  return {
    client: client as unknown as RedisClientType,
    raw: client,
    deleted,
    scans,
    flushDb,
    flushAll,
    remaining: () => [...present],
  };
}

/** Minimal Redis glob matcher for the `prefix*` patterns this script uses. */
function matchesGlob(key: string, pattern: string): boolean {
  if (pattern.endsWith("*") && !pattern.slice(0, -1).includes("*")) {
    return key.startsWith(pattern.slice(0, -1));
  }
  return key === pattern;
}

type Fake = ReturnType<typeof makeFakeClient>;

async function loadModuleWith(fakes: { products: Fake; cart: Fake }) {
  jest.resetModules();
  jest.doMock("../../src/lib/redis", () => ({
    __esModule: true,
    redisProducts: fakes.products.client,
    ShopCartRedis: fakes.cart.client,
    // Present so an accidental import of these would not explode; they must never
    // be reached because the module only imports the two above.
    redisNotifications: { flushDb: jest.fn(), scan: jest.fn(), del: jest.fn() },
    redisUsersSessions: { flushDb: jest.fn(), scan: jest.fn(), del: jest.fn() },
    redisSearch: { flushDb: jest.fn(), scan: jest.fn(), del: jest.fn() },
    redisTotalViews: { flushDb: jest.fn(), scan: jest.fn(), del: jest.fn() },
  }));
  return import("../../src/jobs/clearRedisCache");
}

// Task 7.49: the script now sets process.exitCode = 1 on any failed operation,
// which is correct behaviour but leaks across tests. Several earlier tests induce
// failures on purpose, so save and restore the exit code around EVERY test in
// this file, not just the block that asserts on it.
let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  delete process.exitCode;
});
afterEach(() => {
  if (savedExitCode === undefined) delete process.exitCode;
  else process.exitCode = savedExitCode;
});

beforeEach(() => {
  jest.resetModules();
});

describe("clearRedisCache safety (Task 7.45)", () => {
  it("never calls flushDb or flushAll on any client", async () => {
    const products = makeFakeClient([...PRODUCT_CACHE_KEYS, ...PROTECTED_KEYS]);
    const cart = makeFakeClient([...CART_CACHE_KEYS, ...PROTECTED_KEYS]);
    const mod = await loadModuleWith({ products, cart });

    await mod.clearAllCaches();

    expect(products.flushDb).not.toHaveBeenCalled();
    expect(products.flushAll).not.toHaveBeenCalled();
    expect(cart.flushDb).not.toHaveBeenCalled();
    expect(cart.flushAll).not.toHaveBeenCalled();
  });

  it("deletes only the approved cache namespaces and preserves everything else", async () => {
    const products = makeFakeClient([...PRODUCT_CACHE_KEYS, ...PROTECTED_KEYS]);
    const cart = makeFakeClient([...CART_CACHE_KEYS, ...PROTECTED_KEYS]);
    const mod = await loadModuleWith({ products, cart });

    await mod.clearAllCaches();

    const remaining = [...products.remaining(), ...cart.remaining()];

    // Every protected key survived, including BullMQ and notifications.
    for (const key of PROTECTED_KEYS) {
      expect(remaining).toContain(key);
    }
    // Every approved cache key is gone.
    for (const key of [...PRODUCT_CACHE_KEYS, ...CART_CACHE_KEYS]) {
      expect(remaining).not.toContain(key);
    }
  });

  it("never deletes BullMQ, notification or session keys even when present in a swept database", async () => {
    const products = makeFakeClient(PROTECTED_KEYS);
    const cart = makeFakeClient(PROTECTED_KEYS);
    const mod = await loadModuleWith({ products, cart });

    await mod.clearAllCaches();

    expect(products.raw.del).not.toHaveBeenCalled();
    expect(cart.raw.del).not.toHaveBeenCalled();
    expect(products.remaining().sort()).toEqual([...PROTECTED_KEYS].sort());
    expect(cart.remaining().sort()).toEqual([...PROTECTED_KEYS].sort());
  });

  it("scans with an explicit MATCH pattern and never a bare SCAN", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    await mod.clearAllCaches();

    for (const pattern of products.scans) {
      expect(pattern).not.toBe("*");
      expect(pattern.endsWith("*")).toBe(true);
    }
    for (const pattern of cart.scans) {
      expect(pattern.endsWith("*")).toBe(true);
    }
  });

  it("deletes across multiple cursor pages", async () => {
    // pageSize 3 with many keys forces the cursor loop to iterate repeatedly.
    const many = Array.from({ length: 40 }, (_, i) => `products:bulk:${i}`);
    const products = makeFakeClient(many, 3);
    const cart = makeFakeClient(CART_CACHE_KEYS, 3);
    const mod = await loadModuleWith({ products, cart });

    await mod.clearAllCaches();

    expect(products.remaining()).toHaveLength(0);
    // Paging is proven by repeated SCAN calls (the cursor loop), not by del
    // calls — del receives one batch of everything scanKeys collected.
    expect(products.raw.scan.mock.calls.length).toBeGreaterThan(5);
  });

  it("reports a Redis failure without falling back to a broader deletion", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    products.raw.scan.mockRejectedValue(new Error("connection lost"));
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(mod.clearAllCaches()).resolves.toBeUndefined();
    errSpy.mockRestore();

    // No deletion happened for the failed client, and no flush fallback either.
    expect(products.raw.del).not.toHaveBeenCalled();
    expect(products.flushDb).not.toHaveBeenCalled();
    expect(products.flushAll).not.toHaveBeenCalled();
    // The other client still ran normally.
    expect(cart.remaining()).toHaveLength(0);
  });

  it("declares the operational clients it refuses to touch", async () => {
    const products = makeFakeClient([]);
    const cart = makeFakeClient([]);
    const mod = await loadModuleWith({ products, cart });

    const names = mod.SKIPPED_CLIENTS.map((s: { name: string }) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["notifications", "userSessions", "search", "totalViews"]),
    );
    for (const entry of mod.SKIPPED_CLIENTS) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// Task 7.47 — hardening regression tests.
// ─────────────────────────────────────────────────────────────────────────────
describe("clearRedisCache hardening (Task 7.47)", () => {
  it("closes every open client even when one quit() rejects", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    // Both clients open normally, then closing the first one fails.
    products.raw.connect.mockImplementation(async function (this: { isOpen: boolean }) {
      this.isOpen = true;
    });
    cart.raw.connect.mockImplementation(async function (this: { isOpen: boolean }) {
      this.isOpen = true;
    });
    products.raw.quit.mockRejectedValue(new Error("quit failed"));

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(mod.clearAllCaches()).resolves.toBeUndefined();
    errSpy.mockRestore();

    // Both cleanup attempts happened: the failure did not short-circuit the loop.
    expect(products.raw.quit).toHaveBeenCalledTimes(1);
    expect(cart.raw.quit).toHaveBeenCalledTimes(1);
  });

  it("does not sweep a client whose connection failed, and still cleans the others", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    products.raw.connect.mockRejectedValue(new Error("cannot connect"));

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    await expect(mod.clearAllCaches()).resolves.toBeUndefined();
    errSpy.mockRestore();
    logSpy.mockRestore();

    // The failed client is never scanned or deleted.
    expect(products.raw.scan).not.toHaveBeenCalled();
    expect(products.raw.del).not.toHaveBeenCalled();
    expect(products.remaining()).toEqual(PRODUCT_CACHE_KEYS);

    // The healthy client is swept normally.
    expect(cart.raw.scan).toHaveBeenCalled();
    expect(cart.remaining()).toHaveLength(0);

    // And cleanup still ran for whichever client was left open.
    expect(cart.raw.quit).toHaveBeenCalledTimes(1);
  });

  it("clears the promotion cache key but not the rest of the promotions namespace", async () => {
    const products = makeFakeClient([...PRODUCT_CACHE_KEYS, ...PROTECTED_KEYS]);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    await mod.clearAllCaches();

    const remaining = products.remaining();
    expect(remaining).not.toContain("promotions:active:product");
    // Narrowed prefix: an unapproved sibling key in the same family survives.
    expect(remaining).toContain("promotions:admin:lock");
  });

  it("rejects prefixes containing Redis glob metacharacters before any scan or delete", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    expect(mod.isGlobSafePrefix("products:")).toBe(true);
    expect(mod.isGlobSafePrefix("promotions:active:product")).toBe(true);
    expect(mod.isGlobSafePrefix("")).toBe(false);
    for (const bad of ["pro*ucts:", "product?:", "product[:", "product]:", "product\\:"]) {
      expect(mod.isGlobSafePrefix(bad)).toBe(false);
      expect(() => mod.assertGlobSafePrefixes([bad])).toThrow(/metacharacters/);
    }

    // Fail-closed: the sweep aborts before touching Redis.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      mod.sweepCacheNamespace({
        name: "bad",
        client: products.client,
        prefixes: ["product*:"],
      }),
    ).rejects.toThrow(/Refusing to sweep/);
    errSpy.mockRestore();

    expect(products.raw.scan).not.toHaveBeenCalled();
    expect(products.raw.del).not.toHaveBeenCalled();
    expect(products.flushDb).not.toHaveBeenCalled();
  });

  it("every shipped prefix is glob-safe", async () => {
    const products = makeFakeClient([]);
    const cart = makeFakeClient([]);
    const mod = await loadModuleWith({ products, cart });

    for (const sweep of mod.CACHE_SWEEPS) {
      expect(() => mod.assertGlobSafePrefixes(sweep.prefixes)).not.toThrow();
    }
  });

  it("declares the intentionally retained keys rather than clearing them by accident", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    const retained = mod.INTENTIONALLY_RETAINED.map(
      (r: { key: string }) => r.key,
    );
    expect(retained).toEqual(
      expect.arrayContaining([
        "global:popularity:max",
        "cart:product:<id>:users",
        "job:popularity:progress",
      ]),
    );

    const allPrefixes = mod.CACHE_SWEEPS.flatMap(
      (s: { prefixes: readonly string[] }) => [...s.prefixes],
    );
    for (const entry of mod.INTENTIONALLY_RETAINED) {
      const literal = entry.key.replace("<id>", "prod-9");
      expect(allPrefixes.some((p: string) => literal.startsWith(p))).toBe(false);
    }
  });

  it("importing the module does not run the cache clear", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    // Import alone must not connect, scan, delete or close anything.
    expect(products.raw.connect).not.toHaveBeenCalled();
    expect(cart.raw.connect).not.toHaveBeenCalled();
    expect(products.raw.scan).not.toHaveBeenCalled();
    expect(cart.raw.scan).not.toHaveBeenCalled();
    expect(products.raw.del).not.toHaveBeenCalled();
    expect(cart.raw.del).not.toHaveBeenCalled();
    expect(products.raw.quit).not.toHaveBeenCalled();
    expect(cart.raw.quit).not.toHaveBeenCalled();
    expect(products.remaining()).toEqual(PRODUCT_CACHE_KEYS);
    expect(mod.clearAllCaches).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 7.49 — honest exit status and bounded client cleanup.
// ─────────────────────────────────────────────────────────────────────────────
describe("clearRedisCache exit status and bounded cleanup (Task 7.49)", () => {
  const silence = () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    return () => {
      err.mockRestore();
      log.mockRestore();
    };
  };

  it("does NOT set a failure exit code when everything succeeds", async () => {
    const products = makeFakeClient([...PRODUCT_CACHE_KEYS, ...PROTECTED_KEYS]);
    const cart = makeFakeClient([...CART_CACHE_KEYS, ...PROTECTED_KEYS]);
    const mod = await loadModuleWith({ products, cart });

    const restore = silence();
    await mod.clearAllCaches();
    restore();

    expect(process.exitCode).toBeUndefined();
  });

  it("sets a non-zero exit code when a connection fails", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });
    products.raw.connect.mockRejectedValue(new Error("cannot connect"));

    const restore = silence();
    await mod.clearAllCaches();
    restore();

    expect(process.exitCode).toBe(1);
    expect(products.raw.scan).not.toHaveBeenCalled();
    expect(products.raw.del).not.toHaveBeenCalled();
  });

  it("sets a non-zero exit code when a sweep fails", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });
    products.raw.scan.mockRejectedValue(new Error("scan failed"));

    const restore = silence();
    await mod.clearAllCaches();
    restore();

    expect(process.exitCode).toBe(1);
    // No broader deletion was attempted as a result of the failure.
    expect(products.flushDb).not.toHaveBeenCalled();
    expect(products.flushAll).not.toHaveBeenCalled();
  });

  it("sets a non-zero exit code when cleanup fails, even though a fallback closes the client", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });
    products.raw.quit.mockRejectedValue(new Error("quit failed"));

    const restore = silence();
    await mod.clearAllCaches();
    restore();

    // Graceful close failed => the run failed, even though close() recovered.
    expect(process.exitCode).toBe(1);
    expect(products.raw.quit).toHaveBeenCalledTimes(1);
    expect(products.raw.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to close() when quit() rejects, in order", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });
    products.raw.quit.mockRejectedValue(new Error("quit failed"));

    const order: string[] = [];
    products.raw.quit.mockImplementation(async () => {
      order.push("quit");
      throw new Error("quit failed");
    });
    products.raw.close.mockImplementation(async function (this: { isOpen: boolean }) {
      order.push("close");
      this.isOpen = false;
    });

    const restore = silence();
    await mod.clearAllCaches();
    restore();

    expect(order).toEqual(["quit", "close"]);
    // close() succeeded, so no destructive destroy() was needed.
    expect(products.raw.destroy).not.toHaveBeenCalled();
    expect(products.raw.isOpen).toBe(false);
  });

  it("attempts destroy() when close() also fails and the client is still open", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    products.raw.quit.mockRejectedValue(new Error("quit failed"));
    // close() rejects AND leaves the client open, so destroy() must be tried.
    products.raw.close.mockRejectedValue(new Error("close failed"));
    products.raw.isOpen = true;

    const restore = silence();
    await mod.clearAllCaches();
    restore();

    expect(products.raw.quit).toHaveBeenCalledTimes(1);
    expect(products.raw.close).toHaveBeenCalledTimes(1);
    expect(products.raw.destroy).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("never uses the deprecated disconnect() method", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });
    products.raw.quit.mockRejectedValue(new Error("quit failed"));

    const restore = silence();
    await mod.clearAllCaches();
    restore();

    const disconnect = (products.raw as unknown as Record<string, unknown>).disconnect;
    if (disconnect) expect(disconnect).not.toHaveBeenCalled();
    // Source-level guard: the script must not reference disconnect at all.
    expect(require("fs").readFileSync(require.resolve("../../src/jobs/clearRedisCache"), "utf8"))
      .not.toMatch(/\.disconnect\s*\(/);
  });

  it("one client's cleanup failure does not stop cleanup attempts on the other", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    // products fails every stage of cleanup; cart must still be attempted.
    products.raw.quit.mockRejectedValue(new Error("quit failed"));
    products.raw.close.mockRejectedValue(new Error("close failed"));

    const restore = silence();
    await expect(mod.clearAllCaches()).resolves.toBeUndefined();
    restore();

    expect(products.raw.destroy).toHaveBeenCalledTimes(1);
    expect(cart.raw.quit).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("still performs the cache deletion work unchanged", async () => {
    const products = makeFakeClient([...PRODUCT_CACHE_KEYS, ...PROTECTED_KEYS]);
    const cart = makeFakeClient([...CART_CACHE_KEYS, ...PROTECTED_KEYS]);
    const mod = await loadModuleWith({ products, cart });

    const restore = silence();
    await mod.clearAllCaches();
    restore();

    const remaining = [...products.remaining(), ...cart.remaining()];
    for (const key of PROTECTED_KEYS) expect(remaining).toContain(key);
    for (const key of [...PRODUCT_CACHE_KEYS, ...CART_CACHE_KEYS]) {
      expect(remaining).not.toContain(key);
    }
    expect(products.flushDb).not.toHaveBeenCalled();
    expect(cart.flushAll).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 7.50 — bounded wait so a close() that never settles cannot block destroy().
// ─────────────────────────────────────────────────────────────────────────────
describe("clearRedisCache bounded close timeout (Task 7.50)", () => {
  const silence = () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    return () => {
      err.mockRestore();
      log.mockRestore();
      warn.mockRestore();
    };
  };

  /** A close() that never settles — the exact hang the bound must survive. */
  const neverSettles = () => new Promise<never>(() => { /* never resolves */ });

  it("defaults to a finite, non-zero close timeout", async () => {
    const products = makeFakeClient([]);
    const cart = makeFakeClient([]);
    const mod = await loadModuleWith({ products, cart });

    expect(mod.CLOSE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(mod.CLOSE_TIMEOUT_MS)).toBe(true);
  });

  it("proceeds to destroy() when close() never settles, within the timeout", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    products.raw.quit.mockRejectedValue(new Error("quit failed"));
    products.raw.close.mockImplementation(neverSettles);

    const started = Date.now();
    const restore = silence();
    await mod.clearAllCaches({ closeTimeoutMs: 10 });
    const elapsed = Date.now() - started;
    restore();

    // The hang did not block cleanup: destroy() was reached.
    expect(products.raw.quit).toHaveBeenCalledTimes(1);
    expect(products.raw.close).toHaveBeenCalledTimes(1);
    expect(products.raw.destroy).toHaveBeenCalledTimes(1);
    // Bounded: it returned promptly rather than hanging.
    expect(elapsed).toBeLessThan(2000);
    expect(products.raw.isOpen).toBe(false);
  });

  it("marks the run failed and exits non-zero even though destroy() succeeded", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    products.raw.quit.mockRejectedValue(new Error("quit failed"));
    products.raw.close.mockImplementation(neverSettles);

    const restore = silence();
    await mod.clearAllCaches({ closeTimeoutMs: 10 });
    restore();

    expect(process.exitCode).toBe(1);
  });

  it("consumes a late rejection from close() with no unhandled rejection", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    let rejectLater: (reason: Error) => void = () => { /* replaced below */ };
    products.raw.quit.mockRejectedValue(new Error("quit failed"));
    products.raw.close.mockImplementation(
      () => new Promise<never>((_resolve, reject) => {
        rejectLater = reject;
      }),
    );

    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);

    try {
      const restore = silence();
      await mod.clearAllCaches({ closeTimeoutMs: 10 });
      restore();

      // The bounded wait already decided; now let the original close() promise
      // reject. Nothing should surface as an unhandled rejection.
      rejectLater(new Error("late close rejection"));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
      expect(products.raw.destroy).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      // The load-bearing half: a rejection arriving AFTER the bounded wait was
      // decided must not abort the run or skip the remaining clients. Without
      // the explicit rejection handler in settleWithin, the race itself rejects
      // and clearAllCaches tears down before cleaning the next client.
      expect(cart.raw.quit).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("continues to the next client after the first one times out", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    products.raw.quit.mockRejectedValue(new Error("quit failed"));
    products.raw.close.mockImplementation(neverSettles);

    const restore = silence();
    await expect(mod.clearAllCaches({ closeTimeoutMs: 10 })).resolves.toBeUndefined();
    restore();

    // The hanging client was forced down...
    expect(products.raw.destroy).toHaveBeenCalledTimes(1);
    // ...and the second client was still cleaned up normally.
    expect(cart.raw.quit).toHaveBeenCalledTimes(1);
    expect(cart.raw.close).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("still uses close() and not destroy() when close() settles in time", async () => {
    const products = makeFakeClient(PRODUCT_CACHE_KEYS);
    const cart = makeFakeClient(CART_CACHE_KEYS);
    const mod = await loadModuleWith({ products, cart });

    const order: string[] = [];
    products.raw.quit.mockImplementation(async () => {
      order.push("quit");
      throw new Error("quit failed");
    });
    products.raw.close.mockImplementation(async function (this: { isOpen: boolean }) {
      order.push("close");
      this.isOpen = false;
    });

    const restore = silence();
    await mod.clearAllCaches({ closeTimeoutMs: 50 });
    restore();

    expect(order).toEqual(["quit", "close"]);
    expect(products.raw.destroy).not.toHaveBeenCalled();
  });

  it("deletion scope and protected keys are unchanged by the timeout work", async () => {
    const products = makeFakeClient([...PRODUCT_CACHE_KEYS, ...PROTECTED_KEYS]);
    const cart = makeFakeClient([...CART_CACHE_KEYS, ...PROTECTED_KEYS]);
    const mod = await loadModuleWith({ products, cart });

    const restore = silence();
    await mod.clearAllCaches();
    restore();

    const remaining = [...products.remaining(), ...cart.remaining()];
    for (const key of PROTECTED_KEYS) expect(remaining).toContain(key);
    for (const key of [...PRODUCT_CACHE_KEYS, ...CART_CACHE_KEYS]) {
      expect(remaining).not.toContain(key);
    }
    expect(products.flushDb).not.toHaveBeenCalled();
    expect(cart.flushAll).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

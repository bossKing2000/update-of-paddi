import { CATALOG_SORT_VALUES } from "../../src/services/product.service";

/**
 * Mirrors the deterministic cache-key construction from
 * productController.getAllProducts. Extracted here as a pure function
 * so tests can verify uniqueness without Redis.
 */
function buildCacheKey(params: {
  category?: string;
  vendorId?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  minPrice?: number;
  maxPrice?: number;
  availableOnly?: boolean;
}): string {
  const category = params.category?.toUpperCase() ?? "ALL";
  const sortBy = params.sortBy || "default";
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const vendorPart = params.vendorId ? `vendor=${params.vendorId}:` : "";
  const filterKey = [
    `sort=${sortBy}`,
    params.minPrice != null ? `min=${params.minPrice}` : "min=none",
    params.maxPrice != null ? `max=${params.maxPrice}` : "max=none",
    `av=${params.availableOnly ? 1 : 0}`,
  ].join(":");

  return `products:all:${vendorPart}category=${category}:page=${page}:limit=${limit}:${filterKey}`;
}

describe("GET /product cache-key uniqueness", () => {
  test("different categories produce different keys", () => {
    const lunch = buildCacheKey({ category: "LUNCH" });
    const breakfast = buildCacheKey({ category: "BREAKFAST" });
    expect(lunch).not.toBe(breakfast);
    expect(lunch).toContain("LUNCH");
    expect(breakfast).toContain("BREAKFAST");
  });

  test("ALL produces a distinct key from any specific category", () => {
    expect(buildCacheKey({ category: "ALL" }))
      .not.toBe(buildCacheKey({ category: "LUNCH" }));
  });

  test("different sortBy values produce different keys", () => {
    expect(buildCacheKey({ sortBy: "popularity" }))
      .not.toBe(buildCacheKey({ sortBy: "newest" }));
    expect(buildCacheKey({ sortBy: "priceAsc" }))
      .not.toBe(buildCacheKey({ sortBy: "priceDesc" }));
  });

  test("different minPrice values produce different keys", () => {
    expect(buildCacheKey({ minPrice: 1000 }))
      .not.toBe(buildCacheKey({ minPrice: 5000 }));
    expect(buildCacheKey({ minPrice: 1000 }))
      .not.toBe(buildCacheKey({}));
  });

  test("different maxPrice values produce different keys", () => {
    expect(buildCacheKey({ maxPrice: 5000 }))
      .not.toBe(buildCacheKey({ maxPrice: 10000 }));
  });

  test("availableOnly=true vs false produce different keys", () => {
    expect(buildCacheKey({ availableOnly: true }))
      .not.toBe(buildCacheKey({ availableOnly: false }));
  });

  test("different pages produce different keys", () => {
    expect(buildCacheKey({ page: 1 })).not.toBe(buildCacheKey({ page: 2 }));
  });

  test("different limits produce different keys", () => {
    expect(buildCacheKey({ limit: 10 })).not.toBe(buildCacheKey({ limit: 20 }));
  });

  test("vendorId creates a vendor-scoped key distinct from global catalog", () => {
    const global = buildCacheKey({});
    const vendor = buildCacheKey({ vendorId: "abc" });
    expect(vendor).toContain("vendor=abc");
    expect(vendor).not.toBe(global);
    expect(buildCacheKey({ vendorId: "a" }))
      .not.toBe(buildCacheKey({ vendorId: "b" }));
  });

  test("combined filters produce a unique key", () => {
    const key1 = buildCacheKey({
      category: "LUNCH", sortBy: "priceAsc", minPrice: 1000, maxPrice: 5000, availableOnly: true,
    });
    const key2 = buildCacheKey({
      category: "LUNCH", sortBy: "priceAsc", minPrice: 1000, maxPrice: 5000, availableOnly: true,
    });
    expect(key1).toBe(key2); // same filters = same key (deterministic)

    const key3 = buildCacheKey({
      category: "LUNCH", sortBy: "priceAsc", minPrice: 1000, maxPrice: 5000, availableOnly: false,
    });
    expect(key3).not.toBe(key1); // toggling availability changes the key
  });

  test("key starts with products: namespace for SCAN-based invalidation", () => {
    expect(buildCacheKey({}).startsWith("products:")).toBe(true);
  });

  test("CATALOG_SORT_VALUES matches backend contract", () => {
    expect(CATALOG_SORT_VALUES).toEqual(
      expect.arrayContaining(["popularity", "priceAsc", "priceDesc", "newest"]),
    );
    expect(CATALOG_SORT_VALUES).not.toContain("relevance");
  });
});

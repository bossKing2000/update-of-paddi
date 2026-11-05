/**
 * Phase 2 M1 — public taxonomy read API.
 *
 * Covers GET /product/tags, GET /product/categories and
 * GET /product/categories/:slug/products (catalogController) plus the
 * categoryId predicate of the shared fetchProductPage query core.
 *
 * All infrastructure is mocked (Prisma, Redis); promotion attachment is
 * identity so tests assert catalog behavior, not pricing.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    category: { findMany: jest.fn(), findUnique: jest.fn() },
    tag: { findMany: jest.fn() },
    product: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  loadActiveProductPromos: jest.fn(async () => []),
  attachPromotions: jest.fn((items: unknown[]) => items),
}));

jest.mock("../../src/services/product.service", () => {
  const actual = jest.requireActual("../../src/services/product.service");
  return {
    __esModule: true,
    ...actual,
    fetchProductPage: jest.fn(async () => ({ products: [], total: 0 })),
    assertActiveDishType: jest.fn(async () => {}),
  };
});

import prisma from "../../src/lib/prisma";
import { redisProducts } from "../../src/lib/redis";
import {
  getTags,
  getCategories,
  getCategoryProducts,
  normalizeCategorySlug,
  resolveActiveCategory,
} from "../../src/controllers/catalogController";
import { fetchProductPage } from "../../src/services/product.service";
import { NotFoundError, ValidationError } from "../../src/errors/AppError";
import { CACHE_KEYS } from "../../src/services/redisCacheTiming";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedGet = redisProducts.get as unknown as jest.Mock;
const mockedSet = redisProducts.set as unknown as jest.Mock;
const mockedFetchPage = fetchProductPage as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const dataOf = (r: any) => r.json.mock.calls[0][0].data;
const metaOf = (r: any) => r.json.mock.calls[0][0].meta;

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockResolvedValue(null);
  mockedFetchPage.mockResolvedValue({ products: [], total: 0 });
});

describe("normalizeCategorySlug", () => {
  it("trims and lowercases, matching stored slug form", () => {
    expect(normalizeCategorySlug("  Rice-Dishes ")).toBe("rice-dishes");
    expect(normalizeCategorySlug("SOUPS-AND-SWALLOW")).toBe("soups-and-swallow");
  });
});

describe("GET /product/tags", () => {
  const tags = [
    { id: "NIGERIAN", name: "Nigerian", type: "CUISINE" },
    { id: "VEGAN", name: "Vegan", type: "DIET" },
  ];

  it("returns only active tags ordered by name then id", async () => {
    db.tag.findMany.mockResolvedValue(tags);
    const r = res();
    await getTags({} as any, r);

    expect(db.tag.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, type: true },
    });
    expect(dataOf(r).tags).toEqual(tags);
    expect(r.setHeader).toHaveBeenCalledWith("X-Cache", "MISS");
  });

  it("serves cached tags without touching the database", async () => {
    mockedGet.mockResolvedValueOnce(JSON.stringify(tags));
    const r = res();
    await getTags({} as any, r);

    expect(mockedGet).toHaveBeenCalledWith(CACHE_KEYS.TAGS_ALL);
    expect(db.tag.findMany).not.toHaveBeenCalled();
    expect(dataOf(r).tags).toEqual(tags);
    expect(r.setHeader).toHaveBeenCalledWith("X-Cache", "HIT");
  });

  it("propagates database errors to the central error middleware", async () => {
    db.tag.findMany.mockRejectedValue(new Error("db down"));
    await expect(getTags({} as any, res())).rejects.toThrow("db down");
  });
});

describe("GET /product/categories", () => {
  const categories = [
    { id: "RICE_DISHES", name: "Rice Dishes", slug: "rice-dishes", icon: null, sortOrder: 10 },
    { id: "DRINKS", name: "Drinks", slug: "drinks", icon: null, sortOrder: 60 },
  ];

  it("returns only active categories in sortOrder with deterministic tie-breaks", async () => {
    db.category.findMany.mockResolvedValue(categories);
    db.product.groupBy.mockResolvedValue([]);
    const r = res();
    await getCategories({} as any, r);

    expect(db.category.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, slug: true, icon: true, sortOrder: true },
    });
    expect(dataOf(r).categories.map((c: any) => c.id)).toEqual(["RICE_DISHES", "DRINKS"]);
  });

  it("counts non-archived products regardless of vendor availability, defaults missing to 0", async () => {
    db.category.findMany.mockResolvedValue(categories);
    // RICE_DISHES has listed products (some from offline vendors — the
    // count query must not filter on vendor state); DRINKS has none.
    db.product.groupBy.mockResolvedValue([
      { categoryId: "RICE_DISHES", _count: { _all: 7 } },
    ]);
    const r = res();
    await getCategories({} as any, r);

    // Archived products are excluded from counts.
    expect(db.product.groupBy).toHaveBeenCalledWith({
      by: ["categoryId"],
      where: { archived: false },
      _count: { _all: true },
    });
    const byId = new Map(dataOf(r).categories.map((c: any) => [c.id, c.productCount]));
    expect(byId.get("RICE_DISHES")).toBe(7);
    expect(byId.get("DRINKS")).toBe(0);
  });

  it("serves cached categories without touching the database", async () => {
    const cached = [{ id: "RICE_DISHES", productCount: 7 }];
    mockedGet.mockResolvedValueOnce(JSON.stringify(cached));
    const r = res();
    await getCategories({} as any, r);

    expect(mockedGet).toHaveBeenCalledWith(CACHE_KEYS.CATEGORIES_ALL);
    expect(db.category.findMany).not.toHaveBeenCalled();
    expect(db.product.groupBy).not.toHaveBeenCalled();
    expect(dataOf(r).categories).toEqual(cached);
  });

  it("propagates database errors to the central error middleware", async () => {
    db.category.findMany.mockRejectedValue(new Error("db down"));
    await expect(getCategories({} as any, res())).rejects.toThrow("db down");
  });
});

describe("resolveActiveCategory", () => {
  it("resolves an active category by slug", async () => {
    const cat = { id: "RICE_DISHES", slug: "rice-dishes", isActive: true };
    db.category.findUnique.mockResolvedValue(cat);
    await expect(resolveActiveCategory("rice-dishes")).resolves.toBe(cat);
    expect(db.category.findUnique).toHaveBeenCalledWith({ where: { slug: "rice-dishes" } });
  });

  it("throws a standard 404 for unknown slugs", async () => {
    db.category.findUnique.mockResolvedValue(null);
    const err = await resolveActiveCategory("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).statusCode).toBe(404);
    expect((err as NotFoundError).code).toBe("NOT_FOUND");
  });

  it("throws a standard 404 for inactive slugs (no probing of hidden taxonomy)", async () => {
    db.category.findUnique.mockResolvedValue({ id: "X", slug: "x", isActive: false });
    await expect(resolveActiveCategory("x")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("GET /product/categories/:slug/products", () => {
  const cat = { id: "RICE_DISHES", slug: "rice-dishes", isActive: true };
  const req = (slug: unknown, query: Record<string, unknown> = {}): any => ({
    params: { slug },
    query,
  });

  it("normalizes the slug and scopes the query to the server-resolved category id", async () => {
    db.category.findUnique.mockResolvedValue(cat);
    mockedFetchPage.mockResolvedValue({ products: [{ id: "p1" }], total: 1 });
    const r = res();
    await getCategoryProducts(req("  Rice-Dishes "), r);

    expect(db.category.findUnique).toHaveBeenCalledWith({ where: { slug: "rice-dishes" } });
    expect(mockedFetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: "RICE_DISHES" }),
    );
    expect(dataOf(r)).toEqual([{ id: "p1" }]);
    expect(metaOf(r)).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
  });

  it("returns 404 for unknown slugs without querying products", async () => {
    db.category.findUnique.mockResolvedValue(null);
    await expect(getCategoryProducts(req("nope"), res())).rejects.toBeInstanceOf(NotFoundError);
    expect(mockedFetchPage).not.toHaveBeenCalled();
  });

  it("returns 404 for inactive slugs without querying products", async () => {
    db.category.findUnique.mockResolvedValue({ ...cat, isActive: false });
    await expect(getCategoryProducts(req("rice-dishes"), res())).rejects.toBeInstanceOf(NotFoundError);
    expect(mockedFetchPage).not.toHaveBeenCalled();
  });

  it("rejects an empty slug", async () => {
    await expect(getCategoryProducts(req("   "), res())).rejects.toBeInstanceOf(ValidationError);
  });

  it("forwards existing filters, sort and pagination (capped at 20)", async () => {
    db.category.findUnique.mockResolvedValue(cat);
    const r = res();
    await getCategoryProducts(
      req("rice-dishes", {
        page: "2", limit: "50", vendorId: "v1", minPrice: "100", maxPrice: "500",
        minRating: "4", sortBy: "priceAsc", availableOnly: "true",
      }),
      r,
    );

    expect(mockedFetchPage).toHaveBeenCalledWith({
      skip: 20, take: 20, dishType: undefined, vendorId: "v1",
      categoryId: "RICE_DISHES", sortBy: "priceAsc",
      minPrice: 100, maxPrice: 500, minRating: 4, availableOnly: true,
    });
    expect(metaOf(r)).toEqual({ total: 0, page: 2, limit: 20, totalPages: 0 });
  });

  it("rejects invalid sortBy, inverted prices and bad availableOnly like plain browse", async () => {
    db.category.findUnique.mockResolvedValue(cat);
    await expect(
      getCategoryProducts(req("rice-dishes", { sortBy: "bogus" }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      getCategoryProducts(req("rice-dishes", { minPrice: "9", maxPrice: "1" }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      getCategoryProducts(req("rice-dishes", { availableOnly: "maybe" }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("isolates cache keys across slugs and query parameters", async () => {
    db.category.findUnique.mockResolvedValue(cat);
    await getCategoryProducts(req("rice-dishes", { page: "1" }), res());
    await getCategoryProducts(req("drinks", { page: "1" }), res());
    await getCategoryProducts(req("rice-dishes", { page: "2" }), res());
    await getCategoryProducts(req("rice-dishes", { sortBy: "priceAsc" }), res());

    const keys = mockedGet.mock.calls.map((c) => String(c[0]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toContain("products:category:rice-dishes:");
    expect(keys[1]).toContain("products:category:drinks:");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("serves cached pages with fresh promotions and pagination metadata", async () => {
    db.category.findUnique.mockResolvedValue(cat);
    mockedGet.mockResolvedValueOnce(
      JSON.stringify({ data: [{ id: "p1" }], pagination: { total: 1, page: 1, limit: 20, totalPages: 1 } }),
    );
    const r = res();
    await getCategoryProducts(req("rice-dishes"), r);

    expect(mockedFetchPage).not.toHaveBeenCalled();
    expect(dataOf(r)).toEqual([{ id: "p1" }]);
    expect(metaOf(r)).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(r.setHeader).toHaveBeenCalledWith("X-Cache", "HIT");
  });
});

describe("fetchProductPage categoryId predicate (shared query core)", () => {
  it("constrains results to the given category without touching other filters", async () => {
    // Use the REAL implementation (via requireActual) against the mocked
    // Prisma client so the test proves the predicate reaches the database.
    const actual = jest.requireActual("../../src/services/product.service") as typeof import("../../src/services/product.service");
    db.product.findMany.mockResolvedValue([]);
    db.product.count.mockResolvedValue(0);

    await actual.fetchProductPage({ skip: 0, take: 20, categoryId: "RICE_DISHES" });

    const where = db.product.findMany.mock.calls[0][0].where;
    expect(where.archived).toBe(false);
    expect(where.categoryId).toBe("RICE_DISHES");
    expect(where.dishTypeId).toBeUndefined();
    expect(where.vendorId).toBeUndefined();
  });
});

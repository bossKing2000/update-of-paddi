/**
 * Phase 2 M2 — canonical product-tag assignment and tag filtering.
 *
 * Covers productTag.service (parse/resolve), vendor create/update tag
 * assignment (productController), tag filtering on browse / category
 * browse / search, cache-key isolation, invalidation wiring, and
 * regression of the tag-less request contract.
 *
 * All infrastructure is mocked (Prisma, Redis); promotion attachment is
 * identity so tests assert catalog behavior, not pricing.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
    productTag: { deleteMany: jest.fn(), createMany: jest.fn() },
    tag: { findMany: jest.fn() },
    category: { findMany: jest.fn(), findUnique: jest.fn() },
    dishType: { findUnique: jest.fn() },
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
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

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => ({ ok: true, failures: [] })),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/controllers/vendorDashboard.service", () => ({
  __esModule: true,
  VendorDashboardService: jest.fn().mockImplementation(() => ({
    invalidateCache: jest.fn(async () => {}),
  })),
}));

// Real fetchProductPage (tag predicate under test); only the dish-type
// vocabulary check is stubbed and cart-sweep is silenced (covered by
// existing cache tests; here it would only log against the redis mock).
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
import { redisProducts, redisSearch } from "../../src/lib/redis";
import { clearProductCache } from "../../src/services/clearCaches";
import {
  parseTagQueryParam,
  resolveActiveTagIds,
} from "../../src/services/productTag.service";
import {
  createProduct,
  updateProduct,
  getAllProducts,
  searchProducts,
} from "../../src/controllers/productController";
import { getCategoryProducts } from "../../src/controllers/catalogController";
import { ForbiddenError, ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedProductGet = redisProducts.get as unknown as jest.Mock;
const mockedProductSet = redisProducts.set as unknown as jest.Mock;
const mockedSearchGet = redisSearch.get as unknown as jest.Mock;
const mockedRaw = db.$queryRawUnsafe as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const bodyOf = (r: any) => r.json.mock.calls[0][0];
const vendorReq = (overrides: Partial<any> = {}): any =>
  ({
    headers: {},
    body: {},
    params: { id: "prod-1" },
    query: {},
    files: undefined,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "vendor-1", role: "VENDOR", sessionId: "sess" },
    ...overrides,
  }) as any;

const ownProduct = {
  id: "prod-1",
  vendorId: "vendor-1",
  dishTypeId: "JOLLOF",
  images: ["img1.jpg"],
  video: [],
  stock: 5,
  options: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedProductGet.mockResolvedValue(null);
  mockedProductSet.mockResolvedValue("OK");
  mockedSearchGet.mockResolvedValue(null);
  db.tag.findMany.mockResolvedValue([]);
  db.dishType.findUnique.mockResolvedValue({ id: "JOLLOF", categoryId: "RICE_DISHES" });
  db.product.findMany.mockResolvedValue([]);
  db.product.count.mockResolvedValue(0);
  mockedRaw.mockImplementation(async (sql: string) =>
    String(sql).includes("COUNT") ? [{ total: 0n }] : [],
  );
  db.$executeRawUnsafe.mockResolvedValue(0);
});

describe("parseTagQueryParam", () => {
  it("returns undefined when no filter was supplied", () => {
    expect(parseTagQueryParam(undefined)).toBeUndefined();
    expect(parseTagQueryParam(null)).toBeUndefined();
    expect(parseTagQueryParam("")).toBeUndefined();
    expect(parseTagQueryParam("   ")).toBeUndefined();
  });

  it("folds case, splits commas, dedupes, accepts arrays and repeated params", () => {
    expect(parseTagQueryParam("SPICY")).toEqual(["SPICY"]);
    expect(parseTagQueryParam(" spicy ")).toEqual(["SPICY"]);
    expect(parseTagQueryParam("SPICY,VEGAN")).toEqual(["SPICY", "VEGAN"]);
    expect(parseTagQueryParam(["SPICY", "vegan"])).toEqual(["SPICY", "VEGAN"]);
    expect(parseTagQueryParam(["SPICY", "SPICY, VEGAN "])).toEqual(["SPICY", "VEGAN"]);
  });

  it("rejects malformed values", () => {
    expect(() => parseTagQueryParam("has space!")).toThrow(ValidationError);
    expect(() => parseTagQueryParam("DROP TABLE x")).toThrow(ValidationError);
    expect(() => parseTagQueryParam("a".repeat(41))).toThrow(ValidationError);
  });

  it("rejects more than the maximum tag count", () => {
    const many = Array.from({ length: 21 }, (_, i) => `TAG${i}`).join(",");
    expect(() => parseTagQueryParam(many)).toThrow(ValidationError);
  });
});

describe("resolveActiveTagIds", () => {
  it("resolves [] without a database call (clear-all signal)", async () => {
    await expect(resolveActiveTagIds([])).resolves.toEqual([]);
    expect(db.tag.findMany).not.toHaveBeenCalled();
  });

  it("dedupes and returns canonical ids", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }, { id: "VEGAN" }]);
    await expect(resolveActiveTagIds(["SPICY", "SPICY", "VEGAN"])).resolves.toEqual([
      "SPICY",
      "VEGAN",
    ]);
    expect(db.tag.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["SPICY", "VEGAN"] }, isActive: true },
      select: { id: true },
    });
  });

  it("rejects unknown tags by name", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    const err = await resolveActiveTagIds(["SPICY", "NOPE"]).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/NOPE/);
  });

  it("rejects inactive tags (never returned by the active-only lookup)", async () => {
    db.tag.findMany.mockResolvedValue([]);
    await expect(resolveActiveTagIds(["RETIRED"])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("createProduct — canonical tag assignment", () => {
  const validBody = {
    name: "Jollof Special",
    description: "Smoky party jollof",
    price: 2500,
    dishTypeId: "JOLLOF",
  };
  const files = { images: [{ path: "img1.jpg" }] };

  beforeEach(() => {
    db.product.create.mockImplementation(async (args: any) => ({ id: "new-1", ...args.data }));
  });

  it("creates a product with valid tags via one nested write", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }, { id: "VEGAN" }]);
    const r = res();
    await createProduct(vendorReq({ files, body: { ...validBody, tagIds: ["SPICY", "VEGAN"] } }), r);

    expect(db.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tags: { create: [{ tagId: "SPICY" }, { tagId: "VEGAN" }] },
        }),
      }),
    );
    const include = db.product.create.mock.calls[0][0].include;
    expect(include.tags).toEqual({ include: { tag: true } });
    expect(bodyOf(r).success).toBe(true);
    expect(clearProductCache).toHaveBeenCalledWith("new-1", "vendor-1");
  });

  it("accepts JSON-string and bare-string tagIds from multipart bodies", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    await createProduct(vendorReq({ files, body: { ...validBody, tagIds: '["SPICY"]' } }), res());
    expect(db.product.create).toHaveBeenCalled();

    jest.clearAllMocks();
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    await createProduct(vendorReq({ files, body: { ...validBody, tagIds: "SPICY" } }), res());
    const data = db.product.create.mock.calls[0][0].data;
    expect(data.tags).toEqual({ create: [{ tagId: "SPICY" }] });
  });

  it("rejects unknown tags without creating anything", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    await expect(
      createProduct(vendorReq({ files, body: { ...validBody, tagIds: ["SPICY", "NOPE"] } }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("rejects inactive tags without creating anything", async () => {
    db.tag.findMany.mockResolvedValue([]);
    await expect(
      createProduct(vendorReq({ files, body: { ...validBody, tagIds: ["RETIRED"] } }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("rejects malformed and free-text tags without creating anything", async () => {
    await expect(
      createProduct(vendorReq({ files, body: { ...validBody, tagIds: ["extra hot!!!"] } }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
    expect(db.tag.findMany).not.toHaveBeenCalled();
  });

  it("creates without a tags key when tagIds is omitted (existing contract)", async () => {
    const r = res();
    await createProduct(vendorReq({ files, body: { ...validBody } }), r);

    const data = db.product.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("tags");
    expect(db.tag.findMany).not.toHaveBeenCalled();
    expect(bodyOf(r).success).toBe(true);
  });
});

describe("updateProduct — tag replacement semantics", () => {
  beforeEach(() => {
    db.product.findUnique.mockResolvedValue({ ...ownProduct });
    db.product.update.mockImplementation(async (args: any) => ({ ...ownProduct, ...args.data }));
    db.productTag.deleteMany.mockResolvedValue({ count: 1 });
    db.productTag.createMany.mockResolvedValue({ count: 1 });
    db.product.findUnique.mockResolvedValue({ ...ownProduct, tags: [] });
  });

  it("leaves associations untouched when tagIds is omitted", async () => {
    const r = res();
    await updateProduct(vendorReq({ body: { name: "Renamed" } }), r);

    expect(db.productTag.deleteMany).not.toHaveBeenCalled();
    expect(db.productTag.createMany).not.toHaveBeenCalled();
    expect(bodyOf(r).success).toBe(true);
  });

  it("clears all associations on an explicit empty array", async () => {
    await updateProduct(vendorReq({ body: { tagIds: [] } }), res());

    expect(db.productTag.deleteMany).toHaveBeenCalledWith({ where: { productId: "prod-1" } });
    expect(db.productTag.createMany).not.toHaveBeenCalled();
  });

  it("replaces the set wholesale inside the existing transaction", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }, { id: "VEGAN" }]);
    const tx = db.$transaction as unknown as jest.Mock;
    const r = res();
    await updateProduct(vendorReq({ body: { tagIds: ["SPICY", "VEGAN"] } }), r);

    expect(tx).toHaveBeenCalledTimes(1);
    expect(db.productTag.deleteMany).toHaveBeenCalledWith({ where: { productId: "prod-1" } });
    expect(db.productTag.createMany).toHaveBeenCalledWith({
      data: [
        { productId: "prod-1", tagId: "SPICY" },
        { productId: "prod-1", tagId: "VEGAN" },
      ],
    });
    expect(clearProductCache).toHaveBeenCalledWith("prod-1", "vendor-1");
    expect(bodyOf(r).success).toBe(true);
  });

  it("rejects unknown tags before any write", async () => {
    db.tag.findMany.mockResolvedValue([]);
    await expect(
      updateProduct(vendorReq({ body: { tagIds: ["NOPE"] } }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects cross-vendor tag changes (ownership first)", async () => {
    db.product.findUnique.mockResolvedValue({ ...ownProduct, vendorId: "vendor-2" });
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    await expect(
      updateProduct(vendorReq({ body: { tagIds: ["SPICY"] } }), res()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("a tag persistence failure rejects without post-commit cache signaling", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    db.productTag.createMany.mockRejectedValue(new Error("write failed"));
    await expect(
      updateProduct(vendorReq({ body: { tagIds: ["SPICY"] } }), res()),
    ).rejects.toThrow("write failed");
    // Nothing after the transaction runs: no cart sweep, no detail
    // pre-warm, no dashboard invalidation — the tx rolled back as a unit.
    expect(clearProductCache).not.toHaveBeenCalled();
  });
});

describe("browse filtering — GET /product?tags=", () => {
  const browseReq = (query: Record<string, unknown>): any => vendorReq({ query });

  it("constrains the shared query to products carrying the tag", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    db.product.findMany.mockResolvedValue([]);
    await getAllProducts(browseReq({ tags: "SPICY" }), res());

    expect(db.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          archived: false,
          tags: { some: { tagId: { in: ["SPICY"] } } },
        }),
      }),
    );
  });

  it("uses any-match semantics for multiple tags", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }, { id: "VEGAN" }]);
    await getAllProducts(browseReq({ tags: "SPICY,VEGAN" }), res());

    const where = db.product.findMany.mock.calls[0][0].where;
    expect(where.tags).toEqual({ some: { tagId: { in: ["SPICY", "VEGAN"] } } });
  });

  it("combines the tag filter with existing filters", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    await getAllProducts(
      browseReq({ tags: "SPICY", dishType: "JOLLOF", vendorId: "v1", minPrice: "100" }),
      res(),
    );

    const where = db.product.findMany.mock.calls[0][0].where;
    expect(where.tags).toEqual({ some: { tagId: { in: ["SPICY"] } } });
    expect(where.dishTypeId).toBe("JOLLOF");
    expect(where.vendorId).toBe("v1");
    expect(where.price).toEqual({ gte: 100 });
  });

  it("rejects unknown and malformed tag filters without querying products", async () => {
    db.tag.findMany.mockResolvedValue([]);
    await expect(getAllProducts(browseReq({ tags: "NOPE" }), res())).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(getAllProducts(browseReq({ tags: "bad tag!" }), res())).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it("isolates cache keys across tags and keeps the swept products: prefix", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }, { id: "VEGAN" }]);
    await getAllProducts(browseReq({ tags: "SPICY" }), res());
    await getAllProducts(browseReq({ tags: "VEGAN" }), res());
    await getAllProducts(browseReq({}), res());

    const keys = mockedProductSet.mock.calls.map((c) => String(c[0]));
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k.startsWith("products:")).toBe(true);
    expect(keys[0]).toContain("tag=SPICY");
    expect(keys[1]).toContain("tag=VEGAN");
    expect(keys[2]).toContain("tag=none");
  });
});

describe("category browse filtering — categories/:slug/products?tags=", () => {
  it("scopes by server-resolved category AND tag together", async () => {
    const prismaMock = prisma as unknown as Record<string, Record<string, jest.Mock>>;
    prismaMock.category.findUnique.mockResolvedValue({
      id: "RICE_DISHES",
      slug: "rice-dishes",
      isActive: true,
    });
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    await getCategoryProducts(
      { params: { slug: "rice-dishes" }, query: { tags: "SPICY" } } as any,
      res(),
    );

    const where = db.product.findMany.mock.calls[0][0].where;
    expect(where.categoryId).toBe("RICE_DISHES");
    expect(where.tags).toEqual({ some: { tagId: { in: ["SPICY"] } } });
  });
});

describe("search filtering — GET /product/p/search?tags=", () => {
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

  it("adds a parameterized EXISTS clause over the join table", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    await searchProducts(searchReq({ q: "jollof", tags: "SPICY" }), res());

    const sql = String(mockedRaw.mock.calls[0][0]);
    expect(sql).toContain('"ProductTag"');
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("ANY(");
    // No string interpolation of the tag id into SQL — it travels as a param.
    expect(sql).not.toContain("SPICY");
    const params = mockedRaw.mock.calls[0].slice(1);
    expect(params).toContainEqual(["SPICY"]);
  });

  it("keeps the tag segment in the cache key", async () => {
    db.tag.findMany.mockResolvedValue([{ id: "SPICY" }]);
    await searchProducts(searchReq({ q: "jollof", tags: "SPICY" }), res());
    await searchProducts(searchReq({ q: "jollof" }), res());

    const searchGet = redisSearch.get as unknown as jest.Mock;
    const keys = searchGet.mock.calls.map((c) => String(c[0]));
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain("tgSPICY");
  });

  it("rejects unknown and malformed tag filters without touching SQL", async () => {
    db.tag.findMany.mockResolvedValue([]);
    await expect(searchProducts(searchReq({ q: "jollof", tags: "NOPE" }), res())).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      searchProducts(searchReq({ q: "jollof", tags: "bad tag!" }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedRaw).not.toHaveBeenCalled();
  });
});

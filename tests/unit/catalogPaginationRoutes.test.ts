/**
 * B-4 — every catalog route rejects a malformed page/limit with the
 * project's standard 400 / VALIDATION_ERROR envelope.
 *
 * This is the ROUTE-level half of the pagination contract (the helper half
 * lives in tests/unit/catalogPagination.test.ts). It proves that the shared
 * parser is actually wired into all five catalog routes and that an invalid
 * value never reaches Prisma.
 *
 * Prisma and Redis are MOCKED here — this suite proves the request-handling
 * contract, not database behaviour. The real-HTTP half is
 * tests/integration/catalogContractHttp.test.ts.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    product: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
    productReview: { aggregate: jest.fn() },
    vendorReview: { aggregate: jest.fn() },
    category: { findUnique: jest.fn() },
    dishType: { findMany: jest.fn() },
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
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => ({ ok: true, failures: [] })),
  invalidateProductRatingCaches: jest.fn(async () => ({ ok: true, failures: [] })),
}));

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
import {
  getAllProducts,
  getMostPopularProducts,
  getNewProducts,
  searchProducts,
} from "../../src/controllers/productController";
import { getCategoryProducts } from "../../src/controllers/catalogController";
import { ValidationError } from "../../src/errors/AppError";
import { MAX_SAFE_PAGE } from "../../src/validations/catalogPagination";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const req = (query: Record<string, unknown>, params: Record<string, unknown> = {}): any =>
  ({
    headers: {},
    body: {},
    params,
    query,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
  }) as any;

type Handler = (req: any, res: any) => Promise<unknown>;

const ROUTES: Array<{ name: string; handler: Handler; query: Record<string, unknown> }> = [
  { name: "GET /api/product", handler: getAllProducts, query: {} },
  {
    name: "GET /api/product/categories/:slug/products",
    handler: getCategoryProducts,
    query: {},
    // resolved below via params
  } as any,
  { name: "GET /api/product/p/search", handler: searchProducts, query: { q: "jollof" } },
  { name: "GET /api/product/p/most", handler: getMostPopularProducts, query: {} },
  { name: "GET /api/product/p/new", handler: getNewProducts, query: {} },
];

beforeEach(() => {
  jest.clearAllMocks();
  (redisProducts.get as unknown as jest.Mock).mockResolvedValue(null);
  (redisSearch.get as unknown as jest.Mock).mockResolvedValue(null);
  (redisProducts.set as unknown as jest.Mock).mockResolvedValue("OK");
  (redisSearch.set as unknown as jest.Mock).mockResolvedValue("OK");
  db.category.findUnique.mockResolvedValue({
    id: "cat-1",
    name: "Rice Dishes",
    slug: "rice-dishes",
    isActive: true,
  });
  db.dishType.findMany.mockResolvedValue([]);
  db.tag.findMany.mockResolvedValue([]);
  db.product.findMany.mockResolvedValue([]);
  db.product.count.mockResolvedValue(0);
  db.product.findFirst.mockResolvedValue(null);
  db.productReview.aggregate.mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } });
  db.vendorReview.aggregate.mockResolvedValue({ _avg: { rating: null }, _count: { rating: 0 } });
  db.$queryRawUnsafe.mockImplementation(async (sql: string) =>
    String(sql).includes("COUNT") ? [{ total: 0n }] : [],
  );
  db.$executeRawUnsafe.mockResolvedValue(0);
});

const callRoute = (route: (typeof ROUTES)[number], query: Record<string, unknown>) => {
  const params = route.name.includes("categories") ? { slug: "rice-dishes" } : {};
  return route.handler(req({ ...route.query, ...query }, params), res());
};

describe("catalog routes reject invalid pagination", () => {
  it.each(ROUTES)(
    "$name rejects page=abc with a 400 before touching the database",
    async (route) => {
      await expect(callRoute(route, { page: "abc" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(db.product.findMany).not.toHaveBeenCalled();
      expect(db.product.count).not.toHaveBeenCalled();
      expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$name rejects page=0 with a 400 before touching the database",
    async (route) => {
      await expect(callRoute(route, { page: "0" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(db.product.findMany).not.toHaveBeenCalled();
      expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$name rejects page=-1 with a 400 before touching the database",
    async (route) => {
      await expect(callRoute(route, { page: "-1" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(db.product.findMany).not.toHaveBeenCalled();
      expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$name rejects limit=abc with a 400 before touching the database",
    async (route) => {
      await expect(callRoute(route, { limit: "abc" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(db.product.findMany).not.toHaveBeenCalled();
      expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$name rejects limit=0 with a 400 before touching the database",
    async (route) => {
      await expect(callRoute(route, { limit: "0" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(db.product.findMany).not.toHaveBeenCalled();
      expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$name rejects limit=-5 with a 400 before touching the database",
    async (route) => {
      await expect(callRoute(route, { limit: "-5" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(db.product.findMany).not.toHaveBeenCalled();
      expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$name rejects a non-integer page with a 400",
    async (route) => {
      await expect(callRoute(route, { page: "1.5" })).rejects.toBeInstanceOf(
        ValidationError,
      );
    },
  );

  it("reports the standard 400 / VALIDATION_ERROR shape", async () => {
    const err = (await callRoute(ROUTES[0], { page: "abc" }).catch(
      (e) => e,
    )) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
  });
});

describe("catalog routes reject non-decimal numeric forms", () => {
  it.each(["0x10", "1e5", "1.5", "+7", "-3", "Infinity", "NaN"])(
    "$name rejects page=%s before touching the database",
    async (page) => {
      for (const route of ROUTES) {
        await expect(callRoute(route, { page })).rejects.toBeInstanceOf(
          ValidationError,
        );
        expect(db.product.findMany).not.toHaveBeenCalled();
        expect(db.product.count).not.toHaveBeenCalled();
        expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["0x10", "1e5", "2.5", "+5", "-5", "Infinity", "NaN"])(
    "$name rejects limit=%s before touching the database",
    async (limit) => {
      for (const route of ROUTES) {
        await expect(callRoute(route, { limit })).rejects.toBeInstanceOf(
          ValidationError,
        );
        expect(db.product.findMany).not.toHaveBeenCalled();
      }
    },
  );
});

describe("catalog routes reject oversized page values", () => {
  it("rejects page at MAX_SAFE_PAGE + 1 before touching the database", async () => {
    for (const route of ROUTES) {
      await expect(
        callRoute(route, { page: String(MAX_SAFE_PAGE + 1) }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(db.product.findMany).not.toHaveBeenCalled();
    }
  });

  it("rejects page at Number.MAX_SAFE_INTEGER before touching the database", async () => {
    for (const route of ROUTES) {
      await expect(
        callRoute(route, { page: String(Number.MAX_SAFE_INTEGER) }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(db.product.findMany).not.toHaveBeenCalled();
    }
  });

  it("rejects a stringified huge page before touching the database", async () => {
    for (const route of ROUTES) {
      await expect(callRoute(route, { page: "999999999999999999999" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(db.product.findMany).not.toHaveBeenCalled();
    }
  });
});

describe("catalog routes accept the documented boundaries", () => {
  it("GET /api/product clamps a limit above the maximum to 20", async () => {
    const r = res();
    await getAllProducts(req({ limit: "500" }), r);
    expect(db.product.findMany.mock.calls[0][0].take).toBe(20);
    expect(r.json.mock.calls[0][0].meta.limit).toBe(20);
  });

  it("GET /api/product honours page and limit", async () => {
    const r = res();
    await getAllProducts(req({ page: "3", limit: "5" }), r);
    expect(db.product.findMany.mock.calls[0][0].skip).toBe(10);
    expect(db.product.findMany.mock.calls[0][0].take).toBe(5);
  });

  it("GET /api/product/categories/:slug/products clamps a limit above the maximum to 20", async () => {
    const r = res();
    await getCategoryProducts(req({ limit: "500" }, { slug: "rice-dishes" }), r);
    expect(db.product.findMany.mock.calls[0][0].take).toBe(20);
  });

  it("GET /api/product/p/most clamps a limit above the maximum to 50", async () => {
    const r = res();
    await getMostPopularProducts(req({ limit: "500" }), r);
    expect(db.product.findMany.mock.calls[0][0].take).toBe(50);
  });

  it("GET /api/product/p/new clamps a limit above the maximum to 50", async () => {
    const r = res();
    await getNewProducts(req({ limit: "500" }), r);
    expect(db.product.findMany.mock.calls[0][0].take).toBe(50);
  });

  it("GET /api/product/p/new honours page and limit", async () => {
    const r = res();
    await getNewProducts(req({ page: "2", limit: "5" }), r);
    expect(db.product.findMany.mock.calls[0][0].skip).toBe(5);
    expect(db.product.findMany.mock.calls[0][0].take).toBe(5);
    expect(r.json.mock.calls[0][0].meta).toMatchObject({ page: 2, limit: 5 });
  });
});

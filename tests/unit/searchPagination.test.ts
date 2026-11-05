/**
 * Phase 2D search-pagination fix -- searchProducts must reject malformed
 * page/limit with HTTP 400 (ValidationError) instead of letting NaN or
 * negative LIMIT/OFFSET reach SQL or Redis keys.
 *
 * Contract under test:
 *   page: positive integer, default 1 (empty falls back to default)
 *   limit: positive integer, default 20, clamped to max 20 (existing contract)
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
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
  clearProductCache: jest.fn(async () => {}),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/services/product.service", () => ({
  __esModule: true,
  assertActiveDishType: jest.fn(async () => {}),
  trackProductView: jest.fn(async () => {}),
}));

jest.mock("../../src/AI/localSearchCorrect", () => ({
  __esModule: true,
  correctQuery: jest.fn((q: string) => q),
}));

jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  loadActiveProductPromos: jest.fn(async () => []),
  attachPromotions: jest.fn((items: unknown[]) => items),
}));

import prisma from "../../src/lib/prisma";
import { redisSearch } from "../../src/lib/redis";
import { searchProducts } from "../../src/controllers/productController";
import { ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedGet = redisSearch.get as unknown as jest.Mock;
const mockedSet = redisSearch.set as unknown as jest.Mock;
const mockedRaw = db.$queryRawUnsafe as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const req = (query: Record<string, unknown>): any =>
  ({
    headers: {},
    body: {},
    params: {},
    query,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
  }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockResolvedValue(null);
  mockedSet.mockResolvedValue("OK");
  mockedRaw.mockImplementation(async (sql: string) =>
    String(sql).includes("COUNT") ? [{ total: 0n }] : [],
  );
  db.$executeRawUnsafe.mockResolvedValue(0);
});

describe("searchProducts -- pagination validation", () => {
  it.each([["abc"], ["0"], ["-1"], ["1.5"], ["10abc"]])(
    "invalid page=%s -> 400, no DB query, no cache access",
    async (page) => {
      await expect(
        searchProducts(req({ q: "burger", page }), res()),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(mockedRaw).not.toHaveBeenCalled();
      expect(mockedGet).not.toHaveBeenCalled();
      expect(mockedSet).not.toHaveBeenCalled();
    },
  );

  it.each([["abc"], ["0"], ["-5"], ["2.5"], ["10abc"]])(
    "invalid limit=%s -> 400, no DB query, no cache access",
    async (limit) => {
      await expect(
        searchProducts(req({ q: "burger", limit }), res()),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(mockedRaw).not.toHaveBeenCalled();
      expect(mockedGet).not.toHaveBeenCalled();
      expect(mockedSet).not.toHaveBeenCalled();
    },
  );

  it("ValidationError maps to HTTP 400", async () => {
    const err = await searchProducts(req({ q: "burger", page: "abc" }), res()).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(400);
  });

  it("valid page/limit flow through to SQL, count, and cache key", async () => {
    const r = res();
    await searchProducts(req({ q: "burger", page: "2", limit: "10" }), r);

    // Base params: [corrected, like, limit, offset, ...filters].
    const firstCall = mockedRaw.mock.calls[0];
    expect(firstCall[1]).toBe("burger");
    expect(firstCall[3]).toBe(10);
    expect(firstCall[4]).toBe(10);
    // Normalized values in the Redis key (no NaN, no negatives).
    // NOTE: key-segment order is the pre-existing SEARCH() convention
    // (sortBy occupies the dishType slot); this fix does not alter it.
    expect(mockedGet).toHaveBeenCalledWith("search:burger:relevance:newest:2:10:f=ALL");
    expect(mockedSet).toHaveBeenCalledWith(
      "search:burger:relevance:newest:2:10:f=ALL",
      expect.any(String),
      { EX: expect.any(Number) },
    );
    const body = r.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.pagination).toMatchObject({ page: 2, limit: 10 });
  });

  it("above-maximum limit keeps the existing clamping contract (20)", async () => {
    const r = res();
    await searchProducts(req({ q: "burger", limit: "50" }), r);

    const firstCall = mockedRaw.mock.calls[0];
    expect(firstCall[3]).toBe(20);
    expect(firstCall[4]).toBe(0);
    expect(r.json.mock.calls[0][0].data.pagination).toMatchObject({
      page: 1,
      limit: 20,
    });
  });

  it("defaults (no page/limit) behave exactly as before", async () => {
    await searchProducts(req({ q: "burger" }), res());

    const firstCall = mockedRaw.mock.calls[0];
    expect(firstCall[3]).toBe(20);
    expect(firstCall[4]).toBe(0);
    expect(mockedGet).toHaveBeenCalledWith("search:burger:relevance:newest:1:20:f=ALL");
  });
});

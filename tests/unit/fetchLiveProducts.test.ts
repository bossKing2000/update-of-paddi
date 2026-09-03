/**
 * Tests for fetchLiveProducts / fetchMostPopularProducts (Stage 1).
 *
 * Both listings now return currently-orderable marketplace products:
 * not archived + vendor live + accepting orders. There is no scheduling,
 * no stored isLive mirror, and no raw-SQL schedule predicate — both use
 * the Prisma query builder, verified here with mocked prisma.
 */

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn() },
  redisTotalViews: { get: jest.fn() },
  ShopCartRedis: {},
}));

import prisma from "../../src/lib/prisma";
import {
  fetchLiveProducts,
  fetchMostPopularProducts,
} from "../../src/services/product.service";

const mockedFindMany = (prisma as any).product.findMany as jest.Mock;
const mockedCount = (prisma as any).product.count as jest.Mock;

const vendorRow = (overrides: Record<string, unknown> = {}) => ({
  id: "vendor-1",
  name: "Mama Put",
  brandName: "Mama Put",
  avatarUrl: null,
  isLive: true,
  deliveryPreferences: { acceptingOrders: true },
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "Palm Nut Soup",
  price: 1200,
  category: "DINNER",
  thumbnail: null,
  images: [],
  popularityPercent: 40,
  popularityScore: 10,
  averageRating: 4.5,
  reviewCount: 3,
  totalViews: 12,
  archived: false,
  vendor: vendorRow(),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedFindMany.mockResolvedValue([]);
  mockedCount.mockResolvedValue(0);
});

describe("fetchLiveProducts (Stage 1: orderable marketplace products)", () => {
  it("returns orderable products with vendorOperating/orderable flags set", async () => {
    mockedFindMany.mockResolvedValue([row()]);
    mockedCount.mockResolvedValue(1);

    const { products, total } = await fetchLiveProducts({ take: 12 });

    expect(total).toBe(1);
    expect(products).toHaveLength(1);
    expect(products[0].vendorOperating).toBe(true);
    expect(products[0].orderable).toBe(true);
  });

  it("filters to non-archived products at query level", async () => {
    await fetchLiveProducts({ take: 12 });
    expect(mockedFindMany.mock.calls[0][0].where.archived).toBe(false);
  });

  it("filters to operating vendors at query level", async () => {
    await fetchLiveProducts({ take: 12 });
    const where = mockedFindMany.mock.calls[0][0].where;
    expect(where.vendor).toBeDefined();
    expect(where.vendor.isLive).toBe(true);
  });

  it("applies an optional category filter", async () => {
    await fetchLiveProducts({ take: 12, category: "DINNER" });
    expect(mockedFindMany.mock.calls[0][0].where.category).toBe("DINNER");
  });
});

describe("fetchMostPopularProducts (popularity ranking, Stage 1)", () => {
  it("ranks by popularityScore and returns the total", async () => {
    mockedFindMany.mockResolvedValue([row()]);
    mockedCount.mockResolvedValue(7);

    const result = await fetchMostPopularProducts({ skip: 0, take: 50 });

    expect(result.total).toBe(7);
    expect(mockedFindMany.mock.calls[0][0].orderBy).toEqual({
      popularityScore: "desc",
    });
  });

  it("only lists non-archived products from operating vendors", async () => {
    await fetchMostPopularProducts({ skip: 0, take: 50 });
    const where = mockedFindMany.mock.calls[0][0].where;
    expect(where.archived).toBe(false);
    expect(where.vendor.isLive).toBe(true);
  });
});

/**
 * Tests for fetchPopularDishTypes — backend-driven Top 3 dish types for the
 * Home Popular Picks tabs.
 *
 * Ranking rule under test (see product.service.ts):
 * only currently-orderable products are considered; each contributes one
 * count to its dish type; top 3 by count win; ties break alphabetically by
 * dish-type name; archived/offline products never contribute.
 */

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: {
      findMany: jest.fn(),
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
import { fetchPopularDishTypes } from "../../src/services/product.service";

const mockedFindMany = (prisma as any).product.findMany as jest.Mock;

const row = (dishTypeId: string, name: string) => ({
  dishTypeId,
  dishType: { id: dishTypeId, name },
});

describe("fetchPopularDishTypes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns exactly 3 when more than 3 dish types are eligible", async () => {
    mockedFindMany.mockResolvedValue([
      ...Array.from({ length: 5 }, () => row("JOLLOF", "Jollof Rice")),
      ...Array.from({ length: 4 }, () => row("SPAGHETTI", "Spaghetti")),
      ...Array.from({ length: 3 }, () => row("PEPPER_SOUP", "Pepper Soup")),
      ...Array.from({ length: 2 }, () => row("OFADA", "Ofada")),
    ]);
    const result = await fetchPopularDishTypes();
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.id)).toEqual(["JOLLOF", "SPAGHETTI", "PEPPER_SOUP"]);
  });

  it("returns only the available dish types when fewer than 3 exist", async () => {
    mockedFindMany.mockResolvedValue([
      ...Array.from({ length: 4 }, () => row("JOLLOF", "Jollof Rice")),
      ...Array.from({ length: 2 }, () => row("OFADA", "Ofada")),
    ]);
    const result = await fetchPopularDishTypes();
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.id)).toEqual(["JOLLOF", "OFADA"]);
  });

  it("returns an empty list when no orderable products exist", async () => {
    mockedFindMany.mockResolvedValue([]);
    await expect(fetchPopularDishTypes()).resolves.toEqual([]);
  });

  it("is deterministic on ties (count desc, then name asc)", async () => {
    mockedFindMany.mockResolvedValue([
      ...Array.from({ length: 3 }, () => row("B_B", "B Soup")),
      ...Array.from({ length: 3 }, () => row("A_A", "A Soup")),
      ...Array.from({ length: 3 }, () => row("C_C", "C Soup")),
    ]);
    const first = await fetchPopularDishTypes();
    const second = await fetchPopularDishTypes();
    expect(first.map((d) => d.id)).toEqual(["A_A", "B_B", "C_C"]);
    expect(second).toEqual(first);
  });

  it("queries only orderable products (not archived, vendor live, in stock)", async () => {
    mockedFindMany.mockResolvedValue([]);
    await fetchPopularDishTypes();
    const where = mockedFindMany.mock.calls[0][0].where;
    expect(where.archived).toBe(false);
    expect(where.vendor).toBeDefined();
    // Archived/offline/sold-out rows must be excluded at query level so a
    // dish type with only unavailable products can never rank.
    expect(JSON.stringify(where)).toContain("isLive");
  });

  it("never hardcodes dish-type ids", async () => {
    mockedFindMany.mockResolvedValue([
      ...Array.from({ length: 6 }, () => row("SOME_NEW_DISH", "Some New Dish")),
      ...Array.from({ length: 2 }, () => row("JOLLOF", "Jollof Rice")),
    ]);
    const result = await fetchPopularDishTypes();
    expect(result[0]).toEqual({ id: "SOME_NEW_DISH", name: "Some New Dish" });
  });
});

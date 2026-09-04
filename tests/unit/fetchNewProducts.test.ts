import prisma from "../../src/lib/prisma";
import { fetchNewProducts } from "../../src/services/product.service";

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
  default: {
    redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
    redisSearch: { get: jest.fn() },
    redisTotalViews: { get: jest.fn() },
    ShopCartRedis: {},
  },
}));

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

const newProductRow = (overrides: Record<string, unknown> = {}) => ({
  id: "new-prod-1",
  name: "New Jollof Rice",
  price: 1500,
  dishType: { id: "JOLLOF", name: "Jollof Rice" },
  images: ["img.jpg"],
  isNew: true,
  createdAt: new Date("2026-09-04T10:00:00Z"),
  archived: false,
  trackInventory: false,
  stock: null,
  vendor: vendorRow(),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedFindMany.mockResolvedValue([]);
  mockedCount.mockResolvedValue(0);
});

describe("fetchNewProducts (Stage 1: orderable marketplace products)", () => {
  it("returns new products with availability fields set correctly", async () => {
    mockedFindMany.mockResolvedValue([newProductRow()]);
    mockedCount.mockResolvedValue(1);

    const { items, total } = await fetchNewProducts({ take: 50 });

    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "new-prod-1",
      name: "New Jollof Rice",
      price: 1500,
      isNew: true,
      trackInventory: false,
      stock: null,
      archived: false,
      vendorOperating: true,
      orderable: true,
    });
  });

  it("handles non-operating vendor correctly", async () => {
    mockedFindMany.mockResolvedValue([
      newProductRow({ vendor: vendorRow({ isLive: false }) }),
    ]);
    mockedCount.mockResolvedValue(1);

    const { items } = await fetchNewProducts({ take: 50 });

    expect(items[0]).toMatchObject({
      vendorOperating: false,
      orderable: false,
    });
  });

  it("handles vendor that paused orders correctly", async () => {
    mockedFindMany.mockResolvedValue([
      newProductRow({
        vendor: vendorRow({ deliveryPreferences: { acceptingOrders: false } }),
      }),
    ]);
    mockedCount.mockResolvedValue(1);

    const { items } = await fetchNewProducts({ take: 50 });

    expect(items[0]).toMatchObject({
      vendorOperating: false,
      orderable: false,
    });
  });

  it("handles archived product correctly", async () => {
    mockedFindMany.mockResolvedValue([
      newProductRow({ archived: true }),
    ]);
    mockedCount.mockResolvedValue(1);

    const { items } = await fetchNewProducts({ take: 50 });

    expect(items[0]).toMatchObject({
      archived: true,
      vendorOperating: true,
      orderable: false,
    });
  });

  it("handles inventory-tracked product with stock 0 correctly", async () => {
    mockedFindMany.mockResolvedValue([
      newProductRow({
        trackInventory: true,
        stock: 0,
      }),
    ]);
    mockedCount.mockResolvedValue(1);

    const { items } = await fetchNewProducts({ take: 50 });

    expect(items[0]).toMatchObject({
      trackInventory: true,
      stock: 0,
      vendorOperating: true,
      orderable: false,
    });
  });

  it("handles inventory-tracked product with stock > 0 correctly", async () => {
    mockedFindMany.mockResolvedValue([
      newProductRow({
        trackInventory: true,
        stock: 5,
      }),
    ]);
    mockedCount.mockResolvedValue(1);

    const { items } = await fetchNewProducts({ take: 50 });

    expect(items[0]).toMatchObject({
      trackInventory: true,
      stock: 5,
      vendorOperating: true,
      orderable: true,
    });
  });

  it("handles untracked inventory product correctly (always available if vendor operating)", async () => {
    mockedFindMany.mockResolvedValue([
      newProductRow({
        trackInventory: false,
        stock: null, // stock should be null for untracked items
      }),
    ]);
    mockedCount.mockResolvedValue(1);

    const { items } = await fetchNewProducts({ take: 50 });

    expect(items[0]).toMatchObject({
      trackInventory: false,
      stock: null,
      vendorOperating: true,
      orderable: true,
    });
  });

  it("filters to non-archived and isNew products at query level", async () => {
    await fetchNewProducts({ take: 50 });
    expect(mockedFindMany.mock.calls[0][0].where.archived).toBe(false);
    expect(mockedFindMany.mock.calls[0][0].where.isNew).toBe(true);
  });

  it("applies an optional dish-type filter", async () => {
    await fetchNewProducts({ take: 50, dishType: "JOLLOF" });
    expect(mockedFindMany.mock.calls[0][0].where.dishTypeId).toBe("JOLLOF");
  });
});
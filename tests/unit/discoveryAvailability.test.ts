import prisma from "../../src/lib/prisma";

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

import prismaClient from "../../src/lib/prisma";
import { fetchProductPage } from "../../src/services/product.service";

const mockedFindMany = (prismaClient as any).product.findMany as jest.Mock;
const mockedCount = (prismaClient as any).product.count as jest.Mock;

const vendorRow = (overrides: Record<string, unknown> = {}) => ({
  id: "vendor-1",
  name: "Mama Put",
  brandName: "Mama Put",
  avatarUrl: null,
  isLive: true,
  deliveryPreferences: { acceptingOrders: true },
  ...overrides,
});

const productRow = (overrides: Record<string, unknown> = {}) => ({
  id: "prod-1",
  name: "Jollof Rice",
  price: 1500,
  category: "LUNCH",
  thumbnail: "img.jpg",
  images: ["img.jpg"],
  popularityPercent: 42,
  archived: false,
  vendor: vendorRow(),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedFindMany.mockResolvedValue([]);
  mockedCount.mockResolvedValue(0);
});

describe("discovery availability contract (fetchProductPage, Stage 1)", () => {
  it("vendor online + unarchived product → vendorOperating=true, orderable=true", async () => {
    mockedFindMany.mockResolvedValue([productRow()]);
    mockedCount.mockResolvedValue(1);

    const { products } = await fetchProductPage({ skip: 0, take: 20 });
    expect(products[0].vendorOperating).toBe(true);
    expect(products[0].orderable).toBe(true);
  });

  it("vendor OFFLINE → vendorOperating=false and NOT orderable", async () => {
    mockedFindMany.mockResolvedValue([
      productRow({ vendor: vendorRow({ isLive: false }) }),
    ]);

    const { products } = await fetchProductPage({ skip: 0, take: 20 });
    expect(products[0].vendorOperating).toBe(false);
    expect(products[0].orderable).toBe(false);
  });

  it("vendor paused orders → not operating, not orderable", async () => {
    mockedFindMany.mockResolvedValue([
      productRow({
        vendor: vendorRow({ deliveryPreferences: { acceptingOrders: false } }),
      }),
    ]);

    const { products } = await fetchProductPage({ skip: 0, take: 20 });
    expect(products[0].vendorOperating).toBe(false);
    expect(products[0].orderable).toBe(false);
  });

  it("archived product → NOT orderable even with an operating vendor", async () => {
    mockedFindMany.mockResolvedValue([productRow({ archived: true })]);

    const { products } = await fetchProductPage({ skip: 0, take: 20 });
    expect(products[0].orderable).toBe(false);
  });

  it("archived products are excluded at query level (archived:false in the where)", async () => {
    await fetchProductPage({ skip: 0, take: 20 });
    expect(mockedFindMany.mock.calls[0][0].where.archived).toBe(false);
  });

  it("availableOnly=true adds the vendor-operating filter", async () => {
    await fetchProductPage({ skip: 0, take: 20, availableOnly: true });
    const where = mockedFindMany.mock.calls[0][0].where;
    expect(where.archived).toBe(false);
    expect(where.vendor).toBeDefined();
    expect(where.vendor.isLive).toBe(true);
  });

  it("vendor + product combination decides the final state together", async () => {
    mockedFindMany.mockResolvedValue([
      productRow(), // operating vendor + unarchived
      productRow({
        id: "prod-2",
        vendor: vendorRow({ isLive: false }),
      }),
    ]);
    mockedCount.mockResolvedValue(2);

    const { products } = await fetchProductPage({ skip: 0, take: 20 });
    expect(products[0].orderable).toBe(true);
    expect(products[1].orderable).toBe(false);
  });
});

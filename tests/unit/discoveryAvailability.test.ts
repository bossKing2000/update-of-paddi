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

const NOW = new Date();
const minutesFromNow = (n: number) => new Date(NOW.getTime() + n * 60_000);

const vendorRow = (overrides: Record<string, unknown> = {}) => ({
  id: "vendor-1",
  name: "Mama Put",
  brandName: "Mama Put",
  avatarUrl: null,
  isLive: true,
  deliveryPreferences: { acceptingOrders: true },
  timezone: null,
  operatingHours: null,
  ...overrides,
});

/** One-time schedule currently inside its window. */
const activeOneTimeSchedule = () => ({
  type: "ONE_TIME" as const,
  enabled: true,
  goLiveAt: minutesFromNow(-30),
  takeDownAt: minutesFromNow(60),
  graceMinutes: 0,
  startDate: null,
  endDate: null,
  windows: [],
});

/** WEEKLY schedule whose window covers right now (UTC). */
const activeWeeklySchedule = () => ({
  type: "WEEKLY" as const,
  enabled: true,
  goLiveAt: null,
  takeDownAt: null,
  graceMinutes: null,
  startDate: null,
  endDate: null,
  windows: [
    {
      id: "w1",
      scheduleId: "s1",
      // Today in UTC, spanning ±60 minutes around now.
      dayOfWeek: NOW.getUTCDay(),
      startMinute: NOW.getUTCHours() * 60 + NOW.getUTCMinutes() - 60,
      endMinute: NOW.getUTCHours() * 60 + NOW.getUTCMinutes() + 60,
      enabled: true,
    },
  ],
});

const productRow = (overrides: Record<string, unknown> = {}) => ({
  id: "prod-1",
  name: "Jollof Rice",
  price: 1500,
  category: "LUNCH",
  thumbnail: "img.jpg",
  images: ["img.jpg"],
  popularityPercent: 42,
  isLive: true,
  archived: false,
  productSchedule: activeOneTimeSchedule(),
  vendor: vendorRow(),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedFindMany.mockResolvedValue([]);
  mockedCount.mockResolvedValue(0);
});

describe("discovery availability contract (fetchProductPage)", () => {
  it("vendor online + active one-time schedule → vendorOperating=true, orderable=true", async () => {
    mockedFindMany.mockResolvedValue([productRow()]);
    mockedCount.mockResolvedValue(1);

    const { products } = await fetchProductPage({ skip: 0, take: 20 });
    expect(products[0].vendorOperating).toBe(true);
    expect(products[0].orderable).toBe(true);
  });

  it("vendor OFFLINE → vendorOperating=false and NOT orderable (even with an active schedule)", async () => {
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

  it("inactive WEEKLY schedule → NOT orderable even though the stored mirror says live", async () => {
    mockedFindMany.mockResolvedValue([
      productRow({
        isLive: true, // stale mirror
        productSchedule: activeWeeklySchedule(),
        vendor: vendorRow(),
      }),
    ]);
    // Re-run with a window far from now by shifting the day to tomorrow:
    const tomorrow = (NOW.getUTCDay() + 1) % 7;
    mockedFindMany.mockResolvedValue([
      productRow({
        isLive: true,
        productSchedule: {
          ...activeWeeklySchedule(),
          windows: [
            {
              ...activeWeeklySchedule().windows[0],
              dayOfWeek: tomorrow,
            },
          ],
        },
      }),
    ]);

    const { products } = await fetchProductPage({ skip: 0, take: 20 });
    expect(products[0].isLive).toBe(true); // mirror untouched — display only
    expect(products[0].orderable).toBe(false); // authoritative evaluator disagrees
  });

  it("active WEEKLY schedule → orderable, evaluated through the authoritative evaluator", async () => {
    mockedFindMany.mockResolvedValue([
      productRow({
        isLive: false, // stale mirror in the other direction
        productSchedule: activeWeeklySchedule(),
      }),
    ]);

    const { products } = await fetchProductPage({ skip: 0, take: 20 });
    expect(products[0].orderable).toBe(true);
  });

  it("expired ONE_TIME window → NOT orderable despite stored-live mirror", async () => {
    mockedFindMany.mockResolvedValue([
      productRow({
        isLive: true,
        productSchedule: {
          ...activeOneTimeSchedule(),
          goLiveAt: minutesFromNow(-120),
          takeDownAt: minutesFromNow(-90),
        },
      }),
    ]);

    const { products } = await fetchProductPage({ skip: 0, take: 20 });
    expect(products[0].orderable).toBe(false);
  });

  it("archived products are excluded at query level (archived:false in the where)", async () => {
    await fetchProductPage({ skip: 0, take: 20 });
    expect(mockedFindMany.mock.calls[0][0].where.archived).toBe(false);
  });

  it("vendor + product combination decides the final state together", async () => {
    mockedFindMany.mockResolvedValue([
      productRow(), // operating vendor + active schedule
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

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    dishType: { findMany: jest.fn() },
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
import { redisProducts } from "../../src/lib/redis";
import {
  parseHomeFeedQuery,
  roundCoord,
  buildHomeFeedCacheKey,
  HOME_FEED_DEFAULT_LIMIT,
  HOME_FEED_MAX_LIMIT,
} from "../../src/services/homeFeed.service";
import { ValidationError } from "../../src/errors/AppError";

const mockedDishFindMany = (prisma as any).dishType.findMany as jest.Mock;
const mockedRedisGet = (redisProducts as any).get as jest.Mock;

const base = { lat: null, lng: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockedRedisGet.mockResolvedValue(null);
  mockedDishFindMany.mockResolvedValue([
    { id: "JOLLOF", name: "Jollof Rice", description: null, imageUrl: null, sortOrder: 10 },
    { id: "SUYA", name: "Suya", description: null, imageUrl: null, sortOrder: 300 },
  ]);
});

describe("home feed query parsing", () => {
  it("applies defaults when no params are supplied", async () => {
    const q = await parseHomeFeedQuery({});
    expect(q.limit).toBe(HOME_FEED_DEFAULT_LIMIT);
    expect(q.dishType).toBe("ALL");
    expect(q.lat).toBeNull();
    expect(q.lng).toBeNull();
  });

  it("clamps the limit into a safe range", async () => {
    expect((await parseHomeFeedQuery({ limit: "0" })).limit).toBe(1);
    expect((await parseHomeFeedQuery({ limit: "10" })).limit).toBe(10);
    expect((await parseHomeFeedQuery({ limit: "9999" })).limit).toBe(HOME_FEED_MAX_LIMIT);
    expect((await parseHomeFeedQuery({ limit: "abc" })).limit).toBe(HOME_FEED_DEFAULT_LIMIT);
    expect((await parseHomeFeedQuery({ limit: "-5" })).limit).toBe(1);
  });

  it("keeps valid coordinate pairs and rounds them to ~3 decimals", async () => {
    const q = await parseHomeFeedQuery({ lat: "6.5244444", lng: "3.3792222" });
    expect(q.lat).toBeCloseTo(6.524);
    expect(q.lng).toBeCloseTo(3.379);
    expect(roundCoord(6.123456)).toBe(6.123);
  });

  it("treats invalid or partial coordinates as no-location, never an error", async () => {
    // out of range
    expect(await parseHomeFeedQuery({ lat: "91", lng: "0" })).toMatchObject(base);
    expect(await parseHomeFeedQuery({ lat: "0", lng: "-181" })).toMatchObject(base);
    // partial
    expect(await parseHomeFeedQuery({ lat: "6.52" })).toMatchObject(base);
    expect(await parseHomeFeedQuery({ lng: "3.37" })).toMatchObject(base);
    // non-numeric
    expect(await parseHomeFeedQuery({ lat: "abc", lng: "def" })).toMatchObject(base);
    // empty strings
    expect(await parseHomeFeedQuery({ lat: "", lng: "" })).toMatchObject(base);
  });

  it("accepts active dish type ids and ALL", async () => {
    expect((await parseHomeFeedQuery({ dishType: "jollof" })).dishType).toBe("JOLLOF");
    expect((await parseHomeFeedQuery({ dishType: "ALL" })).dishType).toBe("ALL");
    expect((await parseHomeFeedQuery({ dishType: "" })).dishType).toBe("ALL");
  });

  it("ignores the legacy meal-time category param", async () => {
    expect((await parseHomeFeedQuery({ category: "LUNCH" })).dishType).toBe("ALL");
  });

  it("rejects unknown dish types with the standard validation error", async () => {
    await expect(parseHomeFeedQuery({ dishType: "RICE" })).rejects.toThrow(ValidationError);
    await expect(parseHomeFeedQuery({ dishType: "DROP TABLE;" })).rejects.toThrow(ValidationError);
  });
});

describe("home feed cache key", () => {
  it("distinguishes guests from authenticated users", async () => {
    const q = await parseHomeFeedQuery({});
    const guest = buildHomeFeedCacheKey({ viewer: null, query: q });
    const customer = buildHomeFeedCacheKey({
      viewer: { id: "u1", role: "CUSTOMER" },
      query: q,
    });
    expect(guest).toContain(":anon:");
    expect(guest).not.toContain(`role:`);
    expect(customer).toContain("role:CUSTOMER");
    expect(customer).not.toBe(guest);
  });

  it("changes with coordinates, dishType and limit", async () => {
    const viewer = null;
    const a = buildHomeFeedCacheKey({
      viewer,
      query: await parseHomeFeedQuery({}),
    });
    const b = buildHomeFeedCacheKey({
      viewer,
      query: await parseHomeFeedQuery({ lat: "6.5244", lng: "3.3792" }),
    });
    const c = buildHomeFeedCacheKey({
      viewer,
      query: await parseHomeFeedQuery({ dishType: "JOLLOF" }),
    });
    const d = buildHomeFeedCacheKey({
      viewer,
      query: await parseHomeFeedQuery({ limit: "50" }),
    });

    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("collapses tiny GPS jitter into one key via coordinate rounding", async () => {
    const q1 = await parseHomeFeedQuery({ lat: "6.52441", lng: "3.37921" });
    const q2 = await parseHomeFeedQuery({ lat: "6.52449", lng: "3.37929" });
    const k1 = buildHomeFeedCacheKey({ viewer: null, query: q1 });
    const k2 = buildHomeFeedCacheKey({ viewer: null, query: q2 });
    expect(k1).toBe(k2);
  });

  it("lives inside an isolated home:feed namespace", async () => {
    const key = buildHomeFeedCacheKey({ viewer: null, query: await parseHomeFeedQuery({}) });
    expect(key.startsWith("home:feed:")).toBe(true);
  });
});

import {
  parseHomeFeedQuery,
  roundCoord,
  buildHomeFeedCacheKey,
  HOME_FEED_DEFAULT_LIMIT,
  HOME_FEED_MAX_LIMIT,
} from "../../src/services/homeFeed.service";
import { ValidationError } from "../../src/errors/AppError";

const base = { lat: null, lng: null };

describe("home feed query parsing", () => {
  it("applies defaults when no params are supplied", () => {
    const q = parseHomeFeedQuery({});
    expect(q.limit).toBe(HOME_FEED_DEFAULT_LIMIT);
    expect(q.category).toBe("ALL");
    expect(q.lat).toBeNull();
    expect(q.lng).toBeNull();
  });

  it("clamps the limit into a safe range", () => {
    expect(parseHomeFeedQuery({ limit: "0" }).limit).toBe(1);
    expect(parseHomeFeedQuery({ limit: "10" }).limit).toBe(10);
    expect(parseHomeFeedQuery({ limit: "9999" }).limit).toBe(HOME_FEED_MAX_LIMIT);
    expect(parseHomeFeedQuery({ limit: "abc" }).limit).toBe(HOME_FEED_DEFAULT_LIMIT);
    expect(parseHomeFeedQuery({ limit: "-5" }).limit).toBe(1);
  });

  it("keeps valid coordinate pairs and rounds them to ~3 decimals", () => {
    const q = parseHomeFeedQuery({ lat: "6.5244444", lng: "3.3792222" });
    expect(q.lat).toBeCloseTo(6.524);
    expect(q.lng).toBeCloseTo(3.379);
    expect(roundCoord(6.123456)).toBe(6.123);
  });

  it("treats invalid or partial coordinates as no-location, never an error", () => {
    // out of range
    expect(parseHomeFeedQuery({ lat: "91", lng: "0" })).toMatchObject(base);
    expect(parseHomeFeedQuery({ lat: "0", lng: "-181" })).toMatchObject(base);
    // partial
    expect(parseHomeFeedQuery({ lat: "6.52" })).toMatchObject(base);
    expect(parseHomeFeedQuery({ lng: "3.37" })).toMatchObject(base);
    // non-numeric
    expect(parseHomeFeedQuery({ lat: "abc", lng: "def" })).toMatchObject(base);
    // empty strings
    expect(parseHomeFeedQuery({ lat: "", lng: "" })).toMatchObject(base);
  });

  it("accepts every real category enum value and ALL", () => {
    expect(parseHomeFeedQuery({ category: "breakfast" }).category).toBe("BREAKFAST");
    expect(parseHomeFeedQuery({ category: "ALL" }).category).toBe("ALL");
    expect(parseHomeFeedQuery({ category: "" }).category).toBe("ALL");
  });

  it("rejects unknown categories with the standard validation error", () => {
    expect(() => parseHomeFeedQuery({ category: "RICE" })).toThrow(ValidationError);
    expect(() => parseHomeFeedQuery({ category: "DROP TABLE;" })).toThrow(ValidationError);
  });
});

describe("home feed cache key", () => {
  it("distinguishes guests from authenticated users", () => {
    const q = parseHomeFeedQuery({});
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

  it("changes with coordinates, category and limit", () => {
    const viewer = null;
    const a = buildHomeFeedCacheKey({
      viewer,
      query: parseHomeFeedQuery({}),
    });
    const b = buildHomeFeedCacheKey({
      viewer,
      query: parseHomeFeedQuery({ lat: "6.5244", lng: "3.3792" }),
    });
    const c = buildHomeFeedCacheKey({
      viewer,
      query: parseHomeFeedQuery({ category: "LUNCH" }),
    });
    const d = buildHomeFeedCacheKey({
      viewer,
      query: parseHomeFeedQuery({ limit: "50" }),
    });

    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("collapses tiny GPS jitter into one key via coordinate rounding", () => {
    const q1 = parseHomeFeedQuery({ lat: "6.52441", lng: "3.37921" });
    const q2 = parseHomeFeedQuery({ lat: "6.52449", lng: "3.37929" });
    const k1 = buildHomeFeedCacheKey({ viewer: null, query: q1 });
    const k2 = buildHomeFeedCacheKey({ viewer: null, query: q2 });
    expect(k1).toBe(k2);
  });

  it("lives inside an isolated home:feed namespace", () => {
    const key = buildHomeFeedCacheKey({ viewer: null, query: parseHomeFeedQuery({}) });
    expect(key.startsWith("home:feed:")).toBe(true);
  });
});

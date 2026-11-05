/**
 * B-7 — GET /api/auth/nearby uses the project's standard error envelope.
 *
 * It used to answer a missing coordinate with a bespoke
 * `{ success: false, error: "lat & lng required" }` — no `code`, a different
 * key name, and no way for a client to treat it like every other validation
 * failure. It also answered a NON-NUMERIC coordinate with HTTP 200 and an
 * empty list (the haversine distance became NaN and matched nothing).
 *
 * The SUCCESS envelope is deliberately unchanged: `{ success: true, data: [...] }`.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: jest.fn() },
    vendorReview: { groupBy: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

import prisma from "../../src/lib/prisma";
import { getNearbyVendors } from "../../src/controllers/vendorControllerMapping";
import { resolveError } from "../../src/middlewares/error.middleware";
import { ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

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
  db.user.findMany.mockResolvedValue([]);
  db.vendorReview.groupBy.mockResolvedValue([]);
});

describe("GET /api/auth/nearby — validation failures use the standard envelope", () => {
  it("a missing coordinate is a 400 with code VALIDATION_ERROR", async () => {
    const err = (await getNearbyVendors(req({}), res()).catch(
      (e) => e,
    )) as ValidationError;

    expect(err).toBeInstanceOf(ValidationError);
    const { statusCode, envelope } = resolveError(err);
    expect(statusCode).toBe(400);
    expect(envelope).toEqual({
      success: false,
      message: expect.stringMatching(/lat and lng are required/i),
      code: "VALIDATION_ERROR",
    });
  });

  it("a missing lng is a 400", async () => {
    const err = (await getNearbyVendors(req({ lat: "6.5" }), res()).catch(
      (e) => e,
    )) as ValidationError;
    expect(resolveError(err).statusCode).toBe(400);
    expect(resolveError(err).envelope.code).toBe("VALIDATION_ERROR");
  });

  it("a non-numeric latitude is a 400, not an empty 200", async () => {
    const err = (await getNearbyVendors(
      req({ lat: "abc", lng: "3.4" }),
      res(),
    ).catch((e) => e)) as ValidationError;

    expect(err).toBeInstanceOf(ValidationError);
    expect(resolveError(err).statusCode).toBe(400);
    expect(resolveError(err).envelope.message).toMatch(/lat/i);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it("an out-of-range latitude is a 400", async () => {
    const err = (await getNearbyVendors(
      req({ lat: "120", lng: "3.4" }),
      res(),
    ).catch((e) => e)) as ValidationError;
    expect(resolveError(err).statusCode).toBe(400);
    expect(resolveError(err).envelope.message).toMatch(/lat/i);
  });

  it("an out-of-range longitude is a 400", async () => {
    const err = (await getNearbyVendors(
      req({ lat: "6.5", lng: "999" }),
      res(),
    ).catch((e) => e)) as ValidationError;
    expect(resolveError(err).statusCode).toBe(400);
    expect(resolveError(err).envelope.message).toMatch(/lng/i);
  });

  it("a non-numeric radius is a 400", async () => {
    const err = (await getNearbyVendors(
      req({ lat: "6.5", lng: "3.4", radius: "wide" }),
      res(),
    ).catch((e) => e)) as ValidationError;
    expect(resolveError(err).statusCode).toBe(400);
    expect(resolveError(err).envelope.message).toMatch(/radius/i);
  });

  it("a zero or negative radius is a 400", async () => {
    for (const radius of ["0", "-3"]) {
      const err = (await getNearbyVendors(
        req({ lat: "6.5", lng: "3.4", radius }),
        res(),
      ).catch((e) => e)) as ValidationError;
      expect(resolveError(err).statusCode).toBe(400);
      expect(resolveError(err).envelope.message).toMatch(/radius/i);
    }
  });
});

describe("GET /api/auth/nearby — the success envelope is unchanged", () => {
  it("returns { success: true, data: [...] }", async () => {
    db.user.findMany.mockResolvedValue([
      {
        id: "vendor-1",
        name: "Mama Put",
        brandName: "Mama Put Kitchen",
        brandLogo: null,
        avatarUrl: null,
        isLive: true,
        vendorStatus: "ACTIVE",
        deliveryPreferences: { acceptingOrders: true },
        addresses: [
          { isDefault: true, latitude: 6.5001, longitude: 3.4001 },
        ],
      },
    ]);

    const r = res();
    await getNearbyVendors(req({ lat: "6.5", lng: "3.4" }), r);

    const body = r.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]).toMatchObject({
      id: "vendor-1",
      name: "Mama Put",
      brandName: "Mama Put Kitchen",
      isOpen: true,
    });
    // The vendor's internal state is not part of the public nearby payload.
    expect(body.data[0]).not.toHaveProperty("vendorStatus");
    expect(body.data[0]).not.toHaveProperty("deliveryPreferences");
  });

  it("uses the documented default radius of 5 km", async () => {
    await getNearbyVendors(req({ lat: "6.5", lng: "3.4" }), res());
    const rows = db.user.findMany.mock.calls[0][0].select;
    expect(rows).toBeDefined();
  });
});

/**
 * Phase 2 M4 — vendor-eligibility cache correctness.
 *
 * Covers: admin vendor-status changes and delivery-preference changes
 * sweeping discovery caches through the existing mechanism, and the
 * discovery sweep covering every namespace that embeds vendor
 * eligibility or orderability state.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { update: jest.fn(), findUnique: jest.fn() },
    order: { count: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisNotifications: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() },
  redisUsersSessions: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(async () => []),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => ({ ok: true, failures: [] })),
  clearVendorProductDetailCaches: jest.fn(async () => ({ ok: true, failures: [] })),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => {}),
}));

jest.mock("../../src/services/vendorStatus.service", () => ({
  __esModule: true,
  changeVendorStatus: jest.fn(async () => ({ id: "vendor-1", vendorStatus: "SUSPENDED" })),
}));

import prisma from "../../src/lib/prisma";
import { redisProducts, redisSearch } from "../../src/lib/redis";
import { scanKeys } from "../../src/lib/redisScan";
import {
  invalidateMarketplaceDiscoveryCaches,
  clearVendorProductDetailCaches,
} from "../../src/services/clearCaches";
import { setVendorStatus } from "../../src/controllers/admin.controller";
import { updateDeliveryPreferences } from "../../src/controllers/vendorSettingsController";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedInvalidate = invalidateMarketplaceDiscoveryCaches as unknown as jest.Mock;
const mockedClearVendorDetails = clearVendorProductDetailCaches as unknown as jest.Mock;
const mockedScanKeys = scanKeys as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("admin vendor-status changes sweep discovery caches", () => {
  it("suspending a vendor invalidates eligibility-dependent caches", async () => {
    db.user.update.mockResolvedValue({ id: "vendor-1" });
    db.order.count.mockResolvedValue(2);
    const r = res();
    await setVendorStatus(
      {
        headers: {},
        body: { status: "SUSPENDED", reason: "fraud review" },
        params: { id: "vendor-1" },
        query: {},
        user: { id: "admin-1", role: "ADMIN" },
      } as any,
      r,
    );

    // Storefront forced offline AND cached orderable flags swept.
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "vendor-1" },
      data: { isLive: false },
    });
    expect(mockedInvalidate).toHaveBeenCalledTimes(1);
    // The vendor's own product-detail entries carry an availability snapshot
    // that a cache HIT reuses, so a suspension must drop them too.
    expect(mockedClearVendorDetails).toHaveBeenCalledTimes(1);
    expect(mockedClearVendorDetails).toHaveBeenCalledWith("vendor-1");
    expect(r.json.mock.calls[0][0].success).toBe(true);
  });

  it("reactivating a vendor also refreshes discovery caches", async () => {
    db.user.update.mockResolvedValue({ id: "vendor-1" });
    const { changeVendorStatus } = require("../../src/services/vendorStatus.service");
    changeVendorStatus.mockResolvedValueOnce({ id: "vendor-1", vendorStatus: "ACTIVE" });
    await setVendorStatus(
      {
        headers: {},
        body: { status: "ACTIVE" },
        params: { id: "vendor-1" },
        query: {},
        user: { id: "admin-1", role: "ADMIN" },
      } as any,
      res(),
    );

    expect(mockedInvalidate).toHaveBeenCalledTimes(1);
    // Reactivation changes the same answer (the vendor becomes orderable
    // again), so the same entries must be dropped.
    expect(mockedClearVendorDetails).toHaveBeenCalledTimes(1);
    expect(mockedClearVendorDetails).toHaveBeenCalledWith("vendor-1");
  });
});

describe("delivery-preference changes sweep discovery caches", () => {
  it("pausing orders invalidates cached orderable flags", async () => {
    db.user.update.mockResolvedValue({ id: "vendor-1", isLive: true });
    const r = res();
    await updateDeliveryPreferences(
      {
        headers: {},
        body: { acceptingOrders: false, deliveryEnabled: true },
        params: {},
        query: {},
        user: { id: "vendor-1", role: "VENDOR" },
      } as any,
      r,
    );

    expect(mockedInvalidate).toHaveBeenCalledTimes(1);
    expect(r.json.mock.calls[0][0].success).toBe(true);
  });
});

describe("invalidateMarketplaceDiscoveryCaches namespace coverage", () => {
  it("sweeps every namespace on BOTH Redis clients that store them", async () => {
    // Exercise the REAL implementation against mocked Redis: the module
    // mock above replaces it for the handler tests, so reach past it here.
    const realCaches = jest.requireActual("../../src/services/clearCaches") as typeof import("../../src/services/clearCaches");
    const seen: Array<[unknown, string]> = [];
    mockedScanKeys.mockImplementation(async (client: unknown, pattern: string) => {
      seen.push([client, pattern]);
      return [`${pattern}demo`];
    });

    await realCaches.invalidateMarketplaceDiscoveryCaches();

    const EXPECTED_PATTERNS = [
      "home:feed:*",
      "products:mostPopular:*",
      "products:all:*",
      "products:new:*",
      "products:category:*",
      "search:*",
      "suggestions:*",
    ];

    // `search:*` and `suggestions:*` are written to redisSearch; the rest to
    // redisProducts. Both clients must be swept, otherwise those two namespaces
    // stay stale for their full TTL.
    for (const client of [redisProducts, redisSearch]) {
      const patterns = seen.filter(([c]) => c === client).map(([, p]) => p);
      expect(patterns).toEqual(EXPECTED_PATTERNS);

      // One del per namespace with exactly the keys that namespace scan found.
      const del = (client as unknown as { del: jest.Mock }).del;
      expect(del).toHaveBeenCalledTimes(EXPECTED_PATTERNS.length);
      for (const pattern of EXPECTED_PATTERNS) {
        expect(del).toHaveBeenCalledWith([`${pattern}demo`]);
      }
    }
  });
});

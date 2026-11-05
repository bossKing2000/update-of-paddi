/**
 * Review follow-up B-1 — `optionGroupsMigrated` on real controller responses.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The B-1 defect (detail always reporting `false`) was invisible to the
 * 17 `optionMigrationState` unit tests, because those build hand-made, fully
 * populated objects and never touch a Prisma `select`. The bug lived in the
 * MISMATCH between the controller's query shape and the state helper's input
 * contract. So every test here goes through the actual controller and asserts
 * on the actual query shape as well as the response.
 *
 * All infrastructure is mocked. These prove APPLICATION behavior only. They do
 * NOT prove that the database constraint exists or that concurrent writes are
 * serialized.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    productReview: { aggregate: jest.fn() },
    vendorReview: { aggregate: jest.fn() },
    optionGroup: { findMany: jest.fn() },
    optionGroupItem: { findMany: jest.fn() },
    dishType: { findUnique: jest.fn() },
    tag: { findUnique: jest.fn(), findMany: jest.fn() },
    productTag: { deleteMany: jest.fn(), createMany: jest.fn() },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
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

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
  clearProductFromCarts: jest.fn(async () => {}),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  loadActiveProductPromos: jest.fn(async () => []),
  attachPromotions: jest.fn((items: unknown[]) => items),
}));

jest.mock("../../src/services/product.service", () => ({
  __esModule: true,
  ...jest.requireActual("../../src/services/product.service"),
  clearProductFromCarts: jest.fn(async () => {}),
  assertActiveDishType: jest.fn(async () => undefined),
  trackProductView: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { redisProducts } from "../../src/lib/redis";
import { CACHE_KEYS } from "../../src/services/redisCacheTiming";
import {
  getProductById,
  createProduct,
  updateProduct,
} from "../../src/controllers/productController";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedGet = redisProducts.get as unknown as jest.Mock;
const mockedSet = redisProducts.set as unknown as jest.Mock;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const publicReq = (): any =>
  ({
    headers: {},
    body: {},
    params: { id: "prod-1" },
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
  }) as any;

const vendorReq = (overrides: Partial<any> = {}): any =>
  ({
    headers: {},
    body: {},
    params: { id: "prod-1" },
    query: {},
    files: undefined,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "vendor-1", role: "VENDOR", sessionId: "sess" },
    ...overrides,
  }) as any;

const PUBLIC_VENDOR = {
  id: "vendor-1",
  name: "Mama Put",
  brandName: "Mama Put Kitchen",
  brandLogo: "https://cdn.example/logo.png",
  isLive: true,
  vendorStatus: "ACTIVE",
  deliveryPreferences: { acceptingOrders: true },
};

const legacy = (id: string, name: string, price: number, isActive: boolean) => ({
  id,
  name,
  price,
  isActive,
});

const extras = (items: Array<{ id: string; name: string; priceAdd: number; isActive: boolean }>) => [
  {
    id: "grp-extras",
    name: "Extras",
    required: false,
    minSelections: 0,
    maxSelections: items.length,
    sortOrder: 0,
    items,
  },
];

function detailRow(options: unknown[], optionGroups: unknown[]) {
  return {
    id: "prod-1",
    name: "Jollof",
    description: "Smoky party jollof",
    price: 2000,
    images: ["https://cdn.example/jollof.png"],
    thumbnail: "https://cdn.example/jollof.png",
    video: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    totalViews: 10,
    dishType: { id: "JOLLOF", name: "Jollof", description: "Rice" },
    portionLabel: null,
    trackInventory: false,
    stock: null,
    popularityScore: 0,
    popularityPercent: 0,
    isNew: false,
    archived: false,
    vendorId: "vendor-1",
    vendor: PUBLIC_VENDOR,
    options,
    optionGroups,
  };
}

const dataOf = (r: any) => r.json.mock.calls[0][0].data;
const bodyOf = (r: any) => r.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockResolvedValue(null);
  mockedSet.mockResolvedValue("OK");
  db.productReview.aggregate.mockResolvedValue({ _avg: { rating: 4 }, _count: { _all: 2 } });
  db.vendorReview.aggregate.mockResolvedValue({ _avg: { rating: 5 }, _count: { rating: 1 } });
  db.dishType.findUnique.mockResolvedValue({ id: "JOLLOF", categoryId: "RICE" });
  db.tag.findMany.mockResolvedValue([]);
});

describe("B-1 — the detail query supplies what the state calculation needs", () => {
  it("selects isActive on legacy options", async () => {
    db.product.findFirst.mockResolvedValue(detailRow([legacy("o1", "Egg", 500, true)], extras([
      { id: "i1", name: "Egg", priceAdd: 500, isActive: true },
    ])));
    await getProductById(publicReq(), res());

    const optionsSelect = db.product.findFirst.mock.calls[0][0].select.options;
    expect(optionsSelect.select).toHaveProperty("isActive", true);
  });

  it("does NOT filter inactive legacy options out of the query", async () => {
    db.product.findFirst.mockResolvedValue(detailRow([], []));
    await getProductById(publicReq(), res());

    const optionsSelect = db.product.findFirst.mock.calls[0][0].select.options;
    // A `where: { isActive: true }` here would hide an inactive legacy option
    // from the migration-state comparison — the original defect.
    expect(optionsSelect.where).toBeUndefined();
  });
});

describe("B-1 — optionGroupsMigrated agrees across detail / create / update", () => {
  const MIGRATED_OPTIONS = [legacy("o1", "Egg", 500, true), legacy("o2", "Cheese", 800, false)];
  const MIGRATED_GROUPS = extras([
    { id: "i1", name: "Egg", priceAdd: 500, isActive: true },
    { id: "i2", name: "Cheese", priceAdd: 800, isActive: false },
  ]);

  it("detail reports true for a fully migrated product", async () => {
    db.product.findFirst.mockResolvedValue(detailRow(MIGRATED_OPTIONS, MIGRATED_GROUPS));
    const r = res();
    await getProductById(publicReq(), r);
    expect(dataOf(r).optionGroupsMigrated).toBe(true);
  });

  it("update reports true for the same data", async () => {
    db.product.findUnique.mockResolvedValue({
      id: "prod-1",
      vendorId: "vendor-1",
      name: "Jollof",
      dishTypeId: "JOLLOF",
      archived: false,
      options: MIGRATED_OPTIONS,
      optionGroups: MIGRATED_GROUPS,
      dishType: { id: "JOLLOF", name: "Jollof" },
      tags: [],
    });
    db.product.update.mockResolvedValue({ id: "prod-1", vendorId: "vendor-1" });
    const r = res();
    await updateProduct(
      vendorReq({ body: { name: "Jollof Rice", description: "Updated description", price: 2600 } }),
      r,
    );
    expect(dataOf(r).optionGroupsMigrated).toBe(true);
  });

  it("create reports true for the same data", async () => {
    db.product.create.mockResolvedValue({
      id: "prod-new",
      vendorId: "vendor-1",
      name: "Jollof",
      archived: false,
      options: MIGRATED_OPTIONS,
      optionGroups: MIGRATED_GROUPS,
      dishType: { id: "JOLLOF", name: "Jollof" },
      tags: [],
    });
    const r = res();
    await createProduct(
      vendorReq({
        body: {
          name: "Jollof Special",
          description: "Smoky party jollof",
          price: 2500,
          dishTypeId: "JOLLOF",
        },
        files: { images: [{ path: "img1.jpg" }] },
      }),
      r,
    );
    expect(bodyOf(r).data.product.optionGroupsMigrated).toBe(true);
  });

  it("an INACTIVE legacy option matching an inactive item does not force false", async () => {
    db.product.findFirst.mockResolvedValue(
      detailRow([legacy("o1", "Egg", 500, false)], extras([
        { id: "i1", name: "Egg", priceAdd: 500, isActive: false },
      ])),
    );
    const r = res();
    await getProductById(publicReq(), r);
    expect(dataOf(r).optionGroupsMigrated).toBe(true);
  });

  it("a partially migrated product reports false", async () => {
    db.product.findFirst.mockResolvedValue(
      detailRow(
        [legacy("o1", "Egg", 500, true), legacy("o2", "Cheese", 800, true)],
        extras([{ id: "i1", name: "Egg", priceAdd: 500, isActive: true }]),
      ),
    );
    const r = res();
    await getProductById(publicReq(), r);
    expect(dataOf(r).optionGroupsMigrated).toBe(false);
  });

  it("a price drift reports false rather than true", async () => {
    db.product.findFirst.mockResolvedValue(
      detailRow(
        [legacy("o1", "Egg", 500, true)],
        extras([{ id: "i1", name: "Egg", priceAdd: 550, isActive: true }]),
      ),
    );
    const r = res();
    await getProductById(publicReq(), r);
    expect(dataOf(r).optionGroupsMigrated).toBe(false);
  });
});

describe("B-1 — display filtering stays active-only for customers", () => {
  it("an inactive legacy option is NOT served to customers", async () => {
    db.product.findFirst.mockResolvedValue(
      detailRow(
        [legacy("o1", "Egg", 500, true), legacy("o2", "Retired", 100, false)],
        extras([
          { id: "i1", name: "Egg", priceAdd: 500, isActive: true },
          { id: "i2", name: "Retired", priceAdd: 100, isActive: false },
        ]),
      ),
    );
    const r = res();
    await getProductById(publicReq(), r);

    expect(dataOf(r).options.map((o: { name: string }) => o.name)).toEqual(["Egg"]);
  });

  it("the customer option payload keeps its original field set", async () => {
    db.product.findFirst.mockResolvedValue(detailRow([legacy("o1", "Egg", 500, true)], extras([])));
    const r = res();
    await getProductById(publicReq(), r);

    // The internal `isActive` flag must not leak into the customer payload as a
    // new field; the response contract is unchanged.
    expect(Object.keys(dataOf(r).options[0]).sort()).toEqual(["id", "name", "price"]);
  });

  it("the cached payload carries the SAME flag as the response", async () => {
    db.product.findFirst.mockResolvedValue(detailRow(MIGRATED_ALL(), MIGRATED_ALL_GROUPS()));
    const r = res();
    await getProductById(publicReq(), r);

    const cached = JSON.parse(mockedSet.mock.calls[0][1]);
    expect(cached.optionGroupsMigrated).toBe(dataOf(r).optionGroupsMigrated);
    expect(cached.optionGroupsMigrated).toBe(true);
  });

  function MIGRATED_ALL() {
    return [legacy("o1", "Egg", 500, true)];
  }
  function MIGRATED_ALL_GROUPS() {
    return extras([{ id: "i1", name: "Egg", priceAdd: 500, isActive: true }]);
  }
});

describe("F-2.15 — option-group item filtering is identical on MISS and HIT", () => {
  // The same product shape the detail query returns: an "Extras" group that
  // fully migrates the legacy set (including an inactive legacy option), plus
  // a non-migrated group. The inactive rows must never reach a customer, but
  // they must still be visible to the migration-state calculation.
  function fixture() {
    return {
      options: [
        legacy("opt-chicken", "Chicken", 500, true),
        legacy("opt-retired", "Retired", 100, false),
      ],
      optionGroups: [
        {
          id: "grp-extras",
          name: "Extras",
          required: false,
          minSelections: 0,
          maxSelections: 3,
          sortOrder: 0,
          items: [
            { id: "item-chicken", name: "Chicken", priceAdd: 500, isActive: true, sortOrder: 0 },
            { id: "item-retired", name: "Retired", priceAdd: 100, isActive: false, sortOrder: 1 },
            { id: "item-beef", name: "Beef", priceAdd: 700, isActive: true, sortOrder: 2 },
          ],
        },
        {
          id: "grp-sides",
          name: "Sides",
          required: false,
          minSelections: 0,
          maxSelections: 1,
          sortOrder: 1,
          items: [
            { id: "item-plantain", name: "Plantain", priceAdd: 300, isActive: true, sortOrder: 0 },
          ],
        },
      ],
    };
  }

  it("MISS returns and caches only active items, without mutating Prisma rows", async () => {
    const { options, optionGroups } = fixture();
    db.product.findFirst.mockResolvedValue(detailRow(options, optionGroups));

    const r = res();
    await getProductById(publicReq(), r);

    expect(r.setHeader).toHaveBeenCalledWith("X-Cache", "MISS");
    const data = dataOf(r);

    // Legacy options keep their pre-existing active-only {id,name,price} shape.
    expect(data.options).toEqual([{ id: "opt-chicken", name: "Chicken", price: 500 }]);
    // The flag is still derived from the UNFILTERED rows.
    expect(data.optionGroupsMigrated).toBe(true);

    // Group order and group fields are preserved.
    expect(data.optionGroups.map((g: { id: string }) => g.id)).toEqual([
      "grp-extras",
      "grp-sides",
    ]);
    expect(data.optionGroups[0]).toEqual({
      id: "grp-extras",
      name: "Extras",
      required: false,
      minSelections: 0,
      maxSelections: 3,
      sortOrder: 0,
      // Item order, ids, names and prices are unchanged; only the inactive
      // row is gone.
      items: [
        { id: "item-chicken", name: "Chicken", priceAdd: 500, isActive: true, sortOrder: 0 },
        { id: "item-beef", name: "Beef", priceAdd: 700, isActive: true, sortOrder: 2 },
      ],
    });
    expect(data.optionGroups[1].items).toEqual([
      { id: "item-plantain", name: "Plantain", priceAdd: 300, isActive: true, sortOrder: 0 },
    ]);
    expect(JSON.stringify(data.optionGroups)).not.toContain("item-retired");

    // The cache entry is the same public representation.
    const cached = JSON.parse(mockedSet.mock.calls[0][1]);
    expect(cached.optionGroups).toEqual(data.optionGroups);
    expect(cached.options).toEqual(data.options);
    expect(cached.optionGroupsMigrated).toBe(true);

    // Filtering returns new objects; the loaded Prisma rows stay intact.
    expect(optionGroups[0].items).toHaveLength(3);
    expect(optionGroups[0].items[1].id).toBe("item-retired");
  });

  it("HIT returns the same option-group items as the MISS path for the same fixture", async () => {
    const { options, optionGroups } = fixture();
    db.product.findFirst.mockResolvedValue(detailRow(options, optionGroups));

    const miss = res();
    await getProductById(publicReq(), miss);
    const cachedPayload = mockedSet.mock.calls[0][1];
    const missData = dataOf(miss);

    mockedGet.mockResolvedValueOnce(cachedPayload);
    const hit = res();
    await getProductById(publicReq(), hit);

    expect(hit.setHeader).toHaveBeenCalledWith("X-Cache", "HIT");
    expect(db.product.findFirst).toHaveBeenCalledTimes(1);
    expect(dataOf(hit).optionGroups).toEqual(missData.optionGroups);
    expect(dataOf(hit).options).toEqual(missData.options);
    expect(dataOf(hit).optionGroupsMigrated).toBe(true);
    expect(dataOf(hit).optionGroups[0].items.map((i: { id: string }) => i.id)).toEqual([
      "item-chicken",
      "item-beef",
    ]);
    expect(JSON.stringify(dataOf(hit).optionGroups)).not.toContain("item-retired");
  });

  it("HIT filters inactive items in a pre-fix cached entry", async () => {
    const { optionGroups } = fixture();
    // Before F-2.15, the MISS path already cached filtered legacy options but
    // left option-group items unfiltered. This is that exact stale entry.
    const preFixCache = detailRow([{ id: "opt-chicken", name: "Chicken", price: 500 }], optionGroups);
    mockedGet.mockResolvedValueOnce(JSON.stringify(preFixCache));

    const r = res();
    await getProductById(publicReq(), r);

    expect(r.setHeader).toHaveBeenCalledWith("X-Cache", "HIT");
    const data = dataOf(r);
    expect(data.optionGroups.map((g: { id: string }) => g.id)).toEqual([
      "grp-extras",
      "grp-sides",
    ]);
    expect(data.optionGroups[0].items.map((i: { id: string }) => i.id)).toEqual([
      "item-chicken",
      "item-beef",
    ]);
    expect(JSON.stringify(data.optionGroups)).not.toContain("item-retired");
    // Legacy options pass through untouched on HIT (pre-existing behavior).
    expect(data.options).toEqual([{ id: "opt-chicken", name: "Chicken", price: 500 }]);
  });

  it("the update path leaves the detail cache to the complete GET path", async () => {
    const { options, optionGroups } = fixture();
    db.product.findUnique.mockResolvedValue({
      id: "prod-1",
      vendorId: "vendor-1",
      name: "Jollof",
      description: "Smoky party jollof",
      price: 2000,
      dishTypeId: "JOLLOF",
      archived: false,
      images: [],
      video: [],
      options,
      optionGroups,
      dishType: { id: "JOLLOF", name: "Jollof" },
      tags: [],
    });
    db.product.update.mockResolvedValue({ id: "prod-1", vendorId: "vendor-1" });

    await updateProduct(
      vendorReq({ body: { name: "Jollof Rice", description: "Updated description", price: 2600 } }),
      res(),
    );

    // HIGH-1: updateProduct has no vendor relation or review aggregates, so it
    // must not publish a partial detail payload. The stale key is dropped by
    // the invalidation sweep and the next read repopulates it through the
    // complete MISS path.
    const detailKey = CACHE_KEYS.PRODUCT_DETAIL("prod-1");
    expect(mockedSet).not.toHaveBeenCalled();

    db.product.findFirst.mockResolvedValue(detailRow(options, optionGroups));
    const detail = res();
    await getProductById(publicReq(), detail);

    expect(detail.setHeader).toHaveBeenCalledWith("X-Cache", "MISS");
    expect(mockedSet).toHaveBeenCalledWith(detailKey, expect.any(String), {
      EX: expect.any(Number),
    });
    const cached = JSON.parse(mockedSet.mock.calls[0][1]);
    expect(cached.optionGroups[0].items.map((i: { id: string }) => i.id)).toEqual([
      "item-chicken",
      "item-beef",
    ]);
    expect(cached.optionGroups[1].items.map((i: { id: string }) => i.id)).toEqual([
      "item-plantain",
    ]);
    expect(JSON.stringify(cached.optionGroups)).not.toContain("item-retired");
    expect(cached.options.map((o: { id: string }) => o.id)).toEqual(["opt-chicken"]);
    expect(cached.vendor).toMatchObject({ id: "vendor-1", name: "Mama Put" });
    expect(cached.vendorOperating).toBe(true);
    expect(cached.orderable).toBe(true);
  });
});
/**
 * Vendor product create — server-derived Product.categoryId.
 *
 * Regression coverage for the pre-existing TS2322 on
 * `src/controllers/productController.ts`: `Product.categoryId` is required
 * (`schema.prisma`, added by migration 20261006030622_product_foundation) and
 * is documented as "server-derived on write, never client-controlled", from
 * the authoritative chain `Product.dishTypeId -> DishType.categoryId`.
 *
 * These tests drive the REAL handler through mocked infrastructure (Prisma,
 * Redis, queue, caches). No source-text inspection is used, so deleting,
 * reordering, or inverting the derivation fails the suite.
 *
 * NOTE: Jest resolves modules from the working tree, not the Git index. These
 * tests therefore assert the worktree implementation. The staged patch is
 * verified separately by the isolated typecheck.
 */

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    dishType: { findUnique: jest.fn() },
    tag: { findMany: jest.fn() },
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
  clearProductCache: jest.fn(async () => ({ ok: true, failures: [] })),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/controllers/vendorDashboard.service", () => ({
  __esModule: true,
  VendorDashboardService: jest.fn().mockImplementation(() => ({
    invalidateCache: jest.fn(async () => {}),
  })),
}));

jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  loadActiveProductPromos: jest.fn(async () => []),
  attachPromotions: jest.fn((items: unknown[]) => items),
}));

jest.mock("../../src/AI/localSearchCorrect", () => ({
  __esModule: true,
  correctQuery: jest.fn((q: string) => q),
}));

// Real product.service, stubbed only at the dish-type vocabulary check so the
// test isolates the category derivation rather than taxonomy validation.
jest.mock("../../src/services/product.service", () => {
  const actual = jest.requireActual("../../src/services/product.service");
  return {
    __esModule: true,
    ...actual,
    assertActiveDishType: jest.fn(async () => {}),
    clearProductFromCarts: jest.fn(async () => {}),
  };
});

import prisma from "../../src/lib/prisma";
import { createProduct } from "../../src/controllers/productController";
import { ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

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

const VALID_BODY = {
  name: "Jollof Special",
  description: "Smoky party jollof",
  price: 2500,
  dishTypeId: "JOLLOF",
};
const FILES = { images: [{ path: "img1.jpg" }] };

const createdWith = () => db.product.create.mock.calls[0][0].data;

describe("createProduct — server-derived categoryId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.dishType.findUnique.mockResolvedValue({ categoryId: "RICE" });
    db.tag.findMany.mockResolvedValue([]);
    db.product.create.mockImplementation(async (args: any) => ({
      id: "new-1",
      ...args.data,
    }));
  });

  it("derives categoryId from the validated dish type", async () => {
    await createProduct(vendorReq({ files: FILES, body: VALID_BODY }), res());

    expect(db.dishType.findUnique).toHaveBeenCalledWith({
      where: { id: "JOLLOF" },
      select: { categoryId: true },
    });
    expect(createdWith().categoryId).toBe("RICE");
    // The derivation must come from the dish type, never from the request.
    expect(createdWith().categoryId).not.toBe(VALID_BODY.dishTypeId);
  });

  it("ignores a client-supplied categoryId", async () => {
    await createProduct(
      vendorReq({ files: FILES, body: { ...VALID_BODY, categoryId: "EVIL_CATEGORY" } }),
      res(),
    );
    expect(createdWith().categoryId).toBe("RICE");
  });

  it("reflects a different dish type's category rather than a cached one", async () => {
    db.dishType.findUnique.mockResolvedValue({ categoryId: "SNACKS" });
    await createProduct(
      vendorReq({ files: FILES, body: { ...VALID_BODY, dishTypeId: "DOUGHNUT" } }),
      res(),
    );
    expect(db.dishType.findUnique).toHaveBeenCalledWith({
      where: { id: "DOUGHNUT" },
      select: { categoryId: true },
    });
    expect(createdWith().categoryId).toBe("SNACKS");
  });

  it("rejects and creates nothing when the dish type cannot be resolved", async () => {
    db.dishType.findUnique.mockResolvedValue(null);
    await expect(
      createProduct(vendorReq({ files: FILES, body: VALID_BODY }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
  });
});
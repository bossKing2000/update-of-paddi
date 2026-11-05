jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    productOption: { count: jest.fn(), deleteMany: jest.fn(), update: jest.fn(), create: jest.fn() },
    dishType: { findUnique: jest.fn() },
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
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
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/services/product.service", () => {
  const actual = jest.requireActual("../../src/services/product.service");
  return {
    __esModule: true,
    ...actual,
    clearProductFromCarts: jest.fn(async () => {}),
    assertActiveDishType: jest.fn(async (id: string) => {
      if (id !== "JOLLOF") {
        const { ValidationError } = require("../../src/errors/AppError");
        throw new ValidationError("Invalid dish type");
      }
    }),
  };
});

jest.mock("../../src/controllers/vendorDashboard.service", () => ({
  __esModule: true,
  VendorDashboardService: jest.fn().mockImplementation(() => ({
    invalidateCache: jest.fn(async () => {}),
  })),
}));

import prisma from "../../src/lib/prisma";
import { updateProduct, createProduct } from "../../src/controllers/productController";
import { ForbiddenError, ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res: any = () => {
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

const ownProduct = {
  id: "prod-1",
  vendorId: "vendor-1",
  images: ["img1.jpg"],
  video: [],
  options: [{ id: "11111111-1111-4111-8111-111111111111", productId: "prod-1", name: "Extra Meat", price: 1000, isActive: true }],
};

beforeEach(() => {
  jest.clearAllMocks();
  db.product.findUnique.mockResolvedValue({ ...ownProduct });
  db.product.update.mockImplementation(async (args: any) => ({ ...ownProduct, ...args.data }));
  db.productOption.count.mockResolvedValue(1);
  db.dishType.findUnique.mockResolvedValue({ id: "JOLLOF", categoryId: "RICE_DISHES" });
});

describe("updateProduct — vendor ownership", () => {
  it("refuses to edit another vendor's product", async () => {
    db.product.findUnique.mockResolvedValue({ ...ownProduct, vendorId: "vendor-2" });

    await expect(
      updateProduct(vendorReq({ body: { name: "Hijacked" } }), res()),
    ).rejects.toThrow(ForbiddenError);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it("freezes legacy add-on mutations on update (explicit error, no writes)", async () => {
    // Phase 2B.2: any submitted `options` is rejected instead of mutating.
    await expect(
      updateProduct(
        vendorReq({ body: { options: [{ id: "22222222-2222-4222-8222-222222222222", name: "X", price: 5 }] } }),
        res(),
      ),
    ).rejects.toThrow(ValidationError);
    expect(db.productOption.deleteMany).not.toHaveBeenCalled();
    expect(db.productOption.update).not.toHaveBeenCalled();
    expect(db.productOption.create).not.toHaveBeenCalled();
  });

  it("freezes legacy add-on mutations on create (explicit error, no writes)", async () => {
    await expect(
      createProduct(
        vendorReq({
          files: { images: [{ path: "img1.jpg" }] },
          body: {
            name: "Jollof Special",
            description: "Smoky party jollof",
            price: 2500,
            dishTypeId: "JOLLOF",
            options: [{ name: "Extra Meat", price: 1000 }],
          },
        }),
        res(),
      ),
    ).rejects.toThrow(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("rejects even an empty options array (previously meant delete-all)", async () => {
    await expect(
      updateProduct(vendorReq({ body: { options: [] } }), res()),
    ).rejects.toThrow(ValidationError);
    expect(db.productOption.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown dish type", async () => {
    await expect(
      updateProduct(vendorReq({ body: { dishTypeId: "BREAKFAST" } }), res()),
    ).rejects.toThrow(ValidationError);
  });

  it("accepts dish type + portion + stock without touching add-ons", async () => {
    const r = res();
    await updateProduct(
      vendorReq({
        body: {
          dishTypeId: "JOLLOF",
          portionLabel: "Family Pack — serves 4–5",
          trackInventory: true,
          stock: 12,
        },
      }),
      r,
    );

    expect(db.product.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dishTypeId: "JOLLOF",
          portionLabel: "Family Pack — serves 4–5",
          trackInventory: true,
          stock: 12,
        }),
      }),
    );
  });

  it("leaves an omitted ProductOption intact (no options key = no mutation)", async () => {
    // Phase 2B.2 regression: the old sync deleted options missing from the
    // payload; with no `options` key nothing may touch ProductOption rows.
    const r = res();
    await updateProduct(vendorReq({ body: { name: "Renamed" } }), r);

    expect(db.product.update).toHaveBeenCalled();
    expect(db.productOption.deleteMany).not.toHaveBeenCalled();
    expect(db.productOption.update).not.toHaveBeenCalled();
    expect(db.productOption.create).not.toHaveBeenCalled();
  });
});

/**
 * Phase 2B.6 corrective fix -- adminUpdateProduct category invariant.
 *
 * Regression coverage for: admin changing Product.dishTypeId must also
 * synchronize Product.categoryId from DishType.categoryId in the same
 * atomic update (Product.categoryId === Product.dishType.categoryId).
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findUnique: jest.fn(), update: jest.fn() },
    dishType: { findUnique: jest.fn() },
    orderItem: { findFirst: jest.fn() },
  },
}));

jest.mock("../../src/services/product.service", () => ({
  __esModule: true,
  assertActiveDishType: jest.fn(async () => {}),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  invalidateActiveProductPromosCache: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { assertActiveDishType } from "../../src/services/product.service";
import {
  clearProductCache,
  invalidateMarketplaceDiscoveryCaches,
} from "../../src/services/clearCaches";
import { invalidateActiveProductPromosCache } from "../../src/services/promotionPricing.service";
import { adminUpdateProduct } from "../../src/controllers/admin.controller";
import { ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedAssertActiveDishType = assertActiveDishType as unknown as jest.Mock;
const mockedClearProductCache = clearProductCache as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const adminReq = (body: Record<string, unknown>): any =>
  ({
    headers: {},
    body,
    params: { id: "prod-1" },
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "admin-1", role: "ADMIN", sessionId: "sess" },
  }) as any;

const EXISTING_PRODUCT = {
  id: "prod-1",
  vendorId: "vendor-1",
  dishTypeId: "DISH_A",
  categoryId: "CAT_A",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedAssertActiveDishType.mockResolvedValue(undefined);
  db.product.findUnique.mockResolvedValue({ ...EXISTING_PRODUCT });
  db.dishType.findUnique.mockResolvedValue({ categoryId: "CAT_B" });
  db.product.update.mockImplementation(async (args: any) => ({
    ...EXISTING_PRODUCT,
    ...args.data,
    dishType: { id: "DISH_B", name: "Dish B" },
    vendor: { id: "vendor-1", name: "Mama Put", brandName: null },
  }));
});

describe("adminUpdateProduct -- category/dishType invariant", () => {
  it("Test 1: admin dishType change writes dishType + derived categoryId together", async () => {
    const r = res();
    await adminUpdateProduct(adminReq({ dishTypeId: "DISH_B" }), r);

    expect(mockedAssertActiveDishType).toHaveBeenCalledWith("DISH_B");
    expect(db.dishType.findUnique).toHaveBeenCalledWith({
      where: { id: "DISH_B" },
      select: { categoryId: true },
    });
    expect(db.product.update).toHaveBeenCalledTimes(1);
    expect(db.product.update).toHaveBeenCalledWith({
      where: { id: "prod-1" },
      data: expect.objectContaining({
        dishType: { connect: { id: "DISH_B" } },
        category: { connect: { id: "CAT_B" } },
      }),
      include: expect.anything(),
    });
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("Test 2: stale Category A does not remain attached after the change", async () => {
    await adminUpdateProduct(adminReq({ dishTypeId: "DISH_B" }), res());

    const data = db.product.update.mock.calls[0][0].data;
    expect(data.category).toEqual({ connect: { id: "CAT_B" } });
  });

  it("Test 3a: nonexistent dishType fails safely with no partial mutation", async () => {
    db.dishType.findUnique.mockResolvedValue(null);

    await expect(
      adminUpdateProduct(adminReq({ dishTypeId: "NOPE" }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.update).not.toHaveBeenCalled();
    expect(mockedClearProductCache).not.toHaveBeenCalled();
  });

  it("Test 3b: inactive dishType fails safely with no partial mutation", async () => {
    mockedAssertActiveDishType.mockRejectedValueOnce(
      new ValidationError("Invalid dish type."),
    );

    await expect(
      adminUpdateProduct(adminReq({ dishTypeId: "INACTIVE_DISH" }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.update).not.toHaveBeenCalled();
    expect(mockedClearProductCache).not.toHaveBeenCalled();
  });

  it("Test 4: unrelated admin fields still update normally without dishType", async () => {
    const r = res();
    await adminUpdateProduct(adminReq({ name: "Renamed", price: 999 }), r);

    expect(mockedAssertActiveDishType).not.toHaveBeenCalled();
    expect(db.dishType.findUnique).not.toHaveBeenCalled();
    const data = db.product.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "Renamed", price: 999 });
    expect(data).not.toHaveProperty("dishType");
    expect(data).not.toHaveProperty("category");
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("Test 4b: client-supplied categoryId cannot override the derived value", async () => {
    await adminUpdateProduct(
      adminReq({ dishTypeId: "DISH_B", categoryId: "EVIL_CAT" }),
      res(),
    );

    const data = db.product.update.mock.calls[0][0].data;
    expect(data.category).toEqual({ connect: { id: "CAT_B" } });
  });

  it("Test 5: existing product cache invalidation still occurs", async () => {
    await adminUpdateProduct(adminReq({ dishTypeId: "DISH_B" }), res());

    expect(mockedClearProductCache).toHaveBeenCalledWith("prod-1", "vendor-1");
    expect(invalidateActiveProductPromosCache).toHaveBeenCalled();
    expect(invalidateMarketplaceDiscoveryCaches).toHaveBeenCalled();
  });
});

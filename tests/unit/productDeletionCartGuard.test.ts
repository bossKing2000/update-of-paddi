/**
 * R-1 / R-2 — product hard-deletion must never destroy live customer carts.
 *
 * Drives the REAL vendor (`productController.deleteProduct`) and admin
 * (`admin.controller.adminDeleteProduct`) handlers with mocked Prisma/Redis.
 *
 * What is proven here (application behavior only):
 *   1. vendor delete refuses a product referenced by CartItem -> 409
 *   2. vendor delete still refuses order history BEFORE looking at carts
 *   3. vendor ownership and VENDOR-role checks run before any reference check
 *   4. admin delete refuses a product referenced by CartItem -> 409
 *   5. admin delete still refuses order history BEFORE looking at carts
 *   6. the real RESTRICT race (PostgreSQL 23001, which Prisma 6 reports as a
 *      PrismaClientUnknownRequestError) maps to the same 409, as does a P2003
 *      naming the protected cart/order FK
 *   7. unrelated database errors — including unrelated RESTRICT and P2003
 *      constraints — are NOT disguised as cart conflicts
 *   8. rejected deletions never invalidate caches or write an audit record
 *   9. successful deletions delete first, then invalidate product + cart caches
 *
 * The database `RESTRICT` backstop itself is applied by a migration and is
 * NOT exercised here; that requires PostgreSQL (integration-only, not run).
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findUnique: jest.fn(), delete: jest.fn() },
    orderItem: { findFirst: jest.fn() },
    cartItem: { findFirst: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => {
  const client = () => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    ping: jest.fn(),
  });
  return {
    __esModule: true,
    redisNotifications: client(),
    redisProducts: client(),
    redisSearch: client(),
    redisTotalViews: client(),
    redisUsersSessions: client(),
    ShopCartRedis: client(),
    redisPayments: client(),
    connectRedis: jest.fn(),
    ensureRedisReady: jest.fn(),
  };
});

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
  clearCategoryCache: jest.fn(async () => {}),
  clearDishTypeCache: jest.fn(async () => {}),
  clearTagCache: jest.fn(async () => {}),
  invalidateProductsByDishTypeCategoryChange: jest.fn(async () => {}),
}));

jest.mock("../../src/services/product.service", () => ({
  __esModule: true,
  clearProductFromCarts: jest.fn(async () => {}),
  assertActiveDishType: jest.fn(async () => {}),
  trackProductView: jest.fn(async () => {}),
  fetchProductPage: jest.fn(),
  fetchMostPopularProducts: jest.fn(),
  fetchNewProducts: jest.fn(),
  getActiveDishTypes: jest.fn(async () => []),
  CATALOG_SORT_VALUES: ["popularity", "priceAsc", "priceDesc", "newest", "rating"],
}));

jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  invalidateActiveProductPromosCache: jest.fn(async () => {}),
  loadActiveProductPromos: jest.fn(async () => []),
  attachPromotions: jest.fn((items: unknown[]) => items),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => {}),
}));

import { Prisma } from "@prisma/client";
import prisma from "../../src/lib/prisma";
import { deleteProduct } from "../../src/controllers/productController";
import { adminDeleteProduct } from "../../src/controllers/admin.controller";
import { clearProductCache } from "../../src/services/clearCaches";
import { clearProductFromCarts } from "../../src/services/product.service";
import { invalidateActiveProductPromosCache } from "../../src/services/promotionPricing.service";
import { createAuditLog } from "../../src/utils/auditLog.service";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedClearProductCache = clearProductCache as unknown as jest.Mock;
const mockedClearProductFromCarts = clearProductFromCarts as unknown as jest.Mock;
const mockedInvalidatePromos = invalidateActiveProductPromosCache as unknown as jest.Mock;
const mockedCreateAuditLog = createAuditLog as unknown as jest.Mock;

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

const adminReq = (overrides: Partial<any> = {}): any =>
  ({
    headers: {},
    body: {},
    params: { id: "prod-1" },
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "admin-1", role: "ADMIN", sessionId: "sess" },
    ...overrides,
  }) as any;

const PRODUCT = {
  id: "prod-1",
  vendorId: "vendor-1",
  images: [],
  video: [],
};

/**
 * The real race error: PostgreSQL's `ON DELETE RESTRICT` violation.
 * Prisma 6.19.2 reports it as PrismaClientUnknownRequestError with a null
 * code; SQLSTATE 23001 and the constraint name survive only in the rendered
 * engine message (shape captured against prisma@6.19.2 + PostgreSQL 18.6).
 */
function restrictViolation(constraint: string) {
  const message =
    "Invalid `prisma.product.delete()` invocation in\n" +
    "src/controllers/productController.ts\n\n" +
    "Error occurred during query execution:\n" +
    "ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(" +
    'PostgresError { code: "23001", message: "update or delete on table \\"Product\\" ' +
    "violates RESTRICT setting of foreign key constraint " +
    `\\"${constraint}\\" on table \\"CartItem\\"", severity: "ERROR", ` +
    'detail: None, column: None, hint: None }), transient: false })';
  return new Prisma.PrismaClientUnknownRequestError(message, {
    clientVersion: "test",
  });
}

/**
 * A structured P2003 naming the violated constraint (NO ACTION rendering).
 * The message carries the constraint after a backtick; meta carries it too.
 */
function p2003(constraint: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `Foreign key constraint violated on the constraint: \`${constraint}\``,
    {
      code: "P2003",
      clientVersion: "test",
      meta: { modelName: "CartItem", field_name: constraint },
    },
  );
}

function expectNoInvalidation() {
  expect(mockedClearProductCache).not.toHaveBeenCalled();
  expect(mockedClearProductFromCarts).not.toHaveBeenCalled();
  expect(mockedInvalidatePromos).not.toHaveBeenCalled();
  expect(mockedCreateAuditLog).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  db.product.findUnique.mockResolvedValue({ ...PRODUCT });
  db.product.delete.mockImplementation(async (args: any) => ({ id: args.where.id }));
  db.orderItem.findFirst.mockResolvedValue(null);
  db.cartItem.findFirst.mockResolvedValue(null);
});

describe("vendor product deletion — cart guard", () => {
  it("1. refuses a product in a customer cart with 409 and never deletes", async () => {
    db.cartItem.findFirst.mockResolvedValue({ id: "cart-item-1" });

    const err = await deleteProduct(vendorReq(), res()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/cart/i);
    expect((err as Error).message).not.toMatch(/customerId|customer id|rows?|count/i);

    expect(db.cartItem.findFirst).toHaveBeenCalledWith({
      where: { productId: "prod-1" },
      select: { id: true },
    });
    expect(db.product.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("2. keeps the order-history guard FIRST and unchanged", async () => {
    db.orderItem.findFirst.mockResolvedValue({ id: "order-item-1" });

    const err = await deleteProduct(vendorReq(), res()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/order history/i);

    expect(db.orderItem.findFirst).toHaveBeenCalledWith({
      where: { productId: "prod-1" },
      select: { id: true },
    });
    // The cart probe must not even run when history already decided the outcome.
    expect(db.cartItem.findFirst).not.toHaveBeenCalled();
    expect(db.product.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("3. refuses another vendor's product before any reference check", async () => {
    db.product.findUnique.mockResolvedValue({ ...PRODUCT, vendorId: "vendor-2" });

    const err = await deleteProduct(vendorReq(), res()).catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(db.orderItem.findFirst).not.toHaveBeenCalled();
    expect(db.cartItem.findFirst).not.toHaveBeenCalled();
    expect(db.product.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("3b. refuses a non-VENDOR caller before touching the database", async () => {
    const err = await deleteProduct(
      vendorReq({ user: { id: "cust-1", role: "CUSTOMER", sessionId: "sess" } }),
      res(),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(db.product.findUnique).not.toHaveBeenCalled();
    expect(db.product.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("4. maps the real RESTRICT race (PostgreSQL 23001) to 409 without leaking SQL internals", async () => {
    db.product.delete.mockRejectedValueOnce(restrictViolation("CartItem_productId_fkey"));

    const err = await deleteProduct(vendorReq(), res()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/orders or customer carts/i);
    expect((err as Error).message).not.toMatch(
      /prisma|23001|FOREIGN KEY|constraint violated|CartItem_productId_fkey/i,
    );
    expectNoInvalidation();
  });

  it("4b. maps a P2003 that names the protected cart/order FK to the same 409", async () => {
    db.product.delete.mockRejectedValueOnce(p2003("CartItem_productId_fkey"));

    const err = await deleteProduct(vendorReq(), res()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/orders or customer carts/i);
    expect((err as Error).message).not.toMatch(/P2003|constraint violated/i);
    expectNoInvalidation();
  });

  it("4c. does not relabel an unrelated RESTRICT violation as a cart conflict", async () => {
    const unrelated = restrictViolation("SomeOtherTable_someId_fkey");
    db.product.delete.mockRejectedValueOnce(unrelated);

    await expect(deleteProduct(vendorReq(), res())).rejects.toBe(unrelated);
    expectNoInvalidation();
  });

  it("4d. does not relabel an unrelated P2003 constraint as a cart conflict", async () => {
    const unrelated = p2003("UnrelatedTable_unrelatedId_fkey");
    db.product.delete.mockRejectedValueOnce(unrelated);

    await expect(deleteProduct(vendorReq(), res())).rejects.toBe(unrelated);
    expectNoInvalidation();
  });

  it("5. propagates an unrelated database failure unchanged and invalidates nothing", async () => {
    const boom = new Error("connection reset");
    db.product.delete.mockRejectedValueOnce(boom);

    await expect(deleteProduct(vendorReq(), res())).rejects.toBe(boom);
    expectNoInvalidation();
  });

  it("6. deletes an unreferenced product, then invalidates product and cart caches", async () => {
    const r = res();

    await deleteProduct(vendorReq(), r);

    expect(db.product.delete).toHaveBeenCalledWith({ where: { id: "prod-1" } });
    expect(mockedClearProductCache).toHaveBeenCalledWith("prod-1", "vendor-1");
    expect(mockedClearProductFromCarts).toHaveBeenCalledWith("prod-1");

    const deleteOrder = db.product.delete.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(mockedClearProductCache.mock.invocationCallOrder[0]);
    expect(deleteOrder).toBeLessThan(mockedClearProductFromCarts.mock.invocationCallOrder[0]);
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

describe("admin product deletion — cart guard", () => {
  it("7. refuses a product in a customer cart with 409 and never deletes", async () => {
    db.cartItem.findFirst.mockResolvedValue({ id: "cart-item-1" });

    const err = await adminDeleteProduct(adminReq(), res()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/cart/i);
    expect((err as Error).message).not.toMatch(/customerId|customer id|rows?|count/i);

    expect(db.cartItem.findFirst).toHaveBeenCalledWith({
      where: { productId: "prod-1" },
      select: { id: true },
    });
    expect(db.product.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("8. keeps the order-history guard FIRST and unchanged", async () => {
    db.orderItem.findFirst.mockResolvedValue({ id: "order-item-1" });

    const err = await adminDeleteProduct(adminReq(), res()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/order history/i);

    expect(db.orderItem.findFirst).toHaveBeenCalledWith({ where: { productId: "prod-1" } });
    expect(db.cartItem.findFirst).not.toHaveBeenCalled();
    expect(db.product.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("9. returns 404 for a missing product before any reference check", async () => {
    db.product.findUnique.mockResolvedValue(null);

    await expect(adminDeleteProduct(adminReq(), res())).rejects.toBeInstanceOf(NotFoundError);
    expect(db.orderItem.findFirst).not.toHaveBeenCalled();
    expect(db.cartItem.findFirst).not.toHaveBeenCalled();
    expect(db.product.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("10. maps the real RESTRICT race (PostgreSQL 23001) to 409 without leaking SQL internals", async () => {
    db.product.delete.mockRejectedValueOnce(restrictViolation("CartItem_productId_fkey"));

    const err = await adminDeleteProduct(adminReq(), res()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/orders or customer carts/i);
    expect((err as Error).message).not.toMatch(
      /prisma|23001|FOREIGN KEY|constraint violated|CartItem_productId_fkey/i,
    );
    expectNoInvalidation();
  });

  it("10b. maps a P2003 that names the protected cart/order FK to the same 409", async () => {
    db.product.delete.mockRejectedValueOnce(p2003("OrderItem_productId_fkey"));

    const err = await adminDeleteProduct(adminReq(), res()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/orders or customer carts/i);
    expect((err as Error).message).not.toMatch(/P2003|constraint violated/i);
    expectNoInvalidation();
  });

  it("10c. does not relabel an unrelated RESTRICT violation as a cart conflict", async () => {
    const unrelated = restrictViolation("SomeOtherTable_someId_fkey");
    db.product.delete.mockRejectedValueOnce(unrelated);

    await expect(adminDeleteProduct(adminReq(), res())).rejects.toBe(unrelated);
    expectNoInvalidation();
  });

  it("10d. does not relabel an unrelated P2003 constraint as a cart conflict", async () => {
    const unrelated = p2003("UnrelatedTable_unrelatedId_fkey");
    db.product.delete.mockRejectedValueOnce(unrelated);

    await expect(adminDeleteProduct(adminReq(), res())).rejects.toBe(unrelated);
    expectNoInvalidation();
  });

  it("11. propagates an unrelated database failure unchanged and invalidates nothing", async () => {
    const boom = new Error("connection reset");
    db.product.delete.mockRejectedValueOnce(boom);

    await expect(adminDeleteProduct(adminReq(), res())).rejects.toBe(boom);
    expectNoInvalidation();
  });

  it("12. deletes an unreferenced product, then sweeps the right caches and audits", async () => {
    const r = res();

    await adminDeleteProduct(adminReq(), r);

    expect(db.product.delete).toHaveBeenCalledWith({ where: { id: "prod-1" } });
    expect(mockedClearProductCache).toHaveBeenCalledWith("prod-1", "vendor-1");
    expect(mockedClearProductFromCarts).toHaveBeenCalledWith("prod-1");
    expect(mockedInvalidatePromos).toHaveBeenCalled();
    expect(mockedCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "ADMIN_DELETED_PRODUCT",
        metadata: { productId: "prod-1" },
      }),
    );

    const deleteOrder = db.product.delete.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(mockedClearProductCache.mock.invocationCallOrder[0]);
    expect(deleteOrder).toBeLessThan(mockedClearProductFromCarts.mock.invocationCallOrder[0]);
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

/**
 * Phase 3.1.1 + R-1 — deletion protection for historical orders AND live carts.
 *
 * Drives the REAL optionGroup.service delete paths with mocked Prisma only:
 *   1. option item referenced by OrderItemOption rows -> 409, delete never runs
 *   2. option item selected in a CartItemOption row -> 409, delete never runs
 *   3. option group referenced via its items by an order -> 409
 *   4. option group with an item selected in a cart -> 409
 *   5. the real RESTRICT race (PostgreSQL 23001, which Prisma 6 reports as a
 *      PrismaClientUnknownRequestError) and a protected-FK P2003 between a
 *      pre-check and the delete -> same 409, no SQL leaked
 *   6. unreferenced item/group -> deletes normally, then invalidates caches
 *   7. rejected deletions never invalidate product or cart caches
 *   8. ownership checks unchanged (wrong vendor -> 403)
 *   9. source proofs: product vendor/admin delete guards, route middleware and
 *      the schema Restrict backstops (behavioral DB proof lives in the
 *      integration suite, which needs PostgreSQL and is NOT run here)
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    optionGroup: { findUnique: jest.fn(), delete: jest.fn() },
    optionGroupItem: { findUnique: jest.fn(), delete: jest.fn() },
    orderItemOption: { findFirst: jest.fn() },
    cartItemOption: { findFirst: jest.fn() },
  },
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
}));

jest.mock("../../src/services/product.service", () => ({
  __esModule: true,
  clearProductFromCarts: jest.fn(async () => {}),
}));

import fs from "fs";
import { Prisma } from "@prisma/client";
import prisma from "../../src/lib/prisma";
import { ConflictError, ForbiddenError } from "../../src/errors/AppError";
import { clearProductCache } from "../../src/services/clearCaches";
import { clearProductFromCarts } from "../../src/services/product.service";
import { deleteOptionGroup, deleteOptionGroupItem } from "../../src/services/optionGroup.service";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedClearProductCache = clearProductCache as unknown as jest.Mock;
const mockedClearProductFromCarts = clearProductFromCarts as unknown as jest.Mock;

const OWN_GROUP = {
  id: "group-1",
  productId: "prod-1",
  product: { id: "prod-1", vendorId: "vendor-1" },
};
const OWN_ITEM = {
  id: "item-1",
  optionGroupId: "group-1",
  optionGroup: { id: "group-1", productId: "prod-1", product: { id: "prod-1", vendorId: "vendor-1" } },
};

/**
 * The real race error: PostgreSQL's `ON DELETE RESTRICT` violation.
 * Prisma 6.19.2 reports it as PrismaClientUnknownRequestError with a null
 * code; SQLSTATE 23001 and the constraint name survive only in the rendered
 * engine message (shape captured against prisma@6.19.2 + PostgreSQL 18.6).
 */
function restrictViolation(constraint: string) {
  const message =
    "Invalid `prisma.optionGroupItem.delete()` invocation in\n" +
    "src/services/optionGroup.service.ts\n\n" +
    "Error occurred during query execution:\n" +
    "ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(" +
    'PostgresError { code: "23001", message: "update or delete on table \\"OptionGroupItem\\" ' +
    "violates RESTRICT setting of foreign key constraint " +
    `\\"${constraint}\\" on table \\"CartItemOption\\"", severity: "ERROR", ` +
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
      meta: { modelName: "CartItemOption", field_name: constraint },
    },
  );
}

function expectNoInvalidation() {
  expect(mockedClearProductCache).not.toHaveBeenCalled();
  expect(mockedClearProductFromCarts).not.toHaveBeenCalled();
}

function expectCachesClearedAfterDelete(
  deleteMock: jest.Mock,
  productId: string,
  vendorId: string,
) {
  expect(deleteMock).toHaveBeenCalledTimes(1);
  expect(mockedClearProductCache).toHaveBeenCalledWith(productId, vendorId);
  expect(mockedClearProductFromCarts).toHaveBeenCalledWith(productId);

  const deleteOrder = deleteMock.mock.invocationCallOrder[0];
  const productCacheOrder = mockedClearProductCache.mock.invocationCallOrder[0];
  const cartCacheOrder = mockedClearProductFromCarts.mock.invocationCallOrder[0];
  expect(deleteOrder).toBeLessThan(productCacheOrder);
  expect(deleteOrder).toBeLessThan(cartCacheOrder);
}

beforeEach(() => {
  jest.clearAllMocks();
  db.optionGroup.findUnique.mockResolvedValue({ ...OWN_GROUP });
  db.optionGroup.delete.mockImplementation(async (a: any) => ({ id: a.where.id }));
  db.optionGroupItem.findUnique.mockResolvedValue({ ...OWN_ITEM });
  db.optionGroupItem.delete.mockImplementation(async (a: any) => ({ id: a.where.id }));
  db.orderItemOption.findFirst.mockResolvedValue(null);
  db.cartItemOption.findFirst.mockResolvedValue(null);
});

describe("option-item deletion guard", () => {
  it("1. order-referenced item is rejected with 409 and never deleted", async () => {
    db.orderItemOption.findFirst.mockResolvedValue({ id: "oio-1" });

    const err = await deleteOptionGroupItem("vendor-1", "item-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect(db.optionGroupItem.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("2. cart-selected item is rejected with 409 and never deleted", async () => {
    db.cartItemOption.findFirst.mockResolvedValue({ id: "cio-1" });

    const err = await deleteOptionGroupItem("vendor-1", "item-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/cart/i);
    expect((err as Error).message).not.toMatch(/customerId|customer id|rows?|count/i);

    expect(db.cartItemOption.findFirst).toHaveBeenCalledWith({
      where: { optionGroupItemId: "item-1" },
      select: { id: true },
    });
    expect(db.optionGroupItem.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("3. maps the real RESTRICT race (PostgreSQL 23001) to the same 409", async () => {
    db.optionGroupItem.delete.mockRejectedValueOnce(
      restrictViolation("CartItemOption_optionGroupItemId_fkey"),
    );

    const err = await deleteOptionGroupItem("vendor-1", "item-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/orders or customer carts/i);
    expect((err as Error).message).not.toMatch(
      /prisma|23001|FOREIGN KEY|constraint violated|CartItemOption_optionGroupItemId_fkey/i,
    );
    expectNoInvalidation();
  });

  it("3b. maps a P2003 that names the protected option FK to the same 409", async () => {
    db.optionGroupItem.delete.mockRejectedValueOnce(
      p2003("CartItemOption_optionGroupItemId_fkey"),
    );

    const err = await deleteOptionGroupItem("vendor-1", "item-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).not.toMatch(/P2003|constraint violated/i);
    expectNoInvalidation();
  });

  it("3c. does not relabel unrelated RESTRICT/P2003 failures as option conflicts", async () => {
    const unrelatedRestrict = restrictViolation("SomeOtherTable_someId_fkey");
    db.optionGroupItem.delete.mockRejectedValueOnce(unrelatedRestrict);
    await expect(deleteOptionGroupItem("vendor-1", "item-1")).rejects.toBe(unrelatedRestrict);
    expectNoInvalidation();

    const unrelatedP2003 = p2003("UnrelatedTable_unrelatedId_fkey");
    db.optionGroupItem.delete.mockRejectedValueOnce(unrelatedP2003);
    await expect(deleteOptionGroupItem("vendor-1", "item-1")).rejects.toBe(unrelatedP2003);
    expectNoInvalidation();
  });

  it("4. unreferenced item deletes normally, then invalidates product and cart caches", async () => {
    const result = await deleteOptionGroupItem("vendor-1", "item-1");
    expect(result).toEqual({ id: "item-1" });
    expect(db.optionGroupItem.delete).toHaveBeenCalledWith({ where: { id: "item-1" } });
    expectCachesClearedAfterDelete(db.optionGroupItem.delete, "prod-1", "vendor-1");
  });

  it("5. ownership check runs before the history and cart checks", async () => {
    db.optionGroupItem.findUnique.mockResolvedValue({
      ...OWN_ITEM,
      optionGroup: { ...OWN_ITEM.optionGroup, product: { id: "prod-1", vendorId: "someone-else" } },
    });

    const err = await deleteOptionGroupItem("vendor-1", "item-1").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(db.orderItemOption.findFirst).not.toHaveBeenCalled();
    expect(db.cartItemOption.findFirst).not.toHaveBeenCalled();
    expect(db.optionGroupItem.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });
});

describe("option-group deletion guard", () => {
  it("6. group with order-referenced items is rejected with 409 and never deleted", async () => {
    db.orderItemOption.findFirst.mockResolvedValue({ id: "oio-9" });

    const err = await deleteOptionGroup("vendor-1", "group-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    // The reference lookup scopes through the group's items.
    expect(db.orderItemOption.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { optionGroupItem: { optionGroupId: "group-1" } } }),
    );
    expect(db.optionGroup.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("7. group whose item is selected in a cart is rejected with 409 and never deleted", async () => {
    db.cartItemOption.findFirst.mockResolvedValue({ id: "cio-9" });

    const err = await deleteOptionGroup("vendor-1", "group-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/cart/i);
    expect((err as Error).message).not.toMatch(/customerId|customer id|rows?|count/i);

    expect(db.cartItemOption.findFirst).toHaveBeenCalledWith({
      where: { optionGroupItem: { optionGroupId: "group-1" } },
      select: { id: true },
    });
    expect(db.optionGroup.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });

  it("8. maps the real RESTRICT race (PostgreSQL 23001) to the same 409", async () => {
    db.optionGroup.delete.mockRejectedValueOnce(
      restrictViolation("CartItemOption_optionGroupItemId_fkey"),
    );

    const err = await deleteOptionGroup("vendor-1", "group-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/orders or customer carts/i);
    expect((err as Error).message).not.toMatch(
      /prisma|23001|FOREIGN KEY|constraint violated|CartItemOption_optionGroupItemId_fkey/i,
    );
    expectNoInvalidation();
  });

  it("8b. maps a P2003 that names the protected option FK to the same 409", async () => {
    db.optionGroup.delete.mockRejectedValueOnce(
      p2003("OrderItemOption_optionGroupItemId_fkey"),
    );

    const err = await deleteOptionGroup("vendor-1", "group-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).not.toMatch(/P2003|constraint violated/i);
    expectNoInvalidation();
  });

  it("8c. does not relabel unrelated RESTRICT/P2003 failures as group conflicts", async () => {
    const unrelatedRestrict = restrictViolation("SomeOtherTable_someId_fkey");
    db.optionGroup.delete.mockRejectedValueOnce(unrelatedRestrict);
    await expect(deleteOptionGroup("vendor-1", "group-1")).rejects.toBe(unrelatedRestrict);
    expectNoInvalidation();

    const unrelatedP2003 = p2003("UnrelatedTable_unrelatedId_fkey");
    db.optionGroup.delete.mockRejectedValueOnce(unrelatedP2003);
    await expect(deleteOptionGroup("vendor-1", "group-1")).rejects.toBe(unrelatedP2003);
    expectNoInvalidation();
  });

  it("9. unreferenced group deletes normally, then invalidates product and cart caches", async () => {
    const result = await deleteOptionGroup("vendor-1", "group-1");
    expect(result).toEqual({ id: "group-1" });
    expect(db.optionGroup.delete).toHaveBeenCalledWith({ where: { id: "group-1" } });
    expectCachesClearedAfterDelete(db.optionGroup.delete, "prod-1", "vendor-1");
  });

  it("10. ownership check runs before the history and cart checks", async () => {
    db.optionGroup.findUnique.mockResolvedValue({
      ...OWN_GROUP,
      product: { id: "prod-1", vendorId: "someone-else" },
    });

    const err = await deleteOptionGroup("vendor-1", "group-1").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(db.orderItemOption.findFirst).not.toHaveBeenCalled();
    expect(db.cartItemOption.findFirst).not.toHaveBeenCalled();
    expect(db.optionGroup.delete).not.toHaveBeenCalled();
    expectNoInvalidation();
  });
});

describe("existing guards preserved (source proof — behavioral DB proof is integration-only)", () => {
  const productSrc = fs.readFileSync("src/controllers/productController.ts", "utf8");
  const adminSrc = fs.readFileSync("src/controllers/admin.controller.ts", "utf8");
  const productRoutes = fs.readFileSync("src/routes/productRoutes.ts", "utf8");
  const adminRoutes = fs.readFileSync("src/routes/admin.routes.ts", "utf8");
  const schema = fs.readFileSync("prisma/schema.prisma", "utf8");

  it("11. vendor product delete refuses order history and cart references before deleting", () => {
    const fn = productSrc.slice(productSrc.indexOf("export const deleteProduct"));
    expect(fn).toContain("prisma.orderItem.findFirst");
    expect(fn).toContain("prisma.cartItem.findFirst");
    expect(fn).toContain("ConflictError");
    expect(fn.indexOf("prisma.orderItem.findFirst")).toBeLessThan(fn.indexOf("prisma.product.delete"));
    expect(fn.indexOf("prisma.cartItem.findFirst")).toBeLessThan(fn.indexOf("prisma.product.delete"));
  });

  it("12. admin product delete refuses order history and cart references before deleting", () => {
    const fn = adminSrc.slice(adminSrc.indexOf("export const adminDeleteProduct"));
    expect(fn).toContain("prisma.orderItem.findFirst");
    expect(fn).toContain("prisma.cartItem.findFirst");
    expect(fn).toContain("ConflictError");
    expect(fn.indexOf("prisma.orderItem.findFirst")).toBeLessThan(fn.indexOf("prisma.product.delete"));
    expect(fn.indexOf("prisma.cartItem.findFirst")).toBeLessThan(fn.indexOf("prisma.product.delete"));
  });

  it("13. deletion routes still require vendor suspension/admin authorization middleware", () => {
    expect(productRoutes).toContain(
      'router.delete("/:id", authenticate, authorizeVendor, requireVendorNotSuspended, deleteProduct);',
    );
    expect(adminRoutes).toContain("router.use(authenticate);");
    expect(adminRoutes).toContain("router.use(authorizeAdmin);");
    expect(adminRoutes).toContain('router.delete("/products/:id", adminDeleteProduct);');
  });

  it("14. schema pins Restrict on the six financial-history relations and the two cart relations", () => {
    // Order -> User (both sides), OrderItem -> Product, legacy
    // OrderItemOption -> ProductOption, RiderWithdrawal -> DeliveryPerson,
    // Order -> VendorPayout. Other Cascade relations (catalog, sessions,
    // legacy cart ProductOption) are intentionally out of scope.
    expect(schema).toContain('"CustomerOrders", fields: [customerId], references: [id], onDelete: Restrict');
    expect(schema).toContain('"VendorOrders", fields: [vendorId], references: [id], onDelete: Restrict');
    expect(schema).toContain("fields: [optionId], references: [id], onDelete: Restrict");
    expect(schema).toContain("fields: [deliveryPersonId], references: [id], onDelete: Restrict");
    expect(schema).toContain("fields: [payoutId], references: [id], onDelete: Restrict");

    // The two cart backstops added by R-1/R-2.
    expect(schema).toMatch(
      /model CartItem \{[\s\S]*?product\s+Product\s+@relation\(fields: \[productId\], references: \[id\], onDelete: Restrict\)/,
    );
    expect(schema).toMatch(
      /model CartItemOption \{[\s\S]*?optionGroupItem OptionGroupItem\? @relation\(fields: \[optionGroupItemId\], references: \[id\], onDelete: Restrict\)/,
    );
  });
});

/**
 * R-1 / R-2 — the delete/cart RESTRICT race over REAL HTTP.
 *
 * The unit suites prove the controllers map the expected foreign-key errors to
 * 409 with mocked Prisma. This suite proves the same thing end to end against
 * a REAL PostgreSQL 18 database with the REAL RESTRICT constraints from
 * `20261021000001_cart_reference_restrict`, and over the REAL Express routes,
 * auth middleware and error handler:
 *
 *   DELETE /api/product/:id                    (vendor)
 *   DELETE /api/product/option-groups/:groupId (vendor)
 *   DELETE /api/product/option-items/:itemId   (vendor)
 *   DELETE /api/admin/products/:id             (admin)
 *
 * The race is reproduced honestly: the cart-reference pre-check is spied to
 * answer "not referenced" once (as it would if a cart line landed immediately
 * after the check), and the REAL delete then runs and is rejected by the REAL
 * database constraint. A pass-through spy on the delete asserts the DELETE was
 * actually attempted — so a 409 cannot be explained by the pre-check alone.
 *
 * Before this fix the same race surfaced as HTTP 500 INTERNAL_ERROR: Prisma
 * 6.19.2 reports PostgreSQL SQLSTATE 23001 (`ON DELETE RESTRICT`) as a
 * PrismaClientUnknownRequestError with `code === null`, which the old
 * `P2003`-only guards did not recognise. The temporary "mapping disabled" run
 * recorded while producing this suite demonstrates exactly that 500.
 *
 * Integrity is asserted after every rejection: the product/group/item, the
 * cart line and the selected option all still exist. No automatic cleanup of
 * customer carts is allowed.
 *
 * Fails closed unless REDIS_URL names an authorized loopback target; the
 * PostgreSQL side is validated by tests/setup/integrationPreflight.ts.
 */
import express from "express";
import request from "supertest";
import { randomUUID } from "crypto";
import type { Role } from "@prisma/client";

jest.mock("../../src/middlewares/rateLimiter.middleware", () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    authRateLimiter: passthrough,
    paymentRateLimiter: passthrough,
    checkoutRateLimiter: passthrough,
    otpRateLimiter: passthrough,
    phoneOtpRateLimiter: passthrough,
    passwordChangeRateLimiter: passthrough,
    secureResetRateLimiter: passthrough,
    cartSummaryRateLimiter: passthrough,
    aiRateLimiter: passthrough,
    emailOtpRateLimiter: passthrough,
  };
});

// productController imports this queue, which would otherwise open a BullMQ
// Redis connection. Queue side effects are not part of the deletion contract.
jest.mock("../../src/jobs/workers jobs/redis-baseQueue", () => ({
  __esModule: true,
  productIndexQueue: { add: jest.fn(async () => {}) },
}));

import prisma from "../../src/lib/prisma";
import { connectRedis, redisUsersSessions } from "../../src/lib/redis";
import { createUserSession, deleteUserSession } from "../../src/lib/session";
import { generateAccessToken } from "../../src/utils/generateToken";
import productRoutes from "../../src/routes/productRoutes";
import adminRoutes from "../../src/routes/admin.routes";
import { errorHandler } from "../../src/middlewares/error.middleware";
import { ensureTestDishType, type TestDishTypeHandle } from "../helpers/testDishType";

const REDIS_URL = process.env.REDIS_URL ?? "";
if (!/^redis:\/\/127\.0\.0\.1:\d+/.test(REDIS_URL)) {
  throw new Error(
    "[restrictDeleteRaceHttp] BLOCKED: REDIS_URL must name the authorized disposable loopback target.",
  );
}

const app = express();
app.use(express.json());
app.use("/api/product", productRoutes);
app.use("/api/admin", adminRoutes);
app.use(errorHandler);

const tag = `r12race-${process.pid}-${Date.now()}`;

const createdUserIds: string[] = [];
const createdSessions: Array<{ userId: string; sessionId: string }> = [];
const createdProductIds: string[] = [];
const createdGroupIds: string[] = [];
const createdItemIds: string[] = [];

let dishType: TestDishTypeHandle;
let categoryId = "";

let vendorToken = "";
let adminToken = "";
let customerId = "";

let cartId = "";
let cartItemVendorId = "";
let cartItemAdminId = "";
let cartItemOptionItemId = "";
let cartItemOptionGroupId = "";

let productVendorId = "";
let productAdminId = "";
let productForItemId = "";
let productForGroupId = "";

let itemId = "";
let groupId = "";
let groupItemId = "";

async function makeUser(
  role: Role,
  label: string,
  data: Record<string, unknown> = {},
): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      name: `RESTRICT race ${label}`,
      email: `${tag}-${label}-${randomUUID()}@restrict-race.test`,
      role,
      roles: [role],
      tokenVersion: 1,
      vendorStatus: role === "VENDOR" ? "ACTIVE" : null,
      ...data,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  const sessionId = randomUUID();
  await createUserSession(user.id, sessionId, {
    activeRole: role,
    ip: "127.0.0.1",
    userAgent: "restrict-delete-race-integration",
  });
  createdSessions.push({ userId: user.id, sessionId });

  return {
    id: user.id,
    token: generateAccessToken(user.id, role, sessionId, 1),
  };
}

async function makeProduct(name: string, vendorId: string): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name: `${tag} ${name}`,
      description: "RESTRICT race fixture",
      price: 1000,
      dishTypeId: dishType.dishTypeId,
      categoryId,
      vendorId,
      images: [],
      video: [],
      archived: false,
    },
    select: { id: true },
  });
  createdProductIds.push(product.id);
  return product.id;
}

async function makeGroupWithItem(
  productId: string,
  name: string,
): Promise<{ groupId: string; itemId: string }> {
  const group = await prisma.optionGroup.create({
    data: {
      productId,
      name,
      required: false,
      minSelections: 0,
      maxSelections: 1,
      sortOrder: 0,
    },
    select: { id: true },
  });
  createdGroupIds.push(group.id);

  const item = await prisma.optionGroupItem.create({
    data: {
      optionGroupId: group.id,
      name: `${name} item`,
      priceAdd: 100,
      isActive: true,
      sortOrder: 0,
    },
    select: { id: true },
  });
  createdItemIds.push(item.id);

  return { groupId: group.id, itemId: item.id };
}

function deleteRequest(path: string, token: string) {
  return request(app).delete(path).set("Authorization", `Bearer ${token}`);
}

/** Bypass the cart pre-check exactly once, simulating the race window. */
function racePastCartCheck() {
  return jest
    .spyOn(prisma.cartItem, "findFirst")
    .mockResolvedValueOnce(null as never);
}

/** Bypass the option pre-check exactly once, simulating the race window. */
function racePastOptionCheck() {
  return jest
    .spyOn(prisma.cartItemOption, "findFirst")
    .mockResolvedValueOnce(null as never);
}

beforeAll(async () => {
  await connectRedis(redisUsersSessions, "UserSessions").catch(() => undefined);

  dishType = await ensureTestDishType(prisma);
  const dish = await prisma.dishType.findUnique({
    where: { id: dishType.dishTypeId },
    select: { categoryId: true },
  });
  if (!dish) throw new Error("dish type fixture missing");
  categoryId = dish.categoryId;

  const vendor = await makeUser("VENDOR", "vendor");
  const admin = await makeUser("ADMIN", "admin");
  const customer = await makeUser("CUSTOMER", "customer");
  vendorToken = vendor.token;
  adminToken = admin.token;
  customerId = customer.id;

  productVendorId = await makeProduct("vendor-product", vendor.id);
  productAdminId = await makeProduct("admin-product", vendor.id);
  productForItemId = await makeProduct("item-product", vendor.id);
  productForGroupId = await makeProduct("group-product", vendor.id);

  const itemFixture = await makeGroupWithItem(productForItemId, "Item race extras");
  itemId = itemFixture.itemId;

  const groupFixture = await makeGroupWithItem(productForGroupId, "Group race extras");
  groupId = groupFixture.groupId;
  groupItemId = groupFixture.itemId;

  const cart = await prisma.cart.create({
    data: { customerId },
    select: { id: true },
  });
  cartId = cart.id;

  const mkCartItem = async (productId: string) => {
    const row = await prisma.cartItem.create({
      data: {
        cartId,
        productId,
        quantity: 1,
        unitPrice: 1000,
        subtotal: 1000,
      },
      select: { id: true },
    });
    return row.id;
  };

  cartItemVendorId = await mkCartItem(productVendorId);
  cartItemAdminId = await mkCartItem(productAdminId);
  cartItemOptionItemId = await mkCartItem(productForItemId);
  cartItemOptionGroupId = await mkCartItem(productForGroupId);

  const mkCartOption = async (cartItemId: string, optionGroupItemId: string) => {
    await prisma.cartItemOption.create({
      data: {
        cartItemId,
        optionGroupItemId,
        name: "Race selection",
        price: 100,
      },
    });
  };
  await mkCartOption(cartItemOptionItemId, itemId);
  await mkCartOption(cartItemOptionGroupId, groupItemId);
});

afterAll(async () => {
  await prisma.cartItemOption.deleteMany({ where: { cartItemId: { in: [cartItemOptionItemId, cartItemOptionGroupId].filter(Boolean) } } }).catch(() => undefined);
  await prisma.cartItem.deleteMany({ where: { cartId } }).catch(() => undefined);
  await prisma.cart.deleteMany({ where: { id: cartId } }).catch(() => undefined);
  await prisma.optionGroupItem.deleteMany({ where: { id: { in: createdItemIds } } }).catch(() => undefined);
  await prisma.optionGroup.deleteMany({ where: { id: { in: createdGroupIds } } }).catch(() => undefined);
  await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } }).catch(() => undefined);

  for (const { userId, sessionId } of createdSessions) {
    await deleteUserSession(userId, sessionId).catch(() => undefined);
  }
  await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);

  await dishType?.dispose().catch(() => undefined);
  await redisUsersSessions.quit().catch(() => undefined);
});

describe("R-1/R-2 RESTRICT race over real HTTP + PostgreSQL", () => {
  it("vendor product delete: a cart line landing after the check returns 409 CONFLICT and preserves both rows", async () => {
    const bypass = racePastCartCheck();
    const deleteSpy = jest.spyOn(prisma.product, "delete");
    try {
      const res = await deleteRequest(`/api/product/${productVendorId}`, vendorToken);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("CONFLICT");
      expect(res.body.message).toMatch(/orders or customer carts/i);
      expect(res.body.message).not.toMatch(/prisma|23001|constraint/i);

      // The real DELETE ran and PostgreSQL rejected it — the 409 is not the
      // pre-check in disguise.
      expect(deleteSpy).toHaveBeenCalledTimes(1);

      const [product, cartItem] = await Promise.all([
        prisma.product.findUnique({ where: { id: productVendorId }, select: { id: true } }),
        prisma.cartItem.findUnique({ where: { id: cartItemVendorId }, select: { id: true } }),
      ]);
      expect(product).not.toBeNull();
      expect(cartItem).not.toBeNull();
    } finally {
      deleteSpy.mockRestore();
      bypass.mockRestore();
    }
  });

  it("admin product delete: the same race returns 409 and preserves the cart line", async () => {
    const bypass = racePastCartCheck();
    const deleteSpy = jest.spyOn(prisma.product, "delete");
    try {
      const res = await deleteRequest(`/api/admin/products/${productAdminId}`, adminToken);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("CONFLICT");
      expect(res.body.message).toMatch(/orders or customer carts/i);
      expect(res.body.message).not.toMatch(/prisma|23001|constraint/i);
      expect(deleteSpy).toHaveBeenCalledTimes(1);

      const [product, cartItem] = await Promise.all([
        prisma.product.findUnique({ where: { id: productAdminId }, select: { id: true } }),
        prisma.cartItem.findUnique({ where: { id: cartItemAdminId }, select: { id: true } }),
      ]);
      expect(product).not.toBeNull();
      expect(cartItem).not.toBeNull();
    } finally {
      deleteSpy.mockRestore();
      bypass.mockRestore();
    }
  });

  it("option item delete: a cart selection landing after the check returns 409 and preserves the item", async () => {
    const bypass = racePastOptionCheck();
    const deleteSpy = jest.spyOn(prisma.optionGroupItem, "delete");
    try {
      const res = await deleteRequest(`/api/product/option-items/${itemId}`, vendorToken);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("CONFLICT");
      expect(res.body.message).toMatch(/orders or customer carts/i);
      expect(res.body.message).not.toMatch(/prisma|23001|constraint/i);
      expect(deleteSpy).toHaveBeenCalledTimes(1);

      const [item, selection] = await Promise.all([
        prisma.optionGroupItem.findUnique({ where: { id: itemId }, select: { id: true } }),
        prisma.cartItemOption.findFirst({
          where: { optionGroupItemId: itemId },
          select: { id: true },
        }),
      ]);
      expect(item).not.toBeNull();
      expect(selection).not.toBeNull();
    } finally {
      deleteSpy.mockRestore();
      bypass.mockRestore();
    }
  });

  it("option group delete: a cart selection on one of its items returns 409 and preserves group, item and selection", async () => {
    const bypass = racePastOptionCheck();
    const deleteSpy = jest.spyOn(prisma.optionGroup, "delete");
    try {
      const res = await deleteRequest(`/api/product/option-groups/${groupId}`, vendorToken);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("CONFLICT");
      expect(res.body.message).toMatch(/orders or customer carts/i);
      expect(res.body.message).not.toMatch(/prisma|23001|constraint/i);
      expect(deleteSpy).toHaveBeenCalledTimes(1);

      const [group, item, selection] = await Promise.all([
        prisma.optionGroup.findUnique({ where: { id: groupId }, select: { id: true } }),
        prisma.optionGroupItem.findUnique({ where: { id: groupItemId }, select: { id: true } }),
        prisma.cartItemOption.findFirst({
          where: { optionGroupItemId: groupItemId },
          select: { id: true },
        }),
      ]);
      expect(group).not.toBeNull();
      expect(item).not.toBeNull();
      expect(selection).not.toBeNull();
    } finally {
      deleteSpy.mockRestore();
      bypass.mockRestore();
    }
  });

  it("sequential pre-check path still returns the same 409 and never attempts the delete", async () => {
    const productDelete = jest.spyOn(prisma.product, "delete");
    const itemDelete = jest.spyOn(prisma.optionGroupItem, "delete");
    try {
      const productRes = await deleteRequest(`/api/product/${productVendorId}`, vendorToken);
      expect(productRes.status).toBe(409);
      expect(productRes.body.code).toBe("CONFLICT");
      expect(productRes.body.message).toMatch(/cart/i);

      const itemRes = await deleteRequest(`/api/product/option-items/${itemId}`, vendorToken);
      expect(itemRes.status).toBe(409);
      expect(itemRes.body.code).toBe("CONFLICT");
      expect(itemRes.body.message).toMatch(/cart/i);

      expect(productDelete).not.toHaveBeenCalled();
      expect(itemDelete).not.toHaveBeenCalled();
    } finally {
      itemDelete.mockRestore();
      productDelete.mockRestore();
    }
  });
});

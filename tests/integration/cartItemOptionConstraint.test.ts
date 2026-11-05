/**
 * Phase 2B.4a — CartItemOption dual-source integrity, proven against the
 * real development database (rejections must come from PostgreSQL itself,
 * not application validation). Self-cleaning: all temp rows are removed.
 */
import { PrismaClient } from "@prisma/client";

import { ensureTestDishType, type TestDishTypeHandle } from "../helpers/testDishType";
jest.setTimeout(60000);

const prisma = new PrismaClient();

// FIN-07-05: Product.dishTypeId is a required FK and these tests hard-code
// "JOLLOF", which only exists after a seed. Provide it idempotently here so
// the fixture is self-contained; a pre-existing seeded row is never removed.
let testDishType: TestDishTypeHandle | null = null;
beforeAll(async () => {
  testDishType = await ensureTestDishType(prisma);
});

const tag = `cio-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let vendorId = "";
let customerId = "";
let productId = "";
let legacyOptionId = "";
let groupId = "";
let groupItemId = "";
let cartId = "";
let cartItemId = "";
const tempOptionIds: string[] = [];

async function cleanup() {
  await prisma.cartItemOption.deleteMany({ where: { id: { in: tempOptionIds } } }).catch(() => {});
  if (cartItemId) await prisma.cartItem.deleteMany({ where: { id: cartItemId } }).catch(() => {});
  if (cartId) await prisma.cart.deleteMany({ where: { id: cartId } }).catch(() => {});
  if (groupId) await prisma.optionGroup.deleteMany({ where: { id: groupId } }).catch(() => {});
  if (legacyOptionId) await prisma.productOption.deleteMany({ where: { id: legacyOptionId } }).catch(() => {});
  if (productId) await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
  if (vendorId) await prisma.user.deleteMany({ where: { id: vendorId } }).catch(() => {});
  if (customerId) await prisma.user.deleteMany({ where: { id: customerId } }).catch(() => {});
}

beforeAll(async () => {
  const vendor = await prisma.user.create({
    data: { email: `${tag}-vendor@example.com`, name: "Vendor", role: "VENDOR", roles: ["VENDOR"] },
  });
  vendorId = vendor.id;
  const customer = await prisma.user.create({
    data: { email: `${tag}-customer@example.com`, name: "Customer", role: "CUSTOMER", roles: ["CUSTOMER"] },
  });
  customerId = customer.id;
  const product = await prisma.product.create({
    data: {
      name: `${tag} product`,
      description: "constraint fixture",
      price: 1000,
      dishTypeId: "JOLLOF",
      categoryId: "RICE_DISHES",
      vendorId,
      images: [],
      video: [],
    },
  });
  productId = product.id;
  const legacy = await prisma.productOption.create({
    data: { productId, name: `${tag}-legacy`, price: 100 },
  });
  legacyOptionId = legacy.id;
  const group = await prisma.optionGroup.create({
    data: { productId, name: "Add-ons", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
  });
  groupId = group.id;
  const item = await prisma.optionGroupItem.create({
    data: { optionGroupId: groupId, name: `${tag}-item`, priceAdd: 100, isActive: true, sortOrder: 0 },
  });
  groupItemId = item.id;
  const cart = await prisma.cart.create({ data: { customerId } });
  cartId = cart.id;
  const cartItem = await prisma.cartItem.create({
    data: { cartId, productId, quantity: 1, unitPrice: 1000, subtotal: 1000 },
  });
  cartItemId = cartItem.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await testDishType?.dispose();
});

async function createOption(id: string, data: Record<string, unknown>) {
  tempOptionIds.push(id);
  return prisma.cartItemOption.create({ data: { id, cartItemId, name: `${tag}-opt`, price: 100, ...data } as never });
}

describe("CartItemOption exactly-one-source CHECK constraint (database-enforced)", () => {
  it("accepts a legacy-only row", async () => {
    const row = await createOption(`legacy-${tag}`, { productOptionId: legacyOptionId, optionGroupItemId: null });
    expect(row.productOptionId).toBe(legacyOptionId);
    expect(row.optionGroupItemId).toBeNull();
  });

  it("accepts a new-only row", async () => {
    const row = await createOption(`new-${tag}`, { productOptionId: null, optionGroupItemId: groupItemId });
    expect(row.productOptionId).toBeNull();
    expect(row.optionGroupItemId).toBe(groupItemId);
  });

  it("rejects both-NULL at the database level", async () => {
    await expect(
      createOption(`null-${tag}`, { productOptionId: null, optionGroupItemId: null }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects both-populated at the database level", async () => {
    await expect(
      createOption(`both-${tag}`, { productOptionId: legacyOptionId, optionGroupItemId: groupItemId }),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe("CartItemOption FK integrity", () => {
  it("rejects an optionGroupItemId with no such row", async () => {
    await expect(
      createOption(`badgroup-${tag}`, { productOptionId: null, optionGroupItemId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow();
  });

  it("rejects a productOptionId with no such row", async () => {
    await expect(
      createOption(`badlegacy-${tag}`, { productOptionId: "00000000-0000-4000-8000-000000000001", optionGroupItemId: null }),
    ).rejects.toThrow();
  });

  it("resolves a legacy productOptionId to its ProductOption after migration", async () => {
    const row = await createOption(`resolve-${tag}`, { productOptionId: legacyOptionId, optionGroupItemId: null });
    const loaded = await prisma.cartItemOption.findUnique({
      where: { id: row.id },
      include: { productOption: true },
    });
    expect(loaded?.productOption?.id).toBe(legacyOptionId);
    expect(loaded?.productOption?.price).toBe(100);
  });
});

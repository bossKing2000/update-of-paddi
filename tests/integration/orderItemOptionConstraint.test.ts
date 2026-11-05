/**
 * Phase 2B.5a — OrderItemOption dual-source integrity, proven against the
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

const tag = `oio-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let vendorId = "";
let customerId = "";
let productId = "";
let legacyOptionId = "";
let groupId = "";
let groupItemId = "";
let orderId = "";
let orderItemId = "";
const tempOptionIds: string[] = [];

async function cleanup() {
  await prisma.orderItemOption.deleteMany({ where: { id: { in: tempOptionIds } } }).catch(() => {});
  if (orderItemId) await prisma.orderItem.deleteMany({ where: { id: orderItemId } }).catch(() => {});
  if (orderId) await prisma.order.deleteMany({ where: { id: orderId } }).catch(() => {});
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
  const order = await prisma.order.create({
    data: {
      customerId,
      vendorId,
      basePrice: 1000,
      totalPrice: 1000,
      status: "PENDING",
    },
  });
  orderId = order.id;
  const orderItem = await prisma.orderItem.create({
    data: { orderId, productId, quantity: 1, unitPrice: 1000, subtotal: 1000 },
  });
  orderItemId = orderItem.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await testDishType?.dispose();
});

async function createOption(id: string, data: Record<string, unknown>) {
  tempOptionIds.push(id);
  return prisma.orderItemOption.create({
    data: { id, orderItemId, name: `${tag}-opt`, price: 100, ...data } as never,
  });
}

describe("OrderItemOption exactly-one-source CHECK constraint (database-enforced)", () => {
  it("accepts a legacy-only row", async () => {
    const row = await createOption(`legacy-${tag}`, { optionId: legacyOptionId, optionGroupItemId: null });
    expect(row.optionId).toBe(legacyOptionId);
    expect(row.optionGroupItemId).toBeNull();
  });

  it("accepts a new-only row", async () => {
    const row = await createOption(`new-${tag}`, { optionId: null, optionGroupItemId: groupItemId });
    expect(row.optionId).toBeNull();
    expect(row.optionGroupItemId).toBe(groupItemId);
  });

  it("rejects both-NULL at the database level", async () => {
    await expect(
      createOption(`null-${tag}`, { optionId: null, optionGroupItemId: null }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects both-populated at the database level", async () => {
    await expect(
      createOption(`both-${tag}`, { optionId: legacyOptionId, optionGroupItemId: groupItemId }),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe("OrderItemOption FK integrity", () => {
  it("rejects an optionGroupItemId with no such row", async () => {
    await expect(
      createOption(`badgroup-${tag}`, { optionId: null, optionGroupItemId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow();
  });

  it("rejects an optionId with no such row", async () => {
    await expect(
      createOption(`badlegacy-${tag}`, { optionId: "00000000-0000-4000-8000-000000000001", optionGroupItemId: null }),
    ).rejects.toThrow();
  });

  it("resolves a legacy optionId to its ProductOption after migration", async () => {
    const row = await createOption(`resolve-${tag}`, { optionId: legacyOptionId, optionGroupItemId: null });
    const loaded = await prisma.orderItemOption.findUnique({
      where: { id: row.id },
      include: { productOption: true },
    });
    expect(loaded?.productOption?.id).toBe(legacyOptionId);
    expect(loaded?.productOption?.price).toBe(100);
  });

  it("resolves a new optionGroupItemId to its OptionGroupItem after migration", async () => {
    const row = await createOption(`resolve-new-${tag}`, { optionId: null, optionGroupItemId: groupItemId });
    const loaded = await prisma.orderItemOption.findUnique({
      where: { id: row.id },
      include: { optionGroupItem: true },
    });
    expect(loaded?.optionGroupItem?.id).toBe(groupItemId);
    expect(loaded?.optionGroupItem?.priceAdd).toBe(100);
  });
});

describe("OrderItemOption delete protection", () => {
  it("rejects deleting a referenced OptionGroupItem (RESTRICT)", async () => {
    await createOption(`ref-${tag}`, { optionId: null, optionGroupItemId: groupItemId });
    await expect(prisma.optionGroupItem.delete({ where: { id: groupItemId } })).rejects.toThrow();
  });

  it("allows deactivating a referenced OptionGroupItem (isActive=false)", async () => {
    const updated = await prisma.optionGroupItem.update({
      where: { id: groupItemId },
      data: { isActive: false },
    });
    expect(updated.isActive).toBe(false);
    // Restore for cleanup
    await prisma.optionGroupItem.update({ where: { id: groupItemId }, data: { isActive: true } });
  });

  it("rejects deleting a referenced legacy ProductOption (RESTRICT, Phase 3.1.1)", async () => {
    // Phase 3.1.1 changed the legacy optionId FK from CASCADE to RESTRICT:
    // deleting catalog must never delete historical order records carrying
    // their snapshots. Create a fresh legacy option, reference it, then
    // prove the delete is rejected and the history row survives.
    const tempLegacy = await prisma.productOption.create({
      data: { productId, name: `${tag}-restrict-test`, price: 50 },
    });
    const row = await createOption(`restrict-${tag}`, { optionId: tempLegacy.id, optionGroupItemId: null });
    await expect(prisma.productOption.delete({ where: { id: tempLegacy.id } })).rejects.toThrow();
    const kept = await prisma.orderItemOption.findUnique({ where: { id: row.id } });
    expect(kept).not.toBeNull();
    // Cleanup: remove the reference first, then the option itself.
    await prisma.orderItemOption.delete({ where: { id: row.id } });
    await prisma.productOption.delete({ where: { id: tempLegacy.id } });
  });
});

describe("OrderItemOption snapshot preservation", () => {
  it("preserves name and price snapshots on legacy rows", async () => {
    const row = await createOption(`snap-${tag}`, { optionId: legacyOptionId, optionGroupItemId: null });
    expect(row.name).toBe(`${tag}-opt`);
    expect(row.price).toBe(100);
  });

  it("preserves name and price snapshots on new rows", async () => {
    const row = await createOption(`snap-new-${tag}`, { optionId: null, optionGroupItemId: groupItemId });
    expect(row.name).toBe(`${tag}-opt`);
    expect(row.price).toBe(100);
  });
});

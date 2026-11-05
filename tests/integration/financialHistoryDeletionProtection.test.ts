/**
 * Phase 3.1.1 — financial-history deletion protection, proven against real
 * PostgreSQL (rejections must come from the database's RESTRICT
 * constraints, not application validation). Self-cleaning: all temp rows
 * are removed. Follows tests/integration/orderItemOptionConstraint.test.ts.
 *
 * NOTE: this suite requires a disposable PostgreSQL database via
 * `npm run test:integration` (integration preflight). It CANNOT run under
 * the unit config and must never point at shared or production data.
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

const tag = `fh-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let vendorId = "";
let customerId = "";
let riderUserId = "";
let deliveryPersonId = "";
let payoutAccountId = "";
let withdrawalId = "";
let payoutId = "";
let productId = "";
let groupId = "";
let groupItemId = "";
let legacyOptionId = "";
let orderId = "";
let orderItemId = "";

async function cleanup() {
  await prisma.riderWithdrawal.deleteMany({ where: { id: withdrawalId } }).catch(() => {});
  await prisma.riderPayoutAccount.deleteMany({ where: { id: payoutAccountId } }).catch(() => {});
  await prisma.deliveryPerson.deleteMany({ where: { id: deliveryPersonId } }).catch(() => {});
  await prisma.orderItemOption.deleteMany({ where: { orderItemId } }).catch(() => {});
  await prisma.orderItem.deleteMany({ where: { id: orderItemId } }).catch(() => {});
  await prisma.order.updateMany({ where: { id: orderId }, data: { payoutId: null } }).catch(() => {});
  await prisma.order.deleteMany({ where: { id: orderId } }).catch(() => {});
  await prisma.vendorPayout.deleteMany({ where: { id: payoutId } }).catch(() => {});
  await prisma.optionGroupItem.deleteMany({ where: { id: groupItemId } }).catch(() => {});
  await prisma.optionGroup.deleteMany({ where: { id: groupId } }).catch(() => {});
  await prisma.productOption.deleteMany({ where: { id: legacyOptionId } }).catch(() => {});
  await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [vendorId, customerId, riderUserId].filter(Boolean) } } }).catch(() => {});
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
  const riderUser = await prisma.user.create({
    data: { email: `${tag}-rider@example.com`, name: "Rider", role: "DELIVERY", roles: ["DELIVERY"] },
  });
  riderUserId = riderUser.id;
  const person = await prisma.deliveryPerson.create({ data: { userId: riderUserId } });
  deliveryPersonId = person.id;
  const account = await prisma.riderPayoutAccount.create({
    data: {
      deliveryPersonId,
      bankName: "Test Bank",
      bankCode: "999",
      accountNumber: "0000000000",
      accountName: "Test Rider",
    },
  });
  payoutAccountId = account.id;
  const withdrawal = await prisma.riderWithdrawal.create({
    data: { deliveryPersonId, payoutAccountId, amount: 500, balanceSnapshot: 1000, idempotencyKey: `${tag}-w` },
  });
  withdrawalId = withdrawal.id;
  const product = await prisma.product.create({
    data: {
      name: `${tag} product`,
      description: "deletion-protection fixture",
      price: 1000,
      dishTypeId: "JOLLOF",
      categoryId: "RICE_DISHES",
      vendorId,
      images: [],
      video: [],
    },
  });
  productId = product.id;
  const group = await prisma.optionGroup.create({
    data: { productId, name: "Add-ons", required: false, minSelections: 0, maxSelections: 1, sortOrder: 0 },
  });
  groupId = group.id;
  const item = await prisma.optionGroupItem.create({
    data: { optionGroupId: groupId, name: `${tag}-item`, priceAdd: 100, isActive: true, sortOrder: 0 },
  });
  groupItemId = item.id;
  const legacy = await prisma.productOption.create({
    data: { productId, name: `${tag}-legacy`, price: 100 },
  });
  legacyOptionId = legacy.id;
  const order = await prisma.order.create({
    data: { customerId, vendorId, basePrice: 1000, totalPrice: 1100, status: "PENDING" },
  });
  orderId = order.id;
  const orderItem = await prisma.orderItem.create({
    data: { orderId, productId, quantity: 1, unitPrice: 1000, subtotal: 1000 },
  });
  orderItemId = orderItem.id;
  await prisma.orderItemOption.create({
    data: { orderItemId, optionGroupItemId: groupItemId, name: `${tag}-item`, price: 100 },
  });
  await prisma.orderItemOption.create({
    data: { orderItemId, optionId: legacyOptionId, name: `${tag}-legacy`, price: 100 },
  });
  const payout = await prisma.vendorPayout.create({
    data: {
      vendorId,
      grossRevenue: 1000,
      commission: 150,
      amount: 850,
      orderCount: 1,
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-01-31"),
    },
  });
  payoutId = payout.id;
  await prisma.order.update({ where: { id: orderId }, data: { payoutId } });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await testDishType?.dispose();
});

describe("Phase 3.1.1 — RESTRICT blocks history-destroying deletes", () => {
  it("1. referenced option item cannot be deleted", async () => {
    await expect(prisma.optionGroupItem.delete({ where: { id: groupItemId } })).rejects.toThrow();
    // History row survives the blocked delete.
    await expect(
      prisma.orderItemOption.findFirst({ where: { optionGroupItemId: groupItemId } }),
    ).resolves.not.toBeNull();
  });

  it("2. group with referenced items cannot be deleted", async () => {
    await expect(prisma.optionGroup.delete({ where: { id: groupId } })).rejects.toThrow();
  });

  it("3. legacy option referenced by history cannot be deleted", async () => {
    await expect(prisma.productOption.delete({ where: { id: legacyOptionId } })).rejects.toThrow();
    await expect(
      prisma.orderItemOption.findFirst({ where: { optionId: legacyOptionId } }),
    ).resolves.not.toBeNull();
  });

  it("4. product with order items cannot be deleted", async () => {
    await expect(prisma.product.delete({ where: { id: productId } })).rejects.toThrow();
    await expect(prisma.orderItem.findFirst({ where: { productId } })).resolves.not.toBeNull();
  });

  it("5. customer with orders cannot be deleted", async () => {
    await expect(prisma.user.delete({ where: { id: customerId } })).rejects.toThrow();
    await expect(prisma.order.findFirst({ where: { id: orderId } })).resolves.not.toBeNull();
  });

  it("6. vendor with orders cannot be deleted", async () => {
    await expect(prisma.user.delete({ where: { id: vendorId } })).rejects.toThrow();
  });

  it("7. payout attached to orders cannot be deleted", async () => {
    await expect(prisma.vendorPayout.delete({ where: { id: payoutId } })).rejects.toThrow();
    // The double-pay guard link survives: payoutId is NOT nulled.
    await expect(prisma.order.findUnique({ where: { id: orderId } })).resolves.toMatchObject({
      payoutId,
    });
  });

  it("8. rider with withdrawals cannot be deleted", async () => {
    await expect(prisma.deliveryPerson.delete({ where: { id: deliveryPersonId } })).rejects.toThrow();
    await expect(prisma.riderWithdrawal.findFirst({ where: { id: withdrawalId } })).resolves.not.toBeNull();
  });
});

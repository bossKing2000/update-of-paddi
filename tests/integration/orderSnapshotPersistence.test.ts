/**
 * Phase 3.2b — snapshot persistence invariants, proven against the real
 * development database. Self-cleaning: all temp rows are removed.
 *
 * Covers: productName immutability across renames, snapshot immunity to
 * later commission-rate changes, NULL historical compatibility, and the
 * shared RefundRequest.orderId attribution rule (single/multi/null-key).
 */
import { PrismaClient } from "@prisma/client";
import { resolveRefundOrderId } from "../../src/services/orderSnapshot.service";

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

const tag = `sn32b-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let vendorId = "";
let customerId = "";
let otherCustomerId = "";
let productId = "";
const orderIds: string[] = [];
const itemIds: string[] = [];
const paymentIds: string[] = [];

async function cleanup() {
  if (paymentIds.length)
    await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }).catch(() => {});
  if (itemIds.length)
    await prisma.orderItem.deleteMany({ where: { id: { in: itemIds } } }).catch(() => {});
  if (orderIds.length)
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
  if (productId)
    await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
  for (const id of [vendorId, customerId, otherCustomerId]) {
    if (id) await prisma.user.deleteMany({ where: { id } }).catch(() => {});
  }
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
  const other = await prisma.user.create({
    data: { email: `${tag}-other@example.com`, name: "Other", role: "CUSTOMER", roles: ["CUSTOMER"] },
  });
  otherCustomerId = other.id;
  const product = await prisma.product.create({
    data: {
      name: `${tag} Original Name`,
      description: "snapshot fixture",
      price: 2000,
      dishTypeId: "JOLLOF",
      categoryId: "RICE_DISHES",
      vendorId,
      images: [],
      video: [],
    },
  });
  productId = product.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await testDishType?.dispose();
});

async function createOrder(key: string | null, withSnapshots: boolean) {
  const order = await prisma.order.create({
    data: {
      customerId,
      vendorId,
      basePrice: 5000,
      totalPrice: 5000,
      status: "AWAITING_PAYMENT",
      ...(key ? { idempotencyKey: key } : {}),
      ...(withSnapshots
        ? {
            commissionRateSnapshot: 0.15,
            commissionKobo: 75000n,
            vendorPayoutKobo: 425000n,
            discountKobo: 50000n,
          }
        : {}),
      items: {
        create: {
          productId,
          ...(withSnapshots ? { productName: `${tag} Original Name` } : {}),
          quantity: 2,
          unitPrice: 2500,
          subtotal: 5000,
        },
      },
    } as never,
    include: { items: true },
  });
  orderIds.push(order.id);
  for (const item of (order as unknown as { items: { id: string }[] }).items) {
    itemIds.push(item.id);
  }
  return order as unknown as { id: string; items: { id: string }[] };
}

async function createPayment(orderId: string, key: string | null, ref: string) {
  const payment = await prisma.payment.create({
    data: {
      userId: customerId,
      orderId,
      amount: 500000,
      reference: ref,
      status: "SUCCESS",
      ...(key ? { idempotencyKey: key } : {}),
    },
  });
  paymentIds.push(payment.id);
  return payment;
}

describe("OrderItem.productName snapshot", () => {
  it("freezes the order-time name across later product renames", async () => {
    const order = await createOrder(`${tag}-rename-key`, true);
    const itemId = order.items[0].id;
    await prisma.product.update({
      where: { id: productId },
      data: { name: `${tag} Renamed Product` },
    });
    const reread = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(reread.productName).toBe(`${tag} Original Name`);
  });
});

describe("Order money snapshots vs later rate mutation", () => {
  it("stored snapshots do not change when the vendor rate changes", async () => {
    const order = await createOrder(`${tag}-rate-key`, true);
    await prisma.user.update({
      where: { id: vendorId },
      data: { commissionRate: 0.25 },
    });
    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reread.commissionRateSnapshot).toBe(0.15);
    expect(reread.commissionKobo).toBe(75000n);
    expect(reread.vendorPayoutKobo).toBe(425000n);
    expect(reread.discountKobo).toBe(50000n);
    await prisma.user.update({
      where: { id: vendorId },
      data: { commissionRate: 0.15 },
    });
  });

  it("historical NULL snapshots remain valid rows", async () => {
    const order = await createOrder(`${tag}-null-key`, false);
    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(reread.commissionKobo).toBeNull();
    expect(reread.vendorPayoutKobo).toBeNull();
    expect(reread.discountKobo).toBeNull();
    expect(reread.commissionRateSnapshot).toBeNull();
    expect(reread.items[0].productName).toBeNull();
  });
});

describe("resolveRefundOrderId attribution rule", () => {
  it("single-order payment attributes that order", async () => {
    const order = await createOrder(`${tag}-single-key`, false);
    const payment = await createPayment(order.id, `${tag}-single-key`, `${tag}-ref-single`);
    await expect(
      resolveRefundOrderId(prisma, payment, customerId),
    ).resolves.toBe(order.id);
  });

  it("multi-order batch payment stays unattributed (null)", async () => {
    const key = `${tag}-multi-key`;
    const first = await createOrder(key, false);
    const second = await createOrder(key, false);
    const payment = await createPayment(first.id, key, `${tag}-ref-multi`);
    await expect(resolveRefundOrderId(prisma, payment, customerId)).resolves.toBeNull();
    expect(second.id).not.toBe(first.id);
  });

  it("null-key legacy payment uses the authoritative FK-linked order", async () => {
    const order = await createOrder(null, false);
    const payment = await createPayment(order.id, null, `${tag}-ref-legacy`);
    await expect(
      resolveRefundOrderId(prisma, payment, customerId),
    ).resolves.toBe(order.id);
  });

  it("never attributes another customer's order", async () => {
    const foreign = await prisma.order.create({
      data: {
        customerId: otherCustomerId,
        vendorId,
        basePrice: 1000,
        totalPrice: 1000,
        status: "AWAITING_PAYMENT",
      },
    });
    orderIds.push(foreign.id);
    const rows = await prisma.order.findMany({
      where: { idempotencyKey: `${tag}-no-such-key`, customerId },
      select: { id: true },
    });
    expect(rows).toHaveLength(0);
    await expect(
      resolveRefundOrderId(
        prisma,
        { orderId: foreign.id, idempotencyKey: null },
        customerId,
      ),
    ).resolves.toBeNull();
  });
});

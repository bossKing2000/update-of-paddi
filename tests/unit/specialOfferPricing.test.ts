/**
 * Batch F2 — special-offer line pricing.
 *
 * `offer.price` is the vendor's TOTAL bid for the requested quantity (stock
 * is reserved for the full quantity and the order total charges the bid
 * total). The order line must therefore carry the pro-rata unit price while
 * keeping the authoritative subtotal (and every total/snapshot derived
 * from it) exactly at the bid. Previously unitPrice carried the whole bid,
 * so unitPrice × quantity disagreed with the line for any quantity > 1.
 *
 * Drives the REAL `acceptSpecialOffer` (mocked Prisma/delivery-fee only).
 */
import { acceptSpecialOffer } from "../../src/controllers/orderController";
import prisma from "../../src/lib/prisma";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    specialOrderOffer: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    specialOrderRequest: { update: jest.fn() },
    address: { findFirst: jest.fn() },
    product: { findUnique: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    user: { findUnique: jest.fn() },
    order: { create: jest.fn() },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === "function" ? arg(require("../../src/lib/prisma").default) : arg,
    ),
  },
}));

jest.mock("../../src/services/deliveryFee.service", () => ({
  __esModule: true,
  calculateDeliveryFee: jest.fn(async () => ({ fee: 500, withinRange: true, distanceKm: 1 })),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => ({})),
  clearProductsCache: jest.fn(async () => ({})),
}));

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

function offerFixture(price: number, quantity: number) {
  db.specialOrderOffer.findUnique.mockResolvedValue({
    id: "offer-1",
    vendorId: "vend-1",
    requestId: "req-1",
    price,
    status: "PENDING",
    request: { id: "req-1", customerId: "cust-1", status: "OFFER_MADE", productId: "prod-1", quantity },
  });
  db.address.findFirst.mockResolvedValue({ id: "addr-1", userId: "cust-1" });
  db.product.findUnique.mockResolvedValue({
    id: "prod-1",
    name: "Bulk Rice",
    archived: false,
    trackInventory: true,
    stock: 100,
    vendor: { isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } },
  });
  db.user.findUnique.mockResolvedValue({ commissionRate: 0.15 });
  db.specialOrderOffer.updateMany.mockResolvedValue({ count: 0 });
  db.specialOrderRequest.update.mockImplementation(async (args: any) => ({ id: args.where.id, status: "ACCEPTED" }));
  db.specialOrderOffer.update.mockImplementation(async (args: any) => ({ id: args.where.id, status: "ACCEPTED" }));
  db.order.create.mockImplementation(async (args: any) => ({ id: "order-9", ...args.data }));
}

function accept(price: number, quantity: number) {
  offerFixture(price, quantity);
  return acceptSpecialOffer(
    {
      user: { id: "cust-1", role: "CUSTOMER", sessionId: "s" },
      params: { offerId: "offer-1" },
      body: { addressId: "addr-1" },
    } as never,
    res(),
  );
}

function createdLine() {
  return db.order.create.mock.calls[0][0].data.items.create[0];
}
function createdOrder() {
  return db.order.create.mock.calls[0][0].data;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Batch F2 — special-offer quantity pricing", () => {
  it("1. quantity 1: unit price equals the bid total", async () => {
    await accept(10000, 1);
    expect(createdLine()).toMatchObject({ quantity: 1, unitPrice: 10000, subtotal: 10000 });
    expect(createdOrder()).toMatchObject({ basePrice: 10000, totalPrice: 10500 });
  });

  it("2. quantity 4: unit price is pro-rata, totals unchanged", async () => {
    await accept(10000, 4);
    expect(createdLine()).toMatchObject({ quantity: 4, unitPrice: 2500, subtotal: 10000 });
    expect(createdOrder()).toMatchObject({ basePrice: 10000, totalPrice: 10500 });
  });

  it("3. uneven split: subtotal stays exactly at the bid", async () => {
    await accept(10000, 3);
    const line = createdLine();
    expect(line.unitPrice).toBeCloseTo(3333.33, 2);
    expect(line.subtotal).toBe(10000);
    expect(createdOrder().totalPrice).toBe(10500);
  });
});

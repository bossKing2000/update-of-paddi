/**
 * Checkout revalidation: the cart stores quoted prices, but the database
 * is the truth. Price edits, disabled add-ons, and depleted stock between
 * "add to cart" and "checkout" must reject — client totals are never
 * trusted, and OrderItems are built from revalidated values.
 */

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    product: { findMany: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    cart: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    cartItem: { findMany: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
    cartItemOption: { deleteMany: jest.fn() },
    cartSummarySnapshot: { findUnique: jest.fn(), delete: jest.fn() },
    address: { findFirst: jest.fn() },
    order: { findMany: jest.fn(), create: jest.fn() },
    promotion: { findUnique: jest.fn(), updateMany: jest.fn() },
    promotionUsage: { count: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(async () => []),
}));

jest.mock("../../src/services/cartSummary.service", () => ({
  __esModule: true,
  cartSummaryService: jest.fn(),
}));

jest.mock("../../src/services/paymentService", () => ({
  __esModule: true,
  initializePayment: jest.fn(),
  verifyPayment: jest.fn(),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { cartSummaryService } from "../../src/services/cartSummary.service";
import { checkoutCart } from "../../src/controllers/cartController";
import { ConflictError, ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedSummary = cartSummaryService as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const req = (overrides: Partial<any> = {}): any =>
  ({
    headers: {},
    body: { summaryId: "snap-1", addressId: "addr-1" },
    params: {},
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "cust-1", role: "CUSTOMER", sessionId: "sess" },
    ...overrides,
  }) as any;

const OPT_ID = "11111111-1111-4111-8111-111111111111";

const cartItem = (overrides: any = {}) => ({
  id: "item-1",
  productId: "prod-1",
  quantity: 2,
  unitPrice: 2500, // 2000 base + 500 extra meat
  subtotal: 5000,
  options: [{ id: "cio-1", productOptionId: OPT_ID, name: "Extra Meat", price: 500 }],
  product: {
    id: "prod-1",
    archived: false,
    vendorId: "vendor-1",
    vendor: { id: "vendor-1", name: "Mama Put", isLive: true, deliveryPreferences: { acceptingOrders: true } },
  },
  ...overrides,
});

const freshProduct = (overrides: any = {}) => ({
  id: "prod-1",
  name: "Jollof",
  price: 2000,
  archived: false,
  trackInventory: true,
  stock: 10,
  vendorId: "vendor-1",
  options: [{ id: OPT_ID, name: "Extra Meat", price: 500 }],
  ...overrides,
});

function baseMocks() {
  db.address.findFirst.mockResolvedValue({ id: "addr-1", userId: "cust-1" });
  db.cartSummarySnapshot.findUnique.mockResolvedValue({
    id: "snap-1",
    userId: "cust-1",
    createdAt: new Date(),
    snapshot: {
      finalTotal: 5000,
      promo: null,
      vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
    },
  });
  db.cart.findFirst.mockResolvedValue({ id: "cart-1", customerId: "cust-1", items: [cartItem()] });
  db.user.findUnique.mockImplementation((args: any) =>
    Promise.resolve(
      args?.where?.id === "cust-1"
        ? ({ email: "c@test.com", name: "C" } as any)
        : ({ id: "vendor-1", isLive: true, deliveryPreferences: { acceptingOrders: true } } as any),
    ),
  );
  db.product.findMany.mockResolvedValue([freshProduct()]);
  db.cart.updateMany.mockResolvedValue({ count: 1 });
  mockedSummary.mockResolvedValue({
    warnings: [],
    finalTotal: 5000,
    promo: null,
    discount: 0,
    vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
  });
  db.order.create.mockRejectedValue(new Error("STOP_AFTER_GATE"));
}

beforeEach(() => {
  jest.clearAllMocks();
  baseMocks();
});

describe("checkoutCart — server-side revalidation", () => {
  it("rejects when the vendor changed the base price after add-to-cart", async () => {
    db.product.findMany.mockResolvedValue([freshProduct({ price: 2500 })]);

    await expect(checkoutCart(req(), res())).rejects.toThrow(ConflictError);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects when a selected add-on was disabled after add-to-cart", async () => {
    db.product.findMany.mockResolvedValue([freshProduct({ options: [] })]);

    await expect(checkoutCart(req(), res())).rejects.toThrow(
      /no longer available/i,
    );
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects when an add-on price changed after add-to-cart", async () => {
    db.product.findMany.mockResolvedValue([
      freshProduct({ options: [{ id: OPT_ID, name: "Extra Meat", price: 700 }] }),
    ]);

    await expect(checkoutCart(req(), res())).rejects.toThrow(ConflictError);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects when requested quantity exceeds remaining stock", async () => {
    db.product.findMany.mockResolvedValue([freshProduct({ stock: 1 })]);

    await expect(checkoutCart(req(), res())).rejects.toThrow(ValidationError);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects a sold-out product that is still sitting in the cart", async () => {
    db.product.findMany.mockResolvedValue([freshProduct({ stock: 0 })]);

    await expect(checkoutCart(req(), res())).rejects.toThrow(/sold out|orderable/i);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("builds order lines from revalidated database values", async () => {
    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");

    expect(db.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: {
            create: [
              expect.objectContaining({
                productId: "prod-1",
                quantity: 2,
                unitPrice: 2500,
                subtotal: 5000,
              }),
            ],
          },
        }),
      }),
    );
  });
});

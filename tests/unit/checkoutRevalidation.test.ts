/**
 * Checkout revalidation: the cart stores quoted prices, but the database
 * is the truth. Price edits, disabled add-ons, and depleted stock between
 * "add to cart" and "checkout" must reject — client totals are never
 * trusted, and OrderItems are built from revalidated values.
 */

// Groups returned by the mocked Prisma query (filtered by productId, like the real DB).
const GROUP_REGISTRY: any[] = [];

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      // Phase 3.2b: the checkout transaction reads vendor commission rates
      // in-tx for order snapshots; default empty (fallback rate applies).
      findMany: jest.fn(async () => []),
    },
    product: { findMany: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    cart: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    cartItem: { findMany: jest.fn(), deleteMany: jest.fn(), count: jest.fn(), update: jest.fn() },
    cartItemOption: { deleteMany: jest.fn() },
    optionGroup: {
      findMany: jest.fn(async (args: any) =>
        (GROUP_REGISTRY as any[]).filter((g) => {
          const w = args?.where?.productId;
          return w && typeof w === "object" ? w.in.includes(g.productId) : g.productId === w;
        }),
      ),
    },
    cartSummarySnapshot: { findUnique: jest.fn(), delete: jest.fn(async () => ({})) },
    address: { findFirst: jest.fn() },
    order: { findMany: jest.fn(), create: jest.fn() },
    // Phase 1: checkout writes an ORDER_CREATED audit row instead of the old
    // vendor "New Order Received" activity bundle.
    auditLog: { create: jest.fn(async () => ({})) },
    promotion: { findUnique: jest.fn(), findMany: jest.fn(async () => []), updateMany: jest.fn() },
    promotionUsage: { count: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  // Batch 1D.59 follow-up: the remaining instances clearProductCache touches
  // are declared so the post-transaction sweep resolves instead of throwing
  // inside the controller's error handling.
  redisProducts: {
    get: jest.fn(), set: jest.fn(), del: jest.fn(),
    scan: jest.fn(async () => ({ cursor: "0", keys: [] as string[] })),
  },
  redisSearch: {
    get: jest.fn(), set: jest.fn(),
    del: jest.fn(async () => 1),
    scan: jest.fn(async () => ({ cursor: "0", keys: [] as string[] })),
  },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisNotifications: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => 1) },
  redisTotalViews: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => 1) },
  redisUsersSessions: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => 1) },
  // In-memory idempotency store with real SET NX semantics.
  redisPayments: (() => {
    const store = new Map<string, string>();
    return {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
        if (opts?.NX && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }),
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    };
  })(),
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
import { redisPayments, redisProducts } from "../../src/lib/redis";
import { claimCheckoutKey, checkoutPayloadHash } from "../../src/services/checkoutIdempotency.service";
import { cartSummaryService } from "../../src/services/cartSummary.service";
import { checkoutCart } from "../../src/controllers/cartController";
import { ConflictError, ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedSummary = cartSummaryService as unknown as jest.Mock;
const mockedProductCacheGet = (redisProducts as unknown as { get: jest.Mock }).get;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const req = (overrides: Partial<any> = {}): any =>
  ({
    // Mandatory idempotency key — unique per call so the in-memory
    // idempotency store from the redis mock never leaks between tests.
    headers: { "idempotency-key": `reval-${++reqKeySeq}` },
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
let reqKeySeq = 0;

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
    vendor: { id: "vendor-1", name: "Mama Put", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } },
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
        : ({ id: "vendor-1", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } } as any),
    ),
  );
  db.product.findMany.mockResolvedValue([freshProduct()]);
  db.cart.updateMany.mockResolvedValue({ count: 1 });
  db.cartItem.findMany.mockResolvedValue([]);
  db.promotion.findMany.mockResolvedValue([]);
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

  it("ignores a stale cache entry claiming abundant stock when the database is sold out", async () => {
    // The display cache still shows 99 portions; the database says 0.
    // Checkout never reads product stock from the cache — this pins that
    // contract, so a future change that consults the cache cannot silently
    // start accepting orders the database would refuse. Only product-shaped
    // keys get the stale entry; anything else (e.g. the promos key) misses
    // so unrelated behavior is untouched.
    db.product.findMany.mockResolvedValue([freshProduct({ stock: 0 })]);
    mockedProductCacheGet.mockImplementation(async (key: string) =>
      typeof key === "string" && key.includes("prod-1")
        ? JSON.stringify({ id: "prod-1", stock: 99, soldOut: false })
        : null,
    );

    await expect(checkoutCart(req(), res())).rejects.toThrow(/sold out|orderable/i);
    expect(db.order.create).not.toHaveBeenCalled();

    mockedProductCacheGet.mockReset();
  });

  it("ignores a stale cache entry claiming sold-out when the database has stock", async () => {
    // Mirror image: the display cache says 0 while the database holds 10.
    // A stale "sold out" badge must not wrongfully reject a purchasable cart —
    // the order reaches creation (STOP_AFTER_GATE proves the decision point).
    db.product.findMany.mockResolvedValue([freshProduct({ stock: 10 })]);
    mockedProductCacheGet.mockImplementation(async (key: string) =>
      typeof key === "string" && key.includes("prod-1")
        ? JSON.stringify({ id: "prod-1", stock: 0, soldOut: true })
        : null,
    );

    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");
    expect(db.order.create).toHaveBeenCalled();

    mockedProductCacheGet.mockReset();
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

  it("heals stale quotes to the live effective price when a deal starts, then rejects for re-confirmation", async () => {
    // Cart was quoted at ₦2,500 (2,000 base + 500 add-on) before any deal.
    // A 10% automatic vendor-wide promo is now live: effective is ₦2,300.
    db.promotion.findMany.mockResolvedValue([
      {
        id: "promo-wide",
        code: null,
        type: "PERCENTAGE",
        value: 10,
        maxDiscount: null,
        scope: "VENDOR_WIDE",
        isActive: true,
        startsAt: null,
        expiresAt: null,
        usageLimit: null,
        usedCount: 0,
        vendorId: "vendor-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        products: [],
      },
    ]);
    db.cartItem.findMany.mockResolvedValue([{ unitPrice: 2300, quantity: 2 }]);

    await expect(checkoutCart(req(), res())).rejects.toThrow(ConflictError);
    // Stored quote healed to the live effective price …
    expect(db.cartItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { unitPrice: 2300, subtotal: 4600 },
    });
    // … and no order was created from the stale quote.
    expect(db.order.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2B.5b — checkout/order cutover for OptionGroupItem cart lines.
//
// The new-authority fixtures deliberately carry a DELIBERATELY WRONG cart
// snapshot ("Stale Snapshot Name" / price 999) so every assertion proves the
// order snapshot comes from the live database, never from stored cart values.
// The fresh product has NO legacy ProductOptions at all, proving the new path
// never consults the legacy table.
// ─────────────────────────────────────────────────────────────────────────────

const GITEM = "22222222-2222-4222-8222-222222222222";
const GITEM2 = "33333333-3333-4333-8333-333333333333";
const GROUP = "44444444-4444-4444-8444-444444444444";
const GROUP2 = "55555555-5555-4555-8555-555555555555";

const newCartItem = (overrides: any = {}) => ({
  id: "item-new",
  productId: "prod-1",
  quantity: 1,
  unitPrice: 2500,
  subtotal: 2500,
  // Stale snapshot values on purpose.
  options: [
    { id: "cio-n1", productOptionId: null, optionGroupItemId: GITEM, name: "Stale Snapshot Name", price: 999 },
  ],
  product: {
    id: "prod-1",
    archived: false,
    vendorId: "vendor-1",
    vendor: { id: "vendor-1", name: "Mama Put", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } },
  },
  ...overrides,
});

// Fresh product with ZERO legacy ProductOptions.
const freshProductNew = (overrides: any = {}) =>
  freshProduct({ options: [], ...overrides });

const proteinGroup = (overrides: any = {}) => ({
  id: GROUP,
  productId: "prod-1",
  name: "Protein",
  required: true,
  minSelections: 1,
  maxSelections: 1,
  sortOrder: 0,
  items: [
    { id: GITEM, name: "Chicken", priceAdd: 500, isActive: true, sortOrder: 0, optionGroupId: GROUP },
  ],
  ...overrides,
});

function baseNewMocks() {
  baseMocks();
  db.cart.findFirst.mockResolvedValue({
    id: "cart-1",
    customerId: "cust-1",
    items: [newCartItem()],
  });
  db.product.findMany.mockResolvedValue([freshProductNew()]);
  db.cartSummarySnapshot.findUnique.mockResolvedValue({
    id: "snap-1",
    userId: "cust-1",
    createdAt: new Date(),
    snapshot: {
      finalTotal: 2500,
      promo: null,
      vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
    },
  });
  mockedSummary.mockResolvedValue({
    warnings: [],
    finalTotal: 2500,
    promo: null,
    discount: 0,
    vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
  });
  GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[proteinGroup()]);
}

const orderOptions = () =>
  db.order.create.mock.calls[0][0].data.items.create[0].options.create;

describe("checkoutCart — OptionGroupItem (new authority)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    baseNewMocks();
  });

  it("creates an order line priced from live OptionGroupItem.priceAdd", async () => {
    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");
    expect(db.order.create).toHaveBeenCalledTimes(1);
    const line = db.order.create.mock.calls[0][0].data.items.create[0];
    expect(line.unitPrice).toBe(2500); // 2000 base + 500 live priceAdd
    expect(line.subtotal).toBe(2500);
  });

  it("writes optionGroupItemId and NULL optionId with DB snapshots", async () => {
    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");
    expect(orderOptions()).toEqual([
      { optionGroupItemId: GITEM, name: "Chicken", price: 500 },
    ]);
    const created = orderOptions()[0];
    expect(created).not.toHaveProperty("optionId");
    // Stale cart snapshot must never leak into the order.
    expect(created.name).not.toBe("Stale Snapshot Name");
    expect(created.price).not.toBe(999);
  });

  it("order total and payment amount derive from the same authoritative total", async () => {
    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");
    const orderData = db.order.create.mock.calls[0][0].data;
    const itemTotal = orderData.items.create.reduce(
      (s: number, i: any) => s + i.subtotal,
      0,
    );
    expect(orderData.totalPrice).toBe(itemTotal);
    expect(orderData.basePrice).toBe(itemTotal);
  });

  it("rejects an inactive OptionGroupItem before order creation", async () => {
    GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[
      proteinGroup({
        items: [{ id: GITEM, name: "Chicken", priceAdd: 500, isActive: false, sortOrder: 0, optionGroupId: GROUP }],
      }),
    ]);
    await expect(checkoutCart(req(), res())).rejects.toThrow(/no longer available/i);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects a deleted/nonexistent OptionGroupItem", async () => {
    GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[proteinGroup({ items: [] })]);
    await expect(checkoutCart(req(), res())).rejects.toThrow(/no longer available/i);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects an OptionGroupItem from another product", async () => {
    // Item id is not in this product's groups at all.
    GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[
      proteinGroup({
        productId: "prod-OTHER",
        items: [{ id: GITEM, name: "Chicken", priceAdd: 500, isActive: true, sortOrder: 0, optionGroupId: GROUP }],
      }),
    ]);
    await expect(checkoutCart(req(), res())).rejects.toThrow(/no longer available/i);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects a missing required-group selection", async () => {
    db.cart.findFirst.mockResolvedValue({
      id: "cart-1",
      customerId: "cust-1",
      items: [newCartItem({ options: [] })],
    });
    await expect(checkoutCart(req(), res())).rejects.toThrow(/requires between/i);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects a maxSelections violation", async () => {
    GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[
      proteinGroup({
        maxSelections: 1,
        items: [
          { id: GITEM, name: "Chicken", priceAdd: 500, isActive: true, sortOrder: 0, optionGroupId: GROUP },
          { id: GITEM2, name: "Beef", priceAdd: 600, isActive: true, sortOrder: 1, optionGroupId: GROUP },
        ],
      }),
    ]);
    db.cart.findFirst.mockResolvedValue({
      id: "cart-1",
      customerId: "cust-1",
      items: [
        newCartItem({
          options: [
            { id: "a", productOptionId: null, optionGroupItemId: GITEM, name: "x", price: 500 },
            { id: "b", productOptionId: null, optionGroupItemId: GITEM2, name: "y", price: 600 },
          ],
        }),
      ],
    });
    await expect(checkoutCart(req(), res())).rejects.toThrow(/requires between/i);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate OptionGroupItem selections", async () => {
    db.cart.findFirst.mockResolvedValue({
      id: "cart-1",
      customerId: "cust-1",
      items: [
        newCartItem({
          options: [
            { id: "a", productOptionId: null, optionGroupItemId: GITEM, name: "x", price: 500 },
            { id: "b", productOptionId: null, optionGroupItemId: GITEM, name: "y", price: 500 },
          ],
        }),
      ],
    });
    await expect(checkoutCart(req(), res())).rejects.toThrow(/duplicate/i);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects a stale quote when the live priceAdd changed (fails closed)", async () => {
    GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[
      proteinGroup({
        items: [{ id: GITEM, name: "Chicken", priceAdd: 900, isActive: true, sortOrder: 0, optionGroupId: GROUP }],
      }),
    ]);
    // Live total is now 2900 but the cart quoted 2500 → drift rejection.
    await expect(checkoutCart(req(), res())).rejects.toThrow(/pricing changed/i);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("preserves negative priceAdd arithmetic", async () => {
    GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[
      proteinGroup({
        items: [{ id: GITEM, name: "Staff Credit", priceAdd: -200, isActive: true, sortOrder: 0, optionGroupId: GROUP }],
      }),
    ]);
    db.cart.findFirst.mockResolvedValue({
      id: "cart-1",
      customerId: "cust-1",
      items: [
        newCartItem({
          unitPrice: 1800,
          subtotal: 1800,
          options: [{ id: "cio-n1", productOptionId: null, optionGroupItemId: GITEM, name: "x", price: -200 }],
        }),
      ],
    });
    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");
    const line = db.order.create.mock.calls[0][0].data.items.create[0];
    expect(line.unitPrice).toBe(1800); // 2000 - 200, not clamped
    expect(orderOptions()).toEqual([
      { optionGroupItemId: GITEM, name: "Staff Credit", price: -200 },
    ]);
  });

  it("handles an optional group with zero selections", async () => {
    GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[
      {
        id: GROUP2,
        productId: "prod-1",
        name: "Extras",
        required: false,
        minSelections: 0,
        maxSelections: 2,
        sortOrder: 0,
        items: [],
      },
    ]);
    db.cart.findFirst.mockResolvedValue({
      id: "cart-1",
      customerId: "cust-1",
      items: [newCartItem({ options: [], unitPrice: 2000, subtotal: 2000 })],
    });
    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");
    const line = db.order.create.mock.calls[0][0].data.items.create[0];
    expect(line.unitPrice).toBe(2000);
    expect(orderOptions()).toEqual([]);
  });

  it("supports a cart mixing separate legacy and new lines", async () => {
    db.cart.findFirst.mockResolvedValue({
      id: "cart-1",
      customerId: "cust-1",
      items: [cartItem(), newCartItem({ id: "item-new" })],
    });
    // Legacy line validates against ProductOption; new line against groups.
    db.product.findMany.mockResolvedValue([
      freshProduct(),
      freshProduct({ id: "prod-1", name: "Jollof", options: [{ id: OPT_ID, name: "Extra Meat", price: 500 }] }),
    ]);
    GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[proteinGroup()]);
    db.cartSummarySnapshot.findUnique.mockResolvedValue({
      id: "snap-1",
      userId: "cust-1",
      createdAt: new Date(),
      snapshot: {
        finalTotal: 7500,
        promo: null,
        vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
      },
    });
    mockedSummary.mockResolvedValue({
      warnings: [],
      finalTotal: 7500,
      promo: null,
      discount: 0,
      vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
    });

    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");
    const created = db.order.create.mock.calls[0][0].data.items.create;
    expect(created).toHaveLength(2);
    // Legacy line keeps optionId; new line keeps optionGroupItemId.
    const legacyOpts = created.find((l: any) => l.options.create[0]?.optionId)?.options.create;
    const newOpts = created.find((l: any) => l.options.create[0]?.optionGroupItemId)?.options.create;
    expect(legacyOpts).toEqual([{ optionId: OPT_ID, name: "Extra Meat", price: 500 }]);
    expect(newOpts).toEqual([{ optionGroupItemId: GITEM, name: "Chicken", price: 500 }]);
  });

  it("never conflates the two authorities (no ProductOption fallback)", async () => {
    // The cart row references a group item, and the product HAS legacy
    // options with different pricing — the legacy table must not be used.
    GROUP_REGISTRY.length = 0;
    GROUP_REGISTRY.push(...[proteinGroup()]);
    db.product.findMany.mockResolvedValue([
      freshProduct({ options: [{ id: OPT_ID, name: "Extra Meat", price: 500 }] }),
    ]);
    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");
    const opts = orderOptions();
    expect(opts).toHaveLength(1);
    expect(opts[0].optionGroupItemId).toBe(GITEM);
    expect(opts[0]).not.toHaveProperty("optionId");
  });
});

// ---------------------------------------------------------------------------
// Batch 1D.59 follow-up — a committed order whose Redis completion write
// fails. The transaction has already committed, so the request must still be
// reported as a successful checkout, the claim must be released (not left
// stuck in-flight), and a retry must recover the committed order through the
// database replay check rather than creating a second one.
//
// Mocks simulate the transaction and the Redis failure; this is NOT real
// concurrency or Redis/PostgreSQL behaviour.
// ---------------------------------------------------------------------------
describe("checkoutCart — committed order with a failed completion write", () => {
  // Distinct keys per test: the once-implementation chain consumes its
  // failures, but any claim a test leaves behind must not block the next one.
  const payloadHash = checkoutPayloadHash({ summaryId: "snap-1", addressId: "addr-1" });

  /** A valid committed order instead of the STOP_AFTER_GATE sentinel. */
  function committedOrderMocks() {
    baseMocks();
    db.order.findMany.mockResolvedValue([]); // nothing committed yet
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
    db.order.create.mockResolvedValue({ id: "order-committed-1" });
  }

  it("returns 201, releases the claim, and a retry recovers the same order without a duplicate", async () => {
    const set = (redisPayments as unknown as { set: jest.Mock }).set;
    const realSet = set.getMockImplementation()!;

    committedOrderMocks();
    // Fail ONLY the completion write. Per checkout the SET calls are:
    //   #1 the idempotency claim (SET NX) — must succeed
    //   #2 the completion write          — must fail
    // Once-implementations are consumed in order and then the real client
    // behaviour resumes, so nothing leaks into the next test.
    set.mockImplementationOnce(realSet);
    set.mockImplementationOnce(async () => {
      throw new Error("redis down while recording completion");
    });

    const first = res();
    await checkoutCart(
      { ...req(), headers: { "idempotency-key": "completion-fail-key" } } as any,
      first,
    );

    // The transaction committed and the client was told so. A failed cache
    // write must never masquerade as a rolled-back checkout.
    expect(first.status).toHaveBeenCalledWith(201);
    expect(db.order.create).toHaveBeenCalledTimes(1);
    // Both writes were attempted: the claim succeeded, the completion failed.
    expect(set).toHaveBeenCalledTimes(2);

    // Because completion recording failed, the claim was released rather than
    // left complete: the same payload can be claimed again. (Had the error been
    // swallowed and the key left in-flight, this would have been "conflict".)
    expect(await claimCheckoutKey("cust-1", "completion-fail-key", payloadHash)).toEqual({ action: "proceed" });

    // Retry with the same key: the committed order is found by the database
    // replay check at the top of the handler, so checkout never runs again.
    db.order.findMany.mockResolvedValue([{ id: "order-committed-1", idempotencyKey: "completion-fail-key" }]);
    const retry = res();
    await checkoutCart(
      { ...req(), headers: { "idempotency-key": "completion-fail-key" } } as any,
      retry,
    );

    expect(retry.status).toHaveBeenCalledWith(200);
    expect(db.order.create).toHaveBeenCalledTimes(1); // still exactly one order
  });

  it("a successful completion keeps the key complete so a retry replays it", async () => {
    committedOrderMocks();

    const first = res();
    await checkoutCart(
      { ...req(), headers: { "idempotency-key": "completion-ok-key" } } as any,
      first,
    );
    expect(first.status).toHaveBeenCalledWith(201);

    // The key stays complete: a retry with the same payload replays the
    // recorded response without touching the database checkout path.
    expect(await claimCheckoutKey("cust-1", "completion-ok-key", payloadHash)).toMatchObject({
      action: "replay",
    });
  });
});

describe("checkoutCart — Batch G snapshot component reconciliation", () => {
  // Batch G: the price-match gate compares money components, not just the
  // total — a compensating shift (subtotal up, delivery down, same total)
  // changes what the customer confirmed and must reject.
  const snapWith = (snapshot: any) =>
    db.cartSummarySnapshot.findUnique.mockResolvedValue({
      id: "snap-1",
      userId: "cust-1",
      createdAt: new Date(),
      snapshot,
    });
  const freshWith = (summary: any) => mockedSummary.mockResolvedValue(summary);

  it("rejects a compensating subtotal/delivery shift with an identical total", async () => {
    snapWith({ finalTotal: 5000, subtotal: 5000, discount: 0, deliveryFee: 300, promo: null, vendorBreakdown: [{ vendorId: "vendor-1" }] });
    freshWith({
      warnings: [],
      finalTotal: 5000,
      subtotal: 5100,
      discount: 0,
      deliveryFee: 200,
      promo: null,
      vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 200 }],
    });

    await expect(checkoutCart(req(), res())).rejects.toThrow("Cart pricing changed");
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("rejects a discount reallocation with an identical total", async () => {
    snapWith({ finalTotal: 4500, subtotal: 5000, discount: 500, deliveryFee: 0, promo: null, vendorBreakdown: [{ vendorId: "vendor-1" }] });
    freshWith({
      warnings: [],
      finalTotal: 4500,
      subtotal: 4800,
      discount: 300,
      deliveryFee: 0,
      promo: null,
      vendorBreakdown: [{ vendorId: "vendor-1", discount: 300, deliveryFee: 0 }],
    });

    await expect(checkoutCart(req(), res())).rejects.toThrow("Cart pricing changed");
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("proceeds when every component matches (no false rejection)", async () => {
    snapWith({ finalTotal: 5000, subtotal: 5000, discount: 0, deliveryFee: 0, promo: null, vendorBreakdown: [{ vendorId: "vendor-1" }] });
    // baseMocks' fresh summary already matches on all components.
    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_GATE");
    expect(db.order.create).toHaveBeenCalledTimes(1);
  });
});

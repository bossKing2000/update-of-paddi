/**
 * Phase 2B.4b — cart OptionGroupItem cutover.
 * In-memory fake DB exercising the real controller code paths.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findUnique: jest.fn() },
    optionGroup: { findMany: jest.fn() },
    cart: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    cartItem: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    cartItemOption: { deleteMany: jest.fn(), createMany: jest.fn() },
    productReview: { aggregate: jest.fn(async () => ({ _avg: { rating: null }, _count: { _all: 0 } })) },
    vendorReview: { aggregate: jest.fn(async () => ({ _avg: { rating: null }, _count: { rating: 0 } })) },
    // Legacy writes are frozen: any call here is a regression.
    productOption: {
      create: jest.fn(async () => { throw new Error("legacy ProductOption.create attempted"); }),
      update: jest.fn(async () => { throw new Error("legacy ProductOption.update attempted"); }),
      deleteMany: jest.fn(async () => { throw new Error("legacy ProductOption.deleteMany attempted"); }),
    },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => "OK"), del: jest.fn(async () => 1) },
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(async () => []),
}));

jest.mock("../../src/services/vendorAvailability.service", () => ({
  __esModule: true,
  loadVendorOperatingState: jest.fn(async () => ({})),
  assertVendorAvailableForOrdering: jest.fn(),
  isProductCurrentlyAvailable: jest.fn(() => true),
  isVendorOperating: jest.fn(() => true),
}));

jest.mock("../../src/services/promotionPricing.service", () => ({
  __esModule: true,
  loadActiveProductPromos: jest.fn(async () => []),
  resolveEffectivePromotionForProduct: jest.fn(() => null),
}));

import prisma from "../../src/lib/prisma";
import { ShopCartRedis } from "../../src/lib/redis";
import { addToCart, updateCartItem, getCart } from "../../src/controllers/cartController";
import { ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const cartRedis = ShopCartRedis as unknown as { get: jest.Mock; set: jest.Mock; del: jest.Mock };

// ---- In-memory store -------------------------------------------------------
let products: any[];
let groupsByProduct: Record<string, any[]>;
let cart: any;
let seq: number;

const VENDOR = { id: "vendor-1", name: "Mama Put", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } };
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_ACTIVE = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Legacy Extra", price: 250, isActive: true };
const LEGACY_INACTIVE = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Retired Extra", price: 100, isActive: false };

function legacyCartWith(options: any[], unitPrice = 2000) {
  return {
    id: "cart-1",
    customerId: "cust-1",
    basePrice: unitPrice,
    totalPrice: unitPrice,
    items: [{
      id: "line-legacy",
      cartId: "cart-1",
      productId: PRODUCT_ID,
      quantity: 1,
      unitPrice,
      subtotal: unitPrice,
      specialRequest: null,
      options,
    }],
  };
}

function resetStore() {
  seq = 0;
  const nid = (p: string) => `${p}-${++seq}`;
  products = [
    {
      id: "11111111-1111-4111-8111-111111111111", vendorId: "vendor-1", name: "Jollof", price: 2000,
      archived: false, trackInventory: false, stock: null,
      images: [], video: [], vendor: VENDOR, options: [],
    },
    {
      id: "22222222-2222-4222-8222-222222222222", vendorId: "vendor-1", name: "Suya", price: 1500,
      archived: false, trackInventory: false, stock: null,
      images: [], video: [], vendor: VENDOR, options: [],
    },
  ];
  groupsByProduct = {
    "11111111-1111-4111-8111-111111111111": [
      {
        id: "33333333-3333-4333-8333-333333333333", productId: "11111111-1111-4111-8111-111111111111", name: "Protein", required: true,
        minSelections: 1, maxSelections: 1, sortOrder: 0,
        items: [
          { id: "66666666-6666-4666-8666-666666666666", name: "Chicken", priceAdd: 500, isActive: true, sortOrder: 0 },
          { id: "77777777-7777-4777-8777-777777777777", name: "Beef", priceAdd: 300, isActive: true, sortOrder: 1 },
          { id: "88888888-8888-4888-8888-888888888888", name: "Retired", priceAdd: 100, isActive: false, sortOrder: 2 },
        ],
      },
      {
        id: "44444444-4444-4444-8444-444444444444", productId: "11111111-1111-4111-8111-111111111111", name: "Extras", required: false,
        minSelections: 0, maxSelections: 2, sortOrder: 1,
        items: [
          { id: "99999999-9999-4999-8999-999999999999", name: "Cheese", priceAdd: 300, isActive: true, sortOrder: 0 },
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Staff Discount", priceAdd: -200, isActive: true, sortOrder: 1 },
        ],
      },
    ],
    "22222222-2222-4222-8222-222222222222": [
      {
        id: "55555555-5555-4555-8555-555555555555", productId: "22222222-2222-4222-8222-222222222222", name: "Add-ons", required: false,
        minSelections: 0, maxSelections: 5, sortOrder: 0,
        items: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Spicy", priceAdd: 0, isActive: true, sortOrder: 0 }],
      },
    ],
  };
  cart = null;
  void nid;
}

function wire() {
  db.product.findUnique.mockImplementation(async (args: any) => {
    const product = products.find((p) => p.id === args.where.id) ?? null;
    if (!product) return null;
    // Mirror the real active-only include used by addToCart.
    if (args?.include?.options?.where?.isActive === true) {
      return { ...product, options: product.options.filter((o: any) => o.isActive !== false) };
    }
    return product;
  });
  db.optionGroup.findMany.mockImplementation(async (args: any) => {
    const list = groupsByProduct[args.where.productId] ?? [];
    return list.map((g) => ({ ...g, items: g.items.map((i: any) => ({ ...i, optionGroupId: g.id })) }));
  });
  db.cart.findFirst.mockImplementation(async () => cart);
  db.cart.findUnique.mockImplementation(async (args: any) => {
    if (!cart || (args?.where?.id && args.where.id !== cart.id)) return null;
    const fullCart = {
      ...cart,
      items: cart.items.map((i: any) => ({
        ...i,
        product: products.find((p) => p.id === i.productId),
        options: i.options.map((o: any) => ({
          ...o,
          productOption: o.productOptionId ? { id: o.productOptionId, name: o.name, price: o.price } : null,
          optionGroupItem: o.optionGroupItemId
            ? (() => {
                for (const groups of Object.values(groupsByProduct)) {
                  const found = (groups as any[]).flatMap((g: any) => g.items).find((it: any) => it.id === o.optionGroupItemId);
                  if (found) return { ...found, optionGroupId: (groups as any[]).find((g: any) => g.items.includes(found))?.id };
                }
                return null;
              })()
            : null,
        })),
      })),
    };
    return fullCart;
  });
  db.cart.create.mockImplementation(async (args: any) => {
    cart = { id: "cart-1", customerId: "cust-1", basePrice: 0, totalPrice: 0, items: [], ...args.data };
    return cart;
  });
  db.cart.update.mockImplementation(async (args: any) => {
    Object.assign(cart, args.data);
    return cart;
  });
  db.cartItem.findMany.mockImplementation(async (args: any) =>
    cart ? cart.items.filter((i: any) => i.cartId === args.where.cartId) : [],
  );
  db.cartItem.create.mockImplementation(async (args: any) => {
    const item = { id: `line-${cart.items.length + 1}`, ...args.data, options: [] as any[] };
    for (const o of args.data.options?.create ?? []) {
      // Mirror the DB CHECK default: exactly one FK set, the other NULL.
      item.options.push({ id: `opt-${item.id}-${item.options.length + 1}`, cartItemId: item.id, productOptionId: null, optionGroupItemId: null, ...o });
    }
    cart.items.push(item);
    return item;
  });
  db.cartItem.update.mockImplementation(async (args: any) => {
    const item = cart.items.find((i: any) => i.id === args.where.id);
    Object.assign(item, args.data);
    return item;
  });
  db.cartItem.findFirst.mockImplementation(async (args: any) => {
    const item = cart.items.find((i: any) => i.id === args.where.id);
    if (!item) return null;
    return { ...item, cart, product: products.find((p) => p.id === item.productId) };
  });
  db.cartItemOption.deleteMany.mockImplementation(async (args: any) => {
    const item = cart.items.find((i: any) => i.id === args.where.cartItemId);
    const n = item ? item.options.length : 0;
    if (item) item.options = [];
    return { count: n };
  });
  db.cartItemOption.createMany.mockImplementation(async (args: any) => {
    const item = cart.items.find((i: any) => i.cartId === cart.id && i.options.length === 0) ?? cart.items[cart.items.length - 1];
    const target = cart.items.find((l: any) => l.id === (args.data[0] as any).cartItemId) ?? item;
    for (const o of args.data) target.options.push({ id: `opt-${target.id}-${target.options.length + 1}`, ...o });
    return { count: args.data.length };
  });
}

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};
const req = (body: unknown): any =>
  ({ headers: {}, body, params: {}, query: {}, ip: "127.0.0.1", socket: {}, get: () => undefined, user: { id: "cust-1", role: "CUSTOMER", sessionId: "s" } }) as any;
const dataOf = (r: any) => r.json.mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  wire();
  cartRedis.get.mockImplementation(async () => null);
  cartRedis.set.mockImplementation(async () => "OK");
  cartRedis.del.mockImplementation(async () => 1);
});

// ---- A/B: valid selections --------------------------------------------------
describe("new-authority acceptance", () => {
  it("A. accepts a valid active OptionGroupItem", async () => {
    const r = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666"] }), r);
    expect(r.status).toHaveBeenCalledWith(201);
    const line = dataOf(r).items[0];
    expect(line.unitPrice).toBe(2500);
    expect(line.selectedOptions[0]).toMatchObject({ optionGroupItemId: "66666666-6666-4666-8666-666666666666", name: "Chicken", price: 500 });
    expect(line.selectedOptions[0].productOptionId).toBeNull();
  });

  it("B. accepts valid selections across multiple groups", async () => {
    const r = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["77777777-7777-4777-8777-777777777777", "99999999-9999-4999-8999-999999999999"] }), r);
    expect(dataOf(r).items[0].unitPrice).toBe(2000 + 300 + 300);
  });

  it("J. accepts an empty selection when groups allow it", async () => {
    const r = res();
    await addToCart(req({ productId: "22222222-2222-4222-8222-222222222222", optionGroupItemIds: [] }), r);
    expect(r.status).toHaveBeenCalledWith(201);
    expect(dataOf(r).items[0].unitPrice).toBe(1500);
  });
});

// ---- C–E: group rules --------------------------------------------------------
describe("group selection rules", () => {
  it("C. rejects a missing required-group selection", async () => {
    await expect(addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: [] }), res())).rejects.toThrow(ValidationError);
    await expect(
      addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["99999999-9999-4999-8999-999999999999"] }), res()),
    ).rejects.toThrow(ValidationError);
  });

  it("D/E. enforces min and max selections", async () => {
    // max 1 on Protein: two proteins rejected
    await expect(
      addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"] }), res()),
    ).rejects.toThrow(ValidationError);
    // max 2 on Extras is fine with 2 tested in B; single protein + valid extra passes (covered above)
  });
});

// ---- F–I: invalid input ------------------------------------------------------
describe("invalid selections", () => {
  it("F. rejects duplicate ids", async () => {
    await expect(
      addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666", "66666666-6666-4666-8666-666666666666"] }), res()),
    ).rejects.toThrow(ValidationError);
  });

  it("G. rejects an item from another product", async () => {
    await expect(
      addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] }), res()),
    ).rejects.toThrow(ValidationError);
    expect(cart).toBeNull();
  });

  it("H. rejects inactive items", async () => {
    await expect(
      addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666", "88888888-8888-4888-8888-888888888888"] }), res()),
    ).rejects.toThrow(ValidationError);
  });

  it("I. rejects nonexistent ids", async () => {
    await expect(
      addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666", "00000000-0000-4000-8000-000000000000"] }), res()),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects mixing legacy and new ids in one request", async () => {
    await expect(
      addToCart(
        req({ productId: "11111111-1111-4111-8111-111111111111", selectedOptions: ["11111111-1111-4111-8111-111111111111"], optionGroupItemIds: ["66666666-6666-4666-8666-666666666666"] }),
        res(),
      ),
    ).rejects.toThrow(ValidationError);
  });
});

// ---- K–M: pricing -------------------------------------------------------------
describe("pricing", () => {
  it("K. uses Product.price + Σ live priceAdd", async () => {
    const r = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666", "99999999-9999-4999-8999-999999999999"] }), r);
    expect(dataOf(r).items[0].unitPrice).toBe(2800);
    expect(dataOf(r).items[0].subtotal).toBe(2800);
  });

  it("L. ignores client-supplied prices", async () => {
    const r = res();
    await addToCart(
      req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666"], unitPrice: 1, price: 1 } as any),
      r,
    );
    expect(dataOf(r).items[0].unitPrice).toBe(2500);
  });

  it("M. preserves negative priceAdd arithmetic", async () => {
    const r = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] }), r);
    expect(dataOf(r).items[0].unitPrice).toBe(2000 + 500 - 200);
  });
});

// ---- N–O: line identity ---------------------------------------------------------
describe("line identity", () => {
  it("N. [A,B] and [B,A] merge into one line", async () => {
    const r1 = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666", "99999999-9999-4999-8999-999999999999"] }), r1);
    const r2 = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["99999999-9999-4999-8999-999999999999", "66666666-6666-4666-8666-666666666666"] }), r2);
    expect(dataOf(r2).items).toHaveLength(1);
    expect(dataOf(r2).items[0].quantity).toBe(2);
  });

  it("O. different selections stay separate lines", async () => {
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666"] }), res());
    const r = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["77777777-7777-4777-8777-777777777777"] }), r);
    expect(dataOf(r).items).toHaveLength(2);
  });
});

// ---- P–R: legacy compatibility -----------------------------------------------------
describe("legacy compatibility", () => {
  beforeEach(() => {
    products[0].options = [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Legacy Extra", price: 250, isActive: true }];
  });

  it("P. legacy lines remain readable with resolved names", async () => {
    cart = {
      id: "cart-1", customerId: "cust-1", basePrice: 0, totalPrice: 0,
      items: [{
        id: "line-legacy", cartId: "cart-1", productId: "11111111-1111-4111-8111-111111111111", quantity: 1,
        unitPrice: 2250, subtotal: 2250, specialRequest: null,
        options: [{
          id: "cio-1", cartItemId: "line-legacy", productOptionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          optionGroupItemId: null, name: "Legacy Extra", price: 250,
          productOption: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Legacy Extra", price: 250 },
          optionGroupItem: null,
        }],
      }],
    };
    const r = res();
    await getCart(req({}), r);
    const line = dataOf(r).items[0];
    expect(line.selectedOptions[0]).toMatchObject({ productOptionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Legacy Extra", price: 250 });
    expect(line.unitPrice).toBe(2250);
  });

  it("Q/R. new lines store optionGroupItemId with NULL productOptionId", async () => {
    const r = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666"] }), r);
    const stored = cart.items[0].options[0];
    expect(stored.optionGroupItemId).toBe("66666666-6666-4666-8666-666666666666");
    expect(stored.productOptionId).toBeNull();
  });

  it("S. new cart path never writes ProductOption rows", async () => {
    const r = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666"] }), r);
    expect(r.status).toHaveBeenCalledWith(201);
    // The legacy-write freeze holds: db.productOption.* mocks would throw
    // if invoked; reaching here proves no legacy writes occurred.
  });
});

// ---- F-2.17: legacy option visibility and cart cache version -----------------------
describe("F-2.17 legacy option visibility and cache version", () => {
  beforeEach(() => {
    products[0].options = [LEGACY_ACTIVE, LEGACY_INACTIVE];
  });

  it("hides inactive legacy options while retaining active ones", async () => {
    cart = legacyCartWith([]);
    const r = res();
    await getCart(req({}), r);

    const line = dataOf(r).items[0];
    expect(line.product.options).toEqual([
      { id: LEGACY_ACTIVE.id, name: LEGACY_ACTIVE.name, price: LEGACY_ACTIVE.price, selected: false },
    ]);
    expect(line.selectedOptions).toEqual([]);
  });

  it("keeps an already-selected inactive legacy option in selectedOptions", async () => {
    cart = legacyCartWith([{
      id: "cio-1",
      cartItemId: "line-legacy",
      productOptionId: LEGACY_INACTIVE.id,
      optionGroupItemId: null,
      name: LEGACY_INACTIVE.name,
      price: LEGACY_INACTIVE.price,
    }], 2100);
    const r = res();
    await getCart(req({}), r);

    const line = dataOf(r).items[0];
    expect(line.product.options.map((o: any) => o.id)).toEqual([LEGACY_ACTIVE.id]);
    expect(line.selectedOptions[0]).toMatchObject({
      id: "cio-1",
      cartItemId: "line-legacy",
      productOptionId: LEGACY_INACTIVE.id,
      name: LEGACY_INACTIVE.name,
      price: LEGACY_INACTIVE.price,
    });
    // The stale selection remains attached to its line and quote.
    expect(line.unitPrice).toBe(2100);
  });

  it("rejects adding an inactive legacy option ID", async () => {
    const r = res();
    await expect(
      addToCart(req({ productId: PRODUCT_ID, selectedOptions: [LEGACY_INACTIVE.id] }), r),
    ).rejects.toThrow(/no longer available/);
    expect(db.cartItem.create).not.toHaveBeenCalled();
  });

  it("ignores the old unversioned cache and uses the versioned key for reads and writes", async () => {
    cart = legacyCartWith([]);
    const staleCart = {
      id: "cart-1",
      basePrice: 0,
      totalPrice: 0,
      items: [{
        id: "stale-line",
        product: {
          id: PRODUCT_ID,
          name: "Jollof Rice",
          price: 2000,
          images: [],
          video: [],
          vendor: { id: VENDOR.id, name: VENDOR.name },
          options: [
            { id: LEGACY_ACTIVE.id, name: LEGACY_ACTIVE.name, price: LEGACY_ACTIVE.price, selected: false },
            { id: LEGACY_INACTIVE.id, name: LEGACY_INACTIVE.name, price: LEGACY_INACTIVE.price, selected: false },
          ],
          optionGroups: [],
        },
        selectedOptions: [],
      }],
    };
    cartRedis.get.mockImplementation(async (key: string) =>
      key === "cart:user:cust-1" ? JSON.stringify(staleCart) : null,
    );

    const r = res();
    await getCart(req({}), r);

    expect(cartRedis.get).toHaveBeenCalledWith("cart:user:v2:cust-1");
    expect(cartRedis.get).not.toHaveBeenCalledWith("cart:user:cust-1");
    expect(dataOf(r).items[0].product.options.map((o: any) => o.id)).toEqual([LEGACY_ACTIVE.id]);
    expect(cartRedis.set).toHaveBeenCalledWith(
      "cart:user:v2:cust-1",
      expect.any(String),
      { EX: 3600 },
    );
  });

  it("writes the versioned key after add-to-cart", async () => {
    const r = res();
    await addToCart(req({ productId: PRODUCT_ID }), r);
    expect(cartRedis.set).toHaveBeenCalledWith(
      "cart:user:v2:cust-1",
      expect.any(String),
      { EX: 3600 },
    );
  });
});

// ---- update flow ------------------------------------------------------------------
describe("update flow", () => {
  it("replaces options with a validated new selection and reprices", async () => {
    const r1 = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666"] }), r1);
    const lineId = dataOf(r1).items[0].id;
    const r2 = res();
    await updateCartItem(
      { headers: {}, body: { optionGroupItemIds: ["77777777-7777-4777-8777-777777777777", "99999999-9999-4999-8999-999999999999"] }, params: { itemId: lineId }, query: {}, ip: "1", socket: {}, get: () => undefined, user: { id: "cust-1", role: "CUSTOMER", sessionId: "s" } } as any,
      r2,
    );
    const line = dataOf(r2).items.find((l: any) => l.id === lineId);
    expect(line.unitPrice).toBe(2000 + 300 + 300);
    expect(line.selectedOptions.map((o: any) => o.optionGroupItemId).sort()).toEqual(["77777777-7777-4777-8777-777777777777", "99999999-9999-4999-8999-999999999999"]);
  });

  it("quantity-only updates reprice new lines from snapshots", async () => {
    const r1 = res();
    await addToCart(req({ productId: "11111111-1111-4111-8111-111111111111", optionGroupItemIds: ["66666666-6666-4666-8666-666666666666"] }), r1);
    const lineId = dataOf(r1).items[0].id;
    const r2 = res();
    await updateCartItem(
      { headers: {}, body: { quantity: 3 }, params: { itemId: lineId }, query: {}, ip: "1", socket: {}, get: () => undefined, user: { id: "cust-1", role: "CUSTOMER", sessionId: "s" } } as any,
      r2,
    );
    const line = dataOf(r2).items.find((l: any) => l.id === lineId);
    expect(line.quantity).toBe(3);
    expect(line.unitPrice).toBe(2500);
    expect(line.subtotal).toBe(7500);
  });
});

/**
 * Batch E — automatic promotion usage is consumed atomically at checkout.
 *
 * Automatic (codeless) promotions were filtered by `usageLimit` at load
 * time but never consumed it: concurrent checkouts could all redeem past
 * the cap without ever exhausting it. The checkout transaction now
 * row-locks each winning auto promo, re-checks the cap, conditionally
 * increments `usedCount`, and records a usage row — mirroring the code
 * path. Failed checkouts roll everything back; committed checkouts replay
 * via idempotency and never re-enter.
 *
 * Drives the REAL `checkoutCart` (mocked Prisma/Redis/summary only).
 * Conditional-write races are simulated deterministically via
 * `updateMany` counts — not real PostgreSQL concurrency.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
    product: { findMany: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    cart: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(async () => ({})) },
    cartItem: { findMany: jest.fn(), deleteMany: jest.fn(async () => ({})), count: jest.fn(), update: jest.fn() },
    cartItemOption: { deleteMany: jest.fn(async () => ({})) },
    optionGroup: { findMany: jest.fn(async () => []) },
    cartSummarySnapshot: { findUnique: jest.fn(), delete: jest.fn(async () => ({})) },
    address: { findFirst: jest.fn() },
    order: { findMany: jest.fn(), create: jest.fn() },
    // Phase 1: checkout writes an ORDER_CREATED audit row instead of the old
    // vendor "New Order Received" activity bundle.
    auditLog: { create: jest.fn(async () => ({})) },
    promotion: { findUnique: jest.fn(), findMany: jest.fn(async () => []), updateMany: jest.fn() },
    promotionUsage: { count: jest.fn(async () => 0), create: jest.fn() },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn(), scan: jest.fn(async () => ({ cursor: "0", keys: [] as string[] })) },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn(async () => 1), scan: jest.fn(async () => ({ cursor: "0", keys: [] as string[] })) },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisNotifications: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => 1) },
  redisTotalViews: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => 1) },
  redisUsersSessions: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => 1) },
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

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => ({})),
  clearProductsCache: jest.fn(async () => ({})),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => ({})),
}));

import prisma from "../../src/lib/prisma";
import { cartSummaryService } from "../../src/services/cartSummary.service";
import { checkoutCart } from "../../src/controllers/cartController";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedSummary = cartSummaryService as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

let reqKeySeq = 1000;
const req = (overrides: Partial<any> = {}): any =>
  ({
    headers: { "idempotency-key": `auto-promo-${++reqKeySeq}` },
    body: { summaryId: "snap-1", addressId: "addr-1" },
    params: {},
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "cust-1", role: "CUSTOMER", sessionId: "sess" },
    ...overrides,
  }) as any;

const cartItem = (overrides: any = {}) => ({
  id: "item-1",
  productId: "prod-1",
  quantity: 2,
  unitPrice: 2500,
  subtotal: 5000,
  options: [],
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
  price: 2500,
  archived: false,
  trackInventory: true,
  stock: 10,
  vendorId: "vendor-1",
  options: [],
  ...overrides,
});

/** Summary where a 10% automatic promo won: ₦500 off, promo auto-1. */
function autoWinSummary() {
  return {
    warnings: [],
    finalTotal: 4500,
    promo: { code: null, applied: false, promoId: null, meta: null },
    discount: 500,
    vendorBreakdown: [
      {
        vendorId: "vendor-1",
        discount: 500,
        deliveryFee: 0,
        items: [{ productId: "prod-1", quantity: 2, unitDiscount: 250, promotionId: "auto-1" }],
      },
    ],
  };
}

function baseMocks() {
  db.address.findFirst.mockResolvedValue({ id: "addr-1", userId: "cust-1" });
  db.cartSummarySnapshot.findUnique.mockResolvedValue({
    id: "snap-1",
    userId: "cust-1",
    createdAt: new Date(),
    snapshot: { finalTotal: 4500, promo: null, vendorBreakdown: [{ vendorId: "vendor-1" }] },
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
  mockedSummary.mockResolvedValue(autoWinSummary());
  db.order.create.mockImplementation(async (args: any) => ({ ...args.data, id: "order-1" }));
  // Auto promo auto-1: cap 100, 41 used — claimable.
  db.promotion.findUnique.mockResolvedValue({ usageLimit: 100, usedCount: 41, maxUsesPerUser: 2 });
  db.promotion.updateMany.mockResolvedValue({ count: 1 });
  db.promotionUsage.count.mockResolvedValue(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  baseMocks();
});

function autoUsageRows() {
  return db.promotionUsage.create.mock.calls.map((c) => c[0].data);
}

describe("Batch E — automatic promotion usage enforcement", () => {
  it("1. winning auto promos are claimed atomically with an AUTO usage row", async () => {
    await checkoutCart(req(), res());

    // Row lock + limit re-check + conditional increment, in-transaction.
    expect(db.promotion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "auto-1" }),
        data: { usedCount: { increment: 1 } },
      }),
    );
    const rows = autoUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      promotionId: "auto-1",
      userId: "cust-1",
      promoCode: "AUTO",
      discount: 500, // 250 kobo × 2 units; unitDiscount is integer kobo (Phase 3A)
      orderIds: ["order-1"],
    });
  });

  it("2. an exhausted auto promo rejects checkout without creating orders", async () => {
    db.promotion.findUnique.mockResolvedValue({ usageLimit: 100, usedCount: 100, maxUsesPerUser: 2 });

    await expect(checkoutCart(req(), res())).rejects.toMatchObject({ statusCode: 409 });
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.promotionUsage.create).not.toHaveBeenCalled();
  });

  it("3. losing the last-slot race rejects without consuming usage", async () => {
    db.promotion.findUnique.mockResolvedValue({ usageLimit: 100, usedCount: 99, maxUsesPerUser: 2 });
    db.promotion.updateMany.mockResolvedValue({ count: 0 }); // concurrent winner committed first

    await expect(checkoutCart(req(), res())).rejects.toMatchObject({ statusCode: 409 });
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.promotionUsage.create).not.toHaveBeenCalled();
  });

  it("4. code-winning checkouts do not touch the auto path", async () => {
    mockedSummary.mockResolvedValue({
      warnings: [],
      finalTotal: 4000,
      promo: { code: "SAVE", applied: true, promoId: "code-1", meta: null },
      discount: 1000,
      vendorBreakdown: [
        {
          vendorId: "vendor-1",
          discount: 1000,
          deliveryFee: 0,
          items: [{ productId: "prod-1", quantity: 2, unitDiscount: 0, promotionId: "code-1" }],
        },
      ],
    });
    db.cartSummarySnapshot.findUnique.mockResolvedValue({
      id: "snap-1",
      userId: "cust-1",
      createdAt: new Date(),
      snapshot: { finalTotal: 4000, promo: { code: "SAVE" }, vendorBreakdown: [{ vendorId: "vendor-1" }] },
    });
    db.promotion.findUnique.mockResolvedValue({ usageLimit: 50, usedCount: 10, maxUsesPerUser: 1 });

    await checkoutCart(req(), res());

    const rows = autoUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].promotionId).toBe("code-1");
    expect(rows[0].promoCode).toBe("SAVE");
    // The code claim ran once; no AUTO rows exist.
    expect(rows.some((r: any) => r.promoCode === "AUTO")).toBe(false);
  });

  it("5. failed checkout creates no usage row (claim rolls back with the transaction)", async () => {
    db.order.create.mockRejectedValueOnce(new Error("STOP_AFTER_CLAIM"));

    await expect(checkoutCart(req(), res())).rejects.toThrow("STOP_AFTER_CLAIM");
    // The increment was issued inside the aborted transaction (rolled back
    // in PostgreSQL); the usage row — created after orders — never ran.
    expect(db.promotionUsage.create).not.toHaveBeenCalled();
  });

  it("6. repeat buyers are not rejected: per-user caps stay out of the auto claim", async () => {
    // A customer who already used this auto promo checks out again. The
    // global cap still has room, so checkout succeeds — the claim enforces
    // the global limit only (per-user policy documented as a data decision).
    db.promotionUsage.count.mockResolvedValue(3);
    await checkoutCart(req(), res());

    expect(db.promotion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "auto-1" }) }),
    );
    expect(autoUsageRows()).toHaveLength(1);
  });
});

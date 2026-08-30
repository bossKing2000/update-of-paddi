/**
 * Vendor Live lifecycle — integration-level verification.
 *
 * Covers the full flow required by the migration spec, using mocked
 * infrastructure (Prisma/Redis) but the REAL availability logic:
 *
 *   offline vendor → products NOT orderable
 *     ↓ PATCH /api/vendor/settings/live → true (+ cache invalidation)
 *   online vendor → products orderable
 *     ↓ PATCH /api/vendor/settings/live → false (+ cache invalidation)
 *   offline again → NOT orderable
 *
 * Plus the critical invariant: an offline vendor can never have a NEW
 * purchase created — neither through checkout (even with a stale cart
 * snapshot taken while the vendor was still online) nor through either
 * payment-initialization path.
 */

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    product: { findUnique: jest.fn() },
    cart: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    cartItem: { create: jest.fn(), update: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
    cartItemOption: { deleteMany: jest.fn() },
    cartSummarySnapshot: { findUnique: jest.fn(), delete: jest.fn() },
    address: { findFirst: jest.fn() },
    order: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
    payment: { create: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn(async (cb: any) => {
      // Provide transaction client as the mocked prisma itself
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn() },
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(),
}));

jest.mock("../../src/services/cartSummary.service", () => ({
  __esModule: true,
  cartSummaryService: jest.fn(),
}));

jest.mock("../../src/services/paymentService", () => ({
  __esModule: true,
  initializePayment: jest.fn(),
  verifyPayment: jest.fn(),
  cancelOrdersForOfflineProduct: jest.fn(),
}));

jest.mock("../../src/services/paymentFinalizer.service", () => ({
  __esModule: true,
  finalizePaymentSuccess: jest.fn(),
}));

import prisma from "../../src/lib/prisma";
import { ShopCartRedis, redisProducts } from "../../src/lib/redis";
import { scanKeys } from "../../src/lib/redisScan";
import { cartSummaryService } from "../../src/services/cartSummary.service";
import { initializePayment } from "../../src/services/paymentService";
import { ValidationError } from "../../src/errors/AppError";

import { updateVendorLive } from "../../src/controllers/vendorSettingsController";
import { addToCart, checkoutCart } from "../../src/controllers/cartController";
import { initiateOrderPayment } from "../../src/controllers/paymentController";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedScanKeys = scanKeys as unknown as jest.Mock;
const mockedSummary = cartSummaryService as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const PRODUCT_UUID = "11111111-1111-4111-8111-111111111111";

const req = (overrides: Partial<any> = {}): any =>
  ({
    headers: {},
    body: {},
    params: {},
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "cust-1", role: "CUSTOMER", sessionId: "sess" },
    ...overrides,
  }) as any;

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// 1+5. Toggle lifecycle + cache invalidation
// ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/vendor/settings/live — lifecycle", () => {
  const vendorReq = (isLive: boolean): any =>
    req({
      user: { id: "vendor-1", role: "VENDOR", sessionId: "sess" },
      body: { isLive },
    });

  it("offline → live: flips state, invalidates marketplace caches, audits", async () => {
    db.user.findUnique.mockResolvedValue({ kycStatus: "VERIFIED" });
    db.user.update.mockResolvedValue({ isLive: true });
    mockedScanKeys.mockResolvedValue(["home:feed:x"]);

    await updateVendorLive(vendorReq(true), res());

    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isLive: true } }),
    );
    // All three vendor-dependent marketplace namespaces are invalidated
    const scanned = mockedScanKeys.mock.calls.map((c) => c[1]);
    expect(scanned).toEqual(["home:feed:*", "products:mostPopular:*", "products:all:*"]);
    expect(redisProducts.del).toHaveBeenCalledWith(["home:feed:x"]);
  });

  it("live → offline: flips state and invalidates the same caches", async () => {
    db.user.update.mockResolvedValue({ isLive: false });
    mockedScanKeys.mockResolvedValue([]);

    await updateVendorLive(vendorReq(false), res());

    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isLive: false } }),
    );
    expect(mockedScanKeys).toHaveBeenCalledTimes(3);
  });

  it("refuses to go live without VERIFIED KYC and touches nothing", async () => {
    db.user.findUnique.mockResolvedValue({ kycStatus: "PENDING" });

    await expect(updateVendorLive(vendorReq(true), res())).rejects.toThrow(ValidationError);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(mockedScanKeys).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Cart: add gated by vendor state; items survive offline vendors
// ─────────────────────────────────────────────────────────────────────

describe("addToCart — vendor live gate", () => {
  const product = {
    id: PRODUCT_UUID,
    archived: false,
    isLive: true,
    productSchedule: null,
    price: 1000,
    vendorId: "vendor-1",
    options: [],
  };

  it("rejects adding a product whose vendor is offline", async () => {
    db.product.findUnique.mockResolvedValue(product);
    db.user.findUnique.mockResolvedValue({ id: "vendor-1", isLive: false, deliveryPreferences: {} });

    await expect(addToCart(req({ body: { productId: PRODUCT_UUID, quantity: 1 } }), res())).rejects.toThrow(
      /currently offline/,
    );
    expect(db.cartItem.create).not.toHaveBeenCalled();
  });

  it("rejects adding a product whose vendor paused orders", async () => {
    db.product.findUnique.mockResolvedValue(product);
    db.user.findUnique.mockResolvedValue({
      id: "vendor-1",
      isLive: true,
      deliveryPreferences: { acceptingOrders: false },
    });

    await expect(addToCart(req({ body: { productId: PRODUCT_UUID, quantity: 1 } }), res())).rejects.toThrow(
      /paused new orders/,
    );
    expect(db.cartItem.create).not.toHaveBeenCalled();
  });

  it("accepts adding a product from an operating vendor", async () => {
    db.product.findUnique.mockResolvedValue(product);
    db.user.findUnique.mockResolvedValue({
      id: "vendor-1",
      isLive: true,
      deliveryPreferences: { acceptingOrders: true },
    });
    db.cart.findFirst.mockResolvedValue({ id: "cart-1", customerId: "cust-1", items: [] });
    db.cartItem.findMany.mockResolvedValue([{ quantity: 1, subtotal: 1000 }]);
    db.cart.update.mockResolvedValue({});
    db.cart.findUnique.mockResolvedValue(null); // enhanced cart unavailable — fine
    db.cartItem.create.mockResolvedValue({ id: "item-1" });

    await addToCart(req({ body: { productId: PRODUCT_UUID, quantity: 1 } }), res());

    expect(db.cartItem.create).toHaveBeenCalled();
    expect(ShopCartRedis.set).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Checkout: authoritative DB state decides — stale clients cannot win
// ─────────────────────────────────────────────────────────────────────

const checkoutBase = (cartItems: any[]) => {
  db.address.findFirst.mockResolvedValue({ id: "addr-1", userId: "cust-1" });
  db.cartSummarySnapshot.findUnique.mockResolvedValue({
    id: "snap-1",
    userId: "cust-1",
    createdAt: new Date(),
    promo: null,
    snapshot: {
      finalTotal: 2000,
      promo: null,
      vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
    },
  });
  db.cart.findFirst.mockResolvedValue({
    id: "cart-1",
    customerId: "cust-1",
    items: cartItems,
  });
};

const cartItemFrom = (vendor: Record<string, unknown>) => ({
  id: "item-1",
  productId: "prod-1",
  quantity: 2,
  unitPrice: 1000,
  subtotal: 2000,
  options: [],
  product: {
    id: "prod-1",
    name: "Jollof",
    archived: false,
    isLive: true, // mirror says live…
    vendorId: "vendor-1",
    vendor, // …but THIS is what the rule reads
    productSchedule: null,
    options: [],
  },
});

describe("checkoutCart — vendor live invariant", () => {
  it("blocks checkout when the vendor went OFFLINE before checkout, keeping the item in the cart", async () => {
    checkoutBase([
      cartItemFrom({ id: "vendor-1", name: "Mama Put", isLive: false, deliveryPreferences: {} }),
    ]);

    await expect(
      checkoutCart(req({ body: { summaryId: "snap-1", addressId: "addr-1" } }), res()),
    ).rejects.toThrow(/currently orderable/i);

    // Item was NOT deleted — it remains in the cart for when the vendor returns
    expect(db.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("blocks checkout when the vendor goes offline AFTER the snapshot/filter — stale client state cannot bypass the fresh DB revalidation", async () => {
    // Cart snapshot taken while vendor appeared online…
    checkoutBase([
      cartItemFrom({ id: "vendor-1", name: "Mama Put", isLive: true, deliveryPreferences: {} }),
    ]);
    // …lock acquired, pricing unchanged…
    db.cart.updateMany.mockResolvedValue({ count: 1 });
    mockedSummary.mockResolvedValue({
      warnings: [],
      finalTotal: 2000,
      vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
    });
    // …but the FRESH database read inside order creation finds the vendor offline
    db.user.findUnique.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.id === "cust-1"
          ? { name: "Test Customer" }
          : { id: "vendor-1", isLive: false, deliveryPreferences: {} },
      ),
    );

    await expect(
      checkoutCart(req({ body: { summaryId: "snap-1", addressId: "addr-1" } }), res()),
    ).rejects.toThrow(/currently offline/);

    // The invariant: NO purchase was created
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("proceeds past the per-vendor revalidation when the fresh DB read shows the vendor operating", async () => {
    checkoutBase([
      cartItemFrom({ id: "vendor-1", name: "Mama Put", isLive: true, deliveryPreferences: {} }),
    ]);
    db.cart.updateMany.mockResolvedValue({ count: 1 });
    mockedSummary.mockResolvedValue({
      warnings: [],
      finalTotal: 2000,
      vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
    });
    db.user.findUnique.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.id === "cust-1"
          ? { name: "Test Customer" }
          : { id: "vendor-1", isLive: true, deliveryPreferences: { acceptingOrders: true } },
      ),
    );

    // Run far enough to prove the gate opened: order creation begins.
    // (Deep order-creation internals are out of scope for this verification.)
    db.order.create.mockRejectedValue(new Error("STOP_AFTER_GATE"));

    await expect(
      checkoutCart(req({ body: { summaryId: "snap-1", addressId: "addr-1" } }), res()),
    ).rejects.toThrow("STOP_AFTER_GATE");

    expect(db.order.create).toHaveBeenCalled(); // gate passed; creation started
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Payment initiation — both paths refuse offline vendors
// ─────────────────────────────────────────────────────────────────────

const payableOrder = (vendorIsLive: boolean | null) => ({
  id: "order-1",
  vendorId: "vendor-1",
  customerId: "cust-1",
  status: "AWAITING_PAYMENT",
  totalPrice: 2000,
  payments: [],
  items: [
    {
      product: {
        id: "prod-1",
        name: "Jollof",
        isLive: true,
        productSchedule: { takeDownAt: new Date(Date.now() + 60 * 60_000), graceMinutes: 0 },
      },
    },
  ],
});

describe("initiateOrderPayment — vendor live gate on every payment path", () => {
  it("rejects payment initiation when the vendor went offline after checkout", async () => {
    db.order.findMany.mockResolvedValue([payableOrder(false)]);
    db.user.findMany.mockResolvedValue([
      { id: "vendor-1", name: "Mama Put", brandName: null, isLive: false, deliveryPreferences: {} },
    ]);

    await expect(
      initiateOrderPayment(req({ body: { idempotencyKey: "idem-1" } }), res()),
    ).rejects.toThrow(/currently offline/);

    expect(initializePayment).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled(); // nothing marked paid/initiated
  });

  it("lets payment proceed when the vendor is operating (gate opens)", async () => {
    const online = payableOrder(true);
    db.order.findMany.mockResolvedValue([online]);
    db.user.findMany.mockResolvedValue([
      { id: "vendor-1", name: "Mama Put", brandName: null, isLive: true, deliveryPreferences: {} },
    ]);
    db.user.findUnique.mockResolvedValue({ email: "c@test.com" });
    db.order.updateMany.mockResolvedValue({ count: 1 });
    (initializePayment as jest.Mock).mockResolvedValue({
      reference: "ref-123",
      authorization_url: "https://paystack.com/pay/ref-123",
    });
    db.payment.create.mockResolvedValue({ id: "pay-1" });

    await initiateOrderPayment(req({ body: { idempotencyKey: "idem-2" } }), res());

    expect(initializePayment).toHaveBeenCalled();
    expect(db.payment.create).toHaveBeenCalled();
  });
});

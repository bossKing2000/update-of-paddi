/**
 * Checkout idempotency rules (Phase 1B.2-D):
 * - key scoped userId + endpoint, Redis 24h TTL, atomic SET NX
 * - same key + same payload -> stored response, no new order/payment
 * - same key + different payload -> 422
 * - in-flight -> 409
 * - failure releases the claim (no poisoning)
 */
import {
  claimCheckoutKey,
  completeCheckoutKey,
  releaseCheckoutKey,
  checkoutPayloadHash,
} from "../../src/services/checkoutIdempotency.service";
import { ConflictError, UnprocessableEntityError } from "../../src/errors/AppError";

jest.mock("../../src/lib/redis", () => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const get = jest.fn(async (key: string) => {
    const e = store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      store.delete(key);
      return null;
    }
    return e.value;
  });
  const set = jest.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
    if (opts?.NX && store.has(key)) return null;
    store.set(key, { value, expiresAt: Date.now() + (opts?.EX ?? 3600) * 1000 });
    return "OK";
  });
  const del = jest.fn(async (key: string) => (store.delete(key) ? 1 : 0));
  return {
    __esModule: true,
    redisPayments: { get, set, del, store },
    redisProducts: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
    ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
  };
});

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    product: { findMany: jest.fn() },
    promotion: { findMany: jest.fn(async () => []) },
    cart: { findFirst: jest.fn(), updateMany: jest.fn() },
    cartItem: { findMany: jest.fn(), update: jest.fn() },
    address: { findFirst: jest.fn() },
    order: { findMany: jest.fn(), create: jest.fn() },
    cartSummarySnapshot: { findUnique: jest.fn() },
  },
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

import { redisPayments } from "../../src/lib/redis";
import prisma from "../../src/lib/prisma";
import { checkoutCart } from "../../src/controllers/cartController";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const redis = redisPayments as unknown as {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  store: Map<string, { value: string; expiresAt: number }>;
};

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const H = (summaryId = "snap-1", addressId = "addr-1") => checkoutPayloadHash({ summaryId, addressId });

beforeEach(() => {
  jest.clearAllMocks();
  redis.store.clear();
});

describe("claim mechanics", () => {
  it("claims with a user+endpoint scoped key, NX, 24h TTL", async () => {
    const out = await claimCheckoutKey("u-1", "k-1", H());
    expect(out).toEqual({ action: "proceed" });
    expect(redis.set).toHaveBeenCalledWith(
      "idem:checkout:u-1:k-1",
      expect.any(String),
      { NX: true, EX: 24 * 3600 },
    );
  });

  it("same key + same payload replays the stored response", async () => {
    await claimCheckoutKey("u-1", "k-2", H());
    await completeCheckoutKey("u-1", "k-2", H(), { orders: [{ id: "o-1" }] });
    const out = await claimCheckoutKey("u-1", "k-2", H());
    expect(out).toEqual({ action: "replay", response: { orders: [{ id: "o-1" }] } });
  });

  it("same key + different payload is a mismatch", async () => {
    await claimCheckoutKey("u-1", "k-3", H());
    await completeCheckoutKey("u-1", "k-3", H(), { orders: [] });
    const out = await claimCheckoutKey("u-1", "k-3", H("other-snap", "addr-1"));
    expect(out).toEqual({ action: "mismatch" });
  });

  it("a fresh in-flight claim is a conflict", async () => {
    await claimCheckoutKey("u-1", "k-4", H());
    const out = await claimCheckoutKey("u-1", "k-4", H());
    expect(out).toEqual({ action: "conflict" });
  });

  it("a stale in-flight claim is reclaimed, not poisonous", async () => {
    redis.store.set("idem:checkout:u-1:k-5", {
      value: JSON.stringify({ status: "in-flight", payloadHash: H(), claimedAt: Date.now() - 10 * 60 * 1000 }),
      expiresAt: Date.now() + 3600 * 1000,
    });
    const out = await claimCheckoutKey("u-1", "k-5", H());
    expect(out).toEqual({ action: "proceed" });
  });

  it("release deletes the claim", async () => {
    await claimCheckoutKey("u-1", "k-6", H());
    await releaseCheckoutKey("u-1", "k-6");
    expect(await redis.get("idem:checkout:u-1:k-6")).toBeNull();
  });
});

describe("checkoutCart wiring", () => {
  const cartWithOtherVendorsProduct = () => ({
    id: "cart-1",
    customerId: "cust-1",
    items: [
      {
        id: "item-1",
        productId: "prod-1",
        quantity: 1,
        unitPrice: 2000,
        subtotal: 2000,
        options: [],
        product: {
          id: "prod-1",
          archived: false,
          trackInventory: false,
          stock: null,
          vendorId: "vendor-9",
          vendor: { id: "vendor-9", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } },
        },
      },
    ],
  });

  const freshProduct = () => ({
    id: "prod-1",
    name: "Jollof",
    price: 2000,
    archived: false,
    trackInventory: false,
    stock: null,
    vendorId: "vendor-9",
    options: [],
  });

  function earlyMocks() {
    db.order.findMany.mockResolvedValue([]);
    db.address.findFirst.mockResolvedValue({ id: "addr-1", userId: "cust-1" });
    db.cartSummarySnapshot.findUnique.mockResolvedValue({
      id: "snap-1",
      userId: "cust-1",
      createdAt: new Date(),
      snapshot: { finalTotal: 2000, vendorBreakdown: [{ vendorId: "vendor-9", discount: 0, deliveryFee: 0 }] },
    });
    db.user.findUnique.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.id === "cust-1"
          ? { email: "c@test.com", name: "C" }
          : { id: "vendor-9", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } },
      ),
    );
    db.cart.findFirst.mockResolvedValue(cartWithOtherVendorsProduct());
    db.product.findMany.mockResolvedValue([freshProduct()]);
    db.cart.updateMany.mockResolvedValue({ count: 1 });
  }

  const req = (key: string): any =>
    ({
      headers: { "idempotency-key": key },
      body: { summaryId: "snap-1", addressId: "addr-1" },
      params: {},
      query: {},
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      get: () => undefined,
      user: { id: "cust-1", role: "CUSTOMER", sessionId: "sess" },
    }) as any;

  it("same key + same payload returns the stored response and creates nothing", async () => {
    earlyMocks();
    await claimCheckoutKey("cust-1", "replay-key", H());
    await completeCheckoutKey("cust-1", "replay-key", H(), { orders: [{ id: "stored-1" }] });

    const r = res();
    await checkoutCart(req("replay-key"), r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orders: [{ id: "stored-1" }] } }),
    );
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("same key + different payload is 422 and keeps the stored record", async () => {
    db.order.findMany.mockResolvedValue([]);
    db.address.findFirst.mockResolvedValue({ id: "addr-2", userId: "cust-1" });
    db.cartSummarySnapshot.findUnique.mockResolvedValue({
      id: "snap-2",
      userId: "cust-1",
      createdAt: new Date(),
      snapshot: { finalTotal: 2000, vendorBreakdown: [{ vendorId: "vendor-9", discount: 0, deliveryFee: 0 }] },
    });
    db.user.findUnique.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.id === "cust-1"
          ? { email: "c@test.com", name: "C" }
          : { id: "vendor-9", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } },
      ),
    );
    db.cart.findFirst.mockResolvedValue(cartWithOtherVendorsProduct());
    db.product.findMany.mockResolvedValue([freshProduct()]);
    db.cart.updateMany.mockResolvedValue({ count: 1 });

    await claimCheckoutKey("cust-1", "clash-key", H());
    await completeCheckoutKey("cust-1", "clash-key", H(), { orders: [{ id: "stored-1" }] });

    const clashReq: any = {
      ...req("clash-key"),
      body: { summaryId: "snap-2", addressId: "addr-2" },
    };
    await expect(checkoutCart(clashReq, res())).rejects.toThrow(UnprocessableEntityError);
    // Stored record untouched — the original key owner can still replay.
    expect(await redis.get("idem:checkout:cust-1:clash-key")).not.toBeNull();
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("same key while in flight is 409", async () => {
    earlyMocks();
    await claimCheckoutKey("cust-1", "flight-key", H());

    await expect(checkoutCart(req("flight-key"), res())).rejects.toThrow(ConflictError);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it("a failed checkout releases the claim so the same key can be retried", async () => {
    const { cartSummaryService } = require("../../src/services/cartSummary.service") as { cartSummaryService: jest.Mock };
    earlyMocks();
    cartSummaryService.mockResolvedValue({ warnings: ["out of range"], finalTotal: 0, vendorBreakdown: [] });

    await expect(checkoutCart(req("poison-key"), res())).rejects.toThrow(/out of range/i);
    expect(await redis.get("idem:checkout:cust-1:poison-key")).toBeNull();

    // Retry with the same key gets past the claim (fails again on business
    // validation, not on 409) — the key was not poisoned.
    await expect(checkoutCart(req("poison-key"), res())).rejects.toThrow(/out of range/i);
  });
});

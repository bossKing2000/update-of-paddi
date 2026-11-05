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
import { AppError, ConflictError, UnprocessableEntityError } from "../../src/errors/AppError";

jest.mock("../../src/lib/redis", () => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  // Flip to simulate an unreachable Redis. Mirrors the `fail` toggle already
  // provided by tests/helpers/fakeRedis.ts, which this file's inline mock
  // predates; kept local so the shared helper stays untouched.
  const state = { fail: false };
  const get = jest.fn(async (key: string) => {
    if (state.fail) throw new Error("redis down");
    const e = store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      store.delete(key);
      return null;
    }
    return e.value;
  });
  const set = jest.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
    if (state.fail) throw new Error("redis down");
    if (opts?.NX && store.has(key)) return null;
    store.set(key, { value, expiresAt: Date.now() + (opts?.EX ?? 3600) * 1000 });
    return "OK";
  });
  const del = jest.fn(async (key: string) => (store.delete(key) ? 1 : 0));
  return {
    __esModule: true,
    redisPayments: { get, set, del, store, __state: state },
    redisProducts: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
    ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
  };
});

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    product: { findMany: jest.fn() },
    // Phase 2B.5b: checkout batch-loads option groups for new-authority lines.
    optionGroup: { findMany: jest.fn(async () => []) },
    promotion: { findMany: jest.fn(async () => []) },
    cart: { findFirst: jest.fn(), updateMany: jest.fn() },
    cartItem: { findMany: jest.fn(), update: jest.fn() },
    address: { findFirst: jest.fn() },
    order: { findMany: jest.fn(), create: jest.fn() },
    // Phase 1: checkout writes an ORDER_CREATED audit row instead of the old
    // vendor "New Order Received" activity bundle.
    auditLog: { create: jest.fn(async () => ({})) },
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
  __state: { fail: boolean };
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
  redis.__state.fail = false;
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


// ─────────────────────────────────────────────────────────────────────────────
// Fail-CLOSED behaviour (Batch 1E.35).
//
// Checkout is the operation that charges a customer and decrements stock, so
// an unconfirmed idempotency claim must NOT degrade into an unrestricted
// checkout. These tests pin the regression directly.
// ─────────────────────────────────────────────────────────────────────────────
describe("Redis outage fails closed", () => {
  it("the claim itself reports unavailable rather than proceeding", async () => {
    redis.__state.fail = true;

    const out = await claimCheckoutKey("u-1", "k-redis-down", H());

    expect(out).toEqual({ action: "unavailable" });
  });

  it("no order is created and no payment is initiated when Redis is down", async () => {
    redis.__state.fail = true;
    earlyMocks();

    await expect(checkoutCart(req("redis-down-key"), res())).rejects.toThrow(AppError);

    // The decisive assertions: nothing was created, nothing was charged.
    expect(db.order.create).not.toHaveBeenCalled();
    const { initializePayment } = require("../../src/services/paymentService") as {
      initializePayment: jest.Mock;
    };
    expect(initializePayment).not.toHaveBeenCalled();
  });

  it("the 503 is retryable and leaks no infrastructure detail", async () => {
    redis.__state.fail = true;
    earlyMocks();

    const err = await checkoutCart(req("redis-down-503"), res()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.statusCode).toBe(503);
    expect(appErr.code).toBe("IDEMPOTENCY_UNAVAILABLE");
    // No mention of Redis, sockets, hosts or connection details.
    const rendered = JSON.stringify(appErr.message).toLowerCase();
    for (const leak of ["redis", "econnrefused", "timeout", "127.0.0.1", "socket"]) {
      expect(rendered).not.toContain(leak);
    }
  });

  it("a request AFTER a prior Redis error proceeds normally", async () => {
    redis.__state.fail = true;
    earlyMocks();
    await expect(checkoutCart(req("recover-key"), res())).rejects.toThrow(AppError);

    // Redis recovers — the key must not be left poisoned.
    redis.__state.fail = false;
    const out = await claimCheckoutKey("cust-1", "recover-key", H());
    expect(out).toEqual({ action: "proceed" });
  });

  it("an unconfirmed NX race also fails closed instead of proceeding", async () => {
    // Simulates the ambiguous case: SET NX did not win, and the re-read comes
    // back empty because the store cannot be read. Proceeding here would be
    // the dangerous choice, so it must report unavailable.
    redis.set.mockResolvedValueOnce(null);
    redis.get.mockResolvedValueOnce(null);

    const out = await claimCheckoutKey("u-1", "k-nx-race", H());

    expect(out).toEqual({ action: "unavailable" });
  });

  it("normal behaviour is preserved when Redis is healthy", async () => {
    // Regression guard: the fail-closed change must not disturb the happy path.
    expect(await claimCheckoutKey("u-1", "k-ok", H())).toEqual({ action: "proceed" });
    await completeCheckoutKey("u-1", "k-ok", H(), { orders: [{ id: "stored" }] });
    expect(await claimCheckoutKey("u-1", "k-ok", H())).toEqual({
      action: "replay",
      response: { orders: [{ id: "stored" }] },
    });
    expect(await claimCheckoutKey("u-1", "k-ok", H("other", "other"))).toEqual({ action: "mismatch" });
    expect(await claimCheckoutKey("u-1", "k-busy", H())).toEqual({ action: "proceed" });
    expect(await claimCheckoutKey("u-1", "k-busy", H())).toEqual({ action: "conflict" });
  });
});
});

// ---------------------------------------------------------------------------
// Batch 1D.59 follow-up — completion-recording failure.
//
// completeCheckoutKey used to swallow its Redis error, so the caller could not
// tell a recorded completion from a lost one. It now reports success/failure,
// which is what lets the controller release the claim (and let the DB replay
// check recover the committed order) instead of stranding retries behind a
// stale in-flight 409.
// ---------------------------------------------------------------------------
describe("completeCheckoutKey failure reporting", () => {
  it("returns true when the completion write succeeds", async () => {
    expect(await completeCheckoutKey("u-1", "k-complete-ok", H(), { orders: [{ id: "o-1" }] })).toBe(true);
  });

  it("returns false when the completion write fails, and never throws", async () => {
    redis.__state.fail = true;
    await expect(
      completeCheckoutKey("u-1", "k-complete-fail", H(), { orders: [{ id: "o-1" }] }),
    ).resolves.toBe(false);
    redis.__state.fail = false;
  });

  it("a lost completion leaves the claim in-flight, so releasing it is required before a retry can proceed", async () => {
    expect(await claimCheckoutKey("u-1", "k-stuck", H())).toEqual({ action: "proceed" });

    redis.__state.fail = true;
    expect(await completeCheckoutKey("u-1", "k-stuck", H(), { orders: [{ id: "o-1" }] })).toBe(false);
    redis.__state.fail = false;

    // The record is still "in-flight" and fresh: a retry is refused as a
    // conflict. This is exactly why silently swallowing the failure was
    // harmful — the key would stay unusable for up to five minutes.
    expect(await claimCheckoutKey("u-1", "k-stuck", H())).toEqual({ action: "conflict" });

    // Releasing (what the controller now does on failure) restores retrying.
    await releaseCheckoutKey("u-1", "k-stuck");
    expect(await claimCheckoutKey("u-1", "k-stuck", H())).toEqual({ action: "proceed" });
  });

  it("a lost completion does not falsify the record as complete", async () => {
    expect(await claimCheckoutKey("u-1", "k-not-fake", H())).toEqual({ action: "proceed" });
    redis.__state.fail = true;
    expect(await completeCheckoutKey("u-1", "k-not-fake", H(), { orders: [{ id: "o-1" }] })).toBe(false);
    redis.__state.fail = false;
    // Nothing was recorded, so the store holds no complete record to replay
    // (the key is absent entirely once the caller releases it).
    await releaseCheckoutKey("u-1", "k-not-fake");
    expect(await redis.get("idem:checkout:u-1:k-not-fake")).toBeNull();
  });
});

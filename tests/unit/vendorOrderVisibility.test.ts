/**
 * Phase 1 — vendor order visibility and payment-gated notifications.
 *
 * WHAT IS BEING PROVEN
 * --------------------
 * Checkout creates `Order` rows in `AWAITING_PAYMENT` before the customer has
 * paid. Until `finalizePaymentSuccess` wins its compare-and-set and moves the
 * order to `PAYMENT_CONFIRMED`, that order must not be visible to the vendor —
 * not in a list, not by direct id, not in a dashboard count or activity feed —
 * and checkout must not announce it to the vendor.
 *
 * WHAT THESE TESTS DO NOT PROVE
 * -----------------------------
 * `prisma` is mocked and `$transaction` is a pass-through, so:
 *   * a query filter is asserted by its ARGUMENTS, not by rows the real
 *     PostgreSQL would return;
 *   * compare-and-set behaviour is asserted by mock counts, not by real row
 *     locking or isolation behaviour;
 *   * socket and push delivery is asserted at the `emitSocketEvents` /
 *     `sendNotification` CALL boundary only. `socket.io-client` is never
 *     connected and no Redis or database is contacted;
 *   * no Notification/Activity row is proven persisted — only that the code
 *     path that would create one is no longer called.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
    order: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
      aggregate: jest.fn(async () => ({ _sum: { totalPrice: null }, _count: { id: 0 } })),
    },
    vendorReview: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0), aggregate: jest.fn(async () => ({ _avg: { rating: null } })) },
    productReview: { aggregate: jest.fn(async () => ({ _avg: { rating: null } })) },
    activity: { create: jest.fn(async () => ({})) },
    auditLog: { create: jest.fn(async () => ({})) },
    notification: { create: jest.fn(async () => ({})) },
    payment: { findFirst: jest.fn(async () => null), findUnique: jest.fn(), updateMany: jest.fn(async () => ({ count: 0 })), update: jest.fn(async () => ({})) },
    userPaymentMethod: { upsert: jest.fn(async () => ({})) },
    refundRequest: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
    product: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })) },
    cart: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })), delete: jest.fn(async () => ({})) },
    cartItem: { findMany: jest.fn(async () => []), update: jest.fn(), deleteMany: jest.fn(async () => ({})) },
    cartItemOption: { deleteMany: jest.fn(async () => ({})) },
    cartSummarySnapshot: { findUnique: jest.fn(), delete: jest.fn(async () => ({})) },
    address: { findFirst: jest.fn() },
    optionGroup: { findMany: jest.fn(async () => []) },
    promotion: { findUnique: jest.fn(), findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 1 })) },
    promotionUsage: { count: jest.fn(async () => 0), create: jest.fn(async () => ({})) },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === "function" ? arg(require("../../src/lib/prisma").default) : arg,
    ),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    scan: jest.fn(async () => ({ cursor: "0", keys: [] as string[] })),
  },
  redisNotifications: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
  },
  ShopCartRedis: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
  },
  // In-memory idempotency store with real SET NX semantics, so checkoutCart's
  // claim/release/complete cycle behaves as it does in production.
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

jest.mock("../../src/lib/redisScan", () => ({ scanKeys: jest.fn(async () => []) }));

jest.mock("../../src/services/clearCaches", () => ({
  clearProductCache: jest.fn(async () => ({ ok: true, failures: [] })),
}));

// The whole point of the notification half of this suite: the checkout path
// must not reach ANY vendor-facing emitter. Both are mocked so the assertions
// can prove they were never called, and so nothing tries to touch a socket.
jest.mock("../../src/utils/activityUtils/socketEvents", () => ({
  emitSocketEvents: jest.fn(async () => {}),
}));
jest.mock("../../src/utils/activityUtils/notify", () => ({
  sendNotification: jest.fn(async () => ({})),
  sendNotificationToMany: jest.fn(async () => []),
  notifyRole: jest.fn(async () => []),
}));
jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  recordActivityBundle: jest.fn(async () => {}),
}));

jest.mock("../../src/services/inventory.service", () => ({
  restoreStockForOrders: jest.fn(async () => []),
  reserveStockForItems: jest.fn(async () => {}),
  assertQuantityAvailable: jest.fn(async () => {}),
}));

jest.mock("../../src/services/cartSummary.service", () => ({
  __esModule: true,
  cartSummaryService: jest.fn(),
}));

jest.mock("../../src/utils/generate Receipt/generateReceipt", () => ({
  __esModule: true,
  generateReceipt: jest.fn(async () => ({ pdfUrl: "http://test/r.pdf" })),
}));

import * as fs from "fs";
import * as path from "path";
import {
  PRE_PAYMENT_ORDER_STATUSES,
  SETTLED_PAYMENT_STATUSES,
  VENDOR_VISIBLE_ORDER_WHERE,
  isVendorVisibleOrder,
  vendorVisibleOrderWhere,
  vendorDashboardCacheKey,
} from "../../src/services/vendorOrderVisibility";
import { getMyOrders, getSingleOrder, getVendorOrderStats } from "../../src/controllers/orderController";
import { checkoutCart } from "../../src/controllers/cartController";
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";
import { cartSummaryService } from "../../src/services/cartSummary.service";
import { VendorDashboardService } from "../../src/controllers/vendorDashboard.service";
import { recordActivityBundle } from "../../src/utils/activityUtils/recordActivityBundle";
import { emitSocketEvents } from "../../src/utils/activityUtils/socketEvents";
import { sendNotification } from "../../src/utils/activityUtils/notify";
import prisma from "../../src/lib/prisma";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedSummary = cartSummaryService as unknown as jest.Mock;
const activityBundle = recordActivityBundle as unknown as jest.Mock;
const emitSockets = emitSocketEvents as unknown as jest.Mock;
const pushNotify = sendNotification as unknown as jest.Mock;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const req = (user: Record<string, unknown>, params: Record<string, unknown> = {}, query: Record<string, unknown> = {}): any => ({
  user,
  params,
  query,
  body: {},
  headers: {},
});

const orderRow = (over: Record<string, unknown> = {}): any => ({
  id: "order-1",
  vendorId: "vendor-1",
  customerId: "customer-1",
  status: "PAYMENT_CONFIRMED",
  paymentStatus: "SUCCESS",
  idempotencyKey: "idem-1",
  items: [],
  customer: { id: "customer-1", name: "Ada" },
  vendor: { id: "vendor-1", name: "Ada's Kitchen" },
  address: null,
  assignments: [],
  ...over,
});

async function rejection(p: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  return caught as Error;
}

/** Finds the vendor branch of a `OR` array in a captured `where`. */
function vendorBranch(where: any) {
  const branches: any[] = where.OR ?? [];
  return branches.find((b) => b && b.AND && b.AND.some((c: any) => c && c.vendorId));
}

beforeEach(() => {
  jest.clearAllMocks();
  db.order.findMany.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  db.order.findUnique.mockResolvedValue(null);
});

describe("Phase 1 — the visibility predicate itself", () => {
  it("excludes every status that cannot be reached after a settled payment", () => {
    for (const status of [
      "PENDING",
      "WAITING_VENDOR_CONFIRMATION",
      "WAITING_CUSTOMER_APPROVAL",
      "AWAITING_PAYMENT",
      "PAYMENT_EXPIRED",
      "CANCELLED_UNPAID",
    ] as const) {
      expect(PRE_PAYMENT_ORDER_STATUSES).toContain(status);
      // Even a SUCCESS marker cannot rescue a pre-payment status.
      expect(
        isVendorVisibleOrder({ status, paymentStatus: "SUCCESS" as never }),
      ).toBe(false);
    }
  });

  it("excludes every payment marker that is not captured money", () => {
    for (const paymentStatus of [
      "PENDING",
      "INITIATED",
      "FAILED",
      "EXPIRED",
      "LATE_PAYMENT",
      "AMOUNT_MISMATCH",
    ] as const) {
      expect(SETTLED_PAYMENT_STATUSES).not.toContain(paymentStatus);
      expect(
        isVendorVisibleOrder({ status: "PAYMENT_CONFIRMED" as never, paymentStatus: paymentStatus as never }),
      ).toBe(false);
    }
  });

  it("treats a NULL payment marker as unsettled rather than as paid", () => {
    expect(isVendorVisibleOrder({ status: "COMPLETED" as never, paymentStatus: null })).toBe(false);
  });

  it("keeps paid, processing, delivered, cancelled-after-payment and refunded orders visible", () => {
    for (const status of [
      "PAYMENT_CONFIRMED",
      "COOKING",
      "READY_FOR_PICKUP",
      "OUT_FOR_DELIVERY",
      "COMPLETED",
      "FAILED_DELIVERY",
      "CANCELLED",
    ] as const) {
      expect(isVendorVisibleOrder({ status: status as never, paymentStatus: "SUCCESS" as never })).toBe(true);
    }
    // A full refund rewrites the order to CANCELLED + REFUNDED. It WAS paid, so
    // the store must keep seeing it for their own records and payout disputes.
    expect(isVendorVisibleOrder({ status: "CANCELLED" as never, paymentStatus: "REFUNDED" as never })).toBe(true);
  });

  it("exposes the same rule as a Prisma where fragment", () => {
    expect(VENDOR_VISIBLE_ORDER_WHERE).toEqual({
      status: { notIn: [...PRE_PAYMENT_ORDER_STATUSES] },
      paymentStatus: { in: [...SETTLED_PAYMENT_STATUSES] },
    });
  });

  it("composes with a caller filter instead of replacing it", () => {
    const merged: any = vendorVisibleOrderWhere({ vendorId: "vendor-1" });
    expect(merged.AND[0]).toEqual({ vendorId: "vendor-1" });
    expect(merged.AND[1]).toEqual(VENDOR_VISIBLE_ORDER_WHERE);
  });

  it("versioned the dashboard summary cache key so a pre-change entry cannot be served", () => {
    expect(vendorDashboardCacheKey("vendor-1")).toBe("vendor:vendor-1:dashboardSummary:v2");
  });
});

describe("Phase 1 — vendor order LIST excludes unpaid orders", () => {
  it("filters the vendor branch but leaves the customer's own branch untouched", async () => {
    await getMyOrders(req({ id: "vendor-1", role: "VENDOR" }), res());
    const where = db.order.findMany.mock.calls[0][0].where;

    const branch = vendorBranch(where);
    expect(branch).toBeDefined();
    expect(branch.AND).toContainEqual({ vendorId: "vendor-1" });
    expect(branch.AND).toContainEqual(VENDOR_VISIBLE_ORDER_WHERE);

    // Requirement 4: the customer branch carries NO visibility rule, so a
    // customer still sees their own AWAITING_PAYMENT order.
    const customerBranch = where.OR.find((b: any) => b.customerId);
    expect(customerBranch).toEqual({ customerId: "vendor-1" });
  });

  it("never drops the vendor branch entirely — a dual-role account still sees its own paid orders", async () => {
    await getMyOrders(req({ id: "vendor-1", role: "VENDOR" }), res());
    const where = db.order.findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(2);
  });

  it("still scopes the count query to the same predicate as the list", async () => {
    await getMyOrders(req({ id: "vendor-1", role: "VENDOR" }), res());
    const listWhere = db.order.findMany.mock.calls[0][0].where;
    const countWhere = db.order.count.mock.calls[0][0].where;
    expect(countWhere).toEqual(listWhere);
  });

  it("still allows a caller to narrow by status or paymentStatus", async () => {
    await getMyOrders(
      req({ id: "vendor-1", role: "VENDOR" }, {}, { status: "COOKING", paymentStatus: "SUCCESS" }),
      res(),
    );
    const where = db.order.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("COOKING");
    expect(where.paymentStatus).toBe("SUCCESS");
    expect(vendorBranch(where)).toBeDefined();
  });

  it("counts only vendor-visible orders in the vendor stats summary", async () => {
    db.order.count.mockResolvedValue(4);
    await getVendorOrderStats(req({ id: "vendor-1", role: "VENDOR" }), res());
    const totalCountCall = db.order.count.mock.calls.find((c: any) =>
      c[0]?.where?.AND?.some((x: any) => x && x.status && x.status.notIn),
    );
    expect(totalCountCall).toBeDefined();
    expect(totalCountCall[0].where.AND).toContainEqual({ vendorId: "vendor-1" });
  });
});

describe("Phase 1 — vendor order DETAIL refuses an unpaid order", () => {
  it("refuses AWAITING_PAYMENT to the vendor of the order", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ status: "AWAITING_PAYMENT", paymentStatus: "PENDING" }));
    const err = await rejection(getSingleOrder(req({ id: "vendor-1", role: "VENDOR" }, { orderId: "order-1" }), res()));
    expect(err.message).toMatch(/don't have access/);
  });

  it("refuses CANCELLED_UNPAID, PAYMENT_EXPIRED and a cancelled-unpaid order", async () => {
    for (const [status, paymentStatus] of [
      ["CANCELLED_UNPAID", "EXPIRED"],
      ["PAYMENT_EXPIRED", "EXPIRED"],
      ["CANCELLED", "PENDING"],
      ["PAYMENT_CONFIRMED", "LATE_PAYMENT"],
    ]) {
      db.order.findUnique.mockResolvedValue(orderRow({ status, paymentStatus }));
      const err = await rejection(
        getSingleOrder(req({ id: "vendor-1", role: "VENDOR" }, { orderId: "order-1" }), res()),
      );
      expect(err.message).toMatch(/don't have access/);
    }
  });

  it("returns a paid order to its own vendor", async () => {
    db.order.findUnique.mockResolvedValue(orderRow());
    await getSingleOrder(req({ id: "vendor-1", role: "VENDOR" }, { orderId: "order-1" }), res());
    expect(db.order.findUnique).toHaveBeenCalledTimes(1);
  });

  it("returns a refunded order to its own vendor", async () => {
    db.order.findUnique.mockResolvedValue(
      orderRow({ status: "CANCELLED", paymentStatus: "REFUNDED" }),
    );
    await getSingleOrder(req({ id: "vendor-1", role: "VENDOR" }, { orderId: "order-1" }), res());
    expect(db.order.findUnique).toHaveBeenCalledTimes(1);
  });

  it("preserves the pre-existing cross-vendor refusal", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendorId: "other-vendor" }));
    const err = await rejection(getSingleOrder(req({ id: "vendor-1", role: "VENDOR" }, { orderId: "order-1" }), res()));
    expect(err.message).toMatch(/don't have access/);
  });

  it("uses ONE message for 'not yours' and 'not paid yet' so it is not an existence oracle", async () => {
    db.order.findUnique.mockResolvedValue(
      orderRow({ status: "AWAITING_PAYMENT", paymentStatus: "PENDING" }),
    );
    const unpaid = await rejection(
      getSingleOrder(req({ id: "vendor-1", role: "VENDOR" }, { orderId: "order-1" }), res()),
    );
    db.order.findUnique.mockResolvedValue(orderRow({ vendorId: "other-vendor" }));
    const notYours = await rejection(
      getSingleOrder(req({ id: "vendor-1", role: "VENDOR" }, { orderId: "order-1" }), res()),
    );
    expect(unpaid.message).toBe(notYours.message);
  });

  it("CUSTOMER BRANCH UNCHANGED: a customer still reads their own unpaid order", async () => {
    db.order.findUnique.mockResolvedValue(
      orderRow({
        customerId: "customer-1",
        vendorId: "vendor-1",
        status: "AWAITING_PAYMENT",
        paymentStatus: "PENDING",
      }),
    );
    await getSingleOrder(req({ id: "customer-1", role: "CUSTOMER" }, { orderId: "order-1" }), res());
    expect(db.order.findUnique).toHaveBeenCalledTimes(1);
  });

  it("CUSTOMER BRANCH UNCHANGED: a customer acting as this order's vendor still sees it", async () => {
    // A vendor who is also the customer of their own order keeps full access —
    // the visibility rule never overrides the customer relationship.
    db.order.findUnique.mockResolvedValue(
      orderRow({
        customerId: "vendor-1",
        vendorId: "vendor-1",
        status: "AWAITING_PAYMENT",
        paymentStatus: "PENDING",
      }),
    );
    await getSingleOrder(req({ id: "vendor-1", role: "VENDOR" }, { orderId: "order-1" }), res());
    expect(db.order.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 1 — vendor dashboard and activity feeds exclude unpaid orders", () => {
  const service = () => new VendorDashboardService("vendor-1");

  it("pending-orders count carries the visibility rule and drops AWAITING_PAYMENT", async () => {
    await service().getPendingOrdersCount();
    const where = db.order.count.mock.calls[0][0].where;
    expect(where.AND).toContainEqual(VENDOR_VISIBLE_ORDER_WHERE);
    expect(where.AND[0].status.in).toContain("PAYMENT_CONFIRMED");
    expect(where.AND[0].status.in).toContain("COOKING");
    expect(where.AND[0].status.in).not.toContain("AWAITING_PAYMENT");
    expect(where.AND[0].status.in).not.toContain("PENDING");
  });

  it("recent-activity feed carries the visibility rule", async () => {
    await service().getRecentActivity();
    const where = db.order.findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual(VENDOR_VISIBLE_ORDER_WHERE);
    expect(where.AND[0]).toMatchObject({ vendorId: "vendor-1" });
  });

  it("detailed activity feed carries the visibility rule on BOTH the page and its total", async () => {
    await service().getDetailedRecentActivity({ page: 1, limit: 20 });
    const pageWhere = db.order.findMany.mock.calls[0][0].where;
    expect(pageWhere.AND).toContainEqual(VENDOR_VISIBLE_ORDER_WHERE);

    const totalCall = db.order.count.mock.calls.find(
      (c: any) => c[0]?.where?.AND?.some((x: any) => x === VENDOR_VISIBLE_ORDER_WHERE),
    );
    expect(totalCall).toBeDefined();
  });

  it("never caches a summary built from an unfiltered order list", async () => {
    // The cache is written only AFTER the filtered queries resolve, so a cached
    // summary can only ever contain vendor-visible rows. Asserting the filter is
    // present on the query that feeds it is what makes that true.
    await service().getPendingOrdersCount();
    const where = db.order.count.mock.calls[0][0].where;
    expect(where.AND).toContainEqual(VENDOR_VISIBLE_ORDER_WHERE);
  });
});

describe("Phase 1 — checkout emits NO vendor-facing notification", () => {
  // A REAL checkoutCart run against mocked Prisma/Redis. The pre-fix code
  // called `recordActivityBundle` here with targetId = order.vendorId,
  // notifyRealtime: true, notifyPush: true and the title "New Order Received",
  // which fanned out to a socket `notification` + `orderUpdate` pair, a
  // persisted Notification row and a push — all for an AWAITING_PAYMENT order.
  const OPT_ID = "11111111-1111-4111-8111-111111111111";
  let keySeq = 0;

  const checkoutReq = (): any => ({
    headers: { "idempotency-key": `vis-${++keySeq}` },
    body: { summaryId: "snap-1", addressId: "addr-1" },
    params: {},
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "cust-1", role: "CUSTOMER", sessionId: "sess" },
  });

  const createdOrder = {
    id: "order-1",
    customerId: "cust-1",
    vendorId: "vendor-1",
    status: "AWAITING_PAYMENT",
    // Phase 3A: order totals are integer kobo.
    totalPrice: 500000,
    basePrice: 500000,
    deliveryFee: 0,
    items: [],
  };

  function arrangeSuccessfulCheckout() {
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
    db.cart.findFirst.mockResolvedValue({
      id: "cart-1",
      customerId: "cust-1",
      items: [
        {
          id: "item-1",
          productId: "prod-1",
          quantity: 2,
          unitPrice: 2500,
          subtotal: 5000,
          options: [{ id: "cio-1", productOptionId: OPT_ID, name: "Extra Meat", price: 500 }],
          product: {
            id: "prod-1",
            archived: false,
            vendorId: "vendor-1",
            vendor: {
              id: "vendor-1",
              name: "Mama Put",
              isLive: true,
              vendorStatus: "ACTIVE",
              deliveryPreferences: { acceptingOrders: true },
            },
          },
        },
      ],
    });
    db.user.findUnique.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.id === "cust-1"
          ? ({ email: "c@test.com", name: "Ada" } as any)
          : ({ id: "vendor-1", isLive: true, vendorStatus: "ACTIVE", deliveryPreferences: { acceptingOrders: true } } as any),
      ),
    );
    db.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Jollof",
        price: 2000,
        archived: false,
        trackInventory: true,
        stock: 10,
        vendorId: "vendor-1",
        options: [{ id: OPT_ID, name: "Extra Meat", price: 500 }],
      },
    ]);
    db.order.create.mockResolvedValue(createdOrder as any);
    mockedSummary.mockResolvedValue({
      warnings: [],
      finalTotal: 5000,
      promo: null,
      discount: 0,
      vendorBreakdown: [{ vendorId: "vendor-1", discount: 0, deliveryFee: 0 }],
    });
  }

  beforeEach(() => {
    arrangeSuccessfulCheckout();
  });

  it("guard: the emitter helpers are real jest mocks, so 'not called' cannot pass vacuously", () => {
    expect(jest.isMockFunction(activityBundle)).toBe(true);
    expect(jest.isMockFunction(emitSockets)).toBe(true);
    expect(jest.isMockFunction(pushNotify)).toBe(true);
  });

  it("completes the checkout and creates the AWAITING_PAYMENT order", async () => {
    await checkoutCart(checkoutReq(), res());
    expect(db.order.create).toHaveBeenCalledTimes(1);
    expect(db.order.create.mock.calls[0][0].data.status).toBe("AWAITING_PAYMENT");
    expect(db.order.create.mock.calls[0][0].data.vendorId).toBe("vendor-1");
  });

  it("emits NO vendor Activity, Notification, socket event or push for the unpaid order", async () => {
    await checkoutCart(checkoutReq(), res());

    expect(activityBundle).not.toHaveBeenCalled();
    expect(emitSockets).not.toHaveBeenCalled();
    expect(pushNotify).not.toHaveBeenCalled();
    expect(db.activity.create).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("the surviving record is an internal audit row, carrying no vendor recipient", async () => {
    await checkoutCart(checkoutReq(), res());
    const audit = db.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("ORDER_CREATED");
    expect(audit.userId).toBe("cust-1");
    expect(audit.metadata.orderId).toBe("order-1");
    expect(audit.metadata.vendorId).toBe("vendor-1");
    expect(audit.metadata.orderStatus).toBe("AWAITING_PAYMENT");
    // The audit table has no recipient column and is admin-only
    // (GET /admin/audit-logs), so no vendor-target field can exist here.
    expect(audit).not.toHaveProperty("targetId");
  });

  it("CUSTOMER-FACING BEHAVIOUR UNCHANGED: the checkout response still returns the orders", async () => {
    const r = res();
    await checkoutCart(checkoutReq(), r);
    expect(r.status).toHaveBeenCalledWith(201);
    const body = r.json.mock.calls[0][0];
    expect(body.message).toBe("Checkout successful");
    expect(body.data.orders[0].id).toBe("order-1");
  });

  it("the authoritative paid-order notification is emitted only by the payment finalizer", async () => {
    // Guard against the wrong fix — deleting the notification outright, or
    // inventing a second emitter. `NEW_PAID_ORDER` must exist exactly where the
    // payment finalizer decides the order is paid.
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/services/paymentFinalizer.service.ts"),
      "utf8",
    );
    expect(source).toContain("ActivityType.NEW_PAID_ORDER");
    expect(source).toContain("NEW_PAID_ORDER_RECEIVED");
    expect(source).toContain("targetId: order.vendorId");
  });

  it("the finalizer emits the paid-order alert only after its conditional claim wins", async () => {
    // Real finalizer, mocked Prisma. `finalizePaymentSuccess` makes two
    // distinct `payment.updateMany` calls: first the `isProcessing` lock
    // (paymentFinalizer.service.ts:135), then the payment-status claim that
    // actually decides SUCCESS (:572). Here the lock succeeds but the CLAIM
    // loses to a concurrent expiry/another finalizer, so a duplicate callback
    // must produce no actionable vendor notification (requirement 4).
    db.payment.findUnique.mockResolvedValue({
      id: "pay-1",
      reference: "PSK-1",
      orderId: "order-1",
      idempotencyKey: null,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      createdAt: new Date(),
    });
    db.order.findUnique.mockResolvedValue({
      id: "order-1",
      customerId: "cust-1",
      vendorId: "vendor-1",
      idempotencyKey: null,
      status: "AWAITING_PAYMENT",
      paymentStatus: "PENDING",
      // Phase 3A: order.totalPrice is integer kobo.
      totalPrice: 500000,
      paidAt: null,
      protectedUntil: new Date(Date.now() + 10 * 60_000),
    });
    let paymentWrites = 0;
    db.payment.updateMany.mockImplementation(async () => {
      paymentWrites += 1;
      // 1st write = the isProcessing lock (wins). Every later write = a status
      // claim, which here always loses.
      return { count: paymentWrites === 1 ? 1 : 0 };
    });

    const result = await finalizePaymentSuccess({
      reference: "PSK-1",
      amountKobo: 500000,
      currency: "NGN",
      customerIdFromGateway: "cust-1",
      channel: "card",
      paystackData: {},
    });

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    // No order status was written and no notification was produced.
    expect(
      db.order.updateMany.mock.calls.some((c: any) => c[0]?.data?.status === "PAYMENT_CONFIRMED"),
    ).toBe(false);
    expect(activityBundle).not.toHaveBeenCalled();
  });

  it("the finalizer DOES emit the paid-order alert once the claim wins", async () => {
    db.payment.findUnique.mockResolvedValue({
      id: "pay-1",
      reference: "PSK-2",
      orderId: "order-1",
      idempotencyKey: null,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      createdAt: new Date(),
    });
    db.order.findUnique.mockResolvedValue({
      id: "order-1",
      customerId: "cust-1",
      vendorId: "vendor-1",
      idempotencyKey: null,
      status: "AWAITING_PAYMENT",
      paymentStatus: "PENDING",
      // Phase 3A: order.totalPrice is integer kobo.
      totalPrice: 500000,
      paidAt: null,
      protectedUntil: new Date(Date.now() + 10 * 60_000),
    });
    let paymentWrites = 0;
    db.payment.updateMany.mockImplementation(async () => {
      paymentWrites += 1;
      return { count: 1 }; // lock wins, claim wins
    });
    db.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await finalizePaymentSuccess({
      reference: "PSK-2",
      amountKobo: 500000,
      currency: "NGN",
      customerIdFromGateway: "cust-1",
      channel: "card",
      paystackData: {},
    });

    expect(result.outcome).toBe("SUCCESS");
    // The order moved to PAYMENT_CONFIRMED inside the same transaction, via a
    // compare-and-set that can only ever claim a payable-pending order.
    const confirmation = db.order.updateMany.mock.calls.find(
      (c: any) => c[0]?.data?.status === "PAYMENT_CONFIRMED",
    );
    expect(confirmation).toBeDefined();
    expect(confirmation[0].where.status).toEqual({
      in: ["AWAITING_PAYMENT", "PENDING"],
    });

    // Exactly one bundle, carrying the vendor as the recipient of the paid alert.
    expect(activityBundle).toHaveBeenCalledTimes(1);
    const vendorAction = activityBundle.mock.calls[0][0].actions.find(
      (a: any) => a.targetId === "vendor-1",
    );
    expect(vendorAction).toBeDefined();
    expect(vendorAction.title).toBe("New Paid Order");
  });

  it("a duplicate success callback on an already-settled payment emits no second vendor alert", async () => {
    // The idempotent branch: payment already SUCCESS. It re-syncs order markers
    // behind a CAS and returns before the notification loop is ever reached.
    db.payment.findUnique.mockResolvedValue({
      id: "pay-1",
      reference: "PSK-3",
      orderId: "order-1",
      idempotencyKey: null,
      status: "SUCCESS",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      createdAt: new Date(),
    });
    db.order.findUnique.mockResolvedValue({
      id: "order-1",
      customerId: "cust-1",
      vendorId: "vendor-1",
      idempotencyKey: null,
      status: "PAYMENT_CONFIRMED",
      paymentStatus: "SUCCESS",
      totalPrice: 5000,
      paidAt: new Date(),
      protectedUntil: new Date(Date.now() + 10 * 60_000),
    });
    let paymentWrites = 0;
    db.payment.updateMany.mockImplementation(async () => {
      paymentWrites += 1;
      return { count: 1 };
    });
    db.order.updateMany.mockResolvedValue({ count: 0 });

    const result = await finalizePaymentSuccess({
      reference: "PSK-3",
      amountKobo: 500000,
      currency: "NGN",
      customerIdFromGateway: "cust-1",
      channel: "card",
      paystackData: {},
    });

    expect(result.outcome).toBe("ALREADY_PROCESSED");
    expect(activityBundle).not.toHaveBeenCalled();
  });

  // Special-offer acceptance is deliberately PRESERVED: it notifies the vendor
  // (not the customer) with a payment-aware message before payment. That
  // behaviour — recipient, title, message, metadata and the realtime/push
  // flags — is now asserted behaviourally in
  // tests/unit/specialOfferNotifications.test.ts, which drives the real
  // controller. It is no longer duplicated here as a brittle source-text match.
});
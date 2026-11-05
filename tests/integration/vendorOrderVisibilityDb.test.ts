/**
 * Phase 1 — real PostgreSQL verification of the vendor order-visibility
 * predicate (`src/services/vendorOrderVisibility.ts`).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The predicate is proven elsewhere only at the *query-argument* level
 * (tests/unit/vendorOrderVisibility.test.ts). That never proves PostgreSQL
 * accepts the nested shape, nor that it returns the rows we claim. This suite
 * executes the REAL `getMyOrders` controller against a real database and
 * asserts on RETURNED ORDER IDS against explicit expected sets.
 *
 * THE EXACT QUERY UNDER TEST
 * --------------------------
 * `getMyOrders` (src/controllers/orderController.ts:80-177) issues:
 *
 *   prisma.order.findMany({
 *     where: {
 *       OR: [
 *         { customerId: userId },                      // customer branch: UNFILTERED
 *         vendorVisibleOrderWhere({ vendorId: userId }) // vendor branch: FILTERED
 *       ]
 *     },
 *     skip, take: limit, orderBy: { createdAt: "desc" }, include: { … }
 *   })
 *   prisma.order.count({ where })                      // same predicate
 *
 * and `vendorVisibleOrderWhere` expands to:
 *
 *   { AND: [ { vendorId }, VENDOR_VISIBLE_ORDER_WHERE ] }
 *
 * where VENDOR_VISIBLE_ORDER_WHERE is
 *   { status: { notIn: PRE_PAYMENT_ORDER_STATUSES },
 *     paymentStatus: { in: [SUCCESS, REFUNDED] } }
 *
 * This suite drives that controller rather than re-declaring the shape, so a
 * future change to either the predicate or the nesting cannot silently drift
 * away from what is proven here.
 *
 * MOCKS PRESENT, AND WHY THEY ARE SAFE
 * ------------------------------------
 * `src/lib/redis`, `src/lib/redisScan`, `activityUtils/notify` and
 * `activityUtils/recordActivityBundle` are mocked. `notify.ts` imports
 * `src/socket.ts`, which imports `src/config/config.ts` and throws at import
 * time when ~7 required environment variables are absent; `src/lib/redis.ts`
 * throws at import time when `REDIS_URL` is absent. Mocking them keeps this
 * read-path suite from requiring Redis, a socket server, or application
 * configuration.
 *
 * NONE of them is reachable from the code under test: `getMyOrders` performs
 * Prisma reads and nothing else. No query, filter, ordering or count is
 * mocked — every assertion below is made against rows PostgreSQL actually
 * returned. This mirrors tests/integration/notificationPersistence.test.ts and
 * tests/integration/refreshDbBoundary.integration.test.ts.
 *
 * CONNECTION MECHANISM
 * --------------------
 * `new PrismaClient()` with NO datasource override, exactly like every other
 * suite under tests/integration. The datasource resolves `env("DATABASE_URL")`,
 * which `tests/setup/pinTestDatabaseUrl.ts` has already pinned to the
 * preflight-validated disposable test database before this module is required.
 * No connection string or credential appears in this file, and no new
 * connection mechanism is introduced.
 *
 * NULL paymentStatus IS COVERED
 * -----------------------------
 * `Order.paymentStatus` is `PaymentStatus? @default(PENDING)` — nullable, with
 * no NOT NULL in the baseline migration
 * (prisma/migrations/20261005233153_baseline/migration.sql:240). A NULL is
 * therefore representable through an ordinary Prisma create by passing
 * `paymentStatus: null` explicitly; no raw SQL and no schema change is needed.
 * The `nullPayment` fixture below proves the predicate's fail-closed branch
 * against a real database: an unreadable payment marker is NOT read as paid.
 *
 * ISOLATION AND CLEANUP
 * ---------------------
 * Every fixture user and order is created with a freshly generated id
 * and recorded in a tracking array. Teardown deletes exactly those ids,
 * child-first (orders, then users), so cleanup is bounded to this suite and can
 * never touch another suite's rows. No OrderItem fixtures are created, so no
 * item-level cleanup is needed.
 */

import { PrismaClient } from "@prisma/client";
import type { OrderStatus, PaymentStatus } from "@prisma/client";
import type { Response } from "express";
import type { AuthRequest } from "../../src/middlewares/auth.middleware";

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisNotifications: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), isOpen: true },
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn(), scan: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn(), scan: jest.fn() },
  redisTotalViews: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), scan: jest.fn() },
  redisUsersSessions: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), scan: jest.fn() },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisPayments: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(), scan: jest.fn() },
  connectRedis: jest.fn(async () => undefined),
  ensureRedisReady: jest.fn(async () => undefined),
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(async () => []),
}));

jest.mock("../../src/utils/activityUtils/notify", () => ({
  __esModule: true,
  sendNotification: jest.fn(async () => ({})),
  sendNotificationToMany: jest.fn(async () => []),
  notifyRole: jest.fn(async () => []),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

import { getMyOrders } from "../../src/controllers/orderController";
import { VendorDashboardService } from "../../src/controllers/vendorDashboard.service";

jest.setTimeout(60000);

const prisma = new PrismaClient();

/** Unique per run, so concurrent or repeated runs cannot collide. */
const tag = `p1vov-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const userIds: string[] = [];
const orderIds: string[] = [];

/**
 * Fixed base time in the PAST. Integration suites set no `runInBand`, so they
 * may run in parallel workers against the same database; a past timestamp
 * guarantees these rows can never fall inside a future-dated window in any
 * other suite's query. Values are distinct, so `orderBy createdAt desc` is
 * fully deterministic and independent of insert timing.
 */
const T0 = new Date("2020-01-01T00:00:00.000Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

let customerId = "";
let vendorId = "";
let otherCustomerId = "";
let otherVendorId = "";

/** Fixture registry: logical name -> created order id. */
const ids: Record<string, string> = {};

async function makeUser(role: "CUSTOMER" | "VENDOR"): Promise<string> {
  const user = await prisma.user.create({
    data: {
      // `User.email` is required and @unique, so every fixture needs its own.
      email: `${tag}.${userIds.length}.${role.toLowerCase()}@vendor-visibility.test`,
      name: `${role} fixture`,
      role,
      roles: [role],
    },
  });
  userIds.push(user.id);
  return user.id;
}

/**
 * Creates one order. `createdAt` is explicit so ordering assertions do not
 * depend on insert timing.
 */
async function makeOrder(
  name: string,
  opts: {
    customer: string;
    vendor: string;
    status: OrderStatus;
    paymentStatus: PaymentStatus | null;
    minutes: number;
  },
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      customerId: opts.customer,
      vendorId: opts.vendor,
      basePrice: 5000,
      totalPrice: 5500,
      status: opts.status,
      paymentStatus: opts.paymentStatus,
      createdAt: at(opts.minutes),
    },
  });
  orderIds.push(order.id);
  ids[name] = order.id;
  return order.id;
}

/** Calls the real controller and returns the parsed envelope. */
async function listOrdersFor(
  userId: string,
  query: Record<string, string> = {},
): Promise<{ orders: Array<{ id: string }>; meta: { total: number; page: number; limit: number } }> {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  // The controller defaults to `limit: 10`, which would silently truncate a
  // caller that owns more than ten orders. Default high here so an unfiltered
  // assertion really means "all of them"; paging tests override it.
  const effectiveQuery = { limit: "50", ...query };
  // `getMyOrders` reads only `req.user!.id` (orderController.ts:81) and
  // `req.query`; nothing else on the request is consulted, so `user` carries
  // the id alone rather than a role this helper would only guess at.
  const req = {
    user: { id: userId },
    query: effectiveQuery,
    params: {},
    body: {},
    headers: {},
  } as unknown as AuthRequest;
  await getMyOrders(req, res as unknown as Response);
  expect(res.json).toHaveBeenCalledTimes(1);
  const envelope = res.json.mock.calls[0][0];
  return { orders: envelope.data.orders, meta: envelope.meta };
}

const returnedIds = (orders: Array<{ id: string }>): string[] => orders.map((o) => o.id);
const sorted = (a: string[]): string[] => [...a].sort();

beforeAll(async () => {
  customerId = await makeUser("CUSTOMER");
  vendorId = await makeUser("VENDOR");
  otherCustomerId = await makeUser("CUSTOMER");
  otherVendorId = await makeUser("VENDOR");

  // --- Orders belonging to `vendorId`, customer `customerId` -----------------

  // Pre-payment states. `status` alone excludes all of these.
  await makeOrder("awaitingPayment", {
    customer: customerId,
    vendor: vendorId,
    status: "AWAITING_PAYMENT",
    paymentStatus: "PENDING",
    minutes: 1,
  });
  await makeOrder("paymentExpired", {
    customer: customerId,
    vendor: vendorId,
    status: "PAYMENT_EXPIRED",
    paymentStatus: "EXPIRED",
    minutes: 2,
  });
  await makeOrder("cancelledUnpaid", {
    customer: customerId,
    vendor: vendorId,
    status: "CANCELLED_UNPAID",
    paymentStatus: "EXPIRED",
    minutes: 3,
  });

  // `status` is a post-payment state, but the payment marker is NOT settled.
  // These prove the `paymentStatus` clause does real work on its own.
  await makeOrder("paidInitd", {
    customer: customerId,
    vendor: vendorId,
    status: "PAYMENT_CONFIRMED",
    paymentStatus: "INITIATED",
    minutes: 4,
  });
  await makeOrder("paidFailed", {
    customer: customerId,
    vendor: vendorId,
    status: "PAYMENT_CONFIRMED",
    paymentStatus: "FAILED",
    minutes: 5,
  });
  await makeOrder("paidLate", {
    customer: customerId,
    vendor: vendorId,
    status: "PAYMENT_CONFIRMED",
    paymentStatus: "LATE_PAYMENT",
    minutes: 6,
  });
  await makeOrder("cancelledUnpaidFlag", {
    customer: customerId,
    vendor: vendorId,
    status: "CANCELLED",
    paymentStatus: "PENDING",
    minutes: 7,
  });
  // An UNREADABLE payment marker on an otherwise post-payment status.
  // `Order.paymentStatus` is nullable with no NOT NULL, so an explicit NULL is
  // representable through an ordinary Prisma create — no raw SQL, no schema
  // change. The predicate must fail CLOSED here: "marker absent" is not
  // evidence that money was taken, so the store must not see this order.
  // Created last (minute 14); being vendor-invisible it cannot perturb the
  // createdAt-desc ordering assertion, which only covers visible orders.
  await makeOrder("nullPayment", {
    customer: customerId,
    vendor: vendorId,
    status: "PAYMENT_CONFIRMED",
    paymentStatus: null,
    minutes: 14,
  });

  // Settled orders the vendor must keep seeing.
  await makeOrder("confirmed", {
    customer: customerId,
    vendor: vendorId,
    status: "PAYMENT_CONFIRMED",
    paymentStatus: "SUCCESS",
    minutes: 8,
  });
  await makeOrder("cooking", {
    customer: customerId,
    vendor: vendorId,
    status: "COOKING",
    paymentStatus: "SUCCESS",
    minutes: 9,
  });
  await makeOrder("completed", {
    customer: customerId,
    vendor: vendorId,
    status: "COMPLETED",
    paymentStatus: "SUCCESS",
    minutes: 10,
  });
  // Paid, then cancelled: settled, so still visible.
  await makeOrder("paidCancelled", {
    customer: customerId,
    vendor: vendorId,
    status: "CANCELLED",
    paymentStatus: "SUCCESS",
    minutes: 11,
  });
  // Paid, then refunded: the refund finalizer writes REFUNDED, which the
  // predicate deliberately counts as settled. The store must keep seeing it.
  await makeOrder("refunded", {
    customer: customerId,
    vendor: vendorId,
    status: "CANCELLED",
    paymentStatus: "REFUNDED",
    minutes: 12,
  });

  // --- An order belonging to a DIFFERENT vendor ----------------------------
  await makeOrder("otherVendorSettled", {
    customer: otherCustomerId,
    vendor: otherVendorId,
    status: "PAYMENT_CONFIRMED",
    paymentStatus: "SUCCESS",
    minutes: 13,
  });
});

afterAll(async () => {
  // Child-first, and strictly limited to ids this suite created.
  if (orderIds.length)
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
  if (userIds.length)
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.$disconnect();
});

/** Every order this suite created for `vendorId`. */
const VENDOR_SETTLED = ["confirmed", "cooking", "completed", "paidCancelled", "refunded"];
const VENDOR_HIDDEN = [
  "awaitingPayment",
  "paymentExpired",
  "cancelledUnpaid",
  "paidInitd",
  "paidFailed",
  "paidLate",
  "cancelledUnpaidFlag",
  "nullPayment",
];

describe("getMyOrders — vendor branch visibility, proven against PostgreSQL", () => {
  it("1. returns a customer their own unpaid order", async () => {
    const { orders } = await listOrdersFor(customerId);
    expect(returnedIds(orders)).toContain(ids.awaitingPayment);
  });

  it("1b. returns a customer EVERY one of their own orders, paid or not", async () => {
    const { orders } = await listOrdersFor(customerId);
    const own = orderIds.filter((id) => id !== ids.otherVendorSettled);
    expect(sorted(returnedIds(orders))).toEqual(sorted(own));
  });

  it("2. never returns another vendor's order, even a settled one", async () => {
    const { orders } = await listOrdersFor(vendorId);
    expect(returnedIds(orders)).not.toContain(ids.otherVendorSettled);
  });

  it("3. hides the unpaid AWAITING_PAYMENT order from the vendor", async () => {
    const { orders } = await listOrdersFor(vendorId);
    expect(returnedIds(orders)).not.toContain(ids.awaitingPayment);
  });

  it("4. hides expired and cancelled-unpaid orders from the vendor", async () => {
    const { orders } = await listOrdersFor(vendorId);
    expect(returnedIds(orders)).not.toContain(ids.paymentExpired);
    expect(returnedIds(orders)).not.toContain(ids.cancelledUnpaid);
  });

  it("5. shows settled SUCCESS orders across the lifecycle", async () => {
    const { orders } = await listOrdersFor(vendorId);
    const got = returnedIds(orders);
    for (const name of ["confirmed", "cooking", "completed"]) {
      expect(got).toContain(ids[name]);
    }
  });

  it("6. shows an order that was paid and then cancelled", async () => {
    const { orders } = await listOrdersFor(vendorId);
    expect(returnedIds(orders)).toContain(ids.paidCancelled);
  });

  it("7. shows a refunded order", async () => {
    const { orders } = await listOrdersFor(vendorId);
    expect(returnedIds(orders)).toContain(ids.refunded);
  });

  it("8. hides unsettled payment markers even on a post-payment status", async () => {
    const { orders } = await listOrdersFor(vendorId);
    const got = returnedIds(orders);
    // INITIATED / FAILED / LATE_PAYMENT, and CANCELLED + PENDING.
    for (const name of ["paidInitd", "paidFailed", "paidLate", "cancelledUnpaidFlag"]) {
      expect(got).not.toContain(ids[name]);
    }
  });

  it("8b. FAILS CLOSED on a NULL payment marker rather than reading it as paid", async () => {
    // The row genuinely exists and really is in a post-payment status.
    const raw = await prisma.order.findUnique({
      where: { id: ids.nullPayment },
      select: { status: true, paymentStatus: true },
    });
    expect(raw).toEqual({ status: "PAYMENT_CONFIRMED", paymentStatus: null });

    // ...yet the vendor cannot retrieve it, and it is not in the visible set.
    const { orders } = await listOrdersFor(vendorId);
    expect(returnedIds(orders)).not.toContain(ids.nullPayment);

    const direct = await listOrdersFor(customerId);
    // The customer branch is unfiltered, so the row is still reachable by its
    // owner — proving it was hidden by the vendor rule, not lost.
    expect(returnedIds(direct.orders)).toContain(ids.nullPayment);
  });

  it("9. returns EXACTLY the expected id set for the vendor", async () => {
    const { orders } = await listOrdersFor(vendorId);
    const expected = sorted(VENDOR_SETTLED.map((n) => ids[n]));
    expect(sorted(returnedIds(orders))).toEqual(expected);
  });

  it("9b. the hidden set is exactly the complement — nothing is half-applied", async () => {
    const { orders } = await listOrdersFor(vendorId);
    const got = returnedIds(orders);
    for (const name of VENDOR_HIDDEN) {
      expect(got).not.toContain(ids[name]);
    }
  });

  it("10. orders by createdAt descending", async () => {
    const { orders } = await listOrdersFor(vendorId);
    const got = returnedIds(orders);
    // createdAt minutes: refunded 12, paidCancelled 11, completed 10, cooking 9, confirmed 8.
    expect(got).toEqual([
      ids.refunded,
      ids.paidCancelled,
      ids.completed,
      ids.cooking,
      ids.confirmed,
    ]);
  });

  it("10b. meta.total agrees with the row count under the same predicate", async () => {
    const { orders, meta } = await listOrdersFor(vendorId);
    expect(meta.total).toBe(orders.length);
    expect(meta.total).toBe(VENDOR_SETTLED.length);
  });

  it("10c. pagination walks the same filtered set without leaking or dropping rows", async () => {
    const page1 = await listOrdersFor(vendorId, { page: "1", limit: "2" });
    const page2 = await listOrdersFor(vendorId, { page: "2", limit: "2" });
    const page3 = await listOrdersFor(vendorId, { page: "3", limit: "2" });

    expect(page1.meta.limit).toBe(2);
    expect(page1.orders).toHaveLength(2);
    expect(page2.orders).toHaveLength(2);
    expect(page3.orders).toHaveLength(1);

    // meta.total stays the size of the FILTERED set on every page.
    for (const p of [page1, page2, page3]) {
      expect(p.meta.total).toBe(VENDOR_SETTLED.length);
    }

    // Paging is a partition of the same set: no duplicates, no omissions.
    const paged = sorted([...returnedIds(page1.orders), ...returnedIds(page2.orders), ...returnedIds(page3.orders)]);
    expect(paged).toEqual(sorted(VENDOR_SETTLED.map((n) => ids[n])));
    expect(new Set(paged).size).toBe(paged.length);
  });

  it("10d. a status filter narrows the vendor branch without widening it", async () => {
    const { orders } = await listOrdersFor(vendorId, { status: "COOKING" });
    expect(returnedIds(orders)).toEqual([ids.cooking]);
  });

  it("10e. asking for a status the vendor must not see still returns nothing", async () => {
    // The query filter is ANDed at the top level and cannot override the
    // visibility rule — it can only narrow it further.
    const { orders, meta } = await listOrdersFor(vendorId, { status: "AWAITING_PAYMENT" });
    expect(orders).toHaveLength(0);
    expect(meta.total).toBe(0);
  });
});

describe("VendorDashboardService.getPendingOrdersCount — same predicate", () => {
  /** The exact status list the dashboard counts as "pending" (vendorDashboard.service.ts:266-274). */
  const PENDING_STATUSES: OrderStatus[] = [
    "WAITING_VENDOR_CONFIRMATION",
    "WAITING_CUSTOMER_APPROVAL",
    "PAYMENT_CONFIRMED",
    "COOKING",
    "READY_FOR_PICKUP",
    "OUT_FOR_DELIVERY",
  ];

  it("counts only settled orders in a pending status, never an unpaid one", async () => {
    const service = new VendorDashboardService(vendorId);
    const count = await service.getPendingOrdersCount();
    expect(count).toBe(2);
  });

  it("excludes every unsettled fixture that shares a pending status", async () => {
    // How many of this vendor's orders sit in a "pending" status at all?
    const inPendingStatus = await prisma.order.count({
      where: { vendorId, status: { in: PENDING_STATUSES } },
    });
    // confirmed(SUCCESS), paidInitd(INITIATED), paidFailed(FAILED),
    // paidLate(LATE_PAYMENT), nullPayment(NULL), cooking(SUCCESS) = 6.
    expect(inPendingStatus).toBe(6);

    // Only the two with a settled payment marker survive the predicate.
    const count = await new VendorDashboardService(vendorId).getPendingOrdersCount();
    expect(count).toBe(2);
    expect(count).toBeLessThan(inPendingStatus);
  });

  it("excludes the unpaid order that the pre-Phase-1 code counted", async () => {
    const service = new VendorDashboardService(vendorId);
    const count = await service.getPendingOrdersCount();
    const rawUnfiltered = await prisma.order.count({
      where: { vendorId, status: "AWAITING_PAYMENT" },
    });
    // Sanity: the unpaid order really does exist for this vendor.
    expect(rawUnfiltered).toBe(1);
    // ...and it is not in the dashboard's pending count.
    expect(count).toBe(2);
  });
});
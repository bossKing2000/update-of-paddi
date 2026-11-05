/**
 * Phase 1 follow-up — special-offer notification recipients.
 *
 * WHAT THIS PINS DOWN
 * -------------------
 * The read-only review of `acceptSpecialOffer` established that its single
 * notification is addressed to the VENDOR whose offer was accepted, NOT to the
 * customer who accepted it — and that the message is payment-aware ("is awaiting
 * payment"), which is why it is a deliberate PRE-PAYMENT informational send
 * rather than the actionable-order alert that was removed from checkout.
 *
 * Both facts are load-bearing and neither was previously asserted anywhere:
 * `grep -rn "targetId" tests/` matched nothing outside this Phase 1 work, and
 * the Phase 1 assertion in `vendorOrderVisibility.test.ts` was a source-text
 * match rather than a behavioural one. This suite drives the REAL controllers
 * and asserts on what the notification boundary actually receives.
 *
 * THE BOUNDARY, EXPLICITLY
 * ------------------------
 * `recordActivityBundle` and `sendNotification` are mocked. This suite proves
 * WHO each message is addressed to and WHAT it says — it does not prove socket
 * fan-out, Redis counters or a persisted `Notification`/`Activity` row. Those
 * live one layer down (`emitSocketEvents`, `notify.sendNotification`) and are
 * out of scope here. No PostgreSQL, Redis, Paystack or socket is contacted, and
 * no notification is actually emitted: no timers, sockets or listeners are
 * opened, so the suite leaves nothing to clean up.
 *
 * The harness (mocks, fixtures, `res()`) follows `specialOfferPricing.test.ts`,
 * which drives the same controller for line-pricing assertions.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    specialOrderOffer: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    specialOrderRequest: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    address: { findFirst: jest.fn() },
    product: { findUnique: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    user: { findUnique: jest.fn() },
    order: { create: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
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
  clearProductCache: jest.fn(async () => ({ ok: true, failures: [] })),
  clearProductsCache: jest.fn(async () => ({ ok: true, failures: [] })),
}));

// The notification/activity boundary. Everything below asserts on these calls.
jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));
jest.mock("../../src/utils/activityUtils/notify", () => ({
  __esModule: true,
  sendNotification: jest.fn(async () => ({})),
  sendNotificationToMany: jest.fn(async () => []),
  notifyRole: jest.fn(async () => []),
}));

import { acceptSpecialOffer, createSpecialOffer } from "../../src/controllers/orderController";
import { recordActivityBundle } from "../../src/utils/activityUtils/recordActivityBundle";
import { sendNotification } from "../../src/utils/activityUtils/notify";
import prisma from "../../src/lib/prisma";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const bundle = recordActivityBundle as unknown as jest.Mock;
const notify = sendNotification as unknown as jest.Mock;

const CUSTOMER_ID = "cust-1";
const VENDOR_ID = "vend-1";
const REQUEST_ID = "req-1";
const OFFER_ID = "offer-1";
const ORDER_ID = "order-9";

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

function offerFixture(over: Record<string, unknown> = {}) {
  db.specialOrderOffer.findUnique.mockResolvedValue({
    id: OFFER_ID,
    vendorId: VENDOR_ID,
    requestId: REQUEST_ID,
    price: 10000,
    status: "PENDING",
    request: {
      id: REQUEST_ID,
      customerId: CUSTOMER_ID,
      status: "OFFER_MADE",
      productId: "prod-1",
      quantity: 2,
    },
    ...over,
  });
  db.address.findFirst.mockResolvedValue({ id: "addr-1", userId: CUSTOMER_ID });
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
  db.order.create.mockImplementation(async (args: any) => ({ id: ORDER_ID, ...args.data }));
}

/** The caller is the CUSTOMER: the controller rejects anyone else (orderController.ts:1276). */
function acceptReq(): any {
  return {
    user: { id: CUSTOMER_ID, role: "CUSTOMER", sessionId: "s" },
    params: { offerId: OFFER_ID },
    body: { addressId: "addr-1" },
  };
}

const accept = async (): Promise<any> => {
  offerFixture();
  return acceptSpecialOffer(acceptReq(), res());
};

/** The single action the acceptance bundle is expected to carry. */
function onlyAction(): any {
  expect(bundle).toHaveBeenCalledTimes(1);
  const call = bundle.mock.calls[0][0];
  expect(call.actions).toHaveLength(1);
  return call.actions[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  db.specialOrderOffer.updateMany.mockResolvedValue({ count: 0 });
});

describe("acceptSpecialOffer — the notification goes to the VENDOR", () => {
  it("1. emits the bundle exactly once", async () => {
    await accept();
    expect(bundle).toHaveBeenCalledTimes(1);
    expect(bundle.mock.calls[0][0].actions).toHaveLength(1);
  });

  it("2. addresses the recipient to offer.vendorId, never the accepting customer", async () => {
    await accept();
    const action = onlyAction();
    expect(action.targetId).toBe(VENDOR_ID);
    expect(action.targetId).not.toBe(CUSTOMER_ID);
  });

  it("2b. sends the accepting customer NO separate notification of their own acceptance", async () => {
    // The customer's only feedback for this action is the HTTP 201 body.
    await accept();
    expect(notify).not.toHaveBeenCalled();
  });

  it("2c. does not set a relation, so the Activity row carries no recipient FK", async () => {
    // `recordActivityBundle` only writes vendorId/customerId/deliveryId when
    // `relation` is supplied. Leaving it unset keeps the Activity row attached
    // to the order only.
    await accept();
    const action = onlyAction();
    expect(action.relation).toBeUndefined();
  });

  it("3. keeps the exact title", async () => {
    await accept();
    expect(onlyAction().title).toBe("Your offer was accepted!");
  });

  it("4. states that the order is awaiting payment, and names that order", async () => {
    await accept();
    const { message } = onlyAction();
    expect(message).toContain("is awaiting payment");
    expect(message).toContain(ORDER_ID);
  });

  it("4b. the message qualifies payment, so it is not an actionable-order alert", async () => {
    // This is the whole justification for keeping a PRE-PAYMENT send. If the
    // qualifier is ever dropped, this fails.
    await accept();
    expect(onlyAction().message).toMatch(/awaiting payment/i);
    // ...and it must never adopt the unqualified checkout wording.
    expect(onlyAction().message).not.toMatch(/new order received/i);
  });

  it("5. carries the order id and the existing route, with no frontendEvent key", async () => {
    await accept();
    const { metadata } = onlyAction();
    expect(metadata.orderId).toBe(ORDER_ID);
    expect(metadata.route).toBe(`/orders/${ORDER_ID}`);
    expect(metadata.offerId).toBe(OFFER_ID);
    // An actionable trigger (`NEW_ORDER` / `NEW_PAID_ORDER_RECEIVED`) would make
    // this behave like the checkout defect that Phase 1 removed.
    expect(metadata).not.toHaveProperty("frontendEvent");
  });

  it("6. leaves the realtime and push flags enabled", async () => {
    await accept();
    const call = bundle.mock.calls[0][0];
    expect(call.notifyRealtime).toBe(true);
    expect(call.notifyPush).toBe(true);
  });

  it("6b. keeps the internal audit trail", async () => {
    await accept();
    const call = bundle.mock.calls[0][0];
    expect(call.audit).toMatchObject({
      action: "SPECIAL_OFFER_ACCEPTED",
      metadata: { offerId: OFFER_ID, requestId: REQUEST_ID, orderId: ORDER_ID },
    });
  });

  it("7. creates the order in AWAITING_PAYMENT with the schema-default pending payment", async () => {
    await accept();
    const data = db.order.create.mock.calls[0][0].data;
    expect(data.status).toBe("AWAITING_PAYMENT");
    // paymentStatus is deliberately NOT written, so `Order.paymentStatus`
    // (nullable, `@default(PENDING)`) supplies PENDING. Writing an explicit
    // value here would bypass the schema default the whole expiry path assumes.
    expect(data.paymentStatus).toBeUndefined();
  });

  it("7b. the order is addressed to the same vendor that was notified", async () => {
    await accept();
    const data = db.order.create.mock.calls[0][0].data;
    expect(data.vendorId).toBe(VENDOR_ID);
    expect(data.customerId).toBe(CUSTOMER_ID);
    expect(onlyAction().targetId).toBe(data.vendorId);
  });
});

describe("createSpecialOffer — the customer-facing message is preserved", () => {
  function offerReq(): any {
    return {
      user: { id: VENDOR_ID, role: "VENDOR", sessionId: "s" },
      params: { requestId: REQUEST_ID },
      body: { price: 10000 },
    };
  }

  beforeEach(() => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: "ACTIVE" });
    db.specialOrderRequest.findUnique.mockResolvedValue({
      id: REQUEST_ID,
      customerId: CUSTOMER_ID,
      status: "PENDING",
    });
    db.specialOrderOffer.create.mockResolvedValue({ id: OFFER_ID });
  });

  it("8. notifies the requesting customer, not the vendor", async () => {
    await createSpecialOffer(offerReq(), res());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].userId).toBe(CUSTOMER_ID);
    expect(notify.mock.calls[0][0].userId).not.toBe(VENDOR_ID);
  });

  it("8b. retains its existing title, message and route, and mentions no payment", async () => {
    await createSpecialOffer(offerReq(), res());
    const call = notify.mock.calls[0][0];
    expect(call.title).toBe("New offer on your special request");
    expect(call.message).toBe("A vendor offered ₦10000 for your special request.");
    expect(call.metadata).toMatchObject({
      requestId: REQUEST_ID,
      offerId: OFFER_ID,
      route: `/special-requests/${REQUEST_ID}`,
    });
    // This is the one customer-facing special-order message. It must stay
    // payment-agnostic and must never be turned into a vendor alert.
    expect(call.message).not.toMatch(/awaiting payment/i);
  });

  it("8c. does not emit a vendor-targeted activity bundle", async () => {
    await createSpecialOffer(offerReq(), res());
    expect(bundle).not.toHaveBeenCalled();
  });
});
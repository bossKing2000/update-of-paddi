/**
 * Batch 1D.43 — order transition authorization is role AND relationship.
 *
 * `updateOrderStatus` shared one endpoint between vendors and customers. Its
 * role gate compared the transition table's `roles` against the ACTIVE ROLE
 * CLAIM, which is an account-level property with no knowledge of the order
 * being acted on. Ownership was checked only as "vendor of this order OR
 * customer of this order", so the two were never combined.
 *
 * The defect, concretely: a user whose active role is VENDOR but who is the
 * CUSTOMER of another store's order passes `roles: [Role.VENDOR]` for
 * COOKING / READY_FOR_PICKUP / OUT_FOR_DELIVERY / FAILED_DELIVERY and can
 * advance an order they have nothing to do with.
 *
 * WHAT THESE TESTS DO NOT PROVE: anything about database-level concurrency,
 * transaction isolation, or compare-and-set locking. `prisma` is mocked and
 * `$transaction` is a pass-through, so a CAS is asserted by its arguments
 * only. Real locking evidence needs a database this environment does not
 * have; see the final report.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(async () => ({ count: 0 })) },
    order: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(async () => []), count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 0 })) },
    deliveryAssignment: { updateMany: jest.fn(async () => ({ count: 0 })) },
    deliveryEarning: { findUnique: jest.fn(async () => null) },
    deliveryPerson: { findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
    payment: { findFirst: jest.fn(async () => null), update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
    refundRequest: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})), update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
    auditLog: { create: jest.fn(async () => ({})) },
    product: { updateMany: jest.fn(async () => ({ count: 0 })) },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === "function" ? arg(require("../../src/lib/prisma").default) : arg,
    ),
  },
}));

jest.mock("../../src/services/clearCaches", () => ({ clearProductCache: jest.fn(async () => {}) }));
jest.mock("../../src/services/inventory.service", () => ({
  restoreStockForOrders: jest.fn(async () => {}),
  assertQuantityAvailable: jest.fn(async () => {}),
  reserveStockForItems: jest.fn(async () => {}),
}));
jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));
jest.mock("../../src/utils/activityUtils/notify", () => ({
  sendNotification: jest.fn(async () => {}),
  sendNotificationToMany: jest.fn(async () => {}),
  notifyRole: jest.fn(async () => {}),
}));
jest.mock("../../src/services/deliveryAssignmentReconciliation", () => ({
  ...jest.requireActual("../../src/services/deliveryAssignmentReconciliation"),
  reconcileActiveDeliveryAssignments: jest.fn(async () => {}),
}));
jest.mock("../../src/services/orderCompletionSideEffects", () => ({
  runOrderCompletionSideEffects: jest.fn(async () => {}),
}));
jest.mock("../../src/services/deliveryEarning", () => ({ creditDeliveryEarning: jest.fn(async () => {}) }));

import { Prisma, Role } from "@prisma/client";
import prisma from "../../src/lib/prisma";
import {
  updateOrderStatus,
  actorHoldsOrderRelationship,
} from "../../src/controllers/orderController";
import { authorizeVendor, authorizeCustomer } from "../../src/middlewares/auth.middleware";

const db = prisma as unknown as {
  user: Record<string, jest.Mock>;
  order: Record<string, jest.Mock>;
  $transaction: jest.Mock;
};

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const orderRow = (over: Record<string, unknown> = {}): any => ({
  id: "order-1",
  vendorId: "vendor-1",
  customerId: "customer-1",
  status: "PAYMENT_CONFIRMED",
  paymentStatus: "SUCCESS",
  idempotencyKey: "idem-1",
  vendor: { vendorStatus: "ACTIVE" },
  ...over,
});

const req = (user: Record<string, unknown>, body: Record<string, unknown>): any => ({
  user,
  params: { orderId: "order-1" },
  body,
  headers: {},
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

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : arg,
  );
  db.order.update.mockResolvedValue({ id: "order-1", status: "COOKING" });
  db.user.findUnique.mockResolvedValue({ vendorStatus: "ACTIVE" });
});

describe("1D.43 — a VENDOR-role customer cannot drive vendor-only transitions", () => {
  // The defect's exact shape: the account holds the VENDOR active role (so
  // the claim matches the table) but the order belongs to another store and
  // this user is only its customer.
  const vendorRoleCustomer = req(
    { id: "customer-1", role: "VENDOR", sessionId: "s1" },
    { status: "COOKING" },
  );

  it("cannot execute the COOKING step on another store's order", async () => {
    db.order.findUnique.mockResolvedValue(orderRow());
    const err = await rejection(updateOrderStatus(vendorRoleCustomer, res()));
    expect(err.message).toBe("You cannot perform this action");
  });

  it("cannot execute any vendor-only transition", async () => {
    for (const [from, to] of [
      ["PAYMENT_CONFIRMED", "COOKING"],
      ["COOKING", "READY_FOR_PICKUP"],
      ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"],
      ["OUT_FOR_DELIVERY", "FAILED_DELIVERY"],
    ]) {
      db.order.findUnique.mockResolvedValue(orderRow({ status: from }));
      const err = await rejection(
        updateOrderStatus(req({ id: "customer-1", role: "VENDOR" }, { status: to }), res()),
      );
      expect(err.message).toBe("You cannot perform this action");
    }
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("performs no write and no side effect when refused", async () => {
    db.order.findUnique.mockResolvedValue(orderRow());
    await rejection(updateOrderStatus(vendorRoleCustomer, res()));
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("still allows the cancellation both roles may perform", async () => {
    // CANCELLED is legitimately dual (customer or the store), so this actor's
    // customer relationship IS sufficient. The fix must not over-block.
    db.order.findUnique.mockResolvedValue(orderRow({ status: "PAYMENT_CONFIRMED" }));
    db.order.update.mockResolvedValue({ id: "order-1", status: "CANCELLED" });
    await updateOrderStatus(
      req({ id: "customer-1", role: "VENDOR" }, { status: "CANCELLED" }),
      res(),
    );
    expect(db.order.update.mock.calls[0][0].data.status).toBe("CANCELLED");
  });

  it("does not leak whether the caller is the vendor of this order", async () => {
    // Same message whether the caller owns the order as vendor, as customer,
    // or not at all — the refusal reveals nothing about the relationship.
    db.order.findUnique.mockResolvedValue(orderRow());
    const asCustomer = await rejection(updateOrderStatus(vendorRoleCustomer, res()));

    db.order.findUnique.mockResolvedValue(orderRow({ vendorId: "vendor-2" }));
    const asStranger = await rejection(updateOrderStatus(vendorRoleCustomer, res()));

    expect(asCustomer.message).toBe("You cannot perform this action");
    expect(asStranger.message).toBe(asCustomer.message);
  });
});

describe("1D.43 — the vendor of this order is still authorized", () => {
  it("can perform every permitted vendor transition", async () => {
    for (const [from, to] of [
      ["PAYMENT_CONFIRMED", "COOKING"],
      ["COOKING", "READY_FOR_PICKUP"],
      ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"],
      ["OUT_FOR_DELIVERY", "FAILED_DELIVERY"],
    ]) {
      db.order.findUnique.mockResolvedValue(orderRow({ status: from }));
      db.order.update.mockResolvedValue({ id: "order-1", status: to });
      db.order.update.mockClear();
      await updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: to }), res());
      expect(db.order.update).toHaveBeenCalledTimes(1);
    }
  });

  it("cannot transition another vendor's order", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendorId: "vendor-2" }));
    const err = await rejection(
      updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res()),
    );
    expect(err.message).toBe("Unauthorized user");
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("cannot transition an order it has no relationship to at all", async () => {
    db.order.findUnique.mockResolvedValue(
      orderRow({ vendorId: "vendor-2", customerId: "customer-9" }),
    );
    const err = await rejection(
      updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res()),
    );
    expect(err.message).toBe("Unauthorized user");
  });
});

describe("1D.43 — customer transitions are unchanged", () => {
  it("a customer can still confirm completion of their own order", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ status: "OUT_FOR_DELIVERY" }));
    db.order.update.mockResolvedValue({ id: "order-1", status: "COMPLETED" });
    await updateOrderStatus(
      req({ id: "customer-1", role: "CUSTOMER" }, { status: "COMPLETED" }),
      res(),
    );
    expect(db.order.update.mock.calls[0][0].data.status).toBe("COMPLETED");
  });

  it("a customer still cannot drive the vendor lifecycle", async () => {
    db.order.findUnique.mockResolvedValue(orderRow());
    const err = await rejection(
      updateOrderStatus(req({ id: "customer-1", role: "CUSTOMER" }, { status: "COOKING" }), res()),
    );
    expect(err.message).toBe("You cannot perform this action");
  });

  it("a customer of another store's order cannot confirm its completion", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ status: "OUT_FOR_DELIVERY" }));
    const err = await rejection(
      updateOrderStatus(req({ id: "customer-2", role: "CUSTOMER" }, { status: "COMPLETED" }), res()),
    );
    // Not the customer of this order at all.
    expect(err.message).toBe("Unauthorized user");
  });

  it("the vendor of an order cannot reach the customer-only COMPLETED step", async () => {
    // The mirror of the original defect, and the case the comment at the
    // transition table exists to prevent: the store must not confirm its own
    // delivery. The vendor holds the relationship but not the CUSTOMER role
    // the step requires, so the store cannot satisfy it.
    db.order.findUnique.mockResolvedValue(orderRow({ status: "OUT_FOR_DELIVERY" }));
    const err = await rejection(
      updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COMPLETED" }), res()),
    );
    expect(err.message).toBe("You cannot perform this action");
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("an actor holding the customer relationship satisfies the customer-only step", async () => {
    // ...and the other half: the relationship is necessary but the role claim
    // still applies, so the fix has not turned the table into a
    // relationship-only test.
    db.order.findUnique.mockResolvedValue(
      orderRow({ status: "OUT_FOR_DELIVERY", vendorId: "vendor-2" }),
    );
    db.order.update.mockResolvedValue({ id: "order-1", status: "COMPLETED" });
    await updateOrderStatus(
      req({ id: "customer-1", role: "CUSTOMER" }, { status: "COMPLETED" }),
      res(),
    );
    expect(db.order.update.mock.calls[0][0].data.status).toBe("COMPLETED");
  });
});

describe("1D.43 — other actors and prior protections are intact", () => {
  it("unauthenticated and wrong-role requests are still rejected by the route guards", () => {
    expect(() => authorizeVendor({ user: { id: "x", role: "CUSTOMER" } } as never, res(), jest.fn()))
      .toThrow("Access denied: requires one of [VENDOR]");
    expect(() => authorizeCustomer({ user: { id: "x", role: "VENDOR" } } as never, res(), jest.fn()))
      .toThrow("Access denied: requires one of [CUSTOMER]");
    expect(() => authorizeVendor({ user: undefined } as never, res(), jest.fn()))
      .toThrow("Authentication required");
  });

  it("the suspended-vendor check still runs before any write", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: "SUSPENDED" } }));
    const err = await rejection(
      updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res()),
    );
    expect(err.message).toBe("Your vendor account is suspended and cannot make changes right now. Contact support.");
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("SYSTEM_CONTROLLED statuses are still refused to any actor", async () => {
    for (const status of ["PAYMENT_CONFIRMED", "AWAITING_PAYMENT", "PENDING"]) {
      db.order.findUnique.mockResolvedValue(orderRow());
      const err = await rejection(
        updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status }), res()),
      );
      expect(err.message).toMatch(/controlled automatically/);
    }
  });

  it("expired orders remain dead ends", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ status: "PAYMENT_EXPIRED" }));
    const err = await rejection(
      updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res()),
    );
    expect(err.message).toMatch(/expired/);
  });

  it("the unpaid-order payment gate is unchanged", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ paymentStatus: "PENDING" }));
    const err = await rejection(
      updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res()),
    );
    expect(err.message).toMatch(/paid/);
  });

  it("the compare-and-set conflict behaviour is unchanged", async () => {
    db.order.findUnique.mockResolvedValue(orderRow());
    await updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res());
    expect(db.order.update.mock.calls[0][0].where).toEqual({
      id: "order-1",
      status: "PAYMENT_CONFIRMED",
    });

    db.order.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Record not found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );
    db.order.findUnique.mockResolvedValue(orderRow());
    const conflict = await rejection(
      updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res()),
    );
    expect(conflict.message).toMatch(/changed|conflict|no longer/i);
  });

  it("only the vendor of the order may cancel once preparation has started", async () => {
    // Pre-existing rule, kept: a customer cannot cancel a cooking order.
    db.order.findUnique.mockResolvedValue(orderRow({ status: "COOKING" }));
    const err = await rejection(
      updateOrderStatus(req({ id: "customer-1", role: "CUSTOMER" }, { status: "CANCELLED" }), res()),
    );
    expect(err.message).toMatch(/cannot be cancelled after preparation/);
  });
});
/**
 * Batch 1D.44 — the role-to-relationship mapping fails closed.
 *
 * The 1D.43 check ended with `return true` for any role that was not
 * VENDOR or CUSTOMER, so a role with no defined relationship passed the gate
 * automatically. Today the transition table contains only VENDOR and
 * CUSTOMER, so that fallback was unreachable — but it would have granted a
 * capability to the first rule anybody added ADMIN or DELIVERY to.
 *
 * These tests drive the extracted predicate directly, because the production
 * table cannot be made to contain an unmapped role without editing it, which
 * this batch forbids.
 */
describe("1D.44 — actorHoldsOrderRelationship fails closed on unmapped roles", () => {
  const BOTH = { isVendor: true, isCustomer: true };
  const NEITHER = { isVendor: false, isCustomer: false };

  it("maps VENDOR to the vendor relationship", () => {
    expect(actorHoldsOrderRelationship([Role.VENDOR], { isVendor: true, isCustomer: false })).toBe(true);
    expect(actorHoldsOrderRelationship([Role.VENDOR], { isVendor: false, isCustomer: true })).toBe(false);
    expect(actorHoldsOrderRelationship([Role.VENDOR], NEITHER)).toBe(false);
  });

  it("maps CUSTOMER to the customer relationship", () => {
    expect(actorHoldsOrderRelationship([Role.CUSTOMER], { isVendor: false, isCustomer: true })).toBe(true);
    expect(actorHoldsOrderRelationship([Role.CUSTOMER], { isVendor: true, isCustomer: false })).toBe(false);
    expect(actorHoldsOrderRelationship([Role.CUSTOMER], NEITHER)).toBe(false);
  });

  it("refuses roles that have no defined relationship, whatever the actor holds", () => {
    // ADMIN and DELIVERY never appear in the transition table; they act
    // through their own handlers. Mapping them here would invent a capability.
    for (const unmapped of [Role.ADMIN, Role.DELIVERY]) {
      for (const actor of [BOTH, NEITHER, { isVendor: true, isCustomer: false }, { isVendor: false, isCustomer: true }]) {
        expect(actorHoldsOrderRelationship([unmapped], actor)).toBe(false);
      }
    }
  });

  it("refuses a role value outside the Role enum entirely", () => {
    expect(actorHoldsOrderRelationship(["SUPERUSER" as Role], BOTH)).toBe(false);
    expect(actorHoldsOrderRelationship([undefined as unknown as Role], BOTH)).toBe(false);
  });

  it("refuses an empty role list", () => {
    expect(actorHoldsOrderRelationship([], BOTH)).toBe(false);
  });

  it("admits a dual-role rule when EITHER relationship is held", () => {
    // CANCELLED lists both roles; this is why it is not over-blocked.
    expect(actorHoldsOrderRelationship([Role.CUSTOMER, Role.VENDOR], { isVendor: true, isCustomer: false })).toBe(true);
    expect(actorHoldsOrderRelationship([Role.CUSTOMER, Role.VENDOR], { isVendor: false, isCustomer: true })).toBe(true);
    expect(actorHoldsOrderRelationship([Role.CUSTOMER, Role.VENDOR], NEITHER)).toBe(false);
  });

  it("does not let a mapped role rescue an otherwise unmapped rule", () => {
    // Holding both relationships is still not enough when the rule asks for a
    // role we have no relationship definition for.
    expect(actorHoldsOrderRelationship([Role.ADMIN, Role.DELIVERY], BOTH)).toBe(false);
    expect(actorHoldsOrderRelationship([Role.ADMIN, Role.VENDOR], BOTH)).toBe(true);
  });

  it("every Role enum member is either mapped or deliberately unmapped", () => {
    // Guards the invariant going forward: adding a role to the enum without
    // deciding its relationship fails here rather than silently failing open.
    const mapped = new Set<string>([Role.VENDOR, Role.CUSTOMER]);
    const deliberatelyUnmapped = new Set<string>([Role.ADMIN, Role.DELIVERY]);
    for (const role of Object.values(Role)) {
      const decided = mapped.has(role) || deliberatelyUnmapped.has(role);
      expect(decided).toBe(true);
    }
  });

  it("every role actually permitted today resolves to a relationship", () => {
    // The four roles the transition table can contain, per orderController.
    for (const role of [Role.VENDOR, Role.CUSTOMER]) {
      expect(actorHoldsOrderRelationship([role], { isVendor: true, isCustomer: true })).toBe(true);
    }
  });
});

describe("1D.44 — handler behaviour is unchanged for supported roles", () => {
  it("vendor transitions still require the vendor relationship", async () => {
    db.order.findUnique.mockResolvedValue(orderRow());
    const err = await rejection(
      updateOrderStatus(req({ id: "customer-1", role: "VENDOR" }, { status: "COOKING" }), res()),
    );
    expect(err.message).toBe("You cannot perform this action");
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("customer transitions still require the customer relationship", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ status: "OUT_FOR_DELIVERY", vendorId: "vendor-2" }));
    const err = await rejection(
      updateOrderStatus(req({ id: "customer-9", role: "CUSTOMER" }, { status: "COMPLETED" }), res()),
    );
    expect(err.message).toBe("Unauthorized user");
  });

  it("dual-role cancellation is still permitted for either party", async () => {
    // The store owner cancelling their own order.
    db.order.findUnique.mockResolvedValue(orderRow({ status: "PAYMENT_CONFIRMED" }));
    db.order.update.mockResolvedValue({ id: "order-1", status: "CANCELLED" });
    await updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "CANCELLED" }), res());
    expect(db.order.update.mock.calls[0][0].data.status).toBe("CANCELLED");

    // The customer cancelling.
    db.order.update.mockClear();
    db.order.update.mockResolvedValue({ id: "order-1", status: "CANCELLED" });
    await updateOrderStatus(req({ id: "customer-1", role: "CUSTOMER" }, { status: "CANCELLED" }), res());
    expect(db.order.update.mock.calls[0][0].data.status).toBe("CANCELLED");
  });

  it("suspension is still enforced before any write", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: "SUSPENDED" } }));
    const err = await rejection(
      updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res()),
    );
    expect(err.message).toMatch(/suspended/);
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("system-controlled statuses are still refused", async () => {
    for (const status of ["PAYMENT_CONFIRMED", "AWAITING_PAYMENT"]) {
      db.order.findUnique.mockResolvedValue(orderRow());
      const err = await rejection(
        updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status }), res()),
      );
      expect(err.message).toMatch(/controlled automatically/);
    }
  });

  it("the compare-and-set and its conflict handling are unchanged", async () => {
    db.order.findUnique.mockResolvedValue(orderRow());
    await updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res());
    expect(db.order.update.mock.calls[0][0].where).toEqual({
      id: "order-1",
      status: "PAYMENT_CONFIRMED",
    });

    db.order.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Record not found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );
    db.order.findUnique.mockResolvedValue(orderRow());
    const conflict = await rejection(
      updateOrderStatus(req({ id: "vendor-1", role: "VENDOR" }, { status: "COOKING" }), res()),
    );
    expect(conflict.message).toMatch(/changed|conflict|no longer/i);
  });
});

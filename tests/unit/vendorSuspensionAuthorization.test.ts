/**
 * Batch 1D.41 — suspended-vendor authorization hardening.
 *
 * Two write surfaces were reachable by a SUSPENDED vendor because
 * `authorizeVendor` reads only the signed `role` claim and never
 * `vendorStatus`:
 *
 *   1. PUT /api/vendor/payouts/bank-details — rewrote the account money is
 *      transferred to (and called Paystack to do it).
 *   2. PATCH /api/order/vendor/order/:orderId/update-status — drove
 *      COOKING / READY_FOR_PICKUP / OUT_FOR_DELIVERY / CANCELLED on orders
 *      they already held.
 *
 * These tests pin the refusal, that nothing is written and no provider is
 * called on rejection, that ACTIVE vendors keep working, that the check is
 * scoped to vendor-initiated actions (customers, admin, delivery and system
 * paths are unaffected), and that the existing ownership, role and
 * compare-and-set safeguards still hold.
 *
 * What these tests do NOT prove: anything about database-level concurrency
 * or transaction isolation. `prisma` is mocked and `$transaction` is a
 * pass-through, so the CAS arguments are asserted but the locking behaviour
 * is not exercised. That evidence lives in tests/integration, which needs a
 * database this environment does not have (see the final report).
 */
process.env.ENCRYPTION_KEY = "test-only-32-char-key-abcdef1234";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(async () => ({ count: 0 })), count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
    order: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(async () => []), count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 0 })), groupBy: jest.fn(async () => []) },
    auditLog: { create: jest.fn(async () => ({})) },
    deliveryEarning: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({})), upsert: jest.fn(async () => ({})) },
    deliveryAssignment: { updateMany: jest.fn(async () => ({ count: 0 })) },
    deliveryPerson: { findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
    payment: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []), update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })), count: jest.fn(async () => 0), groupBy: jest.fn(async () => []) },
    refundRequest: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null), create: jest.fn(async () => ({})), findMany: jest.fn(async () => []), update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })), aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })) },
    vendorPayout: { findUnique: jest.fn(async () => null), updateMany: jest.fn(async () => ({ count: 0 })), create: jest.fn(async () => ({})) },
    specialOrderRequest: { findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
    specialOrderOffer: { create: jest.fn(async () => ({})), findUnique: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === "function" ? arg(require("../../src/lib/prisma").default) : arg,
    ),
  },
}));

const mockResolveBankAccount = jest.fn(async () => ({ account_number: "0123456789", account_name: "TEST VENDOR" }));
const mockListBanks = jest.fn(async () => []);
jest.mock("../../src/services/payoutService", () => ({
  resolveBankAccount: (...a: unknown[]) => mockResolveBankAccount(...(a as [])),
  listBanks: (...a: unknown[]) => mockListBanks(...(a as [])),
}));

const mockClearProductCache = jest.fn(async () => {});
jest.mock("../../src/services/clearCaches", () => ({
  clearProductCache: (...a: unknown[]) => mockClearProductCache(...(a as [])),
}));

const mockRestoreStock = jest.fn(async () => {});
const mockAssertQuantity = jest.fn(async () => {});
const mockReserveStock = jest.fn(async () => {});
jest.mock("../../src/services/inventory.service", () => ({
  restoreStockForOrders: (...a: unknown[]) => mockRestoreStock(...(a as [])),
  assertQuantityAvailable: (...a: unknown[]) => mockAssertQuantity(...(a as [])),
  reserveStockForItems: (...a: unknown[]) => mockReserveStock(...(a as [])),
}));

const mockRecordActivity = jest.fn(async () => {});
jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  recordActivityBundle: (...a: unknown[]) => mockRecordActivity(...(a as [])),
}));

const mockSendNotification = jest.fn(async () => {});
jest.mock("../../src/utils/activityUtils/notify", () => ({
  sendNotification: (...a: unknown[]) => mockSendNotification(...(a as [])),
  sendNotificationToMany: jest.fn(async () => {}),
  notifyRole: jest.fn(async () => {}),
}));

const mockReconcile = jest.fn(async () => {});
// Only the reconciler is stubbed; the status predicates are the real ones so
// the terminal/dispatchable rules under test are not masked.
jest.mock("../../src/services/deliveryAssignmentReconciliation", () => ({
  ...jest.requireActual("../../src/services/deliveryAssignmentReconciliation"),
  reconcileActiveDeliveryAssignments: (...a: unknown[]) => mockReconcile(...(a as [])),
}));

const mockCompletionSideEffects = jest.fn(async () => {});
jest.mock("../../src/services/orderCompletionSideEffects", () => ({
  runOrderCompletionSideEffects: (...a: unknown[]) => mockCompletionSideEffects(...(a as [])),
}));

jest.mock("../../src/services/deliveryEarning", () => ({
  creditDeliveryEarning: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  createAuditLog: jest.fn(async () => {}),
}));

import { Prisma } from "@prisma/client";
import prisma from "../../src/lib/prisma";
import { setBankDetails } from "../../src/controllers/payoutController";
import { updateOrderStatus, createSpecialOffer } from "../../src/controllers/orderController";
import { adminUpdateOrderStatus } from "../../src/controllers/admin.controller";
import { authorizeVendor, requireRole } from "../../src/middlewares/auth.middleware";
import {
  VENDOR_SUSPENDED_MESSAGE,
  VENDOR_STATUS_UNRESOLVED_MESSAGE,
  assertVendorNotSuspended,
  isVendorStatusEstablishable,
} from "../../src/services/vendorStatus.service";

const db = prisma as unknown as {
  user: Record<string, jest.Mock>;
  order: Record<string, jest.Mock>;
  specialOrderRequest: Record<string, jest.Mock>;
  specialOrderOffer: Record<string, jest.Mock>;
  deliveryEarning: Record<string, jest.Mock>;
  $transaction: jest.Mock;
};

const SUSPENDED = "SUSPENDED" as const;
const ACTIVE = "ACTIVE" as const;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const bankReq = (over: Record<string, unknown> = {}): any => ({
  user: { id: "vendor-1", role: "VENDOR", sessionId: "s1" },
  body: { bankName: "GTBank", bankCode: "058", bankAccountNumber: "0123456789" },
  headers: {},
  ...over,
});

const orderRow = (over: Record<string, unknown> = {}): any => ({
  id: "order-1",
  vendorId: "vendor-1",
  customerId: "customer-1",
  status: "PAYMENT_CONFIRMED",
  paymentStatus: "SUCCESS",
  idempotencyKey: "idem-1",
  vendor: { vendorStatus: ACTIVE },
  ...over,
});

const statusReq = (over: Record<string, unknown> = {}): any => ({
  user: { id: "vendor-1", role: "VENDOR", sessionId: "s1" },
  params: { orderId: "order-1" },
  body: { status: "COOKING" },
  headers: {},
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveBankAccount.mockResolvedValue({ account_number: "0123456789", account_name: "TEST VENDOR" });
  db.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : arg,
  );
  db.order.update.mockResolvedValue({ id: "order-1", status: "COOKING" });
  db.user.update.mockResolvedValue({});
  db.user.findUnique.mockResolvedValue({ vendorStatus: ACTIVE });
});

/** Controllers throw AppErrors rather than writing 403 themselves. */
async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  return caught as Error;
}

describe("suspension policy is defined once", () => {
  it("refuses SUSPENDED and permits every other lifecycle state", () => {
    expect(() => assertVendorNotSuspended(SUSPENDED)).toThrow(VENDOR_SUSPENDED_MESSAGE);
    for (const status of [ACTIVE, "NEW", "PENDING_REVIEW", null, undefined]) {
      expect(() => assertVendorNotSuspended(status as any)).not.toThrow();
    }
  });

  it("raises a Forbidden so it maps to HTTP 403", () => {
    const err = (() => {
      try {
        assertVendorNotSuspended(SUSPENDED);
      } catch (e) {
        return e as Error & { statusCode?: number };
      }
      return null;
    })();
    expect(err?.name).toBe("ForbiddenError");
    expect((err as { statusCode?: number })?.statusCode).toBe(403);
  });
});

describe("PUT /vendor/payouts/bank-details", () => {
  it("1. a suspended vendor cannot update bank details", async () => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: SUSPENDED });
    const err = await expectRejection(setBankDetails(bankReq(), res()));
    expect(err.message).toBe(VENDOR_SUSPENDED_MESSAGE);
  });

  it("2. a suspended vendor cannot replace payout details that already exist", async () => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: SUSPENDED });
    // The account is fully configured, so this is a REPLACEMENT of a live
    // payout destination rather than a first-time setup.
    db.user.update.mockResolvedValue({});
    const err = await expectRejection(setBankDetails(bankReq(), res()));
    expect(err.message).toBe(VENDOR_SUSPENDED_MESSAGE);
    // Nothing was replaced.
    expect(db.user.update).not.toHaveBeenCalled();
    // And no payout-provider call was made at all: a rejected request must
    // leave no external side effect, not merely no database write.
    expect(mockResolveBankAccount).not.toHaveBeenCalled();
  });

  it("3. a rejected request performs no write and no provider call", async () => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: SUSPENDED });
    await expectRejection(setBankDetails(bankReq(), res()));
    expect(db.user.update).not.toHaveBeenCalled();
    expect(mockResolveBankAccount).not.toHaveBeenCalled();
  });

  it("5. an active vendor can still set their bank details", async () => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: ACTIVE });
    const r = res();
    await setBankDetails(bankReq(), r);
    expect(mockResolveBankAccount).toHaveBeenCalledWith("0123456789", "058");
    expect(db.user.update).toHaveBeenCalledTimes(1);
    const arg = db.user.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "vendor-1" });
    expect(arg.data.bankName).toBe("GTBank");
    expect(arg.data.bankAccountNumber).not.toBe("0123456789"); // stored encrypted
    expect(arg.data.bankAccountName).toBe("TEST VENDOR"); // from the provider
    // Changing details must still force a fresh recipient code.
    expect(arg.data.paystackRecipientCode).toBeNull();
  });

  it("5b. onboarding vendors (NEW / PENDING_REVIEW) are still allowed to set payout details", async () => {
    for (const status of ["NEW", "PENDING_REVIEW"]) {
      db.user.findUnique.mockResolvedValue({ vendorStatus: status });
      db.user.update.mockClear();
      await setBankDetails(bankReq(), res());
      expect(db.user.update).toHaveBeenCalledTimes(1);
    }
  });

  it("6. a vendor can only ever write their own payout details", async () => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: ACTIVE });
    await setBankDetails(bankReq({ body: { bankName: "X", bankCode: "058", bankAccountNumber: "0123456789", vendorId: "vendor-2" } }), res());
    // There is no vendorId in the payload the write honours: the target is
    // always the authenticated caller's own id.
    expect(db.user.update.mock.calls[0][0].where).toEqual({ id: "vendor-1" });
  });

  it("preserves existing validation on the happy path inputs", async () => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: SUSPENDED });
    const err = await expectRejection(
      setBankDetails(bankReq({ body: { bankName: "GTBank", bankCode: "058", bankAccountNumber: "123" } }), res()),
    );
    expect(err.message).toBe("Invalid bank details");
    expect(mockResolveBankAccount).not.toHaveBeenCalled();
  });
});

describe("PATCH /order/vendor/order/:orderId/update-status", () => {
  it("3. a suspended vendor cannot advance an existing order", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: SUSPENDED } }));
    const err = await expectRejection(updateOrderStatus(statusReq(), res()));
    expect(err.message).toBe(VENDOR_SUSPENDED_MESSAGE);
  });

  it("3b. a suspended vendor is blocked at every vendor-authorised step, not just COOKING", async () => {
    for (const [from, to] of [
      ["PAYMENT_CONFIRMED", "COOKING"],
      ["COOKING", "READY_FOR_PICKUP"],
      ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"],
      ["OUT_FOR_DELIVERY", "FAILED_DELIVERY"],
      ["COOKING", "CANCELLED"],
    ]) {
      db.order.findUnique.mockResolvedValue(orderRow({
        status: from,
        vendor: { vendorStatus: SUSPENDED },
      }));
      const err = await expectRejection(updateOrderStatus(statusReq({ body: { status: to } }), res()));
      expect(err.message).toBe(VENDOR_SUSPENDED_MESSAGE);
    }
  });

  it("4. a rejected order transition changes nothing", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: SUSPENDED } }));
    await expectRejection(updateOrderStatus(statusReq(), res()));
    // No transaction was opened, so nothing was written and no side effect
    // (cache sweep, activity feed, inventory restore) could run.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
    expect(mockClearProductCache).not.toHaveBeenCalled();
    expect(mockRecordActivity).not.toHaveBeenCalled();
    expect(mockRestoreStock).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("5. an active vendor can still advance an order", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: ACTIVE } }));
    await updateOrderStatus(statusReq(), res());
    expect(db.order.update).toHaveBeenCalledTimes(1);
    expect(db.order.update.mock.calls[0][0].data).toEqual({ status: "COOKING" });
  });

  it("5c. onboarding vendors are still allowed to drive their orders", async () => {
    for (const status of ["NEW", "PENDING_REVIEW", null]) {
      db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: status } }));
      db.order.update.mockClear();
      await updateOrderStatus(statusReq(), res());
      expect(db.order.update).toHaveBeenCalledTimes(1);
    }
  });

  it("6. a vendor cannot transition another vendor's order", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendorId: "vendor-2" }));
    const err = await expectRejection(updateOrderStatus(statusReq(), res()));
    expect(err.message).toBe("Unauthorized user");
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("6b. a vendor cannot transition an order they are not the vendor of, even when suspended", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendorId: "vendor-2", vendor: { vendorStatus: SUSPENDED } }));
    const err = await expectRejection(updateOrderStatus(statusReq(), res()));
    // Ownership is still checked first; the suspension guard never runs for
    // someone who does not own the order.
    expect(err.message).toBe("Unauthorized user");
  });

  it("7. a customer is NOT blocked by the vendor's suspension", async () => {
    // The vendor of this order is suspended, but the caller is its customer.
    db.order.findUnique.mockResolvedValue(orderRow({
      vendor: { vendorStatus: SUSPENDED },
      status: "AWAITING_PAYMENT",
    }));
    db.order.update.mockResolvedValue({ id: "order-1", status: "CANCELLED" });
    await updateOrderStatus(
      statusReq({
        user: { id: "customer-1", role: "CUSTOMER", sessionId: "s2" },
        body: { status: "CANCELLED" },
      }),
      res(),
    );
    expect(db.order.update).toHaveBeenCalledTimes(1);
    expect(db.order.update.mock.calls[0][0].data.status).toBe("CANCELLED");
  });

  it("7b. an admin can still force a status on a suspended vendor's order", async () => {
    // adminUpdateOrderStatus is a separate, admin-only handler and is
    // deliberately NOT behind the vendor suspension guard: administrative
    // recovery must keep working. Batch D added a CAS on the pre-read
    // status (concurrent changes surface as 409) and a terminal-state
    // guard — neither applies to this live-order correction.
    db.order.findUnique.mockResolvedValue({ id: "order-1", status: "COOKING" });
    db.order.update.mockResolvedValue({ id: "order-1", status: "READY_FOR_PICKUP" });
    await adminUpdateOrderStatus(
      {
        user: { id: "admin-1", role: "ADMIN", sessionId: "s3" },
        params: { id: "order-1" },
        body: { status: "READY_FOR_PICKUP", reason: "dispute resolution" },
        headers: {},
      } as never,
      res(),
    );
    expect(db.order.update).toHaveBeenCalledWith({
      where: { id: "order-1", status: "COOKING" },
      data: { status: "READY_FOR_PICKUP" },
    });
  });

  it("8. wrong-role and unauthenticated requests remain rejected", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: ACTIVE } }));
    // A customer may not drive the cooking step.
    const wrongRole = await expectRejection(
      updateOrderStatus(
        statusReq({ user: { id: "customer-1", role: "CUSTOMER", sessionId: "s2" }, body: { status: "COOKING" } }),
        res(),
      ),
    );
    expect(wrongRole.message).toBe("You cannot perform this action");

    // The vendor route guard still rejects a non-vendor role...
    expect(() => authorizeVendor({ user: { id: "customer-1", role: "CUSTOMER" } } as never, res(), jest.fn()))
      .toThrow("Access denied: requires one of [VENDOR]");
    // ...and an unauthenticated request.
    expect(() => requireRole("VENDOR")({ user: undefined } as never, res(), jest.fn()))
      .toThrow("Authentication required");
  });

  it("10. the compare-and-set transition safeguard is untouched", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: ACTIVE } }));
    await updateOrderStatus(statusReq(), res());
    // The write is still guarded on the status we read, inside a transaction.
    expect(db.order.update.mock.calls[0][0].where).toEqual({ id: "order-1", status: "PAYMENT_CONFIRMED" });
    expect(db.$transaction).toHaveBeenCalledTimes(1);

    // And a lost race still produces 409 rather than clobbering.
    db.order.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Record not found", { code: "P2025", clientVersion: "test" }),
    );
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: ACTIVE } }));
    const conflict = await expectRejection(updateOrderStatus(statusReq(), res()));
    expect(conflict.message).toMatch(/changed|conflict|no longer/i);
  });

  it("9. the guard is on the handler, not the route, so an alternate path cannot bypass it", async () => {
    // The order route applies `authenticate` only — no role middleware and no
    // suspension middleware — because the same endpoint serves customers.
    // Calling the handler directly (as any future route would) is therefore
    // the worst case, and it is still protected.
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: SUSPENDED } }));
    const err = await expectRejection(updateOrderStatus(statusReq(), res()));
    expect(err.message).toBe(VENDOR_SUSPENDED_MESSAGE);
  });

  it("9b. the bank-details guard is likewise on the handler", async () => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: SUSPENDED });
    const err = await expectRejection(setBankDetails(bankReq(), res()));
    expect(err.message).toBe(VENDOR_SUSPENDED_MESSAGE);
  });
});
/**
 * Batch 1D.42 Part A — the order-transition guard must FAIL CLOSED.
 *
 * Before, `order.vendor?.vendorStatus ?? null` collapsed "the relation was
 * not loaded" and "this vendor is not suspended" into the same value, so an
 * unreadable status silently read as safe. These tests pin the difference.
 */
describe("1D.42 Part A — order transitions fail closed on an unresolved vendor status", () => {
  it("isVendorStatusEstablishable separates a read status from an absent one", () => {
    // Established: every real lifecycle value, including the modelled null.
    for (const status of [ACTIVE, SUSPENDED, "NEW", "PENDING_REVIEW", null]) {
      expect(isVendorStatusEstablishable(status)).toBe(true);
    }
    // Not established: the field was never read, or holds something the
    // lifecycle does not model.
    for (const status of [undefined, "", "  ", 0, {}, "UNKNOWN"]) {
      expect(isVendorStatusEstablishable(status)).toBe(false);
    }
  });

  it("rejects when the vendor relation is missing entirely", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: undefined }));
    const err = await expectRejection(updateOrderStatus(statusReq(), res()));
    expect(err.message).toBe(VENDOR_STATUS_UNRESOLVED_MESSAGE);
    expect(err.name).toBe("ForbiddenError");
  });

  it("rejects when the relation exists but carries no status field", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: {} }));
    const err = await expectRejection(updateOrderStatus(statusReq(), res()));
    expect(err.message).toBe(VENDOR_STATUS_UNRESOLVED_MESSAGE);
  });

  it("rejects rather than treating an unresolved status as unsuspended", async () => {
    for (const vendor of [undefined, null, {}]) {
      db.order.findUnique.mockResolvedValue(orderRow({ vendor }));
      const err = await expectRejection(updateOrderStatus(statusReq(), res()));
      expect(err.message).toBe(VENDOR_STATUS_UNRESOLVED_MESSAGE);
    }
    // And nothing was written on any of those attempts.
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("still refuses a SUSPENDED vendor with the established suspension message", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: SUSPENDED } }));
    const err = await expectRejection(updateOrderStatus(statusReq(), res()));
    expect(err.message).toBe(VENDOR_SUSPENDED_MESSAGE);
  });

  it("still allows ACTIVE, onboarding and a modelled null status", async () => {
    for (const status of [ACTIVE, "NEW", "PENDING_REVIEW", null]) {
      db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: status } }));
      db.order.update.mockClear();
      await updateOrderStatus(statusReq(), res());
      expect(db.order.update).toHaveBeenCalledTimes(1);
    }
  });

  it("needs no second query to establish the status", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: ACTIVE } }));
    await updateOrderStatus(statusReq(), res());
    // The status comes from the order query that was already required.
    expect(db.order.findUnique).toHaveBeenCalledTimes(1);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("does not apply the guard to a customer, even when the relation is missing", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({
      vendor: undefined,
      status: "AWAITING_PAYMENT",
    }));
    db.order.update.mockResolvedValue({ id: "order-1", status: "CANCELLED" });
    await updateOrderStatus(
      statusReq({
        user: { id: "customer-1", role: "CUSTOMER", sessionId: "s2" },
        body: { status: "CANCELLED" },
      }),
      res(),
    );
    expect(db.order.update).toHaveBeenCalledTimes(1);
  });

  it("does not read a third party's status when a vendor acts as the customer", async () => {
    // A VENDOR-role user who is the CUSTOMER of somebody else's order is
    // acting as a customer. Judging their cancellation by the other store's
    // suspension would be wrong in both directions.
    db.order.findUnique.mockResolvedValue(orderRow({
      vendorId: "vendor-2",
      customerId: "vendor-1",
      status: "AWAITING_PAYMENT",
      vendor: { vendorStatus: SUSPENDED },
    }));
    db.order.update.mockResolvedValue({ id: "order-1", status: "CANCELLED" });
    await updateOrderStatus(
      statusReq({
        user: { id: "vendor-1", role: "VENDOR", sessionId: "s1" },
        body: { status: "CANCELLED" },
      }),
      res(),
    );
    expect(db.order.update).toHaveBeenCalledTimes(1);
    expect(db.order.update.mock.calls[0][0].data.status).toBe("CANCELLED");
  });

  it("checks ownership before the status guard", async () => {
    // A non-owner must not be told anything about the vendor's status.
    db.order.findUnique.mockResolvedValue(orderRow({ vendorId: "vendor-2" }));
    const err = await expectRejection(updateOrderStatus(statusReq(), res()));
    expect(err.message).toBe("Unauthorized user");
  });

  it("preserves the compare-and-set for an accepted vendor", async () => {
    db.order.findUnique.mockResolvedValue(orderRow({ vendor: { vendorStatus: ACTIVE } }));
    await updateOrderStatus(statusReq(), res());
    expect(db.order.update.mock.calls[0][0].where).toEqual({
      id: "order-1",
      status: "PAYMENT_CONFIRMED",
    });
  });
});

/**
 * Batch 1D.42 Part B — vendor-initiated special-order offers.
 *
 * Only creation exists; there is no update/delete offer endpoint. The
 * decision to enforce is documented in the handler and in the final report.
 */
describe("1D.42 Part B — special-order offers follow the vendor lifecycle policy", () => {
  const offerReq = (over: Record<string, unknown> = {}): any => ({
    user: { id: "vendor-1", role: "VENDOR", sessionId: "s1" },
    params: { requestId: "req-1" },
    body: { price: 5000, message: "happy to do it" },
    headers: {},
    ...over,
  });

  beforeEach(() => {
    db.specialOrderRequest.findUnique.mockResolvedValue({
      id: "req-1",
      customerId: "customer-1",
      productId: "prod-1",
      quantity: 2,
      status: "PENDING",
    });
    db.user.findUnique.mockResolvedValue({ vendorStatus: ACTIVE });
    db.specialOrderOffer.create.mockResolvedValue({ id: "offer-1" });
  });

  it("an active vendor can still place an offer", async () => {
    await createSpecialOffer(offerReq(), res());
    expect(db.specialOrderOffer.create).toHaveBeenCalledTimes(1);
    expect(db.specialOrderOffer.create.mock.calls[0][0].data).toEqual({
      requestId: "req-1",
      vendorId: "vendor-1",
      price: 5000,
      message: "happy to do it",
    });
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
  });

  it("an onboarding vendor can still place an offer", async () => {
    for (const status of ["NEW", "PENDING_REVIEW", null]) {
      db.user.findUnique.mockResolvedValue({ vendorStatus: status });
      db.specialOrderOffer.create.mockClear();
      await createSpecialOffer(offerReq(), res());
      expect(db.specialOrderOffer.create).toHaveBeenCalledTimes(1);
    }
  });

  it("a suspended vendor cannot place an offer", async () => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: SUSPENDED });
    const err = await expectRejection(createSpecialOffer(offerReq(), res()));
    expect(err.message).toBe(VENDOR_SUSPENDED_MESSAGE);
    expect(err.name).toBe("ForbiddenError");
  });

  it("a rejected offer writes nothing and notifies nobody", async () => {
    db.user.findUnique.mockResolvedValue({ vendorStatus: SUSPENDED });
    await expectRejection(createSpecialOffer(offerReq(), res()));
    expect(db.specialOrderOffer.create).not.toHaveBeenCalled();
    // The request must not be flipped to OFFER_MADE either.
    expect(db.specialOrderRequest.update).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
    // And not even a lookup against the caller-supplied request id.
    expect(db.specialOrderRequest.findUnique).not.toHaveBeenCalled();
  });

  it("fails closed when the vendor row cannot be read", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const err = await expectRejection(createSpecialOffer(offerReq(), res()));
    expect(err.message).toBe(VENDOR_STATUS_UNRESOLVED_MESSAGE);
    expect(db.specialOrderOffer.create).not.toHaveBeenCalled();
  });

  it("preserves the self-dealing guard", async () => {
    db.specialOrderRequest.findUnique.mockResolvedValue({
      id: "req-1",
      customerId: "vendor-1", // their own request
      productId: "prod-1",
      quantity: 1,
      status: "PENDING",
    });
    const err = await expectRejection(createSpecialOffer(offerReq(), res()));
    expect(err.message).toBe("You cannot make an offer on your own request.");
    expect(db.specialOrderOffer.create).not.toHaveBeenCalled();
  });

  it("preserves the closed-request guard", async () => {
    db.specialOrderRequest.findUnique.mockResolvedValue({
      id: "req-1",
      customerId: "customer-1",
      productId: "prod-1",
      quantity: 1,
      status: "ACCEPTED",
    });
    const err = await expectRejection(createSpecialOffer(offerReq(), res()));
    expect(err.message).toBe("This request is no longer open for offers");
    expect(db.specialOrderOffer.create).not.toHaveBeenCalled();
  });

  it("preserves offer validation before any authorization work", async () => {
    const err = await expectRejection(createSpecialOffer(offerReq({ body: { message: "no price" } }), res()));
    expect(err.message).toBe("Invalid offer");
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.specialOrderOffer.create).not.toHaveBeenCalled();
  });

  it("still rejects a missing request", async () => {
    db.specialOrderRequest.findUnique.mockResolvedValue(null);
    const err = await expectRejection(createSpecialOffer(offerReq(), res()));
    expect(err.message).toBe("Special request not found");
    expect(db.specialOrderOffer.create).not.toHaveBeenCalled();
  });
});

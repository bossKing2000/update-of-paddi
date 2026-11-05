import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";
import { ActivityType, OrderStatus, Prisma, Role, type Order } from "@prisma/client";
import dayjs from "dayjs";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { sendNotification } from "../utils/activityUtils/notify";
import { ensureString } from "../utils/paramUtils";
import { clearProductCache } from "../services/clearCaches";
import {
  buildOrderMoneySnapshot,
  resolveCommissionRate,
} from "../services/orderSnapshot.service";
import { sendSuccess, sendCreated, koboToNaira } from "../utils/apiResponse";import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from "../errors/AppError";
import {
  updateOrderStatusSchema,
  createSpecialRequestSchema,
  createSpecialOfferSchema,
} from "../validations/orderSchema";
import { calculateDeliveryFee } from "../services/deliveryFee.service";
import { restoreStockForOrders } from "../services/inventory.service";
import { runOrderCompletionSideEffects } from "../services/orderCompletionSideEffects";
import {
  isTerminalOrderStatus,
  reconcileActiveDeliveryAssignments,
} from "../services/deliveryAssignmentReconciliation";
import { creditDeliveryEarning } from "../services/deliveryEarning";
import { logger } from "../lib/logger";
import { fileRefundOwed } from "../services/refundObligation.service";
import {
  assertQuantityAvailable,
  reserveStockForItems,
} from "../services/inventory.service";
import {
  assertVendorAvailableForOrdering,
} from "../services/vendorAvailability.service";
import { releaseOrderDailyCaps } from "../services/scheduling.service";
import {
  assertVendorNotSuspended,
  isVendorStatusEstablishable,
  VENDOR_STATUS_UNRESOLVED_MESSAGE,
} from "../services/vendorStatus.service";
import {
  isVendorVisibleOrder,
  vendorVisibleOrderWhere,
} from "../services/vendorOrderVisibility";

const round = (v: number) => Number(v.toFixed(2));

// Groups a flat list of {createdAt, totalPrice} rows into day buckets.
// Used instead of Prisma's `groupBy({ by: ["createdAt"] })`, which groups
// by the exact millisecond timestamp and therefore never actually
// aggregates anything by day — every row lands in its own group. This was
// silently broken in the customer order-stats trend chart before.
export function bucketByDay(
  rows: { createdAt: Date; totalPrice?: number }[],
  days: string[],
) {
  const buckets = new Map<string, { count: number; revenue: number }>();
  for (const d of days) buckets.set(d, { count: 0, revenue: 0 });

  for (const row of rows) {
    const key = row.createdAt.toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.revenue += row.totalPrice ?? 0;
    }
  }

  return days.map((date) => ({ date, ...buckets.get(date)! }));
}

// GET /orders - list the current user's orders (as customer or vendor)
export const getMyOrders = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const skip = (page - 1) * limit;

  const status = req.query.status as string | undefined;
  const paymentStatus = req.query.paymentStatus as string | undefined;

  // Phase 1 — vendor order visibility.
  //
  // Checkout creates orders in AWAITING_PAYMENT before the customer has paid,
  // so the VENDOR branch of this OR is filtered by the shared visibility rule:
  // a store sees an order only once payment is authoritatively settled.
  //
  // The CUSTOMER branch is deliberately left unfiltered. Requirement 4 of this
  // phase is that a customer must keep seeing their own pending order, and a
  // global `status`/`paymentStatus` restriction here would hide the very rows
  // the customer needs in order to pay them. The rule is therefore applied per
  // ownership branch, not to the whole result set — see
  // src/services/vendorOrderVisibility.ts.
  //
  // Ownership is unchanged and still scopes both branches to the caller, so
  // this cannot widen what any account can reach.
  const where: Prisma.OrderWhereInput = {
    OR: [
      { customerId: userId },
      vendorVisibleOrderWhere({ vendorId: userId }),
    ],
    ...(status && { status: status as OrderStatus }),
    ...(paymentStatus && { paymentStatus: paymentStatus as any }),
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                images: true,
                price: true,
                archived: true,
              },
            },
            options: {
              include: {
                productOption: {
                  select: { id: true, name: true, price: true },
                },
              },
            },
          },
        },
        customer: { select: { id: true, name: true, avatarUrl: true } },
        vendor: {
          select: { id: true, name: true, brandName: true, brandLogo: true },
        },
        address: { select: { label: true, street: true, city: true } },
        assignments: {
          include: {
            deliveryPerson: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    phoneNumber: true,
                    avatarUrl: true,
                    brandName: true,
                    brandLogo: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.order.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  // Phase 3A: order.totalPrice is integer kobo; report naira to clients so
  // legacy Flutter/web clients keep seeing naira amounts.
  const ordersForClient = orders.map((o) => ({
    ...o,
    totalPrice: koboToNaira(o.totalPrice),
  }));

  return sendSuccess(res, { orders: ordersForClient }, "Orders retrieved successfully", 200, {
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  });
};

// GET /orders/batch/:idempotencyKey - retrieve all orders sharing an idempotencyKey (checkout batch)
export const getOrderBatch = async (req: AuthRequest, res: Response) => {
  const idempotencyKey = ensureString(req.params.idempotencyKey);
  if (!idempotencyKey) {
    throw new ValidationError("idempotencyKey is required");
  }
  const userId = req.user!.id;

  const orders = await prisma.order.findMany({
    where: { idempotencyKey, customerId: userId },
    orderBy: { createdAt: "asc" },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              images: true,
              price: true,
              archived: true,
            },
          },
          options: {
            include: {
              productOption: {
                select: { id: true, name: true, price: true },
              },
            },
          },
        },
      },
      customer: { select: { id: true, name: true, avatarUrl: true } },
      vendor: {
        select: { id: true, name: true, brandName: true, brandLogo: true },
      },
      address: { select: { label: true, street: true, city: true } },
      assignments: {
        include: {
          deliveryPerson: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  phoneNumber: true,
                  avatarUrl: true,
                  brandName: true,
                  brandLogo: true,
                },
              },
            },
          },
        },
      },
      payments: {
        select: {
          id: true,
          reference: true,
          amount: true,
          status: true,
          channel: true,
          createdAt: true,
          completedAt: true,
        },
      },
    },
  });

  if (orders.length === 0) {
    throw new NotFoundError("Order batch");
  }

  // Calculate batch aggregates
  const orderCount = orders.length;
  const total = orders.reduce((sum, o) => sum + o.totalPrice, 0);

  // Determine batch payment status from individual order payment statuses
  const paymentStatuses = orders.map((o) => o.paymentStatus);
  const allSucceeded = paymentStatuses.every((s) => s === "SUCCESS");
  const allFailed = paymentStatuses.every((s) => s !== "PENDING" && s !== "INITIATED" && s !== "SUCCESS");
  const someSucceeded = paymentStatuses.some((s) => s === "SUCCESS");
  const hasPending = paymentStatuses.some((s) => s === "PENDING" || s === "INITIATED");

  let paymentStatus: string;
  if (allSucceeded) {
    paymentStatus = "SUCCESS";
  } else if (allFailed) {
    paymentStatus = "FAILED";
  } else if (someSucceeded && hasPending) {
    paymentStatus = "PARTIAL";
  } else if (hasPending) {
    paymentStatus = "PENDING";
  } else {
    paymentStatus = "FAILED";
  }

  // Phase 3A: totals are integer kobo; report naira to clients.
  const totalNaira = koboToNaira(total);
  const ordersForClient = orders.map((o) => ({
    ...o,
    totalPrice: koboToNaira(o.totalPrice),
  }));

  const batch = {
    idempotencyKey,
    orderCount,
    total: totalNaira,
    paymentStatus,
    orders: ordersForClient,
  };

  return sendSuccess(res, { batch }, "Order batch retrieved successfully");
};

// GET /orders/:orderId - single order detail
export const getSingleOrder = async (req: AuthRequest, res: Response) => {
  const orderId = ensureString(req.params.orderId);
  const userId = req.user!.id;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              description: true,
              images: true,
              price: true,
            },
          },
          options: {
            include: {
              productOption: { select: { id: true, name: true, price: true } },
            },
          },
        },
      },
      customer: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
      vendor: {
        select: {
          id: true,
          name: true,
          brandName: true,
          brandLogo: true,
          phoneNumber: true,
        },
      },
      address: {
        select: {
          id: true,
          label: true,
          street: true,
          city: true,
          latitude: true,
          longitude: true,
        },
      },
      assignments: {
        include: {
          deliveryPerson: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  phoneNumber: true,
                  avatarUrl: true,
                  brandName: true,
                  brandLogo: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!order) throw new NotFoundError("Order");
  // Phase 1 — vendor order visibility (detail counterpart of the list filter
  // in `getMyOrders`). Hiding an order in a list is worthless if the same row
  // is still fetchable by id, so the detail path carries the identical rule.
  //
  // The customer branch is untouched: a customer keeps full access to their own
  // pending order, which is what they need in order to pay it.
  //
  // Both refusals deliberately share one message, so a rejected caller cannot
  // tell "not yours" from "exists but not paid yet" — the same no-enumeration
  // property the vendor-suspension check uses further down this file.
  const isOrderCustomer = order.customerId === userId;
  const isOrderVendor = order.vendorId === userId;
  if (
    !isOrderCustomer &&
    (!isOrderVendor || !isVendorVisibleOrder(order))
  ) {
    throw new ForbiddenError("You don't have access to this order");
  }

  // Phase 3A: order.totalPrice is integer kobo; report naira to clients.
  const orderForClient = { ...order, totalPrice: koboToNaira(order.totalPrice) };

  return sendSuccess(res, { order: orderForClient }, "Order retrieved successfully");
};

/**
 * Which relationship to an order each role must hold to act on it through
 * `updateOrderStatus`.
 *
 * Batch 1D.43 introduced this check. Batch 1D.44 makes it FAIL CLOSED: the
 * first version treated "no relationship defined for this role" as "allowed",
 * so any role beyond VENDOR/CUSTOMER would have passed the gate the moment it
 * appeared in a transition rule. An unmapped role is now refused.
 *
 * Roles present in the `transitions` table today are exactly VENDOR and
 * CUSTOMER, so no other entry is needed. ADMIN and DELIVERY are deliberately
 * NOT mapped and must not be added without evidence:
 *   - ADMIN never appears in this table; it acts through
 *     `adminUpdateOrderStatus` under `authorizeAdmin`, a separate handler.
 *   - DELIVERY never appears in this table either; drivers act through
 *     `DeliveryAssignmentService.updateStatus` under
 *     `authorizeDeliveryPerson`, which mirrors to Order.status separately.
 * Guessing a relationship for either would invent a capability that does not
 * exist today.
 */
const ORDER_ROLE_RELATIONSHIP: Partial<
  Record<Role, (actor: OrderActorRelationship) => boolean>
> = {
  [Role.VENDOR]: ({ isVendor }) => isVendor,
  [Role.CUSTOMER]: ({ isCustomer }) => isCustomer,
};

export interface OrderActorRelationship {
  /** The actor is this order's vendor. */
  isVendor: boolean;
  /** The actor is this order's customer. */
  isCustomer: boolean;
}

/**
 * True when the actor holds, for this specific order, the relationship that
 * at least one of `roles` stands for.
 *
 * A role with no entry in ORDER_ROLE_RELATIONSHIP is refused: we do not know
 * what relationship it represents on an order, and "unknown" must not read as
 * "permitted". Callers additionally check the actor's active role against the
 * same list, so both the account-level capability and the order-level
 * relationship must hold.
 */
export function actorHoldsOrderRelationship(
  roles: readonly Role[],
  actor: OrderActorRelationship,
): boolean {
  return roles.some((required) => {
    const relationship = ORDER_ROLE_RELATIONSHIP[required];
    return relationship ? relationship(actor) : false;
  });
}

// PATCH /orders/vendor/order/:orderId/update-status
export const updateOrderStatus = async (req: AuthRequest, res: Response) => {
  const orderId = ensureString(req.params.orderId);
  const userId = req.user!.id;
  const userRole = req.user!.role as Role;

  const parsed = updateOrderStatusSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid or missing order status",
      parsed.error.flatten().fieldErrors,
    );
  const { status } = parsed.data;

  // `include` (not `select`) so every scalar field the rest of this handler
  // reads is still returned; only the vendor's lifecycle status is added.
  //
  // Batch 1D.41/1D.42: the vendor's `vendorStatus` is read here so a SUSPENDED
  // vendor cannot drive fulfilment on orders they already hold. Taken from
  // the order's own relation rather than a second query — the actor below is
  // this very user, whose row `authenticate` has already loaded, so no
  // additional round trip is needed.
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { vendor: { select: { vendorStatus: true } } },
  });
  if (!order) throw new NotFoundError("Order");

  const isVendor = userId === order.vendorId;
  const isCustomer = userId === order.customerId;
  if (!isVendor && !isCustomer) throw new ForbiddenError("Unauthorized user");

  // Suspension applies to vendor-INITIATED actions only. Customers keep their
  // own transitions (including cancelling), and admin / delivery / system
  // writers never reach this handler, so recovery paths, payment finalisation
  // and the delivery mirror are untouched.
  //
  // Scoped to `isVendor` as well as the role: a vendor who is the CUSTOMER of
  // somebody else's order is acting as a customer, and `order.vendor` would
  // describe a different account. Judging their cancellation by a third
  // party's suspension would be wrong in both directions.
  if (userRole === Role.VENDOR && isVendor) {
    const vendorStatus = order.vendor?.vendorStatus;
    // Batch 1D.42 — FAIL CLOSED. A missing relation or unreadable field is
    // NOT evidence that the vendor is unsuspended. Only an explicitly read
    // status may pass; anything else is refused rather than assumed safe.
    if (!isVendorStatusEstablishable(vendorStatus)) {
      throw new ForbiddenError(VENDOR_STATUS_UNRESOLVED_MESSAGE);
    }
    assertVendorNotSuspended(vendorStatus);
  }

  const currentStatus = order.status;

  // Expired orders are dead ends — nothing can change their status through
  // this endpoint. Give a clear, specific message rather than falling
  // through to a generic "invalid transition" error.
  if (
    currentStatus === OrderStatus.PAYMENT_EXPIRED ||
    currentStatus === OrderStatus.CANCELLED_UNPAID
  ) {
    throw new ConflictError(
      "This order has expired and can no longer be modified. Please place a new order.",
    );
  }

  // These statuses are exclusively system/webhook-controlled — no human
  // should ever be able to set them directly through this endpoint.
  const SYSTEM_CONTROLLED: OrderStatus[] = [
    OrderStatus.PENDING,
    OrderStatus.WAITING_VENDOR_CONFIRMATION,
    OrderStatus.WAITING_CUSTOMER_APPROVAL,
    OrderStatus.AWAITING_PAYMENT,
    OrderStatus.PAYMENT_CONFIRMED,
    OrderStatus.PAYMENT_EXPIRED,
    OrderStatus.CANCELLED_UNPAID,
  ];
  if (SYSTEM_CONTROLLED.includes(status)) {
    throw new ForbiddenError(
      "This status is controlled automatically by the system, not set manually",
    );
  }

  // Vendor drives the cooking/pickup/delivery lifecycle. Completion is
  // confirmed by the CUSTOMER (not the vendor) — this protects the
  // customer from an order being marked "delivered" when it wasn't.
  //
  // Note: once the Delivery domain is built, driver-driven status changes
  // will go through their own dedicated endpoint (matching how
  // DeliveryAssignment already works) rather than this generic one, to
  // avoid two independent paths writing Order.status with no cross-sync.
  const transitions: Partial<
    Record<OrderStatus, { from: OrderStatus[]; roles: Role[] }>
  > = {
    COOKING: { from: [OrderStatus.PAYMENT_CONFIRMED], roles: [Role.VENDOR] },
    READY_FOR_PICKUP: { from: [OrderStatus.COOKING], roles: [Role.VENDOR] },
    OUT_FOR_DELIVERY: {
      from: [OrderStatus.READY_FOR_PICKUP],
      roles: [Role.VENDOR],
    },
    COMPLETED: { from: [OrderStatus.OUT_FOR_DELIVERY], roles: [Role.CUSTOMER] },
    CANCELLED: {
      from: [
        OrderStatus.AWAITING_PAYMENT,
        OrderStatus.PAYMENT_CONFIRMED,
        OrderStatus.COOKING,
        OrderStatus.READY_FOR_PICKUP,
        OrderStatus.OUT_FOR_DELIVERY,
      ],
      roles: [Role.CUSTOMER, Role.VENDOR],
    },
    FAILED_DELIVERY: {
      from: [OrderStatus.OUT_FOR_DELIVERY],
      roles: [Role.VENDOR],
    },
  };

  const rule = transitions[status];
  if (!rule) throw new ValidationError("This status change is not allowed");
  if (!rule.from.includes(currentStatus))
    throw new ConflictError(
      `Cannot transition from ${currentStatus} to ${status}`,
    );
  if (!rule.roles.includes(userRole))
    throw new ForbiddenError("You cannot perform this action");

  // Batch 1D.43 — RESOURCE authorization.
  //
  // `rule.roles` is checked against `userRole`, which comes from the signed
  // token and therefore describes the ACCOUNT, not this order. On its own it
  // is insufficient: a user whose active role is VENDOR, but who is the
  // CUSTOMER of somebody else's order, satisfies
  // `roles: [Role.VENDOR]` for COOKING / READY_FOR_PICKUP /
  // OUT_FOR_DELIVERY / FAILED_DELIVERY while having no relationship at all to
  // that order's store — they could advance a competitor's order. The same
  // gap exists in mirror image: holding VENDOR is no obstacle to the
  // CUSTOMER-only COMPLETED transition, which exists specifically to stop the
  // store from confirming its own delivery.
  //
  // So a role listed in the rule is not sufficient on its own: the actor must
  // also HOLD that role's relationship to THIS order, as established above by
  // isVendor / isCustomer. Both gates are required — the claim still decides
  // what the account may do in general (so a vendor browsing in CUSTOMER mode
  // keeps its existing behaviour), and the relationship decides whether that
  // permission applies to this order at all.
  //
  // The same message is reused so a rejected caller learns nothing about
  // whether they are the vendor of this order.
  //
  // No redesign of the transition table was needed: it already states which
  // roles each step belongs to; it just was not being consulted for the
  // relationship those roles stand for.
  if (!actorHoldsOrderRelationship(rule.roles, { isVendor, isCustomer }))
    throw new ForbiddenError("You cannot perform this action");

  // Payment gate — checked against the dedicated paymentStatus field, not
  // the workflow `status` field. (A previous version of this check
  // compared against `status === PAYMENT_CONFIRMED`, which breaks once the
  // order legitimately moves on to COOKING/READY_FOR_PICKUP/etc. — by then
  // status is no longer PAYMENT_CONFIRMED even though the order is still
  // paid. paymentStatus stays SUCCESS throughout, which is what this
  // actually needs to check.)
  const requiresPayment: OrderStatus[] = [
    OrderStatus.COOKING,
    OrderStatus.READY_FOR_PICKUP,
    OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.COMPLETED,
  ];
  if (requiresPayment.includes(status) && order.paymentStatus !== "SUCCESS") {
    throw new ConflictError("Order must be paid before proceeding");
  }

  const updateData: Prisma.OrderUpdateInput = { status };

  if (status === OrderStatus.CANCELLED) {
    if (
      !isVendor &&
      (currentStatus === OrderStatus.COOKING ||
        currentStatus === OrderStatus.READY_FOR_PICKUP ||
        currentStatus === OrderStatus.OUT_FOR_DELIVERY)
    ) {
      throw new ForbiddenError(
        "Order cannot be cancelled after preparation has started",
      );
    }
    updateData.cancelledAt = new Date();
    updateData.cancellationReason = isVendor
      ? "VENDOR_REJECTED"
      : "USER_CANCELLED";
  }

  // Status change + paid-cancel refund filing happen in ONE transaction:
  // no external API calls inside, and a RefundRequest failure rolls the
  // whole cancellation back (loud failure) instead of vanishing silently.
  // The open-request guard makes double-cancel idempotent: one
  // cancellation can only ever file one refund request per payment.
  // N-04A: the CAS predicate on the status below means this run either
  // performed the transition or threw. `cancellationApplied` is therefore
  // authoritative for the stock release — never the pre-read `currentStatus`.
  let cancellationApplied = false;

  const updatedOrder = await prisma.$transaction(async (tx) => {
    // N-04A: CAS on the expected status. Previously this was an
    // unconditional `update({ where: { id } })` validated only against a
    // status read earlier in the request, so a cancel that read
    // AWAITING_PAYMENT could overwrite an order that a payment-expiry /
    // order-expiry worker had already moved to CANCELLED_UNPAID — and then
    // restore stock for an order another path already owned. Prisma's
    // extended where-unique turns that into a genuine compare-and-set:
    // no matching row ⇒ P2025 ⇒ we abort instead of clobbering.
    let updated: Order;
    try {
      updated = await tx.order.update({
        where: { id: orderId, status: currentStatus },
        data: updateData,
      });
    } catch (err: any) {
      if (err?.code === "P2025") {
        throw new ConflictError(
          "This order changed state while the update was in progress. Reload and try again.",
        );
      }
      throw err;
    }
    cancellationApplied = true;

    // F4-2: a COMPLETED order must pay its rider.
    //
    // Before F4-2 the only writer of DeliveryEarning was the driver path
    // (`updateStatus(DELIVERED)`), so an order the CUSTOMER confirmed completing
    // — the ordinary end of a successful delivery — produced no earning and no
    // wallet credit: the rider delivered and was never paid.
    //
    // It runs here, inside this transaction, immediately after the Order CAS —
    // not in a callback, not fire-and-forget, not in a separate transaction — so
    // a failure to pay rolls the completion, the F4-1 reconciliation below and
    // the payout back together. `creditDeliveryEarning` is the same helper the
    // driver path uses, so there is exactly one earning implementation and the
    // amount is identical on both routes.
    //
    // This transaction already owns the Order row (the CAS above locked it),
    // which is what makes the helper's exactly-once read safe.
    if (status === OrderStatus.COMPLETED) {
      await creditDeliveryEarning(tx, orderId);
    }

    // F4-1 / INV-1: a terminal order must not retain an active
    // DeliveryAssignment. This runs inside the SAME transaction as the order
    // CAS above, so the order can never commit terminal while an
    // ASSIGNED/ACCEPTED/PICKED_UP/EN_ROUTE row survives for it — previously a
    // customer confirming an out-for-delivery order left the rider's EN_ROUTE
    // assignment active forever (stranding a capacity slot and leaving the
    // assignment actionable against a completed order).
    //
    // The target status is mechanically derivable: CANCELLED is the only
    // terminal delivery status reachable from all four active statuses in the
    // existing state machine. No earning and no wallet change happen here —
    // whether a rider is owed for a customer-completed order is F4-2's
    // decision, deliberately not taken in F4-1.
    //
    // Lock order: this transaction already owns the Order row (the CAS above
    // took it), so it reaches the assignment second — the same
    // Order -> Assignment order as `updateStatus` and F3's `claimOrderRow`.
    if (isTerminalOrderStatus(status)) {
      await reconcileActiveDeliveryAssignments(tx, order.id);
    }

    if (status === OrderStatus.CANCELLED && order.paymentStatus === "SUCCESS") {
      const payment = await tx.payment.findFirst({
        where: {
          idempotencyKey: order.idempotencyKey,
          status: "SUCCESS",
        },
      });

      if (payment) {
        // Finding C-1: scope the dedupe to THIS order. One Paystack payment can
        // cover several vendors' orders, so an unresolved request filed for a
        // sibling order must not suppress the obligation this cancelled order
        // is owed. `paymentRef` alone is not a uniqueness key here. The create
        // below already attributed the request with `orderId: order.id`, so the
        // lookup must match that attribution. This mirrors
        // fileRefundOwedForCancelledOrder in paymentFinalizer.service.ts.
        // A NULL-orderId row therefore never matches and never suppresses a
        // real, order-scoped obligation.
        const existing = await tx.refundRequest.findFirst({
          where: {
            paymentRef: payment.reference,
            orderId: order.id,
            status: { in: ["PENDING", "APPROVED", "PROCESSING"] },
          },
        });
        if (!existing) {
          // C-2: the insert is itself conflict-tolerant. The helper uses
          // `INSERT ... ON CONFLICT ("paymentRef","orderId") WHERE ... DO
          // NOTHING` against the partial unique index, so a concurrent
          // writer that filed the same obligation first cannot leave a
          // duplicate open obligation behind. The transaction client is
          // passed through, so this stays inside the caller's transaction.
          // Phase 3.2b: this path knows the exact cancelled order, so
          // attribution is exact even for multi-order batch payments.
          //
          // N-01: the request must be bounded by THIS order's paid
          // value, never by the payment total. One Paystack payment can
          // cover several vendors' orders (payment.orderId is only the
          // primary order), so leaving this null made the admin's
          // `requestedAmountKobo ?? remaining` fallback resolve to the
          // whole payment — refunding sibling vendors' orders too.
          // `order.totalPrice` is integer kobo (Phase 3A) — the amount this
          // order contributed to the payment. Pass it directly: no * 100,
          // which would double-convert kobo into a wrong larger value.
          await fileRefundOwed(tx, {
            userId: order.customerId,
            paymentRef: payment.reference,
            reason: "Order cancelled after payment",
            orderId: order.id,
            requestedAmountKobo: order.totalPrice,
          });
        }
      }
    }

    // Stock restoration for an unpaid cancellation now happens INSIDE this
      // transaction, together with the status change above.
      //
      // Previously it ran afterwards on the root client behind a `.catch` log.
      // A failure there left the order already CANCELLED with nothing recording
      // that a restoration was owed: `restoreStockForOrders` is a blind
      // `stock += qty` with no marker, and every other restoration path filters
      // on AWAITING_PAYMENT, which this order had just left. The stock was lost
      // permanently and nothing could recover it.
      //
      // Committing both together means a restore failure rolls the cancellation
      // back, leaving the order AWAITING_PAYMENT — where the expiry/cleanup
      // sweeps can still see it. No schema change and no new reconciliation job.
      //
      // N-04A still holds: gated on `cancellationApplied` (this run won the
      // CAS), not on the pre-read `currentStatus`, so the release is exactly
      // once. Paid orders never restore — portions are consumed on success.
      if (
        cancellationApplied &&
        status === OrderStatus.CANCELLED &&
        currentStatus === OrderStatus.AWAITING_PAYMENT &&
        order.paymentStatus !== "SUCCESS"
      ) {
        await restoreStockForOrders(tx, [orderId]);

        // Phase 3D: release the daily-cap units this cancelled unpaid order
        // consumed so another customer can use that day's capacity.
        try {
          const orderForCaps = await tx.order.findUnique({
            where: { id: orderId },
            select: {
              id: true,
              scheduledAt: true,
              items: { select: { productId: true } },
            },
          });
          if (orderForCaps) {
            await releaseOrderDailyCaps(tx, orderForCaps);
          }
        } catch (capErr) {
          // A cap-release failure must not roll back an already-committed
          // cancellation. Logged for a reconciliation sweep to correct.
          logger.warn(
            { err: capErr, orderId },
            "Failed to release daily cap on cancellation",
          );
        }
      }

      return updated;
  });

  await clearProductCache(undefined, order.vendorId);

  // Referrals + Pot Points: awarded once an order actually completes.
  // N-05C (F1): the invocation now lives in one shared helper so the driver
  // completion path (`DeliveryAssignmentService.updateStatus(DELIVERED)`) earns
  // the same effects instead of silently skipping them. Semantics unchanged
  // here — same arguments, still fire-and-forget, same warn-level logging.
  if (status === OrderStatus.COMPLETED) {
    runOrderCompletionSideEffects(orderId, order.customerId);
  }

  const recipientId = isVendor ? order.customerId : order.vendorId;
  await recordActivityBundle({
    actorId: userId,
    orderId,
    actions: [
      {
        type: ActivityType.GENERAL,
        title: `Order ${status}`,
        message: `Order ${orderId} status has been updated to ${status}`,
        targetId: recipientId,
        socketEvent: "ORDER",
        metadata: { orderId, updatedBy: userRole },
      },
    ],
    audit: {
      action: "ORDER_STATUS_UPDATED",
      metadata: {
        orderId,
        updatedBy: userId,
        previousStatus: currentStatus,
        newStatus: status,
      },
    },
    notifyRealtime: true,
    notifyPush: true,
  });

  return sendSuccess(
    res,
    { order: updatedOrder },
    `Order status updated to ${status}`,
  );
};

// GET /orders/vendor/stats
export const getVendorOrderStats = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user!.id;

  const [
    totalOrders,
    completedOrders,
    pendingOrders,
    inProgressOrders,
    awaitingApprovalOrders,
    totalRevenueObj,
  ] = await Promise.all([
    // Phase 1 — `totalOrders` was the only figure here counted across every
    // status, so it included unpaid checkouts the store cannot act on. The
    // remaining counts are already restricted to post-payment statuses and are
    // therefore left untouched.
    prisma.order.count({ where: vendorVisibleOrderWhere({ vendorId }) }),
    prisma.order.count({ where: { vendorId, status: OrderStatus.COMPLETED } }),
    prisma.order.count({ where: { vendorId, status: OrderStatus.PENDING } }),
    prisma.order.count({
      where: {
        vendorId,
        status: {
          in: [
            OrderStatus.COOKING,
            OrderStatus.READY_FOR_PICKUP,
            OrderStatus.OUT_FOR_DELIVERY,
          ],
        },
      },
    }),
    prisma.order.count({
      where: { vendorId, status: OrderStatus.WAITING_CUSTOMER_APPROVAL },
    }),
    prisma.order.aggregate({
      _sum: { totalPrice: true },
      where: { vendorId, status: OrderStatus.COMPLETED },
    }),
  ]);

  return sendSuccess(
    res,
    {
      summary: {
        totalOrders,
        completedOrders,
        pendingOrders,
        inProgressOrders,
        awaitingApprovalOrders,
        totalRevenue: totalRevenueObj._sum.totalPrice ?? 0,
      },
      metadata: { vendorId, lastUpdated: new Date().toISOString() },
    },
    "Vendor order stats retrieved successfully",
  );
};

// GET /orders/customer/stats
export const getCustomerOrderStats = async (
  req: AuthRequest,
  res: Response,
) => {
  const customerId = req.user!.id;

  const today = new Date();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(today.getDate() - 6);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sevenDaysAgo);
    d.setDate(sevenDaysAgo.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  const [
    totalOrders,
    completedOrders,
    pendingOrders,
    inProgressOrders,
    awaitingPaymentOrders,
    totalSpentObj,
    recentOrders,
  ] = await Promise.all([
    prisma.order.count({ where: { customerId } }),
    prisma.order.count({
      where: { customerId, status: OrderStatus.COMPLETED },
    }),
    prisma.order.count({ where: { customerId, status: OrderStatus.PENDING } }),
    prisma.order.count({
      where: {
        customerId,
        status: {
          in: [
            OrderStatus.COOKING,
            OrderStatus.READY_FOR_PICKUP,
            OrderStatus.OUT_FOR_DELIVERY,
          ],
        },
      },
    }),
    prisma.order.count({
      where: { customerId, status: OrderStatus.AWAITING_PAYMENT },
    }),
    prisma.order.aggregate({
      _sum: { totalPrice: true },
      where: { customerId, status: OrderStatus.COMPLETED },
    }),
    // Single range query, bucketed by day in JS below — replaces a
    // groupBy(createdAt) that never actually grouped anything (see
    // bucketByDay's comment for why).
    prisma.order.findMany({
      where: { customerId, createdAt: { gte: sevenDaysAgo, lte: today } },
      select: { createdAt: true, totalPrice: true },
    }),
  ]);

  return sendSuccess(
    res,
    {
      totalOrders,
      completedOrders,
      pendingOrders,
      inProgressOrders,
      awaitingPaymentOrders,
      totalSpent: totalSpentObj._sum.totalPrice ?? 0,
      last7DaysOrders: bucketByDay(recentOrders, last7Days).map(
        ({ date, count }) => ({ date, orders: count }),
      ),
    },
    "Customer order stats retrieved successfully",
  );
};

// GET /orders/vendor/report
export const getVendorReport = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user!.id;
  const now = dayjs();

  const startOfToday = now.startOf("day").toDate();
  const startOfWeek = now.startOf("week").toDate();
  const startOfMonth = now.startOf("month").toDate();
  const startOfYear = now.startOf("year").toDate();
  const sevenDaysAgo = now.subtract(6, "day").startOf("day").toDate();

  // SQL-side sum/count via aggregate() instead of pulling every matching
  // order's row into JS just to reduce() it — the previous version did a
  // findMany() (fetching every row) for each of these 4 windows, which
  // gets expensive fast once a vendor has any real order volume in a
  // year-long window.
  const getStatsFromDate = (from: Date) =>
    prisma.order.aggregate({
      where: {
        vendorId,
        createdAt: { gte: from },
        status: OrderStatus.COMPLETED,
      },
      _count: { id: true },
      _sum: { totalPrice: true },
    });

  const [
    revenueAgg,
    totalOrders,
    completedOrders,
    itemsSoldAgg,
    todayAgg,
    weekAgg,
    monthAgg,
    yearAgg,
    last7DaysRows,
    topProductsAgg,
  ] = await Promise.all([
    prisma.order.aggregate({
      _sum: { totalPrice: true },
      where: { vendorId, status: OrderStatus.COMPLETED },
    }),
    // Phase 1 — same reason as `getVendorOrderStats`: this was the one
    // unfiltered count in the report. Every other figure in this Promise.all
    // is already restricted to COMPLETED.
    prisma.order.count({ where: vendorVisibleOrderWhere({ vendorId }) }),
    prisma.order.count({ where: { vendorId, status: OrderStatus.COMPLETED } }),
    prisma.orderItem.aggregate({
      _sum: { quantity: true },
      where: { order: { vendorId, status: OrderStatus.COMPLETED } },
    }),
    getStatsFromDate(startOfToday),
    getStatsFromDate(startOfWeek),
    getStatsFromDate(startOfMonth),
    getStatsFromDate(startOfYear),
    // One range query instead of 7 separate day-by-day queries.
    prisma.order.findMany({
      where: {
        vendorId,
        status: OrderStatus.COMPLETED,
        createdAt: { gte: sevenDaysAgo },
      },
      select: { createdAt: true, totalPrice: true },
    }),
    prisma.orderItem.groupBy({
      by: ["productId"],
      where: { order: { vendorId, status: OrderStatus.COMPLETED } },
      _sum: { quantity: true, subtotal: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    }),
  ]);

  const totalRevenue = revenueAgg._sum.totalPrice ?? 0;
  const totalItemsSold = itemsSoldAgg._sum.quantity ?? 0;
  const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  const toStats = (agg: {
    _count: { id: number };
    _sum: { totalPrice: number | null };
  }) => ({
    orders: agg._count.id,
    revenue: agg._sum.totalPrice ?? 0,
  });

  const last7Days = Array.from({ length: 7 }, (_, i) =>
    now.subtract(6 - i, "day").format("YYYY-MM-DD"),
  );
  const daily = bucketByDay(last7DaysRows, last7Days);

  const productDetails = await prisma.product.findMany({
    where: { id: { in: topProductsAgg.map((p) => p.productId) } },
    select: { id: true, name: true },
  });

  const topProducts = topProductsAgg.map((p) => {
    const product = productDetails.find((d) => d.id === p.productId);
    return {
      productId: p.productId,
      name: product?.name ?? "Unknown Product",
      sold: p._sum.quantity ?? 0,
      revenue: p._sum.subtotal ?? 0,
    };
  });

  return sendSuccess(
    res,
    {
      summary: {
        totalRevenue,
        totalOrders,
        completedOrders,
        totalItemsSold,
        averageOrderValue: round(averageOrderValue),
      },
      timeline: {
        today: toStats(todayAgg),
        week: toStats(weekAgg),
        month: toStats(monthAgg),
        year: toStats(yearAgg),
      },
      daily,
      topProducts,
    },
    "Vendor report retrieved successfully",
  );
};

// ─────────────────────────────────────────────────────────────────────────
// SPECIAL ORDERS — a customer requests a custom quantity/version of a
// product, vendors bid with an offer (price + note), customer accepts one.
//
// NOTE: this logic already existed in the codebase but was never actually
// wired into any route — completely unreachable. It's wired up for real
// as part of this pass (see orderRouter.ts).
// ─────────────────────────────────────────────────────────────────────────

// POST /orders/special-requests — customer creates a request
export const createSpecialRequest = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  const parsed = createSpecialRequestSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid special request",
      parsed.error.flatten().fieldErrors,
    );
  const { productId, quantity, details } = parsed.data;

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new NotFoundError("Product");

  // Phase 1B self-dealing guard: cannot request a special order for your own product.
  if (product.vendorId === userId)
    throw new ForbiddenError("You cannot request a special order for your own product.");

  const request = await prisma.specialOrderRequest.create({
    data: { customerId: userId, productId, quantity, message: details },
  });

  return sendCreated(res, { request }, "Special request created");
};

// GET /orders/special-requests — current customer's request history and vendor offers
export const getMySpecialRequests = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const skip = (page - 1) * limit;
  const status = req.query.status as string | undefined;
  const where: Prisma.SpecialOrderRequestWhereInput = {
    customerId: userId,
    ...(status ? { status: status as any } : {}),
  };

  const [requests, total] = await Promise.all([
    prisma.specialOrderRequest.findMany({
      where,
      skip,
      take: limit,
      orderBy: { updatedAt: "desc" },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            images: true,
            price: true,
            dishType: { select: { id: true, name: true } },
          },
        },
        offers: {
          orderBy: { createdAt: "desc" },
          include: {
            vendor: {
              select: {
                id: true,
                name: true,
                brandName: true,
                avatarUrl: true,
                phoneNumber: true,
              },
            },
            order: {
              select: {
                id: true,
                status: true,
                totalPrice: true,
                paymentStatus: true,
              },
            },
          },
        },
      },
    }),
    prisma.specialOrderRequest.count({ where }),
  ]);
  const totalPages = Math.ceil(total / limit);
  return sendSuccess(res, { requests }, "Special requests retrieved", 200, {
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  });
};

// POST /orders/special-requests/:requestId/offers — vendor bids on a request
export const createSpecialOffer = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user!.id;
  const requestId = ensureString(req.params.requestId);

  const parsed = createSpecialOfferSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid offer",
      parsed.error.flatten().fieldErrors,
    );
  const { price, message } = parsed.data;

  // Batch 1D.42 — vendor lifecycle gate.
  //
  // Evidence that suspension is intended to cover this surface:
  //   - vendorStatus.service.ts: "SUSPENDED: admin-set, cannot sell".
  //     Placing an offer is a commercial act, not catalog preparation.
  //   - vendorStatus.middleware.ts (Phase 1C) blocks SUSPENDED from "vendor
  //     WRITE surfaces"; an offer is a write (it also mutates the request
  //     and notifies the customer).
  //   - acceptSpecialOffer states that special orders "must not bypass
  //     availability", i.e. the codebase already treats special-order
  //     commerce as subject to the vendor lifecycle.
  //
  // Acceptance-time availability already refuses a SUSPENDED vendor
  // (assertVendorAvailableForOrdering), so such an offer can never become an
  // order. That does not make the write harmless: it still flips the
  // customer's request to OFFER_MADE and notifies them of a bid that can
  // never be accepted. Enforcing here keeps one policy on one surface.
  //
  // Placed before the request lookup and any write, so a rejection performs
  // no query against a caller-supplied id, no row write and no notification.
  const vendor = await prisma.user.findUnique({
    where: { id: vendorId },
    select: { vendorStatus: true },
  });
  if (!vendor || !isVendorStatusEstablishable(vendor.vendorStatus)) {
    throw new ForbiddenError(VENDOR_STATUS_UNRESOLVED_MESSAGE);
  }
  assertVendorNotSuspended(vendor.vendorStatus);

  const request = await prisma.specialOrderRequest.findUnique({
    where: { id: requestId },
  });
  if (!request) throw new NotFoundError("Special request");

  // Phase 1B self-dealing guard: a vendor cannot bid on their own request.
  if (request.customerId === vendorId)
    throw new ForbiddenError("You cannot make an offer on your own request.");
  if (
    request.status === "ACCEPTED" ||
    request.status === "CANCELLED" ||
    request.status === "REJECTED"
  ) {
    throw new ConflictError("This request is no longer open for offers");
  }

  const offer = await prisma.specialOrderOffer.create({
    data: { requestId, vendorId, price, message },
  });

  await prisma.specialOrderRequest.update({
    where: { id: requestId },
    data: { status: "OFFER_MADE" },
  });

  // Previously the customer was never told a vendor had responded to
  // their request at all — they'd have had to keep polling manually.
  await sendNotification({
    userId: request.customerId,
    title: "New offer on your special request",
    message: `A vendor offered ₦${price} for your special request.`,
    type: "GENERAL",
    metadata: {
      requestId,
      offerId: offer.id,
      route: `/special-requests/${requestId}`,
    },
  });

  return sendCreated(res, { offer }, "Offer created");
};

// PATCH /orders/special-offers/:offerId/accept — customer accepts one offer
export const acceptSpecialOffer = async (req: AuthRequest, res: Response) => {
  const offerId = ensureString(req.params.offerId);
  const userId = req.user!.id;
  const { addressId } = req.body as { addressId?: string };

  if (!addressId) throw new ValidationError("addressId is required");

  const offer = await prisma.specialOrderOffer.findUnique({
    where: { id: offerId },
    include: { request: true },
  });
  if (!offer) throw new NotFoundError("Offer");
  if (offer.request.customerId !== userId)
    throw new ForbiddenError("This isn't your request");
  if (offer.request.status !== "OFFER_MADE")
    throw new ConflictError("This offer can no longer be accepted");

  // Phase 1B self-dealing guard: cannot accept (and order from) your own offer.
  if (offer.vendorId === userId)
    throw new ForbiddenError("You cannot order from your own store.");

  const address = await prisma.address.findFirst({
    where: { id: addressId, userId },
  });
  if (!address) throw new NotFoundError("Address");

  const deliveryFeeResult = await calculateDeliveryFee(
    offer.vendorId,
    addressId,
    offer.price,
  );
  if (!deliveryFeeResult.withinRange) {
    throw new ValidationError(
      `This vendor is outside the delivery range for your address (${deliveryFeeResult.distanceKm}km away).`,
    );
  }

  // Special orders bypass the cart, but they must not bypass availability:
  // the vendor must be operating and the requested product/quantity must
  // be purchasable (not archived, in stock).
  const requestedProduct = await prisma.product.findUnique({
    where: { id: offer.request.productId },
    select: {
      id: true,
      name: true,
      archived: true,
      trackInventory: true,
      stock: true,
      vendor: { select: { isLive: true, vendorStatus: true, deliveryPreferences: true } },
    },
  });
  if (!requestedProduct || requestedProduct.archived) {
    throw new ValidationError("This product is no longer available.");
  }
  assertVendorAvailableForOrdering(
    requestedProduct.vendor
      ? { id: offer.vendorId, ...requestedProduct.vendor }
      : null,
  );
  assertQuantityAvailable({
    productId: requestedProduct.id,
    productName: requestedProduct.name,
    quantity: offer.request.quantity,
    trackInventory: requestedProduct.trackInventory,
    stock: requestedProduct.stock,
  });

  const [, , acceptedOffer, order] = await prisma.$transaction(async (tx) => {
    // Reserve stock atomically with order creation (same final-portion
    // guarantee as cart checkout; rolls back on failure).
    await reserveStockForItems(tx, [
      {
        productId: requestedProduct.id,
        productName: requestedProduct.name,
        quantity: offer.request.quantity,
        trackInventory: requestedProduct.trackInventory,
        stock: requestedProduct.stock,
      },
    ]);

    const rejected = await tx.specialOrderOffer.updateMany({
      where: { requestId: offer.requestId, id: { not: offerId } },
      data: { status: "REJECTED" },
    });
    const acceptedRequest = await tx.specialOrderRequest.update({
      where: { id: offer.requestId },
      data: { status: "ACCEPTED" },
    });
    const accepted = await tx.specialOrderOffer.update({
      where: { id: offerId },
      data: { status: "ACCEPTED" },
    });
    // Phase 3.2b going-forward snapshots. Special orders carry no promo
    // discount (discount 0); the vendor's effective rate is read in-tx so
    // the frozen rate is the rate actually used, and economics
    // (price/base, delivery fee) are exactly as currently implemented.
    const specialVendor = await tx.user.findUnique({
      where: { id: offer.vendorId },
      select: { commissionRate: true },
    });
    // offer.price and deliveryFeeResult.fee are both integer kobo (Phase 3A).
    const specialBase = offer.price;
    const specialSnapshot = buildOrderMoneySnapshot({
      basePriceKobo: specialBase,
      discountKobo: 0,
      commissionRate: resolveCommissionRate(specialVendor?.commissionRate),
    });
    const created = await tx.order.create({
      data: {
        customerId: userId,
        vendorId: offer.vendorId,
        addressId,
        basePrice: specialBase,
        deliveryFee: deliveryFeeResult.fee,
        totalPrice: specialBase + deliveryFeeResult.fee,
        commissionRateSnapshot: specialSnapshot.commissionRateSnapshot,
        commissionKobo: specialSnapshot.commissionKobo,
        vendorPayoutKobo: specialSnapshot.vendorPayoutKobo,
        discountKobo: specialSnapshot.discountKobo,
        status: OrderStatus.AWAITING_PAYMENT,
        specialOrderOfferId: offer.id,
        idempotencyKey: uuidv4(),
        protectedUntil: new Date(Date.now() + 15 * 60 * 1000),
        items: {
          create: [
            {
              productId: offer.request.productId,
              productName: requestedProduct.name,
              quantity: offer.request.quantity,
              // Batch F: offer.price is the vendor's TOTAL bid for the
              // requested quantity (stock is reserved for the full
              // quantity and the order total charges the bid total), so
              // the per-unit price is the pro-rata share. Previously
              // unitPrice carried the whole bid, making unitPrice ×
              // quantity disagree with the line whenever quantity > 1.
              // subtotal (the authoritative line total) is unchanged, so
              // no money movement, snapshot, or total changes here.
              unitPrice: round(offer.price / Math.max(offer.request.quantity, 1)),
              subtotal: offer.price,
            },
          ],
        },
      },
      include: { items: true },
    });
    return [rejected, acceptedRequest, accepted, created] as const;
  });

  // Post-commit: the transaction above has committed (a rejection would have
  // propagated instead of reaching here), so sweeping the cached product rows
  // now cannot invalidate entries for a rolled-back order. Best-effort — a
  // failure only costs display staleness until TTL expiry.
  await clearProductCache(requestedProduct.id, offer.vendorId)
    .then((result) => {
      // The helper reports incomplete sweeps via its return, not
      // exceptions. `result &&` tolerates test doubles that stub the
      // helper as returning undefined.
      if (result && !result.ok) {
        logger.warn(
          { productId: requestedProduct.id, vendorId: offer.vendorId, orderId: order.id, failures: result.failures },
          "Product cache invalidation incomplete after special-order acceptance",
        );
      }
    })
    .catch((err) => {
      // Defensive only: the helper contract is never-throw, so reaching
      // here means the contract itself broke. Logged instead of swallowed
      // so an unexpected failure is visible rather than silent.
      logger.warn(
        { err, productId: requestedProduct.id, vendorId: offer.vendorId, orderId: order.id },
        "Product cache invalidation threw unexpectedly after special-order acceptance",
      );
    });

  // Previously the vendor was never notified their offer was accepted —
  // they'd only find out by happening to check their orders list.
  await recordActivityBundle({
    actorId: userId,
    orderId: order.id,
    actions: [
      {
        type: ActivityType.GENERAL,
        title: "Your offer was accepted!",
        message: `Your special-order offer was accepted. Order ${order.id} is awaiting payment.`,
        targetId: offer.vendorId,
        socketEvent: "ORDER",
        metadata: {
          orderId: order.id,
          offerId: offer.id,
          route: `/orders/${order.id}`,
        },
      },
    ],
    audit: {
      action: "SPECIAL_OFFER_ACCEPTED",
      metadata: {
        offerId: offer.id,
        requestId: offer.requestId,
        orderId: order.id,
      },
    },
    notifyRealtime: true,
    notifyPush: true,
  });

  return sendCreated(
    res,
    { order, offer: acceptedOffer },
    "Offer accepted and order created",
  );
};

// PATCH /orders/special-offers/:offerId/reject — customer declines one vendor offer
export const rejectSpecialOffer = async (req: AuthRequest, res: Response) => {
  const offerId = ensureString(req.params.offerId);
  const userId = req.user!.id;
  const offer = await prisma.specialOrderOffer.findUnique({
    where: { id: offerId },
    include: { request: true },
  });
  if (!offer) throw new NotFoundError("Offer");
  if (offer.request.customerId !== userId)
    throw new ForbiddenError("This isn't your request");
  if (
    offer.request.status === "ACCEPTED" ||
    offer.request.status === "REJECTED" ||
    offer.request.status === "CANCELLED"
  ) {
    throw new ConflictError(
      "This request is no longer open for offer decisions",
    );
  }
  if (offer.status !== "PENDING")
    throw new ConflictError("This offer has already been decided");

  const [, pendingCount] = await prisma.$transaction([
    prisma.specialOrderOffer.update({
      where: { id: offerId },
      data: { status: "REJECTED" },
    }),
    prisma.specialOrderOffer.count({
      where: {
        requestId: offer.requestId,
        status: "PENDING",
        id: { not: offerId },
      },
    }),
  ]);
  if (pendingCount === 0) {
    await prisma.specialOrderRequest.update({
      where: { id: offer.requestId },
      data: { status: "REJECTED" },
    });
  }
  await sendNotification({
    userId: offer.vendorId,
    title: "Special offer declined",
    message: "A customer declined your special-order offer.",
    type: "GENERAL",
    metadata: { offerId, requestId: offer.requestId },
  });
  return sendSuccess(
    res,
    { offerId, requestId: offer.requestId, requestClosed: pendingCount === 0 },
    "Offer declined",
  );
};

// PATCH /orders/special-requests/:requestId/reject — customer rejects all offers
export const rejectSpecialRequest = async (req: AuthRequest, res: Response) => {
  const requestId = ensureString(req.params.requestId);
  const userId = req.user!.id;

  const request = await prisma.specialOrderRequest.findUnique({
    where: { id: requestId },
    include: { offers: true },
  });
  if (!request) throw new NotFoundError("Special request");
  if (request.customerId !== userId)
    throw new ForbiddenError("This isn't your request");

  await prisma.$transaction([
    prisma.specialOrderRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED" },
    }),
    prisma.specialOrderOffer.updateMany({
      where: { requestId },
      data: { status: "REJECTED" },
    }),
  ]);

  // Previously vendors who'd made an offer were never told it was
  // rejected — silently left hanging with no resolution.
  const pendingOfferVendorIds = request.offers
    .filter((o) => o.status === "PENDING")
    .map((o) => o.vendorId);
  if (pendingOfferVendorIds.length > 0) {
    await Promise.all(
      pendingOfferVendorIds.map((vendorId) =>
        sendNotification({
          userId: vendorId,
          title: "Special request closed",
          message:
            "The customer chose a different offer for their special request.",
          type: "GENERAL",
          metadata: { requestId },
        }),
      ),
    );
  }

  return sendSuccess(res, {}, "Special request rejected");
};

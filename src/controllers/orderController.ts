import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";
import { ActivityType, OrderStatus, Prisma, Role } from "@prisma/client";
import dayjs from "dayjs";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { sendNotification } from "../utils/activityUtils/notify";
import { ensureString } from "../utils/paramUtils";
import { clearProductCache } from "../services/clearCaches";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import {
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
import { creditReferralRewardIfEligible } from "./referralController";
import { logger } from "../lib/logger";

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

  const where: Prisma.OrderWhereInput = {
    OR: [{ customerId: userId }, { vendorId: userId }],
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

  return sendSuccess(res, { orders }, "Orders retrieved successfully", 200, {
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

  const batch = {
    idempotencyKey,
    orderCount,
    total,
    paymentStatus,
    orders,
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
  if (order.customerId !== userId && order.vendorId !== userId) {
    throw new ForbiddenError("You don't have access to this order");
  }

  return sendSuccess(res, { order }, "Order retrieved successfully");
};

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

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError("Order");

  const isVendor = userId === order.vendorId;
  const isCustomer = userId === order.customerId;
  if (!isVendor && !isCustomer) throw new ForbiddenError("Unauthorized user");

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
    updateData.cancelledAt = new Date();
    updateData.cancellationReason = isVendor
      ? "VENDOR_REJECTED"
      : "USER_CANCELLED";
  }

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: updateData,
  });

  // Cancelling an unpaid order releases its checkout-time stock
  // reservation back on sale. Paid orders never restore — portions are
  // consumed once payment succeeds.
  if (
    status === OrderStatus.CANCELLED &&
    currentStatus === OrderStatus.AWAITING_PAYMENT &&
    order.paymentStatus !== "SUCCESS"
  ) {
    await restoreStockForOrders(prisma, [orderId]).catch((err) =>
      logger.warn({ err, orderId }, "Failed to restore stock for cancelled order"),
    );
  }

  await clearProductCache(undefined, order.vendorId);

  // Referrals: check (and credit, if eligible) once an order actually
  // completes — the referred customer's *first* completed order is what
  // triggers a reward for whoever referred them.
  if (status === OrderStatus.COMPLETED) {
    creditReferralRewardIfEligible(order.customerId, orderId).catch((err) =>
      logger.warn(
        { err, orderId, customerId: order.customerId },
        "Failed to check/credit referral reward",
      ),
    );
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
    prisma.order.count({ where: { vendorId } }),
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
    prisma.order.count({ where: { vendorId } }),
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

  const request = await prisma.specialOrderRequest.findUnique({
    where: { id: requestId },
  });
  if (!request) throw new NotFoundError("Special request");
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

  const [, , acceptedOffer, order] = await prisma.$transaction([
    prisma.specialOrderOffer.updateMany({
      where: { requestId: offer.requestId, id: { not: offerId } },
      data: { status: "REJECTED" },
    }),
    prisma.specialOrderRequest.update({
      where: { id: offer.requestId },
      data: { status: "ACCEPTED" },
    }),
    prisma.specialOrderOffer.update({
      where: { id: offerId },
      data: { status: "ACCEPTED" },
    }),
    prisma.order.create({
      data: {
        customerId: userId,
        vendorId: offer.vendorId,
        addressId,
        basePrice: offer.price,
        deliveryFee: deliveryFeeResult.fee,
        totalPrice: round(offer.price + deliveryFeeResult.fee),
        status: OrderStatus.AWAITING_PAYMENT,
        specialOrderOfferId: offer.id,
        idempotencyKey: uuidv4(),
        protectedUntil: new Date(Date.now() + 15 * 60 * 1000),
        items: {
          create: [
            {
              productId: offer.request.productId,
              quantity: offer.request.quantity,
              unitPrice: offer.price,
              subtotal: offer.price,
            },
          ],
        },
      },
      include: { items: true },
    }),
  ]);

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

import { Request, Response } from "express";
import {
  Prisma,
  Role,
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  PayoutStatus,
  ReviewReportStatus,
  KycStatus,
  DeliveryPersonStatus,
  ActivityType,
  DiscountType,
  PromotionScope,
  SuggestionStatus,
  VendorStatus,
} from "@prisma/client";
import { z } from "zod";
import { changeVendorStatus } from "../services/vendorStatus.service";
import prisma from "../lib/prisma";
import {
  isForeignKeyConflictFor,
  PRODUCT_DELETE_FK_CONSTRAINTS,
} from "../lib/prismaFkConflict";
import { AuthRequest } from "../middlewares/auth.middleware";
import { ensureString } from "../utils/paramUtils";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  UpstreamServiceError,
} from "../errors/AppError";
import { createAuditLog } from "../utils/auditLog.service";
import { deleteAllUserSessions } from "../lib/session";
import {
  isDispatchableOrderStatus,
  isTerminalOrderStatus,
  reconcileActiveDeliveryAssignments,
} from "../services/deliveryAssignmentReconciliation";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { refundPaymentViaPaystack, classifyRefundSubmitError } from "../services/refundService";
import { failRefund } from "../services/refundFinalizer.service";
import {
  createTransferRecipient,
  initiateTransfer,
  type TransferInitiationOutcome,
} from "../services/payoutService";
import { settleVendorPayoutFailed } from "../services/vendorPayoutSettlement.service";
import { calculatePayoutAmounts, previewVendorPayoutAmounts } from "./vendorDashboard.service";
import { acquireMultiPaymentClaim } from "../services/financialOperationClaim.service";
import { requireFinancialSubmissionNotFrozen } from "../services/financialSubmissionFreeze.service";
import {
  findPayoutSnapshotDefects,
  isLegacyNullSnapshotOrder,
  sumSnapshotKoboTotals,
} from "../services/orderSnapshot.service";
import {
  lockPaymentsCoveringOrders,
  partitionPayoutBlockedOrders,
} from "../services/payoutEligibility.service";
import { evaluateVendorStatus } from "../services/vendorStatus.service";
import { validatePromoDatesAndValue } from "./promoController";
import { logger } from "../lib/logger";
import { encrypt, decrypt } from "../utils/encrypt";
import { invalidateActiveProductPromosCache } from "../services/promotionPricing.service";
import {
  invalidateMarketplaceDiscoveryCaches,
  clearCategoryCache,
  clearDishTypeCache,
  clearProductCache,
  clearTagCache,
  clearVendorProductDetailCaches,
  invalidateProductsByDishTypeCategoryChange,
} from "../services/clearCaches";
import { assertActiveDishType, clearProductFromCarts } from "../services/product.service";

function getPagination(req: Request) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function auditAdmin(
  req: AuthRequest,
  action: string,
  metadata: Record<string, unknown>,
) {
  return createAuditLog({ userId: req.user!.id, action, req, metadata }).catch(
    (err) => logger.error({ err, action }, "Failed to write admin audit log"),
  );
}

// ==================== DASHBOARD ====================

// GET /admin/dashboard
export const getDashboardOverview = async (_req: Request, res: Response) => {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalUsers,
    totalVendors,
    totalCustomers,
    totalDrivers,
    totalAdmins,
    blockedUsers,
    totalOrders,
    pendingOrders,
    completedOrders,
    cancelledOrders,
    todayOrders,
    revenueAgg,
    todayRevenueAgg,
    monthRevenueAgg,
    pendingKyc,
    pendingRefunds,
    reportedReviews,
    totalProducts,
    activeProducts,
    recentOrders,
    recentUsers,
    recentActivity,
    paymentStatusBreakdown,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { roles: { has: Role.VENDOR } } }),
    prisma.user.count({ where: { roles: { has: Role.CUSTOMER } } }),
    prisma.user.count({ where: { roles: { has: Role.DELIVERY } } }),
    prisma.user.count({ where: { roles: { has: Role.ADMIN } } }),
    prisma.user.count({ where: { isBlocked: true } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: OrderStatus.PENDING } }),
    prisma.order.count({ where: { status: OrderStatus.COMPLETED } }),
    prisma.order.count({ where: { status: OrderStatus.CANCELLED } }),
    prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.order.aggregate({
      where: { status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.SUCCESS },
      _sum: { totalPrice: true },
    }),
    prisma.order.aggregate({
      where: { status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.SUCCESS, createdAt: { gte: startOfDay } },
      _sum: { totalPrice: true },
    }),
    prisma.order.aggregate({
      where: { status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.SUCCESS, createdAt: { gte: startOfMonth } },
      _sum: { totalPrice: true },
    }),
    prisma.user.count({
      where: {
        kycStatus: KycStatus.PENDING,
        roles: { hasSome: [Role.VENDOR, Role.DELIVERY] },
      },
    }),
    prisma.refundRequest.count({ where: { status: RefundStatus.PENDING } }),
    prisma.reviewReport.count({
      where: { status: ReviewReportStatus.PENDING },
    }),
    prisma.product.count(),
    prisma.product.count({ where: { archived: false } }),
    prisma.order.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        customer: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true, brandName: true } },
      },
    }),
    prisma.user.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, email: true, role: true, isBlocked: true, isEmailVerified: true, createdAt: true },
    }),
    prisma.activity.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        vendor: { select: { id: true, name: true, brandName: true } },
        customer: { select: { id: true, name: true } },
        order: { select: { id: true } },
      },
    }),
    prisma.payment.groupBy({
      by: ["status"],
      _count: { id: true },
      _sum: { amount: true },
    }),
  ]);

  return sendSuccess(
    res,
    {
      users: {
        total: totalUsers,
        vendors: totalVendors,
        customers: totalCustomers,
        delivery: totalDrivers,
        admins: totalAdmins,
        blocked: blockedUsers,
      },
      orders: {
        total: totalOrders,
        pending: pendingOrders,
        completed: completedOrders,
        cancelled: cancelledOrders,
        today: todayOrders,
      },
      products: {
        total: totalProducts,
        active: activeProducts,
      },
      revenue: {
        total: revenueAgg._sum.totalPrice || 0,
        today: todayRevenueAgg._sum.totalPrice || 0,
        thisMonth: monthRevenueAgg._sum.totalPrice || 0,
      },
      payments: paymentStatusBreakdown.map((p) => ({
        status: p.status,
        totalAmount: Number(p._sum.amount || 0),
        count: p._count.id,
      })),
      pendingRefunds,
      recentOrders,
      recentUsers,
      recentActivity,
      pendingActions: {
        kycReviews: pendingKyc,
        refundRequests: pendingRefunds,
        reportedReviews,
      },
    },
    "Dashboard overview retrieved",
  );
};

// ==================== USERS ====================

// GET /admin/users
export const getAllUsers = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const role = req.query.role as Role | undefined;
  const search = req.query.search as string | undefined;

  const where = {
    ...(role && Object.values(Role).includes(role) && { roles: { has: role } }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { email: { contains: search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        roles: true,
        kycStatus: true,
        isBlocked: true,
        isEmailVerified: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return sendSuccess(res, { users }, "Users retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// GET /admin/users/:id
export const getUserById = async (req: Request, res: Response) => {
  const id = ensureString(req.params.id);
  const user = await prisma.user
    .findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        phoneNumber: true,
        role: true,
        roles: true,
        kycStatus: true,
        isBlocked: true,
        blockedReason: true,
        isEmailVerified: true,
        brandName: true,
        avatarUrl: true,
        createdAt: true,
        _count: { select: { customerOrders: true, vendorOrders: true } },
      },
    })
    .catch(() => null);
  if (!user) throw new NotFoundError("User");
  return sendSuccess(res, { user }, "User retrieved");
};

// PATCH /admin/users/:id/role
export const setUserRole = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const { role } = req.body as { role?: Role };
  if (!role || !Object.values(Role).includes(role))
    throw new ValidationError("Invalid role");

  // An admin cannot change their own role through this endpoint — that
  // would allow accidental self-demotion (locking themselves out of the
  // admin surface) or unchecked self-escalation.
  if (req.user && id === req.user.id)
    throw new ValidationError("You cannot change your own role");

  const target = await prisma.user.findUnique({
    where: { id },
    select: { role: true, roles: true },
  });
  if (!target) throw new NotFoundError("User");

  // Never leave the platform with zero administrators: refusing to demote
  // the final ADMIN keeps the admin surface recoverable.
  if (
    target.role === Role.ADMIN &&
    role !== Role.ADMIN
  ) {
    const adminCount = await prisma.user.count({
      where: { roles: { has: Role.ADMIN } },
    });
    if (adminCount <= 1)
      throw new ValidationError(
        "Cannot demote the final administrator account",
      );
  }

  // Admin sets the account to exactly one role: active role and held roles
  // stay in sync (single-role invariant for admin-managed accounts).
  const user = await prisma.user.update({ where: { id }, data: { role, roles: [role] } });

  // A demoted admin's outstanding JWTs still carry role=ADMIN until they
  // expire — revoke their sessions now so the old token stops passing
  // authorizeAdmin on its very next request. Only the target's sessions
  // are touched; the acting admin's session is unaffected.
  if (target.role === Role.ADMIN && role !== Role.ADMIN) {
    await deleteAllUserSessions(id).catch((err) =>
      logger.warn({ err, userId: id }, "Failed to revoke sessions on demotion"),
    );
  }

  await auditAdmin(req, "ADMIN_SET_USER_ROLE", {
    targetUserId: id,
    oldRole: target.role,
    newRole: role,
  });

  return sendSuccess(
    res,
    { id: user.id, role: user.role, roles: user.roles },
    "User role updated",
  );
};

// PATCH /admin/users/:id/kyc-status
export const setKycStatus = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const { kycStatus } = req.body as { kycStatus?: KycStatus };
  if (!kycStatus || !Object.values(KycStatus).includes(kycStatus))
    throw new ValidationError("Invalid kycStatus");

  const existingUser = await prisma.user.findUnique({
    where: { id },
    select: { kycStatus: true },
  });
  if (!existingUser) throw new NotFoundError("User");

  const KYC_ORDER = ["PENDING", "VERIFIED", "REJECTED"];
  const currentKyc = existingUser.kycStatus;
  const currentIndex = KYC_ORDER.indexOf(currentKyc);
  const newIndex = KYC_ORDER.indexOf(kycStatus);

  if (newIndex < currentIndex) {
    return res.status(400).json({
      message: `Cannot move KYC status backward from ${currentKyc} to ${kycStatus}`,
    });
  }

  const user = await prisma.user.update({ where: { id }, data: { kycStatus } });
  await auditAdmin(req, "ADMIN_SET_KYC_STATUS", {
    targetUserId: id,
    newStatus: kycStatus,
  });

  // Phase 1C: an admin VERIFIED flip may complete the vendor requirements.
  if (kycStatus === KycStatus.VERIFIED) {
    await evaluateVendorStatus(id).catch((err) =>
      logger.error({ err, userId: id }, "evaluateVendorStatus failed after admin KYC approval"),
    );
  }

  await recordActivityBundle({
    actorId: req.user!.id,
    actions: [
      {
        type: ActivityType.GENERAL,
        title:
          kycStatus === KycStatus.VERIFIED
            ? "KYC Approved"
            : kycStatus === KycStatus.REJECTED
              ? "KYC Rejected"
              : "KYC Status Updated",
        message:
          kycStatus === KycStatus.VERIFIED
            ? "Your identity verification was approved. You can now go live."
            : kycStatus === KycStatus.REJECTED
              ? "Your identity verification was rejected. Please re-submit your NIN."
              : "Your KYC status was updated.",
        targetId: id,
        socketEvent: "GENERAL",
        metadata: { kycStatus },
      },
    ],
    notifyRealtime: true,
    notifyPush: true,
  });

  return sendSuccess(
    res,
    { id: user.id, kycStatus: user.kycStatus },
    "KYC status updated",
  );
};

// PATCH /admin/users/:id/block
export const blockUser = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const { reason } = req.body as { reason?: string };

  const target = await prisma.user.findUnique({
    where: { id },
    select: { role: true },
  });
  if (!target) throw new NotFoundError("User");
  if (target.role === Role.ADMIN)
    throw new ValidationError("Cannot block another admin");

  const user = await prisma.user.update({
    where: { id },
    data: {
      isBlocked: true,
      blockedReason: reason || null,
      blockedAt: new Date(),
    },
  });

  // Immediately revokes their session — their existing access token stops
  // working on their very next request, rather than staying valid until
  // it naturally expires.
  await deleteAllUserSessions(id).catch((err) =>
    logger.warn({ err, userId: id }, "Failed to revoke sessions on block"),
  );

  await auditAdmin(req, "ADMIN_BLOCKED_USER", { targetUserId: id, reason });
  return sendSuccess(
    res,
    { id: user.id, isBlocked: user.isBlocked },
    "User blocked — session revoked",
  );
};

// PATCH /admin/users/:id/unblock
export const unblockUser = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const user = await prisma.user.update({
    where: { id },
    data: { isBlocked: false, blockedReason: null, blockedAt: null },
  });
  await auditAdmin(req, "ADMIN_UNBLOCKED_USER", { targetUserId: id });
  return sendSuccess(
    res,
    { id: user.id, isBlocked: user.isBlocked },
    "User unblocked",
  );
};

// ==================== VENDORS ====================

// GET /admin/vendors
export const getAllVendors = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const status = req.query.status as string | undefined;
  if (status && !Object.values(VendorStatus).includes(status as VendorStatus)) {
    throw new ValidationError("Invalid vendor status filter", { status });
  }

  const where = {
    roles: { has: Role.VENDOR },
    ...(status && { vendorStatus: status as VendorStatus }),
  };

  const [vendors, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        brandName: true,
        brandLogo: true,
        kycStatus: true,
        vendorStatus: true,
        vendorStatusReason: true,
        vendorStatusChangedAt: true,
        isBlocked: true,
        commissionRate: true,
        createdAt: true,
        _count: { select: { products: true, vendorOrders: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return sendSuccess(res, { vendors }, "Vendors retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// PATCH /admin/vendors/:id/status
const setVendorStatusSchema = z.object({
  status: z.enum(["NEW", "PENDING_REVIEW", "ACTIVE", "SUSPENDED"]),
  reason: z.string().trim().max(500).optional(),
});

const OPEN_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.WAITING_VENDOR_CONFIRMATION,
  OrderStatus.WAITING_CUSTOMER_APPROVAL,
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PAYMENT_CONFIRMED,
  OrderStatus.COOKING,
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.OUT_FOR_DELIVERY,
];

export const setVendorStatus = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const parsed = setVendorStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid vendor status change", parsed.error.flatten().fieldErrors);
  }

  const updated = await changeVendorStatus(id, parsed.data.status as VendorStatus, parsed.data.reason, req.user!.id);

  // Suspending takes the storefront offline immediately, but open orders
  // are deliberately NOT auto-cancelled — they keep their lifecycle and
  // are reported so ops can handle them manually.
  let openOrders = 0;
  if (parsed.data.status === "SUSPENDED") {
    await prisma.user.update({ where: { id }, data: { isLive: false } });
    openOrders = await prisma.order.count({
      where: { vendorId: id, status: { in: OPEN_ORDER_STATUSES } },
    });
  }

  // Phase 2 M4: any eligibility transition changes what discovery may
  // show (and every cached orderable flag for this vendor's products), so
  // sweep the discovery namespaces — previously a suspend left 5h-cached
  // browse pages presenting the vendor's dishes as orderable.
  await invalidateMarketplaceDiscoveryCaches();

  // A status transition also changes the correct answer for this vendor's
  // PRODUCT-DETAIL entries: each one carries an availability snapshot that
  // `getProductById` reuses on a cache HIT, so an entry written while the
  // vendor was ACTIVE kept reporting the product as orderable after the
  // suspension, for the whole detail TTL. The discovery sweep above does not
  // reach those keys, so they are dropped explicitly — bounded to this
  // vendor's own products and their product-detail aliases.
  await clearVendorProductDetailCaches(id);

  return sendSuccess(
    res,
    {
      id: updated.id,
      vendorStatus: updated.vendorStatus,
      vendorStatusReason: updated.vendorStatusReason,
      vendorStatusChangedAt: updated.vendorStatusChangedAt,
      ...(parsed.data.status === "SUSPENDED" && { openOrders }),
    },
    "Vendor status updated",
  );
};

// PATCH /admin/vendors/:id/commission-rate
export const setVendorCommissionRate = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = ensureString(req.params.id);
  const { commissionRate } = req.body as { commissionRate?: number };
  if (
    commissionRate === undefined ||
    commissionRate < 0 ||
    commissionRate > 1
  ) {
    throw new ValidationError(
      "commissionRate must be between 0 and 1 (e.g. 0.15 for 15%)",
    );
  }

  const vendor = await prisma.user.findUnique({
    where: { id },
    select: { role: true, roles: true },
  });
  if (!vendor || !vendor.roles.includes(Role.VENDOR)) throw new NotFoundError("Vendor");

  const updated = await prisma.user.update({
    where: { id },
    data: { commissionRate },
  });
  await auditAdmin(req, "ADMIN_SET_COMMISSION_RATE", {
    vendorId: id,
    newRate: commissionRate,
  });

  return sendSuccess(
    res,
    { id: updated.id, commissionRate: updated.commissionRate },
    "Commission rate updated",
  );
};

// ==================== ORDERS ====================

// GET /admin/orders
export const getAllOrders = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const status = req.query.status as OrderStatus | undefined;

  const where = status ? { status } : {};
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, email: true } },
        vendor: { select: { id: true, name: true, brandName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.order.count({ where }),
  ]);

  return sendSuccess(res, { orders }, "Orders retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// GET /admin/orders/:id
export const getOrderById = async (req: Request, res: Response) => {
  const id = ensureString(req.params.id);
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      customer: {
        select: { id: true, name: true, email: true, phoneNumber: true },
      },
      vendor: {
        select: { id: true, name: true, brandName: true, phoneNumber: true },
      },
      items: {
        include: {
          product: { select: { id: true, name: true } },
          options: true,
        },
      },
      address: true,
      payments: { orderBy: { createdAt: "desc" } },
      assignments: {
        include: {
          deliveryPerson: {
            include: {
              user: { select: { id: true, name: true, phoneNumber: true } },
            },
          },
        },
      },
    },
  });
  if (!order) throw new NotFoundError("Order");
  return sendSuccess(res, { order }, "Order retrieved");
};

// PATCH /admin/orders/:id/status
// Admin override — bypasses the normal customer/vendor state machine
// (Orders domain's updateOrderStatus) for exceptional cases: correcting
// a data error, resolving a dispute, etc. Used sparingly and always
// audited.
export const adminUpdateOrderStatus = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = ensureString(req.params.id);
  const { status, reason } = req.body as {
    status?: OrderStatus;
    reason?: string;
  };
  if (!status || !Object.values(OrderStatus).includes(status))
    throw new ValidationError("Invalid status");

  const order = await prisma.order.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!order) throw new NotFoundError("Order");

  const updated = await prisma.$transaction(async (tx) => {
    // Batch D: terminal orders are immutable through this endpoint. The
    // override exists to correct live orders, not to resurrect settled
    // ones — moving COMPLETED/CANCELLED/FAILED_DELIVERY/CANCELLED_UNPAID
    // (or an expired unpaid order) back into a payable or dispatchable
    // state would silently orphan refunds, payouts, earnings, and
    // reconciliation records. Same-state writes stay allowed (no-op).
    // The CAS on the pre-read status also turns a concurrent transition
    // into a 409 instead of an overwrite (P2025).
    if (status !== order.status && (isTerminalOrderStatus(order.status) || order.status === OrderStatus.PAYMENT_EXPIRED)) {
      throw new ConflictError(
        "This order is in a terminal state and cannot be moved. Terminal order history is immutable.",
      );
    }
    let u;
    try {
      u = await tx.order.update({
        where: { id, status: order.status },
        data: { status },
      });
    } catch (err: any) {
      if (err?.code === "P2025") {
        throw new ConflictError(
          "This order changed state while the update was in progress. Reload and try again.",
        );
      }
      throw err;
    }

    // F4-4: an order that already paid a rider is financially settled and must
    // not be reopened into a dispatchable state.
    //
    // `tx.order.update` above has already taken the Order row lock, so this
    // check is serialized against any concurrent dispatch or completion: no
    // dispatch can slip between the write and the check. Throwing rolls the
    // whole transaction back, status change included.
    //
    // This closes the only route that could reopen a settled order: the normal
    // customer/vendor state machine has no backwards transitions, the payment
    // finalizer and order-expiry jobs only touch `AWAITING_PAYMENT`/`PENDING`,
    // and the refund finalizer never rewrites a `COMPLETED` order — so this
    // unconditional admin override was the single path that could move a paid
    // order back into `READY_FOR_PICKUP`/`OUT_FOR_DELIVERY`.
    //
    // No recovery workflow is invented here. Recovering a settled order needs its
    // own audited design; this only refuses the unsafe transition.
    if (isDispatchableOrderStatus(status)) {
      const earning = await tx.deliveryEarning.findUnique({
        where: { orderId: id },
        select: { id: true },
      });
      if (earning) {
        throw new ConflictError(
          "This order has already been paid out to a rider and cannot be returned to a dispatchable state",
        );
      }
    }

    // F4-1 / INV-1: this override is intentionally unconditional (an admin can
    // correct any state, in either direction), which is exactly why it needed
    // reconciliation — it was the one terminal writer with no guard at all. A
    // terminal order must not retain an active DeliveryAssignment, and the
    // reconciliation commits atomically with the override itself.
    //
    // Authorization and transition semantics are untouched: still any valid
    // OrderStatus, still audited, still no new state machine.
    if (isTerminalOrderStatus(status)) {
      await reconcileActiveDeliveryAssignments(tx, id);
    }

    return u;
  });

  await auditAdmin(req, "ADMIN_FORCED_ORDER_STATUS", {
    orderId: id,
    from: order.status,
    to: status,
    reason,
  });

  return sendSuccess(
    res,
    { order: updated },
    "Order status updated (admin override)",
  );
};

// ==================== PAYMENTS & REFUNDS ====================

// GET /admin/payments
export const getAllPayments = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const status = req.query.status as PaymentStatus | undefined;

  const where = status ? { status } : {};
  const [payments, total, summary] = await Promise.all([
    prisma.payment.findMany({
      where,
      select: {
        id: true,
        reference: true,
        amount: true,
        status: true,
        channel: true,
        createdAt: true,
        orderId: true,
        userId: true,
        user: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
    prisma.payment.groupBy({
      by: ["status"],
      _count: { id: true },
      _sum: { amount: true },
    }),
  ]);

  return sendSuccess(res, { payments, summary }, "Payments retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// GET /admin/refund-requests
export const getRefundRequests = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const status = (req.query.status as RefundStatus) || RefundStatus.PENDING;

  const [requests, total] = await Promise.all([
    prisma.refundRequest.findMany({
      where: { status },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.refundRequest.count({ where: { status } }),
  ]);

  return sendSuccess(res, { requests }, "Refund requests retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// PATCH /admin/refund-requests/:id
// PENDING -> APPROVED/REJECTED are simple label changes. APPROVED ->
// COMPLETED is the actual money-moving transition — was previously
// impossible anywhere in the app; requestRefund (Payments domain) only
// ever created this row, nothing ever acted on it.
export const updateRefundStatus = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const { status, adminNote, amount } = req.body as {
    status?: RefundStatus;
    adminNote?: string;
    amount?: number;
  };
  if (!status || !Object.values(RefundStatus).includes(status))
    throw new ValidationError("Invalid status");

  const refundRequest = await prisma.refundRequest.findUnique({
    where: { id },
  });
  if (!refundRequest) throw new NotFoundError("Refund request");

  if (status === RefundStatus.APPROVED || status === RefundStatus.REJECTED) {
    if (refundRequest.status !== RefundStatus.PENDING) {
      throw new ConflictError(
        `Cannot set status to ${status} — request is already ${refundRequest.status}`,
      );
    }
    const updated = await prisma.refundRequest.update({
      where: { id },
      data: {
        status,
        adminNote: adminNote ?? refundRequest.adminNote,
        resolvedByAdminId: req.user!.id,
        resolvedAt: new Date(),
      },
    });
    await auditAdmin(req, `ADMIN_REFUND_${status}`, { refundRequestId: id });
    return sendSuccess(
      res,
      { updated },
      `Refund request ${status.toLowerCase()}`,
    );
  }

  // Submitting a refund to Paystack. Kept on the `status === COMPLETED`
  // input for API backward-compatibility (that's what admin tooling
  // already sends), but the refund is NOT actually complete yet — a
  // POST /refund only means Paystack accepted the request and is
  // processing it ("pending"/"processing"). Money hasn't moved. The
  // request is stored as PROCESSING; only the refund.processed webhook
  // (see webhook.ts) promotes it to COMPLETED, or refund.failed to
  // FAILED. See https://paystack.com/docs/payments/refunds/#refund-status.
  if (status === RefundStatus.COMPLETED || status === RefundStatus.PROCESSING) {
    if (refundRequest.status !== RefundStatus.APPROVED) {
      throw new ConflictError(
        "Refund must be APPROVED before it can be submitted for processing",
      );
    }

    const payment = await prisma.payment.findUnique({
      where: { reference: refundRequest.paymentRef },
    });
    if (!payment) throw new NotFoundError("Payment for this refund request");

    if (payment.status !== PaymentStatus.SUCCESS && payment.status !== PaymentStatus.REFUNDED) {
      throw new ConflictError(
        `Cannot refund a payment with status ${payment.status}`,
      );
    }

    // Phase 3.0.2: presence is tested with != null, never truthiness. A
    // supplied zero (or "0") must be REJECTED as an invalid amount — the
    // previous `amount ? ... : undefined` silently reinterpreted it as
    // "no amount supplied", which the precedence below would resolve to
    // the stored amount or the full remaining balance.
    const refundAmountNaira = amount !== undefined && amount !== null ? Number(amount) : undefined;
    if (
      refundAmountNaira !== undefined &&
      (isNaN(refundAmountNaira) || refundAmountNaira <= 0)
    ) {
      throw new ValidationError("Invalid refund amount");
    }
    const requestedKobo = refundAmountNaira !== undefined ? Math.round(refundAmountNaira * 100) : undefined;

    // Reserve the amount AND persist a durable PROCESSING record in the
    // SAME transaction, BEFORE ever calling Paystack. This closes the
    // crash gap the previous version had: if the process died between
    // "Paystack accepted the refund" and "we recorded that here", the
    // refund.processed webhook would arrive to find this request still
    // APPROVED with no paystackRefundId/requestedAmountKobo to match
    // against, and reconciliation would have nothing to look for either.
    // Now the PROCESSING row (and the amount it's for) exists before we
    // ever leave the building — a crash after this point still leaves
    // something for the webhook or verifyPendingRefunds to find.
    //
    // The row lock (FOR UPDATE) is what stops two concurrent partial
    // refunds (two admins, or a retried request) from both passing an
    // "amount <= remaining" check against the same stale `refundedAmount`
    // and jointly exceeding what Paystack will actually let us refund —
    // the read and the reservation increment happen inside one
    // transaction, so there's no window between them.
    let reservedKobo = 0;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id} FOR UPDATE`;
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const remaining = fresh.amount - fresh.refundedAmount;
      if (remaining <= 0) {
        throw new ConflictError("This payment has already been fully refunded");
      }
      // N-01: an amount explicitly submitted by the admin still wins, but
      // when none is given we must honour the amount already recorded on the
      // request before falling back to "everything remaining". The
      // paid-cancel path records the cancelled order's own paid value, so a
      // batch payment can no longer have its entire remainder refunded by
      // submitting an order-scoped request with no amount. Amountless
      // requests (the customer self-service path) still fall back to
      // `remaining`, preserving that documented behaviour.
      reservedKobo = requestedKobo ?? refundRequest.requestedAmountKobo ?? remaining;
      // Phase 3.0.2: strictly positive lower bound. A stored
      // requestedAmountKobo of zero or less (no in-app writer produces
      // one, but the column is nullable with no CHECK constraint) must
      // never reach the ledger or Paystack: zero would be falsy-omitted
      // by the refund service into a FULL refund with a zero reservation,
      // and a negative value would decrement the reservation ledger.
      // Throwing inside the transaction rolls everything back, so an
      // invalid stored amount reserves nothing and calls nothing. It is
      // rejected, never clamped or reinterpreted as a full refund.
      if (!Number.isInteger(reservedKobo) || reservedKobo <= 0) {
        throw new ValidationError("Invalid refund amount");
      }
      if (reservedKobo > remaining) {
        throw new ValidationError(
          `Refund amount exceeds remaining refundable balance (₦${(remaining / 100).toFixed(2)})`,
        );
      }
      const claimed = await tx.payment.updateMany({
        where: { id: payment.id, refundedAmount: fresh.refundedAmount },
        data: { refundedAmount: { increment: reservedKobo } },
      });
      if (claimed.count === 0) {
        // Someone else's transaction committed between our read and
        // write despite the row lock (shouldn't happen under FOR UPDATE,
        // but fail loudly rather than silently proceed if it ever does).
        throw new ConflictError("Refund balance changed concurrently — please retry");
      }

      // Durable BEFORE Paystack is ever called. paystackRefundId stays
      // null until Paystack tells us its id — that's fine, matching can
      // still find this row by paymentRef + PROCESSING + no id yet.
      // C-3: this claim must be a COMPARE-AND-SET, not an unconditional write.
      // The APPROVED precondition was evaluated at :918 against a read taken
      // OUTSIDE this transaction, so two concurrent admin submissions both saw
      // APPROVED and both reached this point. The Payment row lock serialises
      // the *balance*, not the *obligation*: the second submitter simply
      // re-reserved against the reduced balance and then issued a SECOND
      // Paystack refund for the same obligation. (A second full refund was
      // incidentally blocked because the balance hit zero, but partial refunds
      // are a supported flow and were not protected at all.)
      //
      // Constraining the update to its expected source status makes the claim
      // atomic. Under READ COMMITTED a competing request re-evaluates this
      // predicate once the winner commits, matches nothing, and throws — which
      // rolls back its own balance reservation, so it never reaches Paystack.
      //
      // The claim still commits BEFORE the external call, and leaves the row in
      // the exact shape reconciliation expects: PROCESSING with a null
      // paystackRefundId, findable by paymentRef + PROCESSING + no id yet.
      const obligationClaim = await tx.refundRequest.updateMany({
        where: { id, status: RefundStatus.APPROVED },
        data: {
          status: RefundStatus.PROCESSING,
          adminNote: adminNote ?? refundRequest.adminNote,
          resolvedByAdminId: req.user!.id,
          resolvedAt: new Date(),
          requestedAmountKobo: reservedKobo,
        },
      });
      if (obligationClaim.count === 0) {
        // Another admin submission claimed this obligation first. Throwing
        // inside the transaction undoes the balance reservation made above, so
        // the losing request is rejected without moving money twice.
        throw new ConflictError(
          "Refund is already being submitted to Paystack — another request claimed it first. No duplicate refund was issued.",
        );
      }
    });

    let paystackResult;
    try {
      // Submit the RESERVED amount — the same validated figure persisted
      // above — never the raw explicit input. When the admin omits an
      // amount, requestedKobo is undefined and the service would treat the
      // omission as a full refund, while the ledger reserved only the
      // order-scoped stored amount (or the remaining balance). Sending
      // reservedKobo keeps Paystack, the ledger, and the persisted record
      // identical by construction.
      paystackResult = await refundPaymentViaPaystack(refundRequest.paymentRef, reservedKobo);
    } catch (err: any) {
      const classification = classifyRefundSubmitError(err);
      logger.error(
        { err: err?.response?.data || err.message, refundRequestId: id, classification },
        "Paystack refund submission errored",
      );

      if (classification === "definite_failure") {
        // Paystack received our request and told us, definitively, that
        // no refund was created — safe to release the reservation.
        await failRefund(id, { source: "admin_sync" });
        throw new UpstreamServiceError(
          "Paystack",
          "Refund failed — no records were changed. You can retry.",
        );
      }

      // UNKNOWN outcome: a timeout or dropped connection means we
      // genuinely don't know whether Paystack created the refund before
      // we lost the response. Do NOT release the reservation and do NOT
      // let the admin blindly retry from here — the PROCESSING record
      // stays as-is and verifyPendingRefunds will reconcile it against
      // Paystack's own records shortly.
      throw new UpstreamServiceError(
        "Paystack",
        "Paystack didn't confirm whether this refund was created — the outcome is unknown, not failed. It's marked PROCESSING and will be reconciled automatically; do not resubmit.",
        { code: "REFUND_OUTCOME_UNKNOWN" } as any,
      );
    }

    const updated = await prisma.refundRequest.update({
      where: { id },
      data: {
        paystackRefundId: paystackResult?.id != null ? String(paystackResult.id) : null,
      },
    });

    await auditAdmin(req, "ADMIN_REFUND_SUBMITTED", {
      refundRequestId: id,
      paystackReference: refundRequest.paymentRef,
      reservedKobo,
      paystackResult,
    });

    return sendSuccess(
      res,
      { refundRequest: updated },
      "Refund submitted to Paystack — it will be marked complete once Paystack confirms the transfer.",
    );
  }

  throw new ValidationError("Unsupported status transition");
};

// ==================== PAYOUTS ====================
// Previously impossible anywhere in the app — the Vendor Dashboard pass
// built the vendor-facing summary and bank-details setup, but explicitly
// deferred actually triggering a payout to here, since it's an
// admin-gated action (moving real money) and building that gate before
// the Admin domain existed would have meant building it twice.

// GET /admin/payouts/pending — vendors with an available balance to pay out
export const getPendingPayouts = async (_req: Request, res: Response) => {
  // F8: filtered at the order level (not after grouping) so the preview shows
  // exactly the orders the payout claim would actually pay — an order with a
  // customer refund is withheld, because a partial refund leaves
  // Payment.status = SUCCESS and a full refund on a COMPLETED order never
  // rewrites the order row at all.
  const payoutCandidates = await prisma.order.findMany({
    where: {
      status: OrderStatus.COMPLETED,
      paymentStatus: PaymentStatus.SUCCESS,
      payoutId: null,
    },
    select: {
      id: true,
      vendorId: true,
      basePrice: true,
      totalPrice: true,
      deliveryFee: true,
      idempotencyKey: true,
      commissionKobo: true,
      vendorPayoutKobo: true,
      commissionRateSnapshot: true,
    },
  });
  const { eligible: pendingCandidates } = await partitionPayoutBlockedOrders(
    prisma,
    payoutCandidates,
  );
  const byVendor = new Map<
    string,
    { vendorId: string; orders: typeof pendingCandidates }
  >();
  for (const order of pendingCandidates) {
    const row = byVendor.get(order.vendorId) ?? {
      vendorId: order.vendorId,
      orders: [],
    };
    row.orders.push(order);
    byVendor.set(order.vendorId, row);
  }
  const vendorsWithEligibleOrders = [...byVendor.values()];

  const vendorIds = vendorsWithEligibleOrders.map((v) => v.vendorId);
  const vendors = await prisma.user.findMany({
    where: { id: { in: vendorIds } },
    select: {
      id: true,
      name: true,
      brandName: true,
      commissionRate: true,
      bankName: true,
      bankCode: true,
      bankAccountNumber: true,
      paystackRecipientCode: true,
      vendorStatus: true,
    },
  });

  const pending = vendorsWithEligibleOrders.map((v) => {
    const vendor = vendors.find((x) => x.id === v.vendorId);
    // Batch G: preview from frozen snapshots (same equation as settlement),
    // not live-rate math — the displayed balance is the claimable balance.
    const preview = previewVendorPayoutAmounts(v.orders, vendor?.commissionRate ?? 0.15);
    const { grossRevenue, commission, netAvailable } = preview;
    // Phase 1C payout holds: skipped vendors stay listed (with a reason)
    // but are never auto-paid; their orders keep payoutId null so nothing
    // is lost. NOTE: a missing paystackRecipientCode alone does NOT hold —
    // the code is created on first transfer, so holding on it would make
    // first payouts impossible.
    const hold = payoutHoldReason(vendor ?? null);
    return {
      vendorId: v.vendorId,
      vendorName: vendor?.brandName || vendor?.name,
      orderCount: preview.orderCount,
      grossRevenue,
      commission,
      netAmount: netAvailable,
      bankOnFile: !!(vendor?.bankName && vendor?.bankAccountNumber),
      transferVerified: !!vendor?.paystackRecipientCode,
      held: hold !== null,
      heldReason: hold,
      // Additive Batch G metadata: snapshot coverage and whether settlement
      // itself would refuse this batch (torn snapshots / non-positive net).
      snapshotOrderCount: preview.snapshotOrderCount,
      legacyOrderCount: preview.legacyOrderCount,
      payoutBlocked: preview.blocked,
      payoutBlockReason: preview.blockReason ?? null,
    };
  });

  return sendSuccess(res, { pending }, "Pending payouts retrieved");
};

/**
 * Phase 1C payout hold reasons. Returns null when the vendor may be paid.
 * SUSPENDED vendors and vendors without bank details are skipped; their
 * orders stay unpaid (payoutId null) until the hold clears.
 */
function payoutHoldReason(
  vendor: {
    vendorStatus?: string | null;
    bankName?: string | null;
    bankCode?: string | null;
    bankAccountNumber?: string | null;
  } | null,
): string | null {
  if (!vendor) return "vendor not found";
  if (vendor.vendorStatus === "SUSPENDED") return "vendor suspended";
  if (!vendor.bankName || !vendor.bankCode || !vendor.bankAccountNumber) {
    return "no verified bank details";
  }
  return null;
}

// GET /admin/payouts
export const getAllPayouts = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const status = req.query.status as PayoutStatus | undefined;

  const where = status ? { status } : {};
  const [payouts, total] = await Promise.all([
    prisma.vendorPayout.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true, brandName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.vendorPayout.count({ where }),
  ]);

  return sendSuccess(res, { payouts }, "Payouts retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

async function initiateVendorPayoutTransfer(
  req: AuthRequest,
  payout: any,
  vendor: any,
  orderCount: number,
  transferReference?: string,
) {
  if (!vendor.bankName || !vendor.bankAccountNumber || !vendor.bankCode) {
    await auditAdmin(req, "ADMIN_PROCESSED_PAYOUT_MANUAL", {
      payoutId: payout.id,
      vendorId: vendor.id,
      amount: payout.amount,
    });
    return payout;
  }

  // Use the claim's idempotency key as the Paystack transfer reference so
  // that retries with the same key are idempotent at the provider level.
  // Fall back to the payout's existing reference or a generated one.
  const reference = transferReference || payout.reference || `vendor_payout_${payout.id}`;
  const claimed = await prisma.vendorPayout.updateMany({
    where: {
      id: payout.id,
      status: { in: [PayoutStatus.PENDING, PayoutStatus.FAILED] },
    },
    data: {
      status: PayoutStatus.PROCESSING,
      reference,
      failureReason: null,
      processedByAdminId: req.user!.id,
    },
  });
  if (claimed.count !== 1)
    throw new ConflictError("This payout is already processing or settled");

  try {
    let recipientCode = vendor.paystackRecipientCode;
    if (!recipientCode) {
      const createdRecipient = await createTransferRecipient({
        name: vendor.bankAccountName || vendor.name || "Vendor",
        accountNumber: decrypt(vendor.bankAccountNumber),
        bankCode: vendor.bankCode,
      });
      const saved = await prisma.user.updateMany({
        where: { id: vendor.id, paystackRecipientCode: null },
        data: { paystackRecipientCode: createdRecipient },
      });
      recipientCode =
        saved.count === 1
          ? createdRecipient
          : (
              await prisma.user.findUnique({
                where: { id: vendor.id },
                select: { paystackRecipientCode: true },
              })
            )?.paystackRecipientCode || createdRecipient;
    }

    await initiateTransfer({
      // payout.amount is integer kobo (Phase 3A, BigInt). Paystack expects
      // kobo, so pass it unchanged — no * 100.
      amountKobo: Number(payout.amount),
      recipientCode,
      reason: `Payout for ${orderCount} order(s)`,
      reference,
    });
    await auditAdmin(req, "ADMIN_PAYOUT_TRANSFER_INITIATED", {
      payoutId: payout.id,
      vendorId: vendor.id,
      amount: payout.amount,
      reference,
    });
    return prisma.vendorPayout.findUnique({ where: { id: payout.id } });
  } catch (err: any) {
    // A timeout has an unknown outcome. Keep PROCESSING so a retry cannot
    // initiate a second transfer before the transfer webhook/reconciliation.
    logger.error(
      { err: err?.details || err.message, payoutId: payout.id, reference },
      "Payout transfer outcome unknown",
    );
    // Batch B (P3.2-03): branch on the authoritative transfer outcome, not
    // the legacy `retryable` flag. Only an explicit provider REJECTION
    // proves no transfer was created. A timeout, network error, or 5xx is
    // UNKNOWN — the transfer may exist — so the payout stays PROCESSING
    // with its order claims held until the webhook/reconciler settles it.
    // Same semantics as the rider withdrawal path.
    const outcome: TransferInitiationOutcome =
      (err?.details?.outcome as TransferInitiationOutcome) || "UNKNOWN";
    if (outcome === "REJECTED") {
      // N-06: a definite rejection closes this payout AND releases the order
      // claims in one transaction, so the orders become eligible for a future
      // payout again instead of being stranded forever against a dead
      // payout. Only the winner of the PROCESSING CAS releases anything; if a
      // concurrent transfer.success already settled it to PAID, this is a
      // no-op and the claims are (correctly) retained.
      const settlement = await settleVendorPayoutFailed(
        payout.id,
        String(err.message),
      );
      if (settlement.outcome === "SETTLED") {
        await auditAdmin(req, "ADMIN_PAYOUT_TRANSFER_FAILED", {
          payoutId: payout.id,
          vendorId: vendor.id,
          reference,
          releasedOrders: settlement.releasedOrders,
        });
      }
      throw new UpstreamServiceError(
        "Paystack",
        "Payout transfer failed; correct the payout details and retry.",
        { outcome },
      );
    }
    await auditAdmin(req, "ADMIN_PAYOUT_TRANSFER_UNKNOWN", {
      payoutId: payout.id,
      vendorId: vendor.id,
      reference,
    });
    throw new UpstreamServiceError(
      "Paystack",
      "Payout transfer was submitted or may be in progress. Await Paystack confirmation before retrying.",
      { outcome },
    );
  }
}

/**
 * Stage H (E-03): bounded attempts for the Serializable payout-claim
 * transaction. Only P2034 (PostgreSQL 40001 serialization failure) is
 * retried — every other error propagates untouched.
 *
 * Retry is safe here because the transaction performs pure database
 * reads/writes (find eligible orders, create VendorPayout, claim orders
 * via updateMany with a count guard) and NO external side effects. The
 * Paystack transfer happens after commit in
 * `initiateVendorPayoutTransfer`, so a retried transaction can never
 * execute a money movement twice.
 */
const PAYOUT_CLAIM_MAX_ATTEMPTS = 3;

function isSerializationFailure(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034"
  );
}

/**
 * Stage H (E-03): the Serializable payout-claim transaction, extracted so
 * the retry loop in `processPayout` can rerun it. Pure database work only —
 * safe to rerun. SERIALIZABLE is preserved: concurrent claims still allow
 * exactly one winner; the loser gets P2034.
 *
 * Stage J (E-04): payout totals are snapshot-authoritative. Orders carrying
 * persisted `commissionKobo`/`vendorPayoutKobo` contribute their exact
 * frozen values (integer sum — never recomputed from aggregate revenue and
 * never re-rated at the live commission rate). Pre-3.2b orders with NULL
 * snapshots ("unknown history", never zero) use the pre-existing
 * aggregate/live-rate fallback for those orders only. Grains are never
 * mixed within a single order.
 */
async function claimVendorPayoutOrders(vendor: {
  id: string;
  commissionRate: number;
}) {
  return prisma.$transaction(
    async (tx) => {
      // Stage 5: Deterministic Order-first locking (mandatory per §5.4)
      // Lock all candidate Order rows in ascending ID order to prevent deadlocks
      // and TOCTOU races between eligibility read and reservation write.
      const payoutCandidates = await tx.$queryRaw<{
        id: string;
        basePrice: number;
        totalPrice: number;
        deliveryFee: number;
        createdAt: Date;
        commissionKobo: bigint | null;
        vendorPayoutKobo: bigint | null;
        commissionRateSnapshot: number | null;
        idempotencyKey: string | null;
      }[]>`
        SELECT o.id, o.basePrice, o.totalPrice, o.deliveryFee, o.createdAt,
               o.commissionKobo, o.vendorPayoutKobo, o.commissionRateSnapshot,
               o.idempotencyKey
        FROM "Order" o
        WHERE o."vendorId" = ${vendor.id}
          AND o."status" = 'COMPLETED'
          AND o."paymentStatus" = 'SUCCESS'
          AND o."payoutId" IS NULL
        ORDER BY o.id ASC
        FOR UPDATE
      `;

      // F8: a customer refund can have consumed some or all of an order's value
      // while the order row still reads COMPLETED + SUCCESS — the refund paths
      // only rewrite the order when it sits in REFUND_CANCELLABLE_ORDER_STATUSES,
      // which deliberately excludes COMPLETED. Lock the covering Payment rows
      // first (the very lock the refund approval/completion paths already take,
      // so the two cannot both observe "safe" and both commit), then withhold
      // any order whose money is in an unresolved or completed refund.
      //
      // Nothing is netted off and no reduced payout is computed: this repository
      // defines no vendor/platform split for refunds, so the only safe action is
      // to not pay the order until that policy exists. Withheld orders keep
      // payoutId = null and return to the eligible pool on their own once their
      // refund is rejected/failed or a policy lands.
      await lockPaymentsCoveringOrders(
        tx,
        [
          ...new Set(
            payoutCandidates
              .map((o) => o.idempotencyKey)
              .filter((k): k is string => !!k),
          ),
        ],
      );
      const { eligible: eligibleOrders, blocked: blockedOrders } =
        await partitionPayoutBlockedOrders(tx, payoutCandidates);

      if (blockedOrders.length > 0) {
        logger.warn(
          {
            vendorId: vendor.id,
            blockedOrderIds: blockedOrders.map((o) => o.id),
            blockedOrderCount: blockedOrders.length,
          },
          "Payout withheld for orders with a customer refund — no vendor/platform refund allocation policy is defined, so these orders are not paid",
        );
      }

      if (payoutCandidates.length > 0 && eligibleOrders.length === 0) {
        throw new ValidationError(
          "No payout-eligible orders: every completed order for this vendor has a customer refund whose vendor allocation has not been decided.",
        );
      }
      if (eligibleOrders.length === 0)
        throw new ValidationError(
          "This vendor has no eligible orders to pay out",
        );
      // E-07: integrity gate BEFORE any financial state is written. An
      // impossible/torn/contradictory snapshot blocks the whole payout
      // deterministically instead of being silently skipped by the
      // aggregation. Pure validation — stored kobo values are never
      // recomputed from a rate. Legacy all-NULL rows are not defects and
      // keep the documented fallback below. The throw is not a P2034, so
      // the Stage H retry loop never re-runs it.
      const snapshotDefects = findPayoutSnapshotDefects(eligibleOrders);
      if (snapshotDefects.length > 0) {
        logger.error(
          {
            vendorId: vendor.id,
            orderIds: eligibleOrders.map((o) => o.id),
            defects: snapshotDefects,
          },
          "Payout blocked: inconsistent order money snapshots",
        );
        throw new ConflictError(
          `Payout blocked: order ${snapshotDefects[0].orderId} has inconsistent financial snapshot data (${snapshotDefects[0].reason}). No payout was created.`,
          "PAYOUT_SNAPSHOT_INVALID",
        );
      }

      // Stage 5: Acquire FinancialOperationClaim for all payments involved.
      // This serializes payout vs refund per payment before any financial
      // state is written. Claims are created inside the same transaction so
      // retries on P2034 re-acquire cleanly (partial unique index prevents
      // duplicates).
      const uniquePaymentIds = [
        ...new Set(
          eligibleOrders
            .map((o) => o.idempotencyKey)
            .filter((k): k is string => !!k)
            .map((k) => k),
        ),
      ];
      // Map idempotencyKey → paymentId by querying Payment rows
      const paymentRows = await tx.$queryRaw<{ id: string; idempotencyKey: string }[]>`
        SELECT id, idempotencyKey FROM "Payment"
        WHERE idempotencyKey = ANY(${
          Prisma.join(
            uniquePaymentIds.filter(Boolean) as string[],
          )
        })
      `;
      const keyToPaymentId = new Map(
        paymentRows.map((r) => [r.idempotencyKey, r.id]),
      );
      const claimPaymentIds = uniquePaymentIds
        .filter(Boolean)
        .map((k) => keyToPaymentId.get(k as string))
        .filter((id): id is string => !!id);

      const claims = await acquireMultiPaymentClaim(tx, {
        paymentIds: claimPaymentIds,
        operationType: "PAYOUT",
        amountKobo: 0, // placeholder; updated below after VendorPayout creation
        operationIdempotencyKey: `payout_${vendor.id}_${Date.now()}`,
      });

      // E-04: exact integer-kobo sum over snapshot-backed orders.
      const snapshotTotals = sumSnapshotKoboTotals(eligibleOrders);
      // E-04 legacy fallback (documented pre-existing behavior, E-05 rate
      // source untouched): aggregate/live-rate math applies ONLY to orders
      // whose snapshots are entirely NULL. Fully snapshotted batches never
      // touch Float commission math.
      const legacyOrders = eligibleOrders.filter(isLegacyNullSnapshotOrder);
      let legacyGrossKobo = 0n;
      let legacyCommissionKobo = 0n;
      let legacyNetKobo = 0n;
      if (legacyOrders.length > 0) {
        const legacy = calculatePayoutAmounts(
          legacyOrders,
          vendor.commissionRate,
        );
        // calculatePayoutAmounts already returns integer kobo — no * 100.
        legacyGrossKobo = BigInt(legacy.grossRevenue);
        legacyCommissionKobo = BigInt(legacy.commission);
        legacyNetKobo = BigInt(legacy.netAvailable);
      }
      const grossKobo = snapshotTotals.grossKobo + legacyGrossKobo;
      const commissionKobo =
        snapshotTotals.commissionKobo + legacyCommissionKobo;
      const netKobo =
        snapshotTotals.vendorPayoutKobo + legacyNetKobo;
      if (netKobo <= 0n)
        throw new ValidationError("Payout amount must be greater than zero");
      // VendorPayout.grossRevenue/commission/amount are integer kobo
      // (Phase 3A, BigInt). Store exact kobo directly — no naira conversion,
      // no * 100 / / 100 round-trip.
      const periodStart = eligibleOrders[0].createdAt;
      const periodEnd = eligibleOrders[eligibleOrders.length - 1].createdAt;
      const created = await tx.vendorPayout.create({
        data: {
          vendorId: vendor.id,
          grossRevenue: grossKobo,
          commission: commissionKobo,
          amount: netKobo,
          orderCount: eligibleOrders.length,
          periodStart,
          periodEnd,
          status: PayoutStatus.PENDING,
        },
      });

      // Update claims with the actual VendorPayout ID and amount
      await Promise.all(
        (claims as Array<{ id: string }>).map((c) =>
          tx.financialOperationClaim.update({
            where: { id: c.id },
            data: {
              vendorPayoutId: created.id,
              amountKobo: Number(netKobo),
            },
          }),
        ),
      );

      const claimed = await tx.order.updateMany({
        where: {
          id: { in: eligibleOrders.map((order) => order.id) },
          payoutId: null,
        },
        data: { payoutId: created.id },
      });
      if (claimed.count !== eligibleOrders.length)
        throw new ConflictError(
          "Another payout process claimed one or more orders; retry this request",
        );
      return { payout: created, claims };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

// POST /admin/payouts/process. Pass payoutId to retry a FAILED payout using
// its original reference; vendorId remains supported for new payouts.
export const processPayout = async (req: AuthRequest, res: Response) => {
  const { vendorId, payoutId } = req.body as {
    vendorId?: string;
    payoutId?: string;
  };
  if (!vendorId && !payoutId)
    throw new ValidationError("vendorId or payoutId is required");

  // Stage 5: Financial submission freeze — checked at every entry point
  await requireFinancialSubmissionNotFrozen();

  if (payoutId) {
    const payout = await prisma.vendorPayout.findUnique({
      where: { id: payoutId },
      include: { vendor: true, _count: { select: { orders: true } } },
    });
    if (!payout) throw new NotFoundError("Payout");
    if (payout.status !== PayoutStatus.FAILED)
      throw new ConflictError("Only failed payouts can be retried");
    // N-06 coherence guard: a definite failure now releases the payout's
    // order claims (see settleVendorPayoutFailed), so such a payout owns no
    // orders and must never be re-sent — re-sending it alongside a fresh
    // claim over those same released orders would produce TWO Paystack
    // transfers for one obligation. A FAILED payout is retryable only while it
    // still holds its orders (pre-existing payouts); otherwise the correct
    // recovery is a normal payout run that re-claims them. This is a no-op
    // for every payout that predates the release behaviour.
    if (payout._count.orders === 0)
      throw new ConflictError(
        "This failed payout no longer holds any orders — its orders were released for a new payout run. Run the payout normally to re-claim them.",
      );
    const retryHold = payoutHoldReason(payout.vendor);
    if (retryHold) {
      return sendSuccess(
        res,
        { payout, skipped: { vendorId: payout.vendorId, reason: retryHold } },
        "Payout retry skipped — vendor is on payout hold",
      );
    }
    const updated = await initiateVendorPayoutTransfer(
      req,
      payout,
      payout.vendor,
      payout._count.orders,
    );
    return sendSuccess(
      res,
      { payout: updated },
      "Payout retry initiated — awaiting Paystack confirmation",
    );
  }

  const vendor = await prisma.user.findUnique({ where: { id: vendorId! } });
  if (!vendor || !vendor.roles.includes(Role.VENDOR)) throw new NotFoundError("Vendor");

  // Phase 1C payout hold: held vendors are skipped, never recorded — their
  // orders keep payoutId null so nothing is lost.
  const hold = payoutHoldReason(vendor);
  if (hold) {
    return sendSuccess(
      res,
      { payout: null, skipped: { vendorId: vendor.id, reason: hold } },
      "Payout skipped — vendor is on payout hold",
    );
  }

  // E-03: the Serializable claim stays intact. A concurrent claimant loses
  // with P2034 instead of double-claiming; the loser retries a bounded
  // number of times and, if still conflicting, receives the same
  // controlled 409 contract as the existing count-guard path — never a
  // generic 500, never a false success, never a second money movement
  // (the Paystack transfer below runs only after this commit).
  let result: Awaited<ReturnType<typeof claimVendorPayoutOrders>> | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      result = await claimVendorPayoutOrders(vendor);
      break;
    } catch (err) {
      if (!isSerializationFailure(err)) throw err;
      if (attempt >= PAYOUT_CLAIM_MAX_ATTEMPTS) {
        logger.warn(
          { vendorId: vendor.id, attempt },
          "Payout claim serialization conflict persists; returning 409",
        );
        throw new ConflictError(
          "Another payout process claimed one or more orders; retry this request",
        );
      }
      logger.warn(
        { vendorId: vendor.id, attempt },
        "Payout claim serialization conflict; retrying",
      );
    }
  }
  if (!result)
    throw new ConflictError(
      "Another payout process claimed one or more orders; retry this request",
    );

  const { payout, claims } = result;

  // Use the claim's idempotency key as the Paystack transfer reference so
  // that retries with the same key are idempotent at the provider level.
  const transferReference = claims[0]?.operationIdempotencyKey;

  const updated = await initiateVendorPayoutTransfer(
    req,
    payout,
    vendor,
    payout.orderCount,
    transferReference,
  );
  return sendSuccess(
    res,
    { payout: updated },
    updated?.status === PayoutStatus.PENDING
      ? "Payout recorded — process the transfer manually and mark it paid"
      : "Payout initiated — awaiting Paystack confirmation",
  );
};

// PATCH /admin/payouts/:id/mark-paid — for payouts settled manually outside Paystack
export const markPayoutPaid = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const payout = await prisma.vendorPayout.findUnique({ where: { id } });
  if (!payout) throw new NotFoundError("Payout");
  if (payout.status !== PayoutStatus.PENDING || payout.reference)
    throw new ConflictError("Only pending manual payouts can be marked paid");

  const result = await prisma.vendorPayout.updateMany({
    where: { id, status: PayoutStatus.PENDING, reference: null },
    data: {
      status: PayoutStatus.PAID,
      paidAt: new Date(),
      processedByAdminId: req.user!.id,
    },
  });
  if (result.count !== 1)
    throw new ConflictError("Payout state changed; refresh and try again");
  const updated = await prisma.vendorPayout.findUniqueOrThrow({
    where: { id },
  });
  await auditAdmin(req, "ADMIN_MARKED_PAYOUT_PAID", { payoutId: id });

  return sendSuccess(res, { payout: updated }, "Payout marked as paid");
};

// ==================== REVIEW MODERATION ====================

// GET /admin/review-reports
export const getReportedReviews = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);

  const [reports, total] = await Promise.all([
    prisma.reviewReport.findMany({
      where: { status: ReviewReportStatus.PENDING },
      include: {
        user: { select: { id: true, name: true } },
        review: {
          include: {
            customer: { select: { id: true, name: true } },
            product: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.reviewReport.count({
      where: { status: ReviewReportStatus.PENDING },
    }),
  ]);

  return sendSuccess(res, { reports }, "Reported reviews retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// PATCH /admin/review-reports/:id
// action: "dismiss" (report was unfounded, review stays) or "remove" (review is deleted)
export const resolveReviewReport = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const { action } = req.body as { action?: "dismiss" | "remove" };
  if (action !== "dismiss" && action !== "remove")
    throw new ValidationError("action must be 'dismiss' or 'remove'");

  const report = await prisma.reviewReport.findUnique({ where: { id } });
  if (!report) throw new NotFoundError("Review report");
  if (report.status !== ReviewReportStatus.PENDING)
    throw new ConflictError("This report has already been resolved");

  if (action === "remove") {
    // Cascade-deletes the review's own votes/reports/vendor reply too.
    await prisma.productReview
      .delete({ where: { id: report.reviewId } })
      .catch(() => null);
  }

  const updated = await prisma.reviewReport.update({
    where: { id },
    data: {
      status:
        action === "remove"
          ? ReviewReportStatus.RESOLVED
          : ReviewReportStatus.DISMISSED,
      resolvedByAdminId: req.user!.id,
      resolvedAt: new Date(),
    },
  });

  await auditAdmin(req, "ADMIN_RESOLVED_REVIEW_REPORT", {
    reportId: id,
    action,
  });
  return sendSuccess(
    res,
    { report: updated },
    `Report ${action === "remove" ? "resolved — review removed" : "dismissed"}`,
  );
};

// ==================== DELIVERY PERSON MODERATION ====================

// PATCH /admin/delivery/:userId/status
export const setDeliveryPersonStatus = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = ensureString(req.params.userId);
  const { status, reason } = req.body as {
    status?: DeliveryPersonStatus;
    reason?: string;
  };
  if (!status || !Object.values(DeliveryPersonStatus).includes(status))
    throw new ValidationError("Invalid status");

  const deliveryPerson = await prisma.deliveryPerson.findUnique({
    where: { userId },
  });
  if (!deliveryPerson) throw new NotFoundError("Delivery person");

  const updated = await prisma.deliveryPerson.update({
    where: { userId },
    data: {
      status,
      ...(status === DeliveryPersonStatus.SUSPENDED ? { isOnline: false } : {}),
    },
  });

  if (status === DeliveryPersonStatus.SUSPENDED) {
    await deleteAllUserSessions(userId).catch((err) =>
      logger.warn({ err, userId }, "Failed to revoke sessions on suspension"),
    );
  }

  await auditAdmin(req, "ADMIN_SET_DELIVERY_STATUS", {
    deliveryUserId: userId,
    newStatus: status,
    reason,
  });
  return sendSuccess(
    res,
    { id: updated.id, status: updated.status },
    "Delivery person status updated",
  );
};

// ==================== AUDIT LOGS ====================

// GET /admin/audit-logs
export const getAuditLogs = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const action = req.query.action as string | undefined;

  const where = action
    ? { action: { contains: action, mode: "insensitive" as const } }
    : {};
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return sendSuccess(res, { logs }, "Audit logs retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// ==================== PROMOTIONS ====================
// Deferred from the Admin domain pass, built together with Promotions
// itself. Vendors create their own scoped promo codes (promoController.ts);
// only an admin can create a PLATFORM-WIDE one (vendorId null), and an
// admin can deactivate any promo regardless of who created it.

// GET /admin/promotions
export const getAllPromotions = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const scope = req.query.scope as "platform" | "vendor" | undefined;

  const where =
    scope === "platform"
      ? { vendorId: null }
      : scope === "vendor"
        ? { vendorId: { not: null } }
        : {};
  const [promotions, total] = await Promise.all([
    prisma.promotion.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true, brandName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.promotion.count({ where }),
  ]);

  return sendSuccess(res, { promotions }, "Promotions retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// POST /admin/promotions — platform-wide only; vendor-scoped promos are created by vendors themselves
export const createPlatformPromotion = async (
  req: AuthRequest,
  res: Response,
) => {
  const {
    code,
    name,
    description,
    type,
    value,
    maxDiscount,
    startsAt,
    expiresAt,
    usageLimit,
    maxUsesPerUser,
    minOrderAmount,
  } = req.body;

  if (!code || !name || !type || value === undefined)
    throw new ValidationError("code, name, type, and value are required");
  if (!Object.values(DiscountType).includes(type))
    throw new ValidationError("Invalid discount type");
  if (type === DiscountType.PERCENTAGE && value > 100)
    throw new ValidationError("Percentage discount can't exceed 100");

  const upperCode = String(code).toUpperCase();
  // Note: Postgres treats NULL as never-equal-to-NULL in unique
  // constraints, so @@unique([vendorId, code]) does NOT by itself stop
  // two platform-wide (vendorId: null) promos from sharing a code — this
  // manual check is what actually enforces it for the platform-wide case.
  const existing = await prisma.promotion.findFirst({
    where: { vendorId: null, code: upperCode },
  });
  if (existing)
    throw new ConflictError(
      "A platform-wide promotion with this code already exists",
    );

  const promo = await prisma.promotion.create({
    data: {
      code: upperCode,
      name,
      description,
      type,
      value,
      maxDiscount,
      startsAt: startsAt ? new Date(startsAt) : undefined,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      usageLimit,
      maxUsesPerUser: maxUsesPerUser ?? 1,
      minOrderAmount: minOrderAmount ?? 0,
      vendorId: null,
    },
  });

  await auditAdmin(req, "ADMIN_CREATED_PLATFORM_PROMOTION", {
    promotionId: promo.id,
    code: upperCode,
  });
  // Discovery embeds resolved promotions — sweep so creation surfaces.
  try {
    const { invalidateActiveProductPromosCache } = await import("../services/promotionPricing.service");
    const { invalidateMarketplaceDiscoveryCaches } = await import("../services/clearCaches");
    await invalidateActiveProductPromosCache();
    await invalidateMarketplaceDiscoveryCaches();
  } catch {
    // Best-effort: TTLs bound staleness anyway.
  }
  return sendSuccess(res, { promo }, "Platform-wide promotion created", 201);
};

// PATCH /admin/promotions/:id — update promotion details (platform-wide only)
export const adminUpdatePromotion = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = ensureString(req.params.id);
  const promo = await prisma.promotion.findUnique({ where: { id } });
  if (!promo) throw new NotFoundError("Promotion");
  if (promo.vendorId !== null) {
    throw new ValidationError("Admins can only update platform-wide promotions");
  }

  const {
    name,
    description,
    type,
    value,
    maxDiscount,
    startsAt,
    expiresAt,
    usageLimit,
    maxUsesPerUser,
    minOrderAmount,
    isActive,
  } = req.body;

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (type !== undefined) {
    if (!Object.values(DiscountType).includes(type)) {
      throw new ValidationError("Invalid discount type");
    }
    updateData.type = type;
  }
  if (value !== undefined) {
    if (type === DiscountType.PERCENTAGE && value > 100) {
      throw new ValidationError("Percentage discount can't exceed 100");
    }
    updateData.value = value;
  }
  if (maxDiscount !== undefined) updateData.maxDiscount = maxDiscount;
  if (startsAt !== undefined) updateData.startsAt = startsAt ? new Date(startsAt) : null;
  if (expiresAt !== undefined) updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
  if (usageLimit !== undefined) updateData.usageLimit = usageLimit;
  if (maxUsesPerUser !== undefined) updateData.maxUsesPerUser = maxUsesPerUser;
  if (minOrderAmount !== undefined) updateData.minOrderAmount = minOrderAmount;
  if (isActive !== undefined) updateData.isActive = isActive;

  // Validate the final effective state (stored values fill in for fields
  // the request omits), reusing the same invariants as the vendor update
  // path: percentage cap applies to the promo's effective type, and date
  // ordering applies to the effective window.
  const effectiveType = (updateData.type as DiscountType) ?? promo.type;
  const effectiveValue =
    updateData.value !== undefined ? Number(updateData.value) : Number(promo.value);
  const effectiveStartsAt =
    updateData.startsAt !== undefined
      ? (updateData.startsAt as Date | null)
      : promo.startsAt;
  const effectiveExpiresAt =
    updateData.expiresAt !== undefined
      ? (updateData.expiresAt as Date | null)
      : promo.expiresAt;
  validatePromoDatesAndValue({
    type: effectiveType,
    value: effectiveValue,
    startsAt: effectiveStartsAt ?? undefined,
    expiresAt: effectiveExpiresAt ?? undefined,
  });

  // Same expiry guard as the dedicated reactivate path: an expired
  // promotion cannot be (or remain) active. Deactivation always works.
  const effectiveIsActive =
    updateData.isActive !== undefined ? Boolean(updateData.isActive) : promo.isActive;
  if (
    effectiveIsActive &&
    effectiveExpiresAt &&
    effectiveExpiresAt < new Date()
  ) {
    throw new ValidationError(
      "Expired promotions cannot be reactivated; create a new promotion instead",
    );
  }

  const updated = await prisma.promotion.update({
    where: { id },
    data: updateData,
  });

  await auditAdmin(req, "ADMIN_UPDATED_PROMOTION", {
    promotionId: id,
    code: promo.code,
    changes: updateData,
  });
  try {
    await invalidateActiveProductPromosCache();
    await invalidateMarketplaceDiscoveryCaches();
  } catch {
    // Best-effort: TTLs bound staleness anyway.
  }

  return sendSuccess(res, { promo: updated }, "Promotion updated");
};

// PATCH /admin/promotions/:id/deactivate
export const adminDeactivatePromotion = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = ensureString(req.params.id);
  const promo = await prisma.promotion.findUnique({ where: { id } });
  if (!promo) throw new NotFoundError("Promotion");

  const updated = await prisma.promotion.update({
    where: { id },
    data: { isActive: false },
  });
  await auditAdmin(req, "ADMIN_DEACTIVATED_PROMOTION", {
    promotionId: id,
    code: promo.code,
    vendorId: promo.vendorId,
  });
  // Discovery embeds resolved promotions — sweep so deactivation surfaces.
  try {
    await invalidateActiveProductPromosCache();
    await invalidateMarketplaceDiscoveryCaches();
  } catch {
    // Best-effort: TTLs bound staleness anyway.
  }

  return sendSuccess(res, { promo: updated }, "Promotion deactivated");
};

// PATCH /admin/promotions/:id/reactivate
export const adminReactivatePromotion = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = ensureString(req.params.id);
  const promo = await prisma.promotion.findUnique({ where: { id } });
  if (!promo) throw new NotFoundError("Promotion");

  if (promo.expiresAt && promo.expiresAt < new Date()) {
    throw new ValidationError("Expired promotions cannot be reactivated; create a new promotion instead");
  }

  const updated = await prisma.promotion.update({
    where: { id },
    data: { isActive: true },
  });

  await auditAdmin(req, "ADMIN_REACTIVATED_PROMOTION", {
    promotionId: id,
    code: promo.code,
    vendorId: promo.vendorId,
  });
  try {
    await invalidateActiveProductPromosCache();
    await invalidateMarketplaceDiscoveryCaches();
  } catch {
    // Best-effort: TTLs bound staleness anyway.
  }

  return sendSuccess(res, { promo: updated }, "Promotion reactivated");
};

// POST /admin/promotions/deactivate-all — bulk-deactivate every active
// promotion across the platform (all scopes, all vendors, not only SEED_*).
// Records are flipped to isActive=false, never deleted: historical
// redemptions, orders, payments and products are untouched. A single
// updateMany keeps the DB mutation atomic.
export const adminDeactivateAllPromotions = async (
  req: AuthRequest,
  res: Response,
) => {
  const result = await prisma.promotion.updateMany({
    where: { isActive: true },
    data: { isActive: false },
  });

  await auditAdmin(req, "ADMIN_DEACTIVATED_ALL_PROMOTIONS", {
    deactivatedCount: result.count,
  });

  // Discovery embeds resolved promotions — sweep so the customer feed stops
  // serving the old active list. Invalidation is best-effort, but unlike
  // single-promo mutations we report its outcome so the admin can tell
  // whether the feed may still serve stale data until TTLs expire.
  let cachesInvalidated = true;
  try {
    await invalidateActiveProductPromosCache();
    await invalidateMarketplaceDiscoveryCaches();
  } catch (err) {
    cachesInvalidated = false;
    logger.warn({ err }, "bulk promotion deactivation cache sweep failed");
  }

  return sendSuccess(
    res,
    {
      deactivatedCount: result.count,
      cachesInvalidated,
    },
    result.count === 0
      ? "No active promotions to deactivate"
      : `Deactivated ${result.count} promotion(s)`,
  );
};

// ==================== PRODUCTS ====================

// GET /admin/products
export const getAllProducts = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const search = req.query.search as string | undefined;
  const category = req.query.category as string | undefined;
  const vendorId = req.query.vendorId as string | undefined;
  const archived = req.query.archived as string | undefined;

  const where: Prisma.ProductWhereInput = {
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { description: { contains: search, mode: "insensitive" as const } },
      ],
    }),
    ...(category && { dishTypeId: category }),
    ...(vendorId && { vendorId }),
    ...(archived === "true" ? { archived: true } : archived === "false" ? { archived: false } : {}),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true, brandName: true, email: true } },
        dishType: { select: { id: true, name: true } },
        _count: { select: { reviews: true, orders: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.product.count({ where }),
  ]);

  return sendSuccess(res, { products }, "Products retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// GET /admin/products/:id
export const getProductById = async (req: Request, res: Response) => {
  const id = ensureString(req.params.id);
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      vendor: { select: { id: true, name: true, brandName: true, email: true, phoneNumber: true, isLive: true } },
      dishType: { select: { id: true, name: true } },
      options: { where: { isActive: true }, select: { id: true, name: true, price: true } },
      _count: { select: { reviews: true, orders: true } },
    },
  });
  if (!product) throw new NotFoundError("Product");
  return sendSuccess(res, { product }, "Product retrieved");
};

// PATCH /admin/products/:id
export const adminUpdateProduct = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const { name, description, price, dishTypeId, archived, trackInventory, stock, available } = req.body;

  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw new NotFoundError("Product");

  const updateData: Prisma.ProductUpdateInput = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (price !== undefined) updateData.price = Number(price);
  if (dishTypeId !== undefined) {
    // Category/DishType invariant: Product.categoryId must always equal
    // Product.dishType.categoryId. The authoritative value is
    // DishType.categoryId -- a client-supplied categoryId (req.body
    // has no such field plumbed through) can never override it.
    // Mirrors the vendor updateProduct path: same active-state rule,
    // then derive categoryId, then a single atomic Product update.
    await assertActiveDishType(dishTypeId);
    const targetDishType = await prisma.dishType.findUnique({
      where: { id: dishTypeId },
      select: { categoryId: true },
    });
    if (!targetDishType) throw new ValidationError("Invalid dish type.");
    updateData.dishType = { connect: { id: dishTypeId } };
    updateData.category = { connect: { id: targetDishType.categoryId } };
  }
  if (archived !== undefined) updateData.archived = Boolean(archived);
  if (trackInventory !== undefined) updateData.trackInventory = Boolean(trackInventory);
  if (stock !== undefined) updateData.stock = Number(stock);

  const updated = await prisma.product.update({
    where: { id },
    data: updateData,
    include: {
      vendor: { select: { id: true, name: true, brandName: true } },
      dishType: { select: { id: true, name: true } },
    },
  });

  await clearProductCache(id, updated.vendorId);
  await invalidateActiveProductPromosCache();
  await invalidateMarketplaceDiscoveryCaches();

  await auditAdmin(req, "ADMIN_UPDATED_PRODUCT", { productId: id, changes: updateData });
  return sendSuccess(res, { product: updated }, "Product updated");
};

// DELETE /admin/products/:id
export const adminDeleteProduct = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw new NotFoundError("Product");

  const hasOrderHistory = await prisma.orderItem.findFirst({ where: { productId: id } });
  if (hasOrderHistory) {
    throw new ConflictError("Product has order history and cannot be deleted — archive it instead");
  }

  // Admin deletion must protect customer carts just like the vendor path.
  const hasCartLines = await prisma.cartItem.findFirst({
    where: { productId: id },
    select: { id: true },
  });
  if (hasCartLines) {
    throw new ConflictError(
      "Product is in a customer's cart and cannot be deleted — archive it instead so customer carts are not changed",
    );
  }

  try {
    await prisma.product.delete({ where: { id } });
  } catch (err) {
    // The database RESTRICT constraint decides the race where a cart line is
    // created after the check. Prisma 6 reports that violation as a
    // PrismaClientUnknownRequestError carrying PostgreSQL SQLSTATE 23001;
    // only the expected product constraints become a 409.
    if (isForeignKeyConflictFor(err, PRODUCT_DELETE_FK_CONSTRAINTS)) {
      throw new ConflictError(
        "Product is still referenced by existing orders or customer carts and cannot be deleted — archive it instead",
      );
    }
    throw err;
  }
  await clearProductCache(id, product.vendorId);
  await clearProductFromCarts(id);
  await invalidateActiveProductPromosCache();
  await invalidateMarketplaceDiscoveryCaches();

  await auditAdmin(req, "ADMIN_DELETED_PRODUCT", { productId: id });
  return sendSuccess(res, {}, "Product deleted");
};

// ==================== TAXONOMY: CATEGORIES ====================

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derives a stable, uppercase taxonomy id from a display name, matching the
 * seed convention (e.g. "Rice Dishes" -> "RICE_DISHES", "Spicy" -> "SPICY").
 * Category, DishType and Tag ids are `@id` with no default, so the server
 * must supply one; clients never send ids.
 */
function taxonomyId(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/, "") || "ITEM";
}

const categoryCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .max(100)
    .regex(SLUG_PATTERN, "Slug must be lowercase and URL-safe (e.g. rice-dishes)"),
  icon: z.string().trim().max(500).optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

const categoryUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(SLUG_PATTERN, "Slug must be lowercase and URL-safe (e.g. rice-dishes)")
    .optional(),
  icon: z.string().trim().max(500).optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

/** POST /admin/categories — admin-only. Creates a new category. */
export const createCategory = async (req: AuthRequest, res: Response) => {
  const parsed = categoryCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid category input", parsed.error.flatten().fieldErrors);
  }
  const { name, slug, icon, sortOrder } = parsed.data;

  // Uniqueness pre-check for a clear client message; P2002 is the backstop.
  const existing = await prisma.category.findFirst({
    where: { OR: [{ name }, { slug }] },
    select: { id: true, name: true, slug: true },
  });
  if (existing) {
    throw new ConflictError(
      `A category with name "${existing.name}" or slug "${existing.slug}" already exists`,
    );
  }

  let category;
  try {
    category = await prisma.category.create({
      data: {
        id: taxonomyId(name),
        name,
        slug,
        ...(icon !== undefined && { icon: icon === "" ? null : icon }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
    });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ConflictError("A category with this name or slug already exists");
    }
    throw error;
  }

  await clearCategoryCache(category.id);
  await invalidateMarketplaceDiscoveryCaches();
  await auditAdmin(req, "ADMIN_CREATED_CATEGORY", {
    categoryId: category.id,
    name,
    slug,
  });

  return sendCreated(res, { category }, "Category created");
};

/** PATCH /admin/categories/:id — admin-only. Updates permitted category fields. */
export const updateCategory = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const parsed = categoryUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid category input", parsed.error.flatten().fieldErrors);
  }

  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Category");

  const updateData: Prisma.CategoryUpdateInput = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.slug !== undefined) updateData.slug = parsed.data.slug;
  if (parsed.data.icon !== undefined) {
    updateData.icon = parsed.data.icon === "" ? null : parsed.data.icon;
  }
  if (parsed.data.sortOrder !== undefined) updateData.sortOrder = parsed.data.sortOrder;

  let updated;
  try {
    updated = await prisma.category.update({ where: { id }, data: updateData });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ConflictError("A category with this name or slug already exists");
    }
    throw error;
  }

  await clearCategoryCache(id);
  await invalidateMarketplaceDiscoveryCaches();
  await auditAdmin(req, "ADMIN_UPDATED_CATEGORY", { categoryId: id, changes: updateData });

  return sendSuccess(res, { category: updated }, "Category updated");
};

/** PATCH /admin/categories/:id/deactivate — admin-only. Soft-deactivates a category. */
export const deactivateCategory = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Category");

  const updated = await prisma.category.update({
    where: { id },
    data: { isActive: false },
  });

  await clearCategoryCache(id);
  await invalidateMarketplaceDiscoveryCaches();
  await auditAdmin(req, "ADMIN_DEACTIVATED_CATEGORY", {
    categoryId: id,
    name: category.name,
  });

  return sendSuccess(res, { category: updated }, "Category deactivated");
};

// ==================== TAXONOMY: DISH TYPES ====================

const dishTypeCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(1000).optional().nullable(),
  imageUrl: z.string().trim().max(500).optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  categoryId: z.string().trim().min(1, "Category is required"),
});

const dishTypeUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  imageUrl: z.string().trim().max(500).optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  categoryId: z.string().trim().min(1).optional(),
});

/** POST /admin/dish-types — admin-only. Creates a new dish type under a category. */
export const createDishType = async (req: AuthRequest, res: Response) => {
  const parsed = dishTypeCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid dish type input", parsed.error.flatten().fieldErrors);
  }
  const { name, description, imageUrl, sortOrder, categoryId } = parsed.data;

  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });
  if (!category) throw new ValidationError("Invalid category reference.");

  let dishType;
  try {
    dishType = await prisma.dishType.create({
      data: {
        id: taxonomyId(name),
        name,
        ...(description !== undefined && { description: description === "" ? null : description }),
        ...(imageUrl !== undefined && {
          imageUrl: imageUrl === "" ? null : imageUrl,
        }),
        ...(sortOrder !== undefined && { sortOrder }),
        category: { connect: { id: categoryId } },
      },
    });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ConflictError("A dish type with this name already exists");
    }
    throw error;
  }

  await clearDishTypeCache(dishType.id);
  await invalidateMarketplaceDiscoveryCaches();
  await auditAdmin(req, "ADMIN_CREATED_DISH_TYPE", {
    dishTypeId: dishType.id,
    name,
    categoryId,
  });

  return sendCreated(res, { dishType }, "Dish type created");
};

/** PATCH /admin/dish-types/:id — admin-only. Updates permitted dish type fields. */
export const updateDishType = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const parsed = dishTypeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid dish type input", parsed.error.flatten().fieldErrors);
  }

  const dishType = await prisma.dishType.findUnique({ where: { id } });
  if (!dishType) throw new NotFoundError("Dish type");

  const updateData: Prisma.DishTypeUpdateInput = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.description !== undefined) {
    updateData.description = parsed.data.description === "" ? null : parsed.data.description;
  }
  if (parsed.data.imageUrl !== undefined) {
    updateData.imageUrl = parsed.data.imageUrl === "" ? null : parsed.data.imageUrl;
  }
  if (parsed.data.sortOrder !== undefined) updateData.sortOrder = parsed.data.sortOrder;
  let categoryChanged = false;
  if (parsed.data.categoryId !== undefined) {
    const category = await prisma.category.findUnique({
      where: { id: parsed.data.categoryId },
      select: { id: true },
    });
    if (!category) throw new ValidationError("Invalid category reference.");
    updateData.category = { connect: { id: parsed.data.categoryId } };
    categoryChanged = parsed.data.categoryId !== dishType.categoryId;
  }

  let updated;
  try {
    updated = await prisma.dishType.update({ where: { id }, data: updateData });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ConflictError("A dish type with this name already exists");
    }
    throw error;
  }

  await clearDishTypeCache(id);
  if (categoryChanged) {
    await invalidateProductsByDishTypeCategoryChange(id);
  }
  await invalidateMarketplaceDiscoveryCaches();
  await auditAdmin(req, "ADMIN_UPDATED_DISH_TYPE", {
    dishTypeId: id,
    changes: updateData,
  });

  return sendSuccess(res, { dishType: updated }, "Dish type updated");
};

/** PATCH /admin/dish-types/:id/deactivate — admin-only. Soft-deactivates a dish type. */
export const deactivateDishType = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const dishType = await prisma.dishType.findUnique({ where: { id } });
  if (!dishType) throw new NotFoundError("Dish type");

  const updated = await prisma.dishType.update({
    where: { id },
    data: { isActive: false },
  });

  await clearDishTypeCache(id);
  await invalidateMarketplaceDiscoveryCaches();
  await auditAdmin(req, "ADMIN_DEACTIVATED_DISH_TYPE", {
    dishTypeId: id,
    name: dishType.name,
  });

  return sendSuccess(res, { dishType: updated }, "Dish type deactivated");
};

// ==================== TAXONOMY: TAGS ====================

const tagCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  type: z.enum(["CUISINE", "DIET", "OCCASION"]),
});

const tagUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: z.enum(["CUISINE", "DIET", "OCCASION"]).optional(),
});

/** POST /admin/tags — admin-only. Creates a new tag. */
export const createTag = async (req: AuthRequest, res: Response) => {
  const parsed = tagCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid tag input", parsed.error.flatten().fieldErrors);
  }
  const { name, type } = parsed.data;

  const existing = await prisma.tag.findFirst({
    where: { name },
    select: { id: true, name: true },
  });
  if (existing) {
    throw new ConflictError(`A tag named "${existing.name}" already exists`);
  }

  let tag;
  try {
    tag = await prisma.tag.create({
      data: {
        id: taxonomyId(name),
        name,
        type,
      },
    });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ConflictError("A tag with this name already exists");
    }
    throw error;
  }

  // Phase 2B.6: a tag change alters the tag list itself and every cached
  // payload that embeds tag objects, so the tag-specific helper is used
  // instead of the generic discovery sweep (which does not cover `tags:all` or
  // product-detail payloads). The helper never throws: a Redis outage must not
  // turn this committed mutation into a failed response.
  const tagCache = await clearTagCache(tag.id);
  if (!tagCache.ok) {
    logger.warn(
      { tagId: tag.id, failures: tagCache.failures },
      "Tag cache invalidation partially failed; the tag list may be served stale until its TTL expires",
    );
  }
  await auditAdmin(req, "ADMIN_CREATED_TAG", { tagId: tag.id, name, type });

  return sendCreated(res, { tag }, "Tag created");
};

/** PATCH /admin/tags/:id — admin-only. Updates permitted tag fields. */
export const updateTag = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const parsed = tagUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid tag input", parsed.error.flatten().fieldErrors);
  }

  const tag = await prisma.tag.findUnique({ where: { id } });
  if (!tag) throw new NotFoundError("Tag");

  const updateData: Prisma.TagUpdateInput = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.type !== undefined) updateData.type = parsed.data.type;

  let updated;
  try {
    updated = await prisma.tag.update({ where: { id }, data: updateData });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ConflictError("A tag with this name already exists");
    }
    throw error;
  }

  // Phase 2B.6: a rename changes every cached payload that embeds the old tag
  // name, plus the tag list itself. The helper never throws — see createTag.
  const tagCache = await clearTagCache(id);
  if (!tagCache.ok) {
    logger.warn(
      { tagId: id, failures: tagCache.failures },
      "Tag cache invalidation partially failed; the tag list may be served stale until its TTL expires",
    );
  }
  await auditAdmin(req, "ADMIN_UPDATED_TAG", { tagId: id, changes: updateData });

  return sendSuccess(res, { tag: updated }, "Tag updated");
};

/** PATCH /admin/tags/:id/deactivate — admin-only. Soft-deactivates a tag. */
export const deactivateTag = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const tag = await prisma.tag.findUnique({ where: { id } });
  if (!tag) throw new NotFoundError("Tag");

  const updated = await prisma.tag.update({
    where: { id },
    data: { isActive: false },
  });

  // Phase 2B.6: deactivating a tag removes it from the active tag list and
  // from every tag-filtered browse result. The helper never throws — see
  // createTag.
  const tagCache = await clearTagCache(tag.id);
  if (!tagCache.ok) {
    logger.warn(
      { tagId: tag.id, failures: tagCache.failures },
      "Tag cache invalidation partially failed; the tag list may be served stale until its TTL expires",
    );
  }
  await auditAdmin(req, "ADMIN_DEACTIVATED_TAG", { tagId: id, name: tag.name });

  return sendSuccess(res, { tag: updated }, "Tag deactivated");
};

/**
 * Returns true when `error` is a Prisma unique-constraint violation (P2002).
 * Used to convert duplicate name/slug writes into controlled ConflictError
 * responses instead of unhandled 500s.
 */
function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

// ==================== DISHTYPE SUGGESTIONS (PHASE 2A.2) ====================

/**
 * Vendors propose new DishTypes for admin approval.
 *
 * The CategorySuggestion model already models the full workflow:
 *   vendorId  -> submitter (server-set, never client-controlled)
 *   suggestedName / suggestedCategoryId -> the proposal
 *   status    -> PENDING / APPROVED / REJECTED (default PENDING)
 *   approvedDishTypeId -> @unique link to the canonical DishType on approval
 *   reviewedByAdminId / reviewedAt / adminNote -> moderation trace
 *
 * No schema change is required; all fields exist. Only HTTP endpoints are
 * added here, plus admin taxonomy management (2A.1) already exists.
 */

const dishTypeSuggestionCreateSchema = z.object({
  suggestedName: z.string().trim().min(1, "Name is required").max(100),
  suggestedCategoryId: z.string().trim().min(1, "Category is required"),
});

const suggestionModerationSchema = z.object({
  adminNote: z.string().trim().max(1000).optional().nullable(),
});

/**
 * POST /api/vendor/suggestions — vendor submit a new DishType suggestion.
 *
 * Mounted on the vendor router (authenticate + authorizeVendor). The submitter
 * is always req.user.id (server-side); the client may not supply an owner.
 * requireVendorNotSuspended is applied to this write route by the router.
 */
export const createDishTypeSuggestion = async (
  req: AuthRequest,
  res: Response,
) => {
  const parsed = dishTypeSuggestionCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid suggestion input",
      parsed.error.flatten().fieldErrors,
    );
  }
  const { suggestedName, suggestedCategoryId } = parsed.data;
  const vendorId = req.user!.id;

  // The referenced category must exist (matches createDishType convention:
  // existence, not isActive, is the gate).
  const category = await prisma.category.findUnique({
    where: { id: suggestedCategoryId },
    select: { id: true },
  });
  if (!category) throw new ValidationError("Invalid category reference.");

  // Duplicate pending suggestion: same vendor, same name, same category.
  const existingPending = await prisma.categorySuggestion.findFirst({
    where: {
      vendorId,
      suggestedName,
      suggestedCategoryId,
      status: SuggestionStatus.PENDING,
    },
    select: { id: true },
  });
  if (existingPending) {
    throw new ConflictError(
      "You already have a pending suggestion for this dish type.",
    );
  }

  // Duplicate official dish type: name is @unique on DishType.
  const existingDishType = await prisma.dishType.findFirst({
    where: { name: suggestedName },
    select: { id: true },
  });
  if (existingDishType) {
    throw new ConflictError("A dish type with this name already exists.");
  }

  const suggestion = await prisma.categorySuggestion.create({
    data: {
      vendorId,
      suggestedName,
      suggestedCategoryId,
      status: SuggestionStatus.PENDING,
    },
  });

  return sendCreated(res, { suggestion }, "Dish type suggestion submitted");
};

/**
 * GET /api/vendor/suggestions — vendor views only their own suggestions.
 */
export const getMyDishTypeSuggestions = async (
  req: AuthRequest,
  res: Response,
) => {
  const vendorId = req.user!.id;
  const { page, limit, skip } = getPagination(req);
  const status = req.query.status as SuggestionStatus | undefined;

  const where: Prisma.CategorySuggestionWhereInput = { vendorId };
  if (status) where.status = status;

  const [suggestions, total] = await Promise.all([
    prisma.categorySuggestion.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        suggestedCategory: { select: { id: true, name: true } },
        approvedDishType: { select: { id: true, name: true } },
      },
    }),
    prisma.categorySuggestion.count({ where }),
  ]);

  return sendSuccess(
    res,
    { suggestions },
    "Suggestions retrieved",
    200,
    { page, limit, total, totalPages: Math.ceil(total / limit) },
  );
};

/**
 * GET /api/admin/suggestions — admin lists suggestions for moderation.
 */
export const listDishTypeSuggestions = async (
  req: AuthRequest,
  res: Response,
) => {
  const { page, limit, skip } = getPagination(req);
  const status = req.query.status as SuggestionStatus | undefined;
  const vendorId = req.query.vendorId
    ? ensureString(req.query.vendorId)
    : undefined;

  const where: Prisma.CategorySuggestionWhereInput = {};
  if (status) where.status = status;
  if (vendorId) where.vendorId = vendorId;

  const [suggestions, total] = await Promise.all([
    prisma.categorySuggestion.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        vendor: { select: { id: true, name: true } },
        suggestedCategory: { select: { id: true, name: true } },
        approvedDishType: { select: { id: true, name: true } },
        reviewedByAdmin: { select: { id: true, name: true } },
      },
    }),
    prisma.categorySuggestion.count({ where }),
  ]);

  return sendSuccess(
    res,
    { suggestions },
    "Suggestions retrieved",
    200,
    { page, limit, total, totalPages: Math.ceil(total / limit) },
  );
};

/**
 * GET /api/admin/suggestions/:id — admin retrieves a suggestion for moderation.
 */
export const getDishTypeSuggestion = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = ensureString(req.params.id);
  const suggestion = await prisma.categorySuggestion.findUnique({
    where: { id },
    include: {
      vendor: { select: { id: true, name: true } },
      suggestedCategory: { select: { id: true, name: true } },
      approvedDishType: { select: { id: true, name: true } },
      reviewedByAdmin: { select: { id: true, name: true } },
    },
  });
  if (!suggestion) throw new NotFoundError("Suggestion");
  return sendSuccess(res, { suggestion }, "Suggestion retrieved");
};

/**
 * PATCH /api/admin/suggestions/:id/approve — admin approves a pending suggestion.
 *
 * Runs in a single Prisma transaction: re-fetch + status check (only PENDING
 * may be approved), create the canonical DishType (stable id via taxonomyId),
 * then mark the suggestion APPROVED and link it via approvedDishTypeId.
 * The @unique constraints (DishType.id, DishType.name,
 * CategorySuggestion.approvedDishTypeId) are the concurrency backstop: any
 * duplicate official type surfaces P2002, which is converted to ConflictError
 * and rolls the transaction back, leaving the suggestion PENDING.
 */
export const approveDishTypeSuggestion = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = ensureString(req.params.id);
  const parsed = suggestionModerationSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid moderation input",
      parsed.error.flatten().fieldErrors,
    );
  }
  const adminId = req.user!.id;
  const { adminNote } = parsed.data;

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const suggestion = await tx.categorySuggestion.findUnique({
        where: { id },
      });
      if (!suggestion) throw new NotFoundError("Suggestion");
      if (suggestion.status !== SuggestionStatus.PENDING) {
        throw new ConflictError(
          `This suggestion has already been ${suggestion.status.toLowerCase()}.`,
        );
      }

      // No duplicate official dish type (name @unique is the backstop).
      const existing = await tx.dishType.findFirst({
        where: { name: suggestion.suggestedName },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError(
          "A dish type with this name already exists.",
        );
      }

      const dishType = await tx.dishType.create({
        data: {
          id: taxonomyId(suggestion.suggestedName),
          name: suggestion.suggestedName,
          categoryId: suggestion.suggestedCategoryId,
          isActive: true,
        },
      });

      // Conditional transition: only a still-PENDING suggestion may be
      // approved. `updateMany` accepts non-unique where fields (unlike
      // `update`, whose where is limited to unique fields) and returns the
      // matched count, so a concurrent moderator that already flipped the
      // status matches zero rows and we abort the transaction, rolling back
      // the DishType creation above.
      const updateResult = await tx.categorySuggestion.updateMany({
        where: { id, status: SuggestionStatus.PENDING },
        data: {
          status: SuggestionStatus.APPROVED,
          approvedDishTypeId: dishType.id,
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
          ...(adminNote !== undefined && {
            adminNote: adminNote === "" ? null : adminNote,
          }),
        },
      });
      if (updateResult.count === 0) {
        throw new ConflictError(
          "This suggestion has already been moderated.",
        );
      }

      const updated = await tx.categorySuggestion.findUnique({
        where: { id },
      });
      return { suggestion: updated, dishType };
    });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ConflictError("A dish type with this name already exists.");
    }
    throw error;
  }

  await clearDishTypeCache(result.dishType.id);
  await invalidateMarketplaceDiscoveryCaches();
  await auditAdmin(req, "ADMIN_APPROVED_DISH_TYPE_SUGGESTION", {
    suggestionId: id,
    dishTypeId: result.dishType.id,
    name: result.dishType.name,
    categoryId: result.dishType.categoryId,
  });

  return sendSuccess(
    res,
    { suggestion: result.suggestion, dishType: result.dishType },
    "Dish type suggestion approved",
  );
};

/**
 * PATCH /api/admin/suggestions/:id/reject — admin rejects a pending suggestion.
 *
 * Applies only to PENDING suggestions. Preserves the suggestion record
 * (traceability); does not create or modify any DishType or product. Records
 * the outcome and reviewer via existing fields (adminNote, reviewedByAdminId,
 * reviewedAt).
 */
export const rejectDishTypeSuggestion = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = ensureString(req.params.id);
  const parsed = suggestionModerationSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid moderation input",
      parsed.error.flatten().fieldErrors,
    );
  }
  const adminId = req.user!.id;
  const { adminNote } = parsed.data;

  // Conditional transition: only a still-PENDING suggestion may be rejected.
  // `updateMany` accepts non-unique where fields and returns the matched
  // count, so a concurrent approver that already flipped the status matches
  // zero rows and we report a conflict instead of overwriting their decision.
  const updateResult = await prisma.categorySuggestion.updateMany({
    where: { id, status: SuggestionStatus.PENDING },
    data: {
      status: SuggestionStatus.REJECTED,
      reviewedByAdminId: adminId,
      reviewedAt: new Date(),
      ...(adminNote !== undefined && {
        adminNote: adminNote === "" ? null : adminNote,
      }),
    },
  });

  if (updateResult.count === 0) {
    // Either the suggestion does not exist, or it was already moderated.
    const existing = await prisma.categorySuggestion.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundError("Suggestion");
    throw new ConflictError(
      `This suggestion has already been ${existing.status.toLowerCase()}.`,
    );
  }

  const updated = await prisma.categorySuggestion.findUnique({
    where: { id },
  });

  await auditAdmin(req, "ADMIN_REJECTED_DISH_TYPE_SUGGESTION", {
    suggestionId: id,
    name: updated?.suggestedName,
    reason: adminNote,
  });

  return sendSuccess(res, { suggestion: updated }, "Dish type suggestion rejected");
};

// ==================== VENDOR DETAIL ====================

// GET /admin/vendors/:id
export const getVendorById = async (req: Request, res: Response) => {
  const id = ensureString(req.params.id);
  const vendor = await prisma.user.findFirst({
    where: { id, roles: { has: Role.VENDOR } },
    select: {
      id: true,
      name: true,
      email: true,
      phoneNumber: true,
      brandName: true,
      brandLogo: true,
      kycStatus: true,
      roles: true,
      vendorStatus: true,
      vendorStatusReason: true,
      vendorStatusChangedAt: true,
      isBlocked: true,
      blockedReason: true,
      blockedAt: true,
      commissionRate: true,
      isLive: true,
      isEmailVerified: true,
      createdAt: true,
      _count: { select: { products: true, vendorOrders: true, followers: true } },
    },
  });
  if (!vendor) throw new NotFoundError("Vendor");

  // Get products
  const products = await prisma.product.findMany({
    where: { vendorId: id },
    select: {
      id: true,
      name: true,
      price: true,
      stock: true,
      trackInventory: true,
      archived: true,
      averageRating: true,
      dishType: { select: { id: true, name: true } },
      _count: { select: { reviews: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Get recent orders
  const orders = await prisma.order.findMany({
    where: { vendorId: id },
    include: {
      customer: { select: { id: true, name: true, phoneNumber: true } },
      items: { include: { product: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  // Get stats
  const [totalRevenueAgg, totalOrders, completedOrders, avgRatingAgg] = await Promise.all([
    prisma.order.aggregate({
      where: { vendorId: id, status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.SUCCESS },
      _sum: { totalPrice: true },
    }),
    prisma.order.count({ where: { vendorId: id } }),
    prisma.order.count({ where: { vendorId: id, status: OrderStatus.COMPLETED } }),
    prisma.productReview.aggregate({
      where: { product: { vendorId: id } },
      _avg: { rating: true },
    }),
  ]);

  // Monthly revenue (last 12 months)
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const monthlyRevenueRaw = await prisma.order.groupBy({
    by: ["createdAt"],
    where: {
      vendorId: id,
      status: OrderStatus.COMPLETED,
      paymentStatus: PaymentStatus.SUCCESS,
      createdAt: { gte: twelveMonthsAgo },
    },
    _sum: { totalPrice: true },
  });
  // Group by month
  const monthlyMap = new Map<string, number>();
  monthlyRevenueRaw.forEach((r) => {
    const month = r.createdAt.toISOString().slice(0, 7); // YYYY-MM
    monthlyMap.set(month, (monthlyMap.get(month) || 0) + Number(r._sum.totalPrice || 0));
  });
  const monthlyRevenue = Array.from(monthlyMap.entries())
    .map(([month, revenue]) => ({ month, revenue }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Status breakdown
  const statusBreakdown = await prisma.order.groupBy({
    by: ["status"],
    where: { vendorId: id },
    _count: { id: true },
  });

  // Recent reviews
  const recentReviews = await prisma.productReview.findMany({
    where: { product: { vendorId: id } },
    include: {
      customer: { select: { id: true, name: true } },
      product: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const stats = {
    totalRevenue: totalRevenueAgg._sum.totalPrice || 0,
    totalOrders,
    totalProducts: vendor._count.products,
    followers: vendor._count.followers,
    avgRating: avgRatingAgg._avg.rating || 0,
  };

  return sendSuccess(res, { vendor, products, orders, stats, monthlyRevenue, statusBreakdown, recentReviews }, "Vendor retrieved");
};

// ==================== TODAY'S ORDERS ====================

// GET /admin/orders/today
export const getTodaysOrders = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const status = req.query.status as OrderStatus | undefined;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const where: Prisma.OrderWhereInput = {
    createdAt: { gte: startOfDay, lte: endOfDay },
    ...(status && { status }),
  };

  const [orders, total, totals] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, phoneNumber: true } },
        vendor: { select: { id: true, name: true, brandName: true } },
        items: { include: { product: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.order.count({ where }),
    prisma.order.groupBy({
      by: ["status"],
      where: { createdAt: { gte: startOfDay, lte: endOfDay } },
      _count: { id: true },
      _sum: { totalPrice: true },
    }),
  ]);

  const totalOrders = totals.reduce((sum, t) => sum + Number(t._count.id), 0);
  const totalRevenue = totals.reduce((sum, t) => sum + Number(t._sum.totalPrice || 0), 0);

  return sendSuccess(
    res,
    { orders, totals, totalOrders, totalRevenue },
    "Today's orders retrieved",
    200,
    {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  );
};

// ==================== GROWTH ANALYTICS ====================

// GET /admin/growth?period=monthly&year=2024
export const getGrowthAnalytics = async (req: Request, res: Response) => {
  const period = (req.query.period as "daily" | "weekly" | "monthly" | "yearly") || "monthly";
  const year = Number(req.query.year) || new Date().getFullYear();

  const startOfYear = new Date(year, 0, 1);
  const endOfYear = new Date(year + 1, 0, 1);

  const [revenue, orders, users, products] = await Promise.all([
    getTimeSeriesData("revenue", period, startOfYear, endOfYear),
    getTimeSeriesData("orders", period, startOfYear, endOfYear),
    getTimeSeriesData("users", period, startOfYear, endOfYear),
    getTimeSeriesData("products", period, startOfYear, endOfYear),
  ]);

  // Category breakdown (orders by dish type)
  const categoryBreakdownRaw = await prisma.$queryRaw<Array<{ dish_type_id: string; count: bigint; revenue: bigint }>>`
    SELECT p."dishTypeId" as dish_type_id, COUNT(DISTINCT o.id) as "count", COALESCE(SUM(o."totalPrice"), 0) as revenue
    FROM "Order" o
    JOIN "OrderItem" oi ON oi."orderId" = o.id
    JOIN "Product" p ON p.id = oi."productId"
    WHERE o."createdAt" >= ${startOfYear} AND o."createdAt" < ${endOfYear}
      AND o.status = ${OrderStatus.COMPLETED}::"OrderStatus"
      AND o."paymentStatus" = ${PaymentStatus.SUCCESS}::"PaymentStatus"
    GROUP BY p."dishTypeId"
  `;

  const dishTypeIds = categoryBreakdownRaw.map((c) => c.dish_type_id).filter(Boolean);
  const dishTypes = await prisma.dishType.findMany({
    where: { id: { in: dishTypeIds } },
    select: { id: true, name: true },
  });
  const dishTypeMap = new Map(dishTypes.map((d) => [d.id, d.name]));
  const categoryData = categoryBreakdownRaw.map((c) => ({
    category: dishTypeMap.get(c.dish_type_id) || c.dish_type_id || "Unknown",
    count: Number(c.count),
    revenue: Number(c.revenue),
  }));

  // Status breakdown
  const statusBreakdown = await prisma.order.groupBy({
    by: ["status"],
    where: { createdAt: { gte: startOfYear, lt: endOfYear } },
    _count: { id: true },
  });

  return sendSuccess(res, {
    revenue,
    orders,
    users,
    products,
    categoryBreakdown: categoryData,
    statusBreakdown,
  }, "Growth analytics retrieved");
};

async function getTimeSeriesData(
  type: "revenue" | "orders" | "users" | "products",
  period: "daily" | "weekly" | "monthly" | "yearly",
  start: Date,
  end: Date,
) {
  if (type === "revenue") {
    const data = await prisma.order.groupBy({
      by: ["createdAt"],
      where: { status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.SUCCESS, createdAt: { gte: start, lt: end } },
      _sum: { totalPrice: true },
    });
    return groupByPeriod(data.map((d) => ({ date: d.createdAt, value: Number(d._sum.totalPrice || 0) })), period);
  }
  if (type === "orders") {
    const data = await prisma.order.groupBy({
      by: ["createdAt"],
      where: { createdAt: { gte: start, lt: end } },
      _count: { id: true },
    });
    return groupByPeriod(data.map((d) => ({ date: d.createdAt, value: d._count.id })), period);
  }
  if (type === "users") {
    const data = await prisma.user.groupBy({
      by: ["createdAt"],
      where: { createdAt: { gte: start, lt: end } },
      _count: { id: true },
    });
    return groupByPeriod(data.map((d) => ({ date: d.createdAt, value: d._count.id })), period);
  }
  if (type === "products") {
    const data = await prisma.product.groupBy({
      by: ["createdAt"],
      where: { createdAt: { gte: start, lt: end } },
      _count: { id: true },
    });
    return groupByPeriod(data.map((d) => ({ date: d.createdAt, value: d._count.id })), period);
  }
  return [];
}

function groupByPeriod(
  data: { date: Date; value: number }[],
  period: "daily" | "weekly" | "monthly" | "yearly",
) {
  const map = new Map<string, { period: string; value: number }>();
  for (const d of data) {
    let key: string;
    const date = new Date(d.date);
    if (period === "daily") {
      key = date.toISOString().slice(0, 10);
    } else if (period === "weekly") {
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      key = weekStart.toISOString().slice(0, 10);
    } else if (period === "monthly") {
      key = date.toISOString().slice(0, 7);
    } else {
      key = date.getFullYear().toString();
    }
    const existing = map.get(key) || { period: key, value: 0 };
    existing.value += d.value;
    map.set(key, existing);
  }
  return Array.from(map.values()).sort((a, b) => a.period.localeCompare(b.period));
}

// ==================== KPIS ====================

// GET /admin/kpis
export const getKpis = async (_req: Request, res: Response) => {
  const [
    totalRevenue,
    lastThirtyDaysRevenue,
    totalOrders,
    completedOrders,
    avgOrderValue,
    totalCustomers,
    newCustomers30d,
    repeatCustomers,
    topCategoryAgg,
    avgPlatformRating,
  ] = await Promise.all([
    prisma.order.aggregate({
      where: { status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.SUCCESS },
      _sum: { totalPrice: true },
    }),
    prisma.order.aggregate({
      where: {
        status: OrderStatus.COMPLETED,
        paymentStatus: PaymentStatus.SUCCESS,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _sum: { totalPrice: true },
    }),
    prisma.order.count(),
    prisma.order.count({ where: { status: OrderStatus.COMPLETED } }),
    prisma.order.aggregate({
      where: { status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.SUCCESS },
      _avg: { totalPrice: true },
    }),
    prisma.user.count({ where: { roles: { has: Role.CUSTOMER } } }),
    prisma.user.count({
      where: { roles: { has: Role.CUSTOMER }, createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    }),
    prisma.user.count({
      where: { roles: { has: Role.CUSTOMER }, customerOrders: { some: { status: OrderStatus.COMPLETED } } },
    }),
    prisma.$queryRaw<Array<{ dish_type_id: string; count: bigint }>>`
      SELECT p."dishTypeId" as dish_type_id, COUNT(DISTINCT o.id) as "count"
      FROM "Order" o
      JOIN "OrderItem" oi ON oi."orderId" = o.id
      JOIN "Product" p ON p.id = oi."productId"
      WHERE o.status = ${OrderStatus.COMPLETED}::"OrderStatus"
        AND o."paymentStatus" = ${PaymentStatus.SUCCESS}::"PaymentStatus"
      GROUP BY p."dishTypeId"
      ORDER BY "count" DESC
      LIMIT 1
    `,
    prisma.productReview.aggregate({ _avg: { rating: true } }),
  ]);

  const topCategoryId = topCategoryAgg[0]?.dish_type_id;
  let topCategory = "—";
  if (topCategoryId) {
    const dt = await prisma.dishType.findUnique({ where: { id: topCategoryId }, select: { name: true } });
    topCategory = dt?.name || "—";
  }

  const completionRate = totalOrders > 0 ? Math.round((completedOrders / totalOrders) * 100) : 0;

  return sendSuccess(res, {
    revenue: { total: totalRevenue._sum.totalPrice || 0, lastThirtyDays: lastThirtyDaysRevenue._sum.totalPrice || 0 },
    orders: { total: totalOrders, avgValue: avgOrderValue._avg.totalPrice || 0 },
    completionRate,
    users: { totalCustomers, newLastThirtyDays: newCustomers30d, repeatCustomers },
    product: { topCategory, avgPlatformRating: avgPlatformRating._avg.rating || 0 },
  }, "KPIs retrieved");
};

// ==================== REVIEWS ====================

// GET /admin/reviews
export const getAllReviews = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req);
  const rating = req.query.rating ? Number(req.query.rating) : undefined;

  const where: Prisma.ProductReviewWhereInput = {
    ...(rating && { rating }),
  };

  const [reviews, total] = await Promise.all([
    prisma.productReview.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, email: true } },
        product: { select: { id: true, name: true, vendorId: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.productReview.count({ where }),
  ]);

  return sendSuccess(res, { reviews }, "Reviews retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
};

// PATCH /admin/reviews/:id — action: "hide" | "delete"
// DELETE /admin/reviews/:id — same as action=delete
export const adminModerateReview = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const action = req.method === "DELETE" ? "delete" : (req.body as { action?: "hide" | "delete" }).action;
  if (!action || !["hide", "delete"].includes(action)) {
    throw new ValidationError("action must be 'hide' or 'delete'");
  }

  const review = await prisma.productReview.findUnique({ where: { id } });
  if (!review) throw new NotFoundError("Review");

  if (action === "delete") {
    await prisma.productReview.delete({ where: { id } });
    await auditAdmin(req, "ADMIN_DELETED_REVIEW", { reviewId: id });
    return sendSuccess(res, {}, "Review deleted");
  }

  // For "hide", we could add a moderation status field, but for now just delete
  // since the schema doesn't have a hidden field. Alternatively, we could
  // mark it as not verifiedPurchase or add a moderation flag in the future.
  await prisma.productReview.update({
    where: { id },
    data: { verifiedPurchase: false },
  });
  await auditAdmin(req, "ADMIN_HIDDEN_REVIEW", { reviewId: id });
  return sendSuccess(res, { id }, "Review hidden (unverified)");
};

// ==================== ACTIVITY ====================

// GET /admin/activity
export const getActivity = async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  
  const activities = await prisma.activity.findMany({
    include: {
      vendor: { select: { id: true, name: true, brandName: true } },
      customer: { select: { id: true, name: true } },
      order: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return sendSuccess(res, activities, "Activity feed retrieved");
};

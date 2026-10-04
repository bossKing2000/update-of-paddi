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
} from "@prisma/client";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import { ensureString } from "../utils/paramUtils";
import { sendSuccess } from "../utils/apiResponse";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  UpstreamServiceError,
} from "../errors/AppError";
import { createAuditLog } from "../utils/auditLog.service";
import { deleteAllUserSessions } from "../lib/session";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { refundPaymentViaPaystack, classifyRefundSubmitError } from "../services/refundService";
import { failRefund } from "../services/refundFinalizer.service";
import {
  createTransferRecipient,
  initiateTransfer,
} from "../services/payoutService";
import { calculatePayoutAmounts } from "./vendorDashboard.service";
import { validatePromoDatesAndValue } from "./promoController";
import { logger } from "../lib/logger";
import { encrypt, decrypt } from "../utils/encrypt";
import { invalidateActiveProductPromosCache } from "../services/promotionPricing.service";
import { invalidateMarketplaceDiscoveryCaches } from "../services/clearCaches";
import { clearProductCache } from "../services/clearCaches";

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

  const [vendors, total] = await Promise.all([
    prisma.user.findMany({
      where: { roles: { has: Role.VENDOR } },
      select: {
        id: true,
        name: true,
        email: true,
        brandName: true,
        brandLogo: true,
        kycStatus: true,
        isBlocked: true,
        commissionRate: true,
        createdAt: true,
        _count: { select: { products: true, vendorOrders: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.user.count({ where: { roles: { has: Role.VENDOR } } }),
  ]);

  return sendSuccess(res, { vendors }, "Vendors retrieved", 200, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
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

  const updated = await prisma.order.update({
    where: { id },
    data: { status },
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

    const refundAmountNaira = amount ? Number(amount) : undefined;
    if (
      refundAmountNaira !== undefined &&
      (isNaN(refundAmountNaira) || refundAmountNaira <= 0)
    ) {
      throw new ValidationError("Invalid refund amount");
    }
    const requestedKobo = refundAmountNaira ? Math.round(refundAmountNaira * 100) : undefined;

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
      reservedKobo = requestedKobo ?? remaining;
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
      await tx.refundRequest.update({
        where: { id },
        data: {
          status: RefundStatus.PROCESSING,
          adminNote: adminNote ?? refundRequest.adminNote,
          resolvedByAdminId: req.user!.id,
          resolvedAt: new Date(),
          requestedAmountKobo: reservedKobo,
        },
      });
    });

    let paystackResult;
    try {
      paystackResult = await refundPaymentViaPaystack(refundRequest.paymentRef, requestedKobo);
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
  const vendorsWithEligibleOrders = await prisma.order.groupBy({
    by: ["vendorId"],
    where: {
      status: OrderStatus.COMPLETED,
      paymentStatus: PaymentStatus.SUCCESS,
      payoutId: null,
    },
    _sum: { totalPrice: true, deliveryFee: true },
    _count: { id: true },
  });

  const vendorIds = vendorsWithEligibleOrders.map((v) => v.vendorId);
  const vendors = await prisma.user.findMany({
    where: { id: { in: vendorIds } },
    select: {
      id: true,
      name: true,
      brandName: true,
      commissionRate: true,
      bankName: true,
      bankAccountNumber: true,
    },
  });

  const pending = vendorsWithEligibleOrders.map((v) => {
    const vendor = vendors.find((x) => x.id === v.vendorId);
    const { grossRevenue, commission, netAvailable } = calculatePayoutAmounts(
      [
        {
          totalPrice: v._sum.totalPrice || 0,
          deliveryFee: v._sum.deliveryFee || 0,
        },
      ],
      vendor?.commissionRate ?? 0.15,
    );
    return {
      vendorId: v.vendorId,
      vendorName: vendor?.brandName || vendor?.name,
      orderCount: v._count.id,
      grossRevenue,
      commission,
      netAmount: netAvailable,
      bankOnFile: !!(vendor?.bankName && vendor?.bankAccountNumber),
    };
  });

  return sendSuccess(res, { pending }, "Pending payouts retrieved");
};

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
) {
  if (!vendor.bankName || !vendor.bankAccountNumber || !vendor.bankCode) {
    await auditAdmin(req, "ADMIN_PROCESSED_PAYOUT_MANUAL", {
      payoutId: payout.id,
      vendorId: vendor.id,
      amount: payout.amount,
    });
    return payout;
  }

  const reference = payout.reference || `vendor_payout_${payout.id}`;
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
      amountNaira: payout.amount,
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
    if (err?.details?.retryable === false) {
      await prisma.vendorPayout.updateMany({
        where: { id: payout.id, status: PayoutStatus.PROCESSING },
        data: {
          status: PayoutStatus.FAILED,
          failureReason: String(err.message).slice(0, 500),
        },
      });
      await auditAdmin(req, "ADMIN_PAYOUT_TRANSFER_FAILED", {
        payoutId: payout.id,
        vendorId: vendor.id,
        reference,
      });
      throw new UpstreamServiceError(
        "Paystack",
        "Payout transfer failed; correct the payout details and retry.",
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
    );
  }
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

  if (payoutId) {
    const payout = await prisma.vendorPayout.findUnique({
      where: { id: payoutId },
      include: { vendor: true, _count: { select: { orders: true } } },
    });
    if (!payout) throw new NotFoundError("Payout");
    if (payout.status !== PayoutStatus.FAILED)
      throw new ConflictError("Only failed payouts can be retried");
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

  const payout = await prisma.$transaction(
    async (tx) => {
      const eligibleOrders = await tx.order.findMany({
        where: {
          vendorId: vendor.id,
          status: OrderStatus.COMPLETED,
          paymentStatus: PaymentStatus.SUCCESS,
          payoutId: null,
        },
        select: {
          id: true,
          totalPrice: true,
          deliveryFee: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      });
      if (eligibleOrders.length === 0)
        throw new ValidationError(
          "This vendor has no eligible orders to pay out",
        );
      const { grossRevenue, commission, netAvailable } = calculatePayoutAmounts(
        eligibleOrders,
        vendor.commissionRate,
      );
      if (netAvailable <= 0)
        throw new ValidationError("Payout amount must be greater than zero");
      const periodStart = eligibleOrders[0].createdAt;
      const periodEnd = eligibleOrders[eligibleOrders.length - 1].createdAt;
      const created = await tx.vendorPayout.create({
        data: {
          vendorId: vendor.id,
          grossRevenue,
          commission,
          amount: netAvailable,
          orderCount: eligibleOrders.length,
          periodStart,
          periodEnd,
          status: PayoutStatus.PENDING,
        },
      });
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
      return created;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  const updated = await initiateVendorPayoutTransfer(
    req,
    payout,
    vendor,
    payout.orderCount,
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
  if (dishTypeId !== undefined) updateData.dishType = { connect: { id: dishTypeId } };
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

  await prisma.product.delete({ where: { id } });
  await clearProductCache(id, product.vendorId);
  await invalidateActiveProductPromosCache();
  await invalidateMarketplaceDiscoveryCaches();

  await auditAdmin(req, "ADMIN_DELETED_PRODUCT", { productId: id });
  return sendSuccess(res, {}, "Product deleted");
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

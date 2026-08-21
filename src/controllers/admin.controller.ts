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
import { refundPaymentViaPaystack } from "../services/refundService";
import {
  createTransferRecipient,
  initiateTransfer,
} from "../services/payoutService";
import { calculatePayoutAmounts } from "./vendorDashboard.service";
import { logger } from "../lib/logger";

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
  const [
    totalUsers,
    totalVendors,
    totalCustomers,
    totalDrivers,
    totalOrders,
    completedOrders,
    revenueAgg,
    pendingKyc,
    pendingRefunds,
    reportedReviews,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: Role.VENDOR } }),
    prisma.user.count({ where: { role: Role.CUSTOMER } }),
    prisma.user.count({ where: { role: Role.DELIVERY } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: OrderStatus.COMPLETED } }),
    prisma.order.aggregate({
      where: { status: OrderStatus.COMPLETED },
      _sum: { totalPrice: true },
    }),
    prisma.user.count({
      where: {
        kycStatus: KycStatus.PENDING,
        role: { in: [Role.VENDOR, Role.DELIVERY] },
      },
    }),
    prisma.refundRequest.count({ where: { status: RefundStatus.PENDING } }),
    prisma.reviewReport.count({
      where: { status: ReviewReportStatus.PENDING },
    }),
  ]);

  return sendSuccess(
    res,
    {
      users: {
        total: totalUsers,
        vendors: totalVendors,
        customers: totalCustomers,
        drivers: totalDrivers,
      },
      orders: { total: totalOrders, completed: completedOrders },
      revenue: { allTime: revenueAgg._sum.totalPrice || 0 },
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
    ...(role && { role }),
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

  const user = await prisma.user.update({ where: { id }, data: { role } });
  await auditAdmin(req, "ADMIN_SET_USER_ROLE", {
    targetUserId: id,
    newRole: role,
  });

  return sendSuccess(
    res,
    { id: user.id, role: user.role },
    "User role updated",
  );
};

// PATCH /admin/users/:id/kyc-status
export const setKycStatus = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const { kycStatus } = req.body as { kycStatus?: KycStatus };
  if (!kycStatus || !Object.values(KycStatus).includes(kycStatus))
    throw new ValidationError("Invalid kycStatus");

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
      where: { role: Role.VENDOR },
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
    prisma.user.count({ where: { role: Role.VENDOR } }),
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
    select: { role: true },
  });
  if (!vendor || vendor.role !== Role.VENDOR) throw new NotFoundError("Vendor");

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
  const [payments, total] = await Promise.all([
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
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);

  return sendSuccess(res, { payments }, "Payments retrieved", 200, {
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

  if (status === RefundStatus.COMPLETED) {
    if (refundRequest.status !== RefundStatus.APPROVED) {
      throw new ConflictError(
        "Refund must be APPROVED before it can be completed",
      );
    }

    const payment = await prisma.payment.findUnique({
      where: { reference: refundRequest.paymentRef },
    });
    if (!payment) throw new NotFoundError("Payment for this refund request");

    // Idempotency: don't call Paystack a second time if this payment was
    // somehow already refunded (a retried request, two admins acting on
    // the same refund, etc.)
    if (payment.status === PaymentStatus.REFUNDED) {
      const already = await prisma.refundRequest.update({
        where: { id },
        data: {
          status: RefundStatus.COMPLETED,
          resolvedByAdminId: req.user!.id,
          resolvedAt: new Date(),
        },
      });
      return sendSuccess(
        res,
        { already },
        "Payment was already refunded — request marked completed",
      );
    }
    if (payment.status !== PaymentStatus.SUCCESS) {
      throw new ConflictError(
        `Cannot refund a payment with status ${payment.status}`,
      );
    }

    const refundAmountNaira = amount ? Number(amount) : undefined;
    if (
      refundAmountNaira !== undefined &&
      (isNaN(refundAmountNaira) ||
        refundAmountNaira <= 0 ||
        refundAmountNaira * 100 > payment.amount)
    ) {
      throw new ValidationError("Invalid refund amount");
    }

    let paystackResult;
    try {
      paystackResult = await refundPaymentViaPaystack(
        refundRequest.paymentRef,
        refundAmountNaira ? Math.round(refundAmountNaira * 100) : undefined,
      );
    } catch (err: any) {
      logger.error(
        { err: err?.response?.data || err.message, refundRequestId: id },
        "Paystack refund failed",
      );
      // Deliberately don't change any status here — the request stays
      // APPROVED so an admin can retry, instead of silently drifting into
      // a state that claims money moved when it didn't.
      throw new UpstreamServiceError(
        "Paystack",
        "Refund failed — no records were changed. You can retry.",
      );
    }

    // Money actually moved — now update our records to match. Covers
    // every order sharing this payment's idempotencyKey (a multi-vendor
    // checkout batch), not just a single order.
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.REFUNDED },
      });

      const affectedOrders = payment.idempotencyKey
        ? await tx.order.findMany({
            where: { idempotencyKey: payment.idempotencyKey },
          })
        : [{ id: payment.orderId }];

      await tx.order.updateMany({
        where: { id: { in: affectedOrders.map((o) => o.id) } },
        data: {
          paymentStatus: PaymentStatus.REFUNDED,
          status: OrderStatus.CANCELLED,
          cancellationReason: "REFUNDED",
          cancelledAt: new Date(),
        },
      });

      await tx.refundRequest.update({
        where: { id },
        data: {
          status: RefundStatus.COMPLETED,
          resolvedByAdminId: req.user!.id,
          resolvedAt: new Date(),
        },
      });
    });

    await auditAdmin(req, "ADMIN_REFUND_COMPLETED", {
      refundRequestId: id,
      paystackReference: refundRequest.paymentRef,
      paystackResult,
    });

    return sendSuccess(res, {}, "Refund completed successfully");
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
        accountNumber: vendor.bankAccountNumber,
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
  if (!vendor || vendor.role !== Role.VENDOR) throw new NotFoundError("Vendor");

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
  return sendSuccess(res, { promo }, "Platform-wide promotion created", 201);
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

  return sendSuccess(res, { promo: updated }, "Promotion deactivated");
};

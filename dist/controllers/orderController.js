"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rejectSpecialRequest = exports.rejectSpecialOffer = exports.acceptSpecialOffer = exports.createSpecialOffer = exports.getMySpecialRequests = exports.createSpecialRequest = exports.getVendorReport = exports.getCustomerOrderStats = exports.getVendorOrderStats = exports.updateOrderStatus = exports.getSingleOrder = exports.getMyOrders = void 0;
exports.bucketByDay = bucketByDay;
const uuid_1 = require("uuid");
const prisma_1 = __importDefault(require("../lib/prisma"));
const client_1 = require("@prisma/client");
const dayjs_1 = __importDefault(require("dayjs"));
const recordActivityBundle_1 = require("../utils/activityUtils/recordActivityBundle");
const notify_1 = require("../utils/activityUtils/notify");
const paramUtils_1 = require("../utils/paramUtils");
const clearCaches_1 = require("../services/clearCaches");
const apiResponse_1 = require("../utils/apiResponse");
const AppError_1 = require("../errors/AppError");
const orderSchema_1 = require("../validations/orderSchema");
const deliveryFee_service_1 = require("../services/deliveryFee.service");
const referralController_1 = require("./referralController");
const logger_1 = require("../lib/logger");
const round = (v) => Number(v.toFixed(2));
// Groups a flat list of {createdAt, totalPrice} rows into day buckets.
// Used instead of Prisma's `groupBy({ by: ["createdAt"] })`, which groups
// by the exact millisecond timestamp and therefore never actually
// aggregates anything by day — every row lands in its own group. This was
// silently broken in the customer order-stats trend chart before.
function bucketByDay(rows, days) {
    const buckets = new Map();
    for (const d of days)
        buckets.set(d, { count: 0, revenue: 0 });
    for (const row of rows) {
        const key = row.createdAt.toISOString().slice(0, 10);
        const bucket = buckets.get(key);
        if (bucket) {
            bucket.count += 1;
            bucket.revenue += row.totalPrice ?? 0;
        }
    }
    return days.map((date) => ({ date, ...buckets.get(date) }));
}
// GET /orders - list the current user's orders (as customer or vendor)
const getMyOrders = async (req, res) => {
    const userId = req.user.id;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;
    const status = req.query.status;
    const paymentStatus = req.query.paymentStatus;
    const where = {
        OR: [{ customerId: userId }, { vendorId: userId }],
        ...(status && { status: status }),
        ...(paymentStatus && { paymentStatus: paymentStatus }),
    };
    const [orders, total] = await Promise.all([
        prisma_1.default.order.findMany({
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
                                isLive: true,
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
        prisma_1.default.order.count({ where }),
    ]);
    const totalPages = Math.ceil(total / limit);
    return (0, apiResponse_1.sendSuccess)(res, { orders }, "Orders retrieved successfully", 200, {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
    });
};
exports.getMyOrders = getMyOrders;
// GET /orders/:orderId - single order detail
const getSingleOrder = async (req, res) => {
    const orderId = (0, paramUtils_1.ensureString)(req.params.orderId);
    const userId = req.user.id;
    const order = await prisma_1.default.order.findUnique({
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
    if (!order)
        throw new AppError_1.NotFoundError("Order");
    if (order.customerId !== userId && order.vendorId !== userId) {
        throw new AppError_1.ForbiddenError("You don't have access to this order");
    }
    return (0, apiResponse_1.sendSuccess)(res, { order }, "Order retrieved successfully");
};
exports.getSingleOrder = getSingleOrder;
// PATCH /orders/vendor/order/:orderId/update-status
const updateOrderStatus = async (req, res) => {
    const orderId = (0, paramUtils_1.ensureString)(req.params.orderId);
    const userId = req.user.id;
    const userRole = req.user.role;
    const parsed = orderSchema_1.updateOrderStatusSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid or missing order status", parsed.error.flatten().fieldErrors);
    const { status } = parsed.data;
    const order = await prisma_1.default.order.findUnique({ where: { id: orderId } });
    if (!order)
        throw new AppError_1.NotFoundError("Order");
    const isVendor = userId === order.vendorId;
    const isCustomer = userId === order.customerId;
    if (!isVendor && !isCustomer)
        throw new AppError_1.ForbiddenError("Unauthorized user");
    const currentStatus = order.status;
    // Expired orders are dead ends — nothing can change their status through
    // this endpoint. Give a clear, specific message rather than falling
    // through to a generic "invalid transition" error.
    if (currentStatus === client_1.OrderStatus.PAYMENT_EXPIRED ||
        currentStatus === client_1.OrderStatus.CANCELLED_UNPAID) {
        throw new AppError_1.ConflictError("This order has expired and can no longer be modified. Please place a new order.");
    }
    // These statuses are exclusively system/webhook-controlled — no human
    // should ever be able to set them directly through this endpoint.
    const SYSTEM_CONTROLLED = [
        client_1.OrderStatus.PENDING,
        client_1.OrderStatus.WAITING_VENDOR_CONFIRMATION,
        client_1.OrderStatus.WAITING_CUSTOMER_APPROVAL,
        client_1.OrderStatus.AWAITING_PAYMENT,
        client_1.OrderStatus.PAYMENT_CONFIRMED,
        client_1.OrderStatus.PAYMENT_EXPIRED,
        client_1.OrderStatus.CANCELLED_UNPAID,
    ];
    if (SYSTEM_CONTROLLED.includes(status)) {
        throw new AppError_1.ForbiddenError("This status is controlled automatically by the system, not set manually");
    }
    // Vendor drives the cooking/pickup/delivery lifecycle. Completion is
    // confirmed by the CUSTOMER (not the vendor) — this protects the
    // customer from an order being marked "delivered" when it wasn't.
    //
    // Note: once the Delivery domain is built, driver-driven status changes
    // will go through their own dedicated endpoint (matching how
    // DeliveryAssignment already works) rather than this generic one, to
    // avoid two independent paths writing Order.status with no cross-sync.
    const transitions = {
        COOKING: { from: [client_1.OrderStatus.PAYMENT_CONFIRMED], roles: [client_1.Role.VENDOR] },
        READY_FOR_PICKUP: { from: [client_1.OrderStatus.COOKING], roles: [client_1.Role.VENDOR] },
        OUT_FOR_DELIVERY: {
            from: [client_1.OrderStatus.READY_FOR_PICKUP],
            roles: [client_1.Role.VENDOR],
        },
        COMPLETED: { from: [client_1.OrderStatus.OUT_FOR_DELIVERY], roles: [client_1.Role.CUSTOMER] },
        CANCELLED: {
            from: [
                client_1.OrderStatus.AWAITING_PAYMENT,
                client_1.OrderStatus.PAYMENT_CONFIRMED,
                client_1.OrderStatus.COOKING,
                client_1.OrderStatus.READY_FOR_PICKUP,
                client_1.OrderStatus.OUT_FOR_DELIVERY,
            ],
            roles: [client_1.Role.CUSTOMER, client_1.Role.VENDOR],
        },
        FAILED_DELIVERY: {
            from: [client_1.OrderStatus.OUT_FOR_DELIVERY],
            roles: [client_1.Role.VENDOR],
        },
    };
    const rule = transitions[status];
    if (!rule)
        throw new AppError_1.ValidationError("This status change is not allowed");
    if (!rule.from.includes(currentStatus))
        throw new AppError_1.ConflictError(`Cannot transition from ${currentStatus} to ${status}`);
    if (!rule.roles.includes(userRole))
        throw new AppError_1.ForbiddenError("You cannot perform this action");
    // Payment gate — checked against the dedicated paymentStatus field, not
    // the workflow `status` field. (A previous version of this check
    // compared against `status === PAYMENT_CONFIRMED`, which breaks once the
    // order legitimately moves on to COOKING/READY_FOR_PICKUP/etc. — by then
    // status is no longer PAYMENT_CONFIRMED even though the order is still
    // paid. paymentStatus stays SUCCESS throughout, which is what this
    // actually needs to check.)
    const requiresPayment = [
        client_1.OrderStatus.COOKING,
        client_1.OrderStatus.READY_FOR_PICKUP,
        client_1.OrderStatus.OUT_FOR_DELIVERY,
        client_1.OrderStatus.COMPLETED,
    ];
    if (requiresPayment.includes(status) && order.paymentStatus !== "SUCCESS") {
        throw new AppError_1.ConflictError("Order must be paid before proceeding");
    }
    const updateData = { status };
    if (status === client_1.OrderStatus.CANCELLED) {
        updateData.cancelledAt = new Date();
        updateData.cancellationReason = isVendor
            ? "VENDOR_REJECTED"
            : "USER_CANCELLED";
    }
    const updatedOrder = await prisma_1.default.order.update({
        where: { id: orderId },
        data: updateData,
    });
    await (0, clearCaches_1.clearProductCache)(undefined, order.vendorId);
    // Referrals: check (and credit, if eligible) once an order actually
    // completes — the referred customer's *first* completed order is what
    // triggers a reward for whoever referred them.
    if (status === client_1.OrderStatus.COMPLETED) {
        (0, referralController_1.creditReferralRewardIfEligible)(order.customerId, orderId).catch((err) => logger_1.logger.warn({ err, orderId, customerId: order.customerId }, "Failed to check/credit referral reward"));
    }
    const recipientId = isVendor ? order.customerId : order.vendorId;
    await (0, recordActivityBundle_1.recordActivityBundle)({
        actorId: userId,
        orderId,
        actions: [
            {
                type: client_1.ActivityType.GENERAL,
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
    return (0, apiResponse_1.sendSuccess)(res, { order: updatedOrder }, `Order status updated to ${status}`);
};
exports.updateOrderStatus = updateOrderStatus;
// GET /orders/vendor/stats
const getVendorOrderStats = async (req, res) => {
    const vendorId = req.user.id;
    const [totalOrders, completedOrders, pendingOrders, inProgressOrders, awaitingApprovalOrders, totalRevenueObj,] = await Promise.all([
        prisma_1.default.order.count({ where: { vendorId } }),
        prisma_1.default.order.count({ where: { vendorId, status: client_1.OrderStatus.COMPLETED } }),
        prisma_1.default.order.count({ where: { vendorId, status: client_1.OrderStatus.PENDING } }),
        prisma_1.default.order.count({
            where: {
                vendorId,
                status: {
                    in: [
                        client_1.OrderStatus.COOKING,
                        client_1.OrderStatus.READY_FOR_PICKUP,
                        client_1.OrderStatus.OUT_FOR_DELIVERY,
                    ],
                },
            },
        }),
        prisma_1.default.order.count({
            where: { vendorId, status: client_1.OrderStatus.WAITING_CUSTOMER_APPROVAL },
        }),
        prisma_1.default.order.aggregate({
            _sum: { totalPrice: true },
            where: { vendorId, status: client_1.OrderStatus.COMPLETED },
        }),
    ]);
    return (0, apiResponse_1.sendSuccess)(res, {
        summary: {
            totalOrders,
            completedOrders,
            pendingOrders,
            inProgressOrders,
            awaitingApprovalOrders,
            totalRevenue: totalRevenueObj._sum.totalPrice ?? 0,
        },
        metadata: { vendorId, lastUpdated: new Date().toISOString() },
    }, "Vendor order stats retrieved successfully");
};
exports.getVendorOrderStats = getVendorOrderStats;
// GET /orders/customer/stats
const getCustomerOrderStats = async (req, res) => {
    const customerId = req.user.id;
    const today = new Date();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(today.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const last7Days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(sevenDaysAgo);
        d.setDate(sevenDaysAgo.getDate() + i);
        return d.toISOString().slice(0, 10);
    });
    const [totalOrders, completedOrders, pendingOrders, inProgressOrders, awaitingPaymentOrders, totalSpentObj, recentOrders,] = await Promise.all([
        prisma_1.default.order.count({ where: { customerId } }),
        prisma_1.default.order.count({
            where: { customerId, status: client_1.OrderStatus.COMPLETED },
        }),
        prisma_1.default.order.count({ where: { customerId, status: client_1.OrderStatus.PENDING } }),
        prisma_1.default.order.count({
            where: {
                customerId,
                status: {
                    in: [
                        client_1.OrderStatus.COOKING,
                        client_1.OrderStatus.READY_FOR_PICKUP,
                        client_1.OrderStatus.OUT_FOR_DELIVERY,
                    ],
                },
            },
        }),
        prisma_1.default.order.count({
            where: { customerId, status: client_1.OrderStatus.AWAITING_PAYMENT },
        }),
        prisma_1.default.order.aggregate({
            _sum: { totalPrice: true },
            where: { customerId, status: client_1.OrderStatus.COMPLETED },
        }),
        // Single range query, bucketed by day in JS below — replaces a
        // groupBy(createdAt) that never actually grouped anything (see
        // bucketByDay's comment for why).
        prisma_1.default.order.findMany({
            where: { customerId, createdAt: { gte: sevenDaysAgo, lte: today } },
            select: { createdAt: true, totalPrice: true },
        }),
    ]);
    return (0, apiResponse_1.sendSuccess)(res, {
        totalOrders,
        completedOrders,
        pendingOrders,
        inProgressOrders,
        awaitingPaymentOrders,
        totalSpent: totalSpentObj._sum.totalPrice ?? 0,
        last7DaysOrders: bucketByDay(recentOrders, last7Days).map(({ date, count }) => ({ date, orders: count })),
    }, "Customer order stats retrieved successfully");
};
exports.getCustomerOrderStats = getCustomerOrderStats;
// GET /orders/vendor/report
const getVendorReport = async (req, res) => {
    const vendorId = req.user.id;
    const now = (0, dayjs_1.default)();
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
    const getStatsFromDate = (from) => prisma_1.default.order.aggregate({
        where: {
            vendorId,
            createdAt: { gte: from },
            status: client_1.OrderStatus.COMPLETED,
        },
        _count: { id: true },
        _sum: { totalPrice: true },
    });
    const [revenueAgg, totalOrders, completedOrders, itemsSoldAgg, todayAgg, weekAgg, monthAgg, yearAgg, last7DaysRows, topProductsAgg,] = await Promise.all([
        prisma_1.default.order.aggregate({
            _sum: { totalPrice: true },
            where: { vendorId, status: client_1.OrderStatus.COMPLETED },
        }),
        prisma_1.default.order.count({ where: { vendorId } }),
        prisma_1.default.order.count({ where: { vendorId, status: client_1.OrderStatus.COMPLETED } }),
        prisma_1.default.orderItem.aggregate({
            _sum: { quantity: true },
            where: { order: { vendorId, status: client_1.OrderStatus.COMPLETED } },
        }),
        getStatsFromDate(startOfToday),
        getStatsFromDate(startOfWeek),
        getStatsFromDate(startOfMonth),
        getStatsFromDate(startOfYear),
        // One range query instead of 7 separate day-by-day queries.
        prisma_1.default.order.findMany({
            where: {
                vendorId,
                status: client_1.OrderStatus.COMPLETED,
                createdAt: { gte: sevenDaysAgo },
            },
            select: { createdAt: true, totalPrice: true },
        }),
        prisma_1.default.orderItem.groupBy({
            by: ["productId"],
            where: { order: { vendorId, status: client_1.OrderStatus.COMPLETED } },
            _sum: { quantity: true, subtotal: true },
            orderBy: { _sum: { quantity: "desc" } },
            take: 5,
        }),
    ]);
    const totalRevenue = revenueAgg._sum.totalPrice ?? 0;
    const totalItemsSold = itemsSoldAgg._sum.quantity ?? 0;
    const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const toStats = (agg) => ({
        orders: agg._count.id,
        revenue: agg._sum.totalPrice ?? 0,
    });
    const last7Days = Array.from({ length: 7 }, (_, i) => now.subtract(6 - i, "day").format("YYYY-MM-DD"));
    const daily = bucketByDay(last7DaysRows, last7Days);
    const productDetails = await prisma_1.default.product.findMany({
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
    return (0, apiResponse_1.sendSuccess)(res, {
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
    }, "Vendor report retrieved successfully");
};
exports.getVendorReport = getVendorReport;
// ─────────────────────────────────────────────────────────────────────────
// SPECIAL ORDERS — a customer requests a custom quantity/version of a
// product, vendors bid with an offer (price + note), customer accepts one.
//
// NOTE: this logic already existed in the codebase but was never actually
// wired into any route — completely unreachable. It's wired up for real
// as part of this pass (see orderRouter.ts).
// ─────────────────────────────────────────────────────────────────────────
// POST /orders/special-requests — customer creates a request
const createSpecialRequest = async (req, res) => {
    const userId = req.user.id;
    const parsed = orderSchema_1.createSpecialRequestSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid special request", parsed.error.flatten().fieldErrors);
    const { productId, quantity, details } = parsed.data;
    const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
    if (!product)
        throw new AppError_1.NotFoundError("Product");
    const request = await prisma_1.default.specialOrderRequest.create({
        data: { customerId: userId, productId, quantity, message: details },
    });
    return (0, apiResponse_1.sendCreated)(res, { request }, "Special request created");
};
exports.createSpecialRequest = createSpecialRequest;
// GET /orders/special-requests — current customer's request history and vendor offers
const getMySpecialRequests = async (req, res) => {
    const userId = req.user.id;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const skip = (page - 1) * limit;
    const status = req.query.status;
    const where = {
        customerId: userId,
        ...(status ? { status: status } : {}),
    };
    const [requests, total] = await Promise.all([
        prisma_1.default.specialOrderRequest.findMany({
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
                        category: true,
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
        prisma_1.default.specialOrderRequest.count({ where }),
    ]);
    const totalPages = Math.ceil(total / limit);
    return (0, apiResponse_1.sendSuccess)(res, { requests }, "Special requests retrieved", 200, {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
    });
};
exports.getMySpecialRequests = getMySpecialRequests;
// POST /orders/special-requests/:requestId/offers — vendor bids on a request
const createSpecialOffer = async (req, res) => {
    const vendorId = req.user.id;
    const requestId = (0, paramUtils_1.ensureString)(req.params.requestId);
    const parsed = orderSchema_1.createSpecialOfferSchema.safeParse(req.body);
    if (!parsed.success)
        throw new AppError_1.ValidationError("Invalid offer", parsed.error.flatten().fieldErrors);
    const { price, message } = parsed.data;
    const request = await prisma_1.default.specialOrderRequest.findUnique({
        where: { id: requestId },
    });
    if (!request)
        throw new AppError_1.NotFoundError("Special request");
    if (request.status === "ACCEPTED" ||
        request.status === "CANCELLED" ||
        request.status === "REJECTED") {
        throw new AppError_1.ConflictError("This request is no longer open for offers");
    }
    const offer = await prisma_1.default.specialOrderOffer.create({
        data: { requestId, vendorId, price, message },
    });
    await prisma_1.default.specialOrderRequest.update({
        where: { id: requestId },
        data: { status: "OFFER_MADE" },
    });
    // Previously the customer was never told a vendor had responded to
    // their request at all — they'd have had to keep polling manually.
    await (0, notify_1.sendNotification)({
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
    return (0, apiResponse_1.sendCreated)(res, { offer }, "Offer created");
};
exports.createSpecialOffer = createSpecialOffer;
// PATCH /orders/special-offers/:offerId/accept — customer accepts one offer
const acceptSpecialOffer = async (req, res) => {
    const offerId = (0, paramUtils_1.ensureString)(req.params.offerId);
    const userId = req.user.id;
    const { addressId } = req.body;
    if (!addressId)
        throw new AppError_1.ValidationError("addressId is required");
    const offer = await prisma_1.default.specialOrderOffer.findUnique({
        where: { id: offerId },
        include: { request: true },
    });
    if (!offer)
        throw new AppError_1.NotFoundError("Offer");
    if (offer.request.customerId !== userId)
        throw new AppError_1.ForbiddenError("This isn't your request");
    if (offer.request.status !== "OFFER_MADE")
        throw new AppError_1.ConflictError("This offer can no longer be accepted");
    const address = await prisma_1.default.address.findFirst({
        where: { id: addressId, userId },
    });
    if (!address)
        throw new AppError_1.NotFoundError("Address");
    const deliveryFeeResult = await (0, deliveryFee_service_1.calculateDeliveryFee)(offer.vendorId, addressId, offer.price);
    if (!deliveryFeeResult.withinRange) {
        throw new AppError_1.ValidationError(`This vendor is outside the delivery range for your address (${deliveryFeeResult.distanceKm}km away).`);
    }
    const [, , acceptedOffer, order] = await prisma_1.default.$transaction([
        prisma_1.default.specialOrderOffer.updateMany({
            where: { requestId: offer.requestId, id: { not: offerId } },
            data: { status: "REJECTED" },
        }),
        prisma_1.default.specialOrderRequest.update({
            where: { id: offer.requestId },
            data: { status: "ACCEPTED" },
        }),
        prisma_1.default.specialOrderOffer.update({
            where: { id: offerId },
            data: { status: "ACCEPTED" },
        }),
        prisma_1.default.order.create({
            data: {
                customerId: userId,
                vendorId: offer.vendorId,
                addressId,
                basePrice: offer.price,
                deliveryFee: deliveryFeeResult.fee,
                totalPrice: round(offer.price + deliveryFeeResult.fee),
                status: client_1.OrderStatus.AWAITING_PAYMENT,
                specialOrderOfferId: offer.id,
                idempotencyKey: (0, uuid_1.v4)(),
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
    await (0, recordActivityBundle_1.recordActivityBundle)({
        actorId: userId,
        orderId: order.id,
        actions: [
            {
                type: client_1.ActivityType.GENERAL,
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
    return (0, apiResponse_1.sendCreated)(res, { order, offer: acceptedOffer }, "Offer accepted and order created");
};
exports.acceptSpecialOffer = acceptSpecialOffer;
// PATCH /orders/special-offers/:offerId/reject — customer declines one vendor offer
const rejectSpecialOffer = async (req, res) => {
    const offerId = (0, paramUtils_1.ensureString)(req.params.offerId);
    const userId = req.user.id;
    const offer = await prisma_1.default.specialOrderOffer.findUnique({
        where: { id: offerId },
        include: { request: true },
    });
    if (!offer)
        throw new AppError_1.NotFoundError("Offer");
    if (offer.request.customerId !== userId)
        throw new AppError_1.ForbiddenError("This isn't your request");
    if (offer.request.status === "ACCEPTED" ||
        offer.request.status === "REJECTED" ||
        offer.request.status === "CANCELLED") {
        throw new AppError_1.ConflictError("This request is no longer open for offer decisions");
    }
    if (offer.status !== "PENDING")
        throw new AppError_1.ConflictError("This offer has already been decided");
    const [, pendingCount] = await prisma_1.default.$transaction([
        prisma_1.default.specialOrderOffer.update({
            where: { id: offerId },
            data: { status: "REJECTED" },
        }),
        prisma_1.default.specialOrderOffer.count({
            where: {
                requestId: offer.requestId,
                status: "PENDING",
                id: { not: offerId },
            },
        }),
    ]);
    if (pendingCount === 0) {
        await prisma_1.default.specialOrderRequest.update({
            where: { id: offer.requestId },
            data: { status: "REJECTED" },
        });
    }
    await (0, notify_1.sendNotification)({
        userId: offer.vendorId,
        title: "Special offer declined",
        message: "A customer declined your special-order offer.",
        type: "GENERAL",
        metadata: { offerId, requestId: offer.requestId },
    });
    return (0, apiResponse_1.sendSuccess)(res, { offerId, requestId: offer.requestId, requestClosed: pendingCount === 0 }, "Offer declined");
};
exports.rejectSpecialOffer = rejectSpecialOffer;
// PATCH /orders/special-requests/:requestId/reject — customer rejects all offers
const rejectSpecialRequest = async (req, res) => {
    const requestId = (0, paramUtils_1.ensureString)(req.params.requestId);
    const userId = req.user.id;
    const request = await prisma_1.default.specialOrderRequest.findUnique({
        where: { id: requestId },
        include: { offers: true },
    });
    if (!request)
        throw new AppError_1.NotFoundError("Special request");
    if (request.customerId !== userId)
        throw new AppError_1.ForbiddenError("This isn't your request");
    await prisma_1.default.$transaction([
        prisma_1.default.specialOrderRequest.update({
            where: { id: requestId },
            data: { status: "REJECTED" },
        }),
        prisma_1.default.specialOrderOffer.updateMany({
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
        await Promise.all(pendingOfferVendorIds.map((vendorId) => (0, notify_1.sendNotification)({
            userId: vendorId,
            title: "Special request closed",
            message: "The customer chose a different offer for their special request.",
            type: "GENERAL",
            metadata: { requestId },
        })));
    }
    return (0, apiResponse_1.sendSuccess)(res, {}, "Special request rejected");
};
exports.rejectSpecialRequest = rejectSpecialRequest;

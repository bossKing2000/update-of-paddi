"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.markAllNotificationsAsRead = exports.markNotificationAsRead = exports.getMyNotifications = exports.getVendorReport = exports.getCustomerOrderStats = exports.getVendorOrderStats = exports.updateOrderStatus = exports.rejectSpecialRequest = exports.acceptSpecialOffer = exports.createSpecialOffer = exports.createSpecialRequest = exports.createNormalOrder = exports.getSingleOrder = exports.getMyOrders = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const client_1 = require("@prisma/client");
const dayjs_1 = __importDefault(require("dayjs"));
const recordActivityBundle_1 = require("../utils/activityUtils/recordActivityBundle");
const redis_1 = require("../lib/redis");
const socket_1 = require("../socket");
const codeMessage_1 = require("../validators/codeMessage");
const time_1 = require("../utils/time");
const zod_1 = require("zod");
// export const vendorRespondToSpecialRequest = async (
//   req: AuthRequest,
//   res: Response
// ): Promise<void> => {
//   try {
//     const { orderId } = req.params;
//     const { vendorNote, extraCharge } = req.body;
//     // 1️⃣ Fetch order
//     const order = await prisma.order.findUnique({
//       where: { id: orderId },
//       include: { items: true },
//     });
//     if (!order || order.vendorId !== req.user?.id) {
//       res.status(403).json({ message: "Unauthorized or order not found" });
//       return;
//     }
//     // 2️⃣ Compute total price
//     const basePrice = order.items.reduce((acc, item) => acc + item.subtotal, 0);
//     const hasExtraCharge = extraCharge && extraCharge > 0;
//     // 3️⃣ Determine next status
//     const nextStatus = hasExtraCharge
//       ? "WAITING_CUSTOMER_APPROVAL"
//       : "AWAITING_PAYMENT";
//     // 4️⃣ Update order
//     const updatedOrder = await prisma.order.update({
//       where: { id: orderId },
//       data: {
//         vendorNote,
//         extraCharge,
//         totalPrice: basePrice + (extraCharge || 0),
//         status: nextStatus,
//       },
//     });
//     // 5️⃣ Record vendor activity + notify customer
//     const message = hasExtraCharge
//       ? `The vendor responded to your special request with an extra charge of ₦${extraCharge}.`
//       : "The vendor has accepted your special request. You can now proceed to payment.";
//     await recordActivityBundle({
//       actorId: req.user.id,
//       orderId,
//       actions: [
//         {
//           type: ActivityType.GENERAL,
//           title: "Vendor Response to Special Request",
//           message,
//           targetId: order.customerId,
//           socketEvent: "ORDER",
//           metadata: {
//             orderId: updatedOrder.id,
//             vendorNote,
//             extraCharge,
//             newStatus: nextStatus,
//           },
//           relation: "customer",
//         },
//       ],
//       audit: {
//         action: "VENDOR_RESPONDED_SPECIAL_REQUEST",
//         metadata: {
//           orderId,
//           vendorId: req.user.id,
//           customerId: order.customerId,
//           vendorNote,
//           extraCharge,
//           nextStatus,
//         },
//       },
//       notifyRealtime: true,
//       notifyPush: true,
//     });
//     // 6️⃣ Send success response
//     res.status(200).json(
//       successResponse("ORDER_UPDATED", "Vendor response saved successfully", updatedOrder)
//     );
//   } catch (err) {
//     console.error("Vendor response error:", err);
//     res
//       .status(500)
//       .json(errorResponse("SERVER_ERROR", "Something went wrong on the server"));
//   }
// };
// export const customerApproveOrderForSpecialRequest = async (
//   req: AuthRequest,
//   res: Response
// ): Promise<void> => {
//   try {
//     const { orderId } = req.params;
//     // 1️⃣ Fetch order
//     const order = await prisma.order.findUnique({
//       where: { id: orderId },
//       include: { payments: true },
//     });
//     if (!order || order.customerId !== req.user?.id) {
//       res.status(403).json(errorResponse("FORBIDDEN", "Unauthorized or order not found"));
//       return;
//     }
//     // 2️⃣ Check if vendor added an extra charge
//     const hasExtraCharge = !!order.extraCharge && order.extraCharge > 0;
//     // 3️⃣ Determine next status
//     const nextStatus = hasExtraCharge
//       ? OrderStatus.AWAITING_PAYMENT
//       : OrderStatus.AWAITING_PAYMENT;
//     // 4️⃣ Compute payment window (30 minutes)
//     const now = new Date();
//     const paymentExpiresAt = new Date(now.getTime() + 30 * 60 * 1000);
//     // 5️⃣ Update order status first
//     const updatedOrder = await prisma.order.update({
//       where: { id: orderId },
//       data: { customerApproval: true, status: nextStatus },
//     });
// // 6️⃣ Create or update Payment record manually
// const existingPayment = await prisma.payment.findFirst({
//   where: {
//     orderId,
//     status: { in: ["INITIATED", "PENDING"] },
//   },
// });
// if (existingPayment) {
//   await prisma.payment.update({
//     where: { id: existingPayment.id },
//     data: {
//       expiresAt: paymentExpiresAt,
//       status: "PENDING",
//       updatedAt: new Date(),
//     },
//   });
// } else {
//   await prisma.payment.create({
//     data: {
//       userId: order.customerId,
//       orderId: order.id,
//       amount: order.totalPrice,
//       status: "PENDING",
//       expiresAt: paymentExpiresAt,
//       reference: `pay_${Date.now()}`,
//     },
//   });
// }
//     // 7️⃣ Record activity + notify vendor
//     await recordActivityBundle({
//       actorId: req.user.id,
//       orderId,
//       actions: [
//         {
//           type: ActivityType.GENERAL,
//           title: "Customer Approved Order Update",
//           message: `Customer approved your update for order #${orderId}. Awaiting payment confirmation.`,
//           targetId: order.vendorId,
//           socketEvent: "ORDER",
//           metadata: {
//             orderId,
//             frontendEvent: "ORDER_APPROVED",
//             extraCharge: order.extraCharge,
//           },
//           relation: "vendor",
//         },
//       ],
//       audit: {
//         action: "CUSTOMER_APPROVED_ORDER",
//         metadata: {
//           orderId,
//           customerId: req.user.id,
//           vendorId: order.vendorId,
//           extraCharge: order.extraCharge,
//         },
//       },
//       notifyRealtime: true,
//       notifyPush: true,
//     });
//     // 8️⃣ Respond
//     res.status(200).json(
//       successResponse("ORDER_APPROVED", "Order approved successfully. Proceed to payment.", {
//         updatedOrder,
//         paymentExpiresAt,
//       })
//     );
//   } catch (err) {
//     console.error("❌ Customer approval error:", err);
//     res.status(500).json(errorResponse("SERVER_ERROR", "Failed to approve order"));
//   }
// };
const getMyOrders = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
            return;
        }
        const orders = await prisma_1.default.order.findMany({
            where: {
                OR: [{ customerId: userId }, { vendorId: userId }],
            },
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
                                    select: {
                                        id: true,
                                        name: true,
                                        price: true,
                                    },
                                },
                            },
                        },
                    },
                },
                customer: { select: { id: true, name: true, avatarUrl: true } },
                vendor: { select: { id: true, name: true, brandName: true, brandLogo: true } },
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
            orderBy: { createdAt: "desc" },
        });
        res.status(200).json((0, codeMessage_1.successResponse)("ORDERS_RETRIEVED", "Orders retrieved successfully", {
            total: orders.length,
            orders,
        }));
    }
    catch (error) {
        console.error("❌ getMyOrders Error:", error);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to retrieve orders"));
    }
};
exports.getMyOrders = getMyOrders;
const getSingleOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const userId = req.user?.id;
        if (!userId) {
            res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
            return;
        }
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
                                productOption: {
                                    select: {
                                        id: true,
                                        name: true,
                                        price: true,
                                    },
                                },
                            },
                        },
                    },
                },
                customer: { select: { id: true, name: true, email: true, avatarUrl: true } },
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
        if (!order || (order.customerId !== userId && order.vendorId !== userId)) {
            res.status(403).json((0, codeMessage_1.errorResponse)("FORBIDDEN", "Unauthorized or order not found"));
            return;
        }
        res.status(200).json((0, codeMessage_1.successResponse)("ORDER_RETRIEVED", "Order retrieved successfully", { order }));
    }
    catch (err) {
        console.error("❌ getSingleOrder Error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to retrieve the order"));
    }
};
exports.getSingleOrder = getSingleOrder;
// export const updateOrderStatus = async (req: AuthRequest, res: Response): Promise<void> => {
//   try {
//     const { orderId } = req.params;
//     const { status } = req.body;
//     const userId = req.user?.id;
//     const userRole = req.user?.role as Role | undefined;
//     // 🔒 1. Authentication
//     if (!userId || !userRole) {
//       res.status(401).json(errorResponse("UNAUTHORIZED", "Unauthorized"));
//       return;
//     }
//     // 🛑 2. Prevent system-managed transitions
//     if (status === OrderStatus.PAYMENT_CONFIRMED) {
//       res
//         .status(403)
//         .json(errorResponse("FORBIDDEN", "Payment confirmations are system-managed only"));
//       return;
//     }
//     // ⚙️ 3. Validate input
//     if (!status || !Object.values(OrderStatus).includes(status)) {
//       res.status(400).json(errorResponse("INVALID_STATUS", "Invalid or missing order status"));
//       return;
//     }
//     // 🔍 4. Fetch order (with products and payments)
//     const order = await prisma.order.findUnique({
//       where: { id: orderId },
//       include: {
//         items: {
//           include: {
//             product: {
//               select: {
//                 isLive: true,
//                 productSchedule: { select: { goLiveAt: true, takeDownAt: true } },
//               },
//             },
//           },
//         },
//         payments: {
//           orderBy: { createdAt: "desc" }, // most recent payment first
//         },
//       },
//     });
//     if (!order) {
//       res.status(404).json(errorResponse("NOT_FOUND", "Order not found"));
//       return;
//     }
//     // 🎭 5. Verify ownership
//     const isVendor = userId === order.vendorId;
//     const isCustomer = userId === order.customerId;
//     if (!isVendor && !isCustomer) {
//       res.status(403).json(errorResponse("FORBIDDEN", "Unauthorized user"));
//       return;
//     }
//     const currentStatus = order.status;
//     // 📜 6. Allowed transitions
//     const transitionRules: Record<OrderStatus, { from: OrderStatus[]; allowedRoles: Role[] }> = {
//       PENDING: { from: [], allowedRoles: [] },
//       WAITING_VENDOR_CONFIRMATION: { from: [], allowedRoles: [Role.CUSTOMER] },
//       WAITING_CUSTOMER_APPROVAL: {
//         from: [OrderStatus.WAITING_VENDOR_CONFIRMATION],
//         allowedRoles: [Role.VENDOR],
//       },
//       AWAITING_PAYMENT: {
//         from: [OrderStatus.WAITING_CUSTOMER_APPROVAL, OrderStatus.WAITING_VENDOR_CONFIRMATION],
//         allowedRoles: [Role.CUSTOMER, Role.VENDOR],
//       },
//       PAYMENT_CONFIRMED: { from: [OrderStatus.AWAITING_PAYMENT], allowedRoles: [] },
//       COOKING: { from: [OrderStatus.PAYMENT_CONFIRMED], allowedRoles: [Role.VENDOR] },
//       READY_FOR_PICKUP: { from: [OrderStatus.COOKING], allowedRoles: [Role.VENDOR] },
//       OUT_FOR_DELIVERY: { from: [OrderStatus.READY_FOR_PICKUP], allowedRoles: [Role.VENDOR] },
//       COMPLETED: { from: [OrderStatus.OUT_FOR_DELIVERY], allowedRoles: [Role.VENDOR] },
//       CANCELLED: {
//         from: [
//           OrderStatus.PENDING,
//           OrderStatus.WAITING_VENDOR_CONFIRMATION,
//           OrderStatus.WAITING_CUSTOMER_APPROVAL,
//           OrderStatus.AWAITING_PAYMENT,
//           OrderStatus.PAYMENT_CONFIRMED,
//           OrderStatus.COOKING,
//           OrderStatus.OUT_FOR_DELIVERY,
//         ],
//         allowedRoles: [Role.CUSTOMER, Role.VENDOR],
//       },
//       FAILED_DELIVERY: { from: [OrderStatus.OUT_FOR_DELIVERY], allowedRoles: [Role.VENDOR] },
//       PAYMENT_EXPIRED: { from: [OrderStatus.AWAITING_PAYMENT], allowedRoles: [] },
//       CANCELLED_UNPAID: {
//         from: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_EXPIRED],
//         allowedRoles: [],
//       },
//     };
//     // 🧩 7. Validate transition
//     const rule = transitionRules[status as OrderStatus];
//     if (!rule) {
//       res.status(400).json(errorResponse("INVALID_TRANSITION", "Invalid status transition"));
//       return;
//     }
//     if (!rule.from.includes(currentStatus)) {
//       res
//         .status(400)
//         .json(
//           errorResponse(
//             "INVALID_TRANSITION",
//             `Cannot transition from ${currentStatus} to ${status}`
//           )
//         );
//       return;
//     }
//     if (!rule.allowedRoles.includes(userRole)) {
//       res
//         .status(403)
//         .json(errorResponse("FORBIDDEN", "You are not allowed to perform this transition"));
//       return;
//     }
//     // 🔄 8. Build update data
//     let updateData: Prisma.OrderUpdateInput = { status };
//     // ✅ If moving to AWAITING_PAYMENT, validate product live state
//     if (status === OrderStatus.AWAITING_PAYMENT) {
//       const firstItem = order.items?.[0];
//       const product = firstItem?.product;
//       if (!product) {
//         res
//           .status(400)
//           .json(errorResponse("INVALID_ORDER", "Order has no product to validate live status"));
//         return;
//       }
//       const now = new Date();
//       const sched = product.productSchedule;
//       let productIsLive = false;
//       if (product.isLive) {
//         productIsLive = true;
//       } else if (sched?.goLiveAt && sched?.takeDownAt) {
//         const go = new Date(sched.goLiveAt).getTime();
//         const take = new Date(sched.takeDownAt).getTime();
//         productIsLive = now.getTime() >= go && now.getTime() <= take;
//       }
//       if (!productIsLive) {
//         res
//           .status(400)
//           .json(
//             errorResponse("PRODUCT_OFFLINE", "Product is not live — cannot move to AWAITING_PAYMENT")
//           );
//         return;
//       }
//     }
//     // 💡 9. Check payment expiration (from Payment, not Order)
//     const latestPayment = order.payments?.[0]; // because we ordered DESC by createdAt
//     if (
//       latestPayment?.expiresAt &&
//       new Date() > new Date(latestPayment.expiresAt) &&
//       status !== OrderStatus.CANCELLED
//     ) {
//       updateData.status = OrderStatus.CANCELLED;
//       updateData.cancelledAt = new Date();
//       updateData.cancellationReason = "PAYMENT_EXPIRED";
//     }
//     // 🟥 Manual cancellation
//     if (status === OrderStatus.CANCELLED) {
//       updateData.cancelledAt = new Date();
//       updateData.cancellationReason = isVendor ? "VENDOR_CANCELLED" : "CUSTOMER_CANCELLED";
//     }
//     // 💾 10. Update DB
//     const updatedOrder = await prisma.order.update({
//       where: { id: orderId },
//       data: updateData,
//     });
//     // 🔔 11. Notify the other user
//     const recipientId = isVendor ? order.customerId : order.vendorId;
//     await recordActivityBundle({
//       actorId: userId,
//       orderId,
//       actions: [
//         {
//           type: ActivityType.GENERAL,
//           title: `Order ${status}`,
//           message: `Order ${orderId} status has been updated to ${status}`,
//           targetId: recipientId,
//           socketEvent: "ORDER",
//           metadata: { orderId, updatedBy: userRole },
//         },
//       ],
//       audit: {
//         action: "ORDER_STATUS_UPDATED",
//         metadata: {
//           orderId,
//           updatedBy: userId,
//           previousStatus: currentStatus,
//           newStatus: status,
//         },
//       },
//       notifyRealtime: true,
//       notifyPush: true,
//     });
//     // ✅ 12. Response
//     res.status(200).json(
//       successResponse("ORDER_STATUS_UPDATED", `Order status updated to ${status}`, {
//         order: updatedOrder,
//       })
//     );
//   } catch (err) {
//     console.error("❌ updateOrderStatus Error:", err);
//     res.status(500).json(errorResponse("SERVER_ERROR", "Failed to update order status"));
//   }
// };
const createNormalOrder = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
        }
        const { vendorId, items } = req.body;
        if (!vendorId || !items || items.length === 0) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_DATA", "Vendor and items are required"));
        }
        // 🔍 Fetch product details
        const productIds = items.map((i) => i.productId);
        const products = await prisma_1.default.product.findMany({
            where: { id: { in: productIds }, isLive: true },
            include: { productSchedule: true },
        });
        if (products.length !== items.length) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_PRODUCTS", "Some products are not available or offline"));
        }
        const now = (0, time_1.nowUtc)();
        // ✅ Validate product schedules
        for (const item of items) {
            const product = products.find((p) => p.id === item.productId);
            if (!product)
                continue;
            const sched = product.productSchedule;
            if (sched?.goLiveAt && sched?.takeDownAt) {
                const goUtc = (0, time_1.toUtc)(sched.goLiveAt);
                const takeUtc = (0, time_1.toUtc)(sched.takeDownAt);
                if (now < goUtc || now > takeUtc) {
                    return res.status(400).json((0, codeMessage_1.errorResponse)("PRODUCT_OFFLINE", `Product "${product.name}" is offline now`));
                }
            }
        }
        // 💰 Calculate total price
        // 💰 Calculate base price and total price
        let basePrice = 0;
        const totalPrice = items.reduce((sum, item) => {
            const product = products.find((p) => p.id === item.productId);
            basePrice += product.price * item.quantity;
            return sum + product.price * item.quantity; // or add modifiers if you have
        }, 0);
        // 🔄 Create order with required basePrice
        const order = await prisma_1.default.order.create({
            data: {
                customer: { connect: { id: userId } },
                vendor: { connect: { id: vendorId } },
                status: "AWAITING_PAYMENT",
                basePrice, // ✅ required
                totalPrice,
                items: {
                    create: items.map((item) => {
                        const product = products.find((p) => p.id === item.productId);
                        const unitPrice = product.price;
                        const subtotal = unitPrice * item.quantity;
                        return {
                            product: { connect: { id: product.id } },
                            quantity: item.quantity,
                            unitPrice,
                            subtotal,
                        };
                    }),
                },
            },
            include: { items: { include: { product: true } } },
        });
        // 💳 Create payment record with required `reference`
        const paymentReference = `ORD-${(0, zod_1.uuidv4)()}`;
        const paymentExpiresAt = (0, time_1.addMinutesUtc)(now, 15);
        const payment = await prisma_1.default.payment.create({
            data: {
                reference: paymentReference,
                amount: totalPrice,
                status: "pending",
                startedAt: now,
                expiresAt: paymentExpiresAt,
                order: { connect: { id: order.id } },
                user: { connect: { id: userId } },
                channel: "web",
                ipAddress: req.ip,
                userAgent: req.headers["user-agent"] || "unknown",
            },
        });
        // 🔔 Record activity for vendor notification
        await (0, recordActivityBundle_1.recordActivityBundle)({
            actorId: userId,
            orderId: order.id,
            actions: [
                {
                    type: client_1.ActivityType.GENERAL,
                    title: "Order Created",
                    message: `Order ${order.id} created and awaiting payment`,
                    targetId: vendorId,
                    socketEvent: "ORDER",
                    metadata: { orderId: order.id, createdBy: userId },
                },
            ],
            audit: {
                action: "ORDER_CREATED",
                metadata: { orderId: order.id, userId, totalPrice },
            },
            notifyRealtime: true,
            notifyPush: true,
        });
        return res.status(201).json((0, codeMessage_1.successResponse)("ORDER_CREATED", "Order created and awaiting payment", {
            order,
            payment,
        }));
    }
    catch (err) {
        console.error("❌ createNormalOrder Error:", err);
        return res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to create order"));
    }
};
exports.createNormalOrder = createNormalOrder;
// 🌟 Customer creates a new special request
const createSpecialRequest = async (req, res) => {
    try {
        const { productId, quantity, details } = req.body; // details from frontend
        const userId = req.user?.id;
        // Validate authentication
        if (!userId) {
            return res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
        }
        // Validate required fields
        if (!productId || !quantity || !details) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_DATA", "Missing required fields"));
        }
        // Create special request
        const request = await prisma_1.default.specialOrderRequest.create({
            data: {
                customerId: userId,
                productId,
                quantity,
                message: details, // map "details" to the existing "message" field
            },
        });
        // Respond with the created request
        return res.status(201).json((0, codeMessage_1.successResponse)("REQUEST_CREATED", "Special request created", { request }));
    }
    catch (err) {
        console.error("Error creating special request:", err);
        return res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to create special request"));
    }
};
exports.createSpecialRequest = createSpecialRequest;
// 🌟 Vendor creates an offer
const createSpecialOffer = async (req, res) => {
    try {
        const { requestId, price, message } = req.body;
        const vendorId = req.user?.id;
        if (!vendorId)
            return res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
        if (!requestId || !price) {
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_DATA", "Missing required fields"));
        }
        const request = await prisma_1.default.specialOrderRequest.findUnique({ where: { id: requestId }, include: { offers: true } });
        if (!request)
            return res.status(404).json((0, codeMessage_1.errorResponse)("NOT_FOUND", "Special request not found"));
        if (request.status === "ACCEPTED" || request.status === "CANCELLED") {
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_STATE", "Cannot offer on this request"));
        }
        const offer = await prisma_1.default.specialOrderOffer.create({
            data: { requestId, vendorId, price, message }
        });
        // Update request status to OFFER_MADE
        await prisma_1.default.specialOrderRequest.update({ where: { id: requestId }, data: { status: "OFFER_MADE" } });
        res.status(201).json((0, codeMessage_1.successResponse)("OFFER_CREATED", "Offer created", { offer }));
    }
    catch (err) {
        console.error(err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to create offer"));
    }
};
exports.createSpecialOffer = createSpecialOffer;
// 🌟 Customer accepts an offer
const acceptSpecialOffer = async (req, res) => {
    try {
        const { offerId } = req.params;
        const userId = req.user?.id;
        if (!userId)
            return res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
        const offer = await prisma_1.default.specialOrderOffer.findUnique({
            where: { id: offerId },
            include: { request: true },
        });
        if (!offer)
            return res.status(404).json((0, codeMessage_1.errorResponse)("NOT_FOUND", "Offer not found"));
        if (offer.request.customerId !== userId)
            return res.status(403).json((0, codeMessage_1.errorResponse)("FORBIDDEN", "Not your request"));
        if (offer.request.status !== "OFFER_MADE")
            return res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_STATE", "Cannot accept this offer"));
        // 1️⃣ Update all other offers to REJECTED
        await prisma_1.default.specialOrderOffer.updateMany({
            where: { requestId: offer.requestId, id: { not: offerId } },
            data: { status: "REJECTED" },
        });
        // 2️⃣ Update accepted offer
        const acceptedOffer = await prisma_1.default.specialOrderOffer.update({
            where: { id: offerId },
            data: { status: "ACCEPTED" },
        });
        // 3️⃣ Update request
        await prisma_1.default.specialOrderRequest.update({
            where: { id: offer.requestId },
            data: { status: "ACCEPTED" },
        });
        // 4️⃣ Create real Order + OrderItem
        const order = await prisma_1.default.order.create({
            data: {
                customerId: userId,
                vendorId: offer.vendorId,
                basePrice: offer.price,
                totalPrice: offer.price,
                status: "AWAITING_PAYMENT",
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
        });
        res.status(201).json((0, codeMessage_1.successResponse)("OFFER_ACCEPTED", "Offer accepted and order created", { order }));
    }
    catch (err) {
        console.error(err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to accept offer"));
    }
};
exports.acceptSpecialOffer = acceptSpecialOffer;
// 🌟 Customer rejects all offers
const rejectSpecialRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        const userId = req.user?.id;
        const request = await prisma_1.default.specialOrderRequest.findUnique({ where: { id: requestId } });
        if (!request)
            return res.status(404).json((0, codeMessage_1.errorResponse)("NOT_FOUND", "Request not found"));
        if (request.customerId !== userId)
            return res.status(403).json((0, codeMessage_1.errorResponse)("FORBIDDEN", "Not your request"));
        await prisma_1.default.specialOrderRequest.update({ where: { id: requestId }, data: { status: "REJECTED" } });
        await prisma_1.default.specialOrderOffer.updateMany({ where: { requestId }, data: { status: "REJECTED" } });
        res.status(200).json((0, codeMessage_1.successResponse)("REQUEST_REJECTED", "Special request rejected"));
    }
    catch (err) {
        console.error(err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to reject request"));
    }
};
exports.rejectSpecialRequest = rejectSpecialRequest;
const updateOrderStatus = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status } = req.body;
        const userId = req.user?.id;
        const userRole = req.user?.role;
        // 🔒 Authentication
        if (!userId || !userRole) {
            res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
            return;
        }
        // ⚙️ Validate status
        if (!status || !Object.values(client_1.OrderStatus).includes(status)) {
            res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_STATUS", "Invalid or missing order status"));
            return;
        }
        // 🔍 Fetch order with latest payment
        const order = await prisma_1.default.order.findUnique({
            where: { id: orderId },
            include: { payments: { orderBy: { createdAt: "desc" } } },
        });
        if (!order) {
            res.status(404).json((0, codeMessage_1.errorResponse)("NOT_FOUND", "Order not found"));
            return;
        }
        // 🎭 Verify ownership
        const isVendor = userId === order.vendorId;
        const isCustomer = userId === order.customerId;
        if (!isVendor && !isCustomer) {
            res.status(403).json((0, codeMessage_1.errorResponse)("FORBIDDEN", "Unauthorized user"));
            return;
        }
        const currentStatus = order.status;
        // 📜 Allowed transitions
        const transitionRules = {
            // Customer can retry payment if needed
            AWAITING_PAYMENT: { from: [], allowedRoles: [client_1.Role.CUSTOMER] },
            // Payment confirmed is system-only (webhook updates this)
            PAYMENT_CONFIRMED: { from: [client_1.OrderStatus.AWAITING_PAYMENT], allowedRoles: [] },
            // Vendor updates the cooking and delivery lifecycle
            COOKING: { from: [client_1.OrderStatus.PAYMENT_CONFIRMED], allowedRoles: [client_1.Role.VENDOR] },
            READY_FOR_PICKUP: { from: [client_1.OrderStatus.COOKING], allowedRoles: [client_1.Role.VENDOR] },
            OUT_FOR_DELIVERY: { from: [client_1.OrderStatus.READY_FOR_PICKUP], allowedRoles: [client_1.Role.VENDOR] },
            COMPLETED: { from: [client_1.OrderStatus.OUT_FOR_DELIVERY], allowedRoles: [client_1.Role.VENDOR] },
            // Manual cancellations allowed by either party
            CANCELLED: {
                from: [
                    client_1.OrderStatus.AWAITING_PAYMENT,
                    client_1.OrderStatus.PAYMENT_CONFIRMED,
                    client_1.OrderStatus.COOKING,
                    client_1.OrderStatus.READY_FOR_PICKUP,
                    client_1.OrderStatus.OUT_FOR_DELIVERY,
                ],
                allowedRoles: [client_1.Role.CUSTOMER, client_1.Role.VENDOR],
            },
            // Payment expired handled by webhook/system
            PAYMENT_EXPIRED: { from: [client_1.OrderStatus.AWAITING_PAYMENT], allowedRoles: [] },
            // Unpaid order cancellations handled by webhook/system
            CANCELLED_UNPAID: { from: [client_1.OrderStatus.AWAITING_PAYMENT, client_1.OrderStatus.PAYMENT_EXPIRED], allowedRoles: [] },
            // Optional or future statuses
            PENDING: { from: [], allowedRoles: [] },
            WAITING_VENDOR_CONFIRMATION: { from: [], allowedRoles: [] },
            WAITING_CUSTOMER_APPROVAL: { from: [], allowedRoles: [] },
            FAILED_DELIVERY: { from: [], allowedRoles: [] },
        };
        // 🧩 Validate transition
        const rule = transitionRules[status];
        if (!rule) {
            res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_TRANSITION", "Invalid status transition"));
            return;
        }
        if (!rule.from.includes(currentStatus)) {
            res.status(400).json((0, codeMessage_1.errorResponse)("INVALID_TRANSITION", `Cannot transition from ${currentStatus} to ${status}`));
            return;
        }
        if (!rule.allowedRoles.includes(userRole)) {
            res.status(403).json((0, codeMessage_1.errorResponse)("FORBIDDEN", "You are not allowed to perform this transition"));
            return;
        }
        // 🔄 Build update data
        let updateData = { status };
        // 💡 Auto-cancel expired payments
        const latestPayment = order.payments?.[0];
        if (latestPayment?.expiresAt && new Date() > new Date(latestPayment.expiresAt) && status !== client_1.OrderStatus.CANCELLED) {
            updateData.status = client_1.OrderStatus.CANCELLED;
            updateData.cancelledAt = new Date();
            updateData.cancellationReason = "PAYMENT_EXPIRED";
        }
        // 🟥 Manual cancellation
        if (status === client_1.OrderStatus.CANCELLED) {
            updateData.cancelledAt = new Date();
            updateData.cancellationReason = isVendor ? "VENDOR_CANCELLED" : "CUSTOMER_CANCELLED";
        }
        // 💾 Update DB
        const updatedOrder = await prisma_1.default.order.update({
            where: { id: orderId },
            data: updateData,
        });
        // 🔔 Notify the other party
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
        res.status(200).json((0, codeMessage_1.successResponse)("ORDER_STATUS_UPDATED", `Order status updated to ${status}`, { order: updatedOrder }));
        return;
    }
    catch (err) {
        console.error("❌ updateOrderStatus Error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to update order status"));
        return;
    }
};
exports.updateOrderStatus = updateOrderStatus;
const getVendorOrderStats = async (req, res) => {
    try {
        // ✅ Access Control: Only vendors can view vendor statistics
        if (req.user?.role !== client_1.Role.VENDOR) {
            res.status(403).json({ message: "Unauthorized access: Vendors only" });
            return;
        }
        const vendorId = req.user.id;
        // ⚡ Fetch multiple statistics in parallel for efficiency
        const [totalOrders, completedOrders, pendingOrders, inProgressOrders, awaitingApprovalOrders, totalRevenueObj,] = await Promise.all([
            // 1️⃣ Total number of orders handled by this vendor
            prisma_1.default.order.count({
                where: { vendorId },
            }),
            // 2️⃣ Successfully completed orders
            prisma_1.default.order.count({
                where: { vendorId, status: client_1.OrderStatus.COMPLETED },
            }),
            // 3️⃣ Orders that are still pending (not yet processed)
            prisma_1.default.order.count({
                where: { vendorId, status: client_1.OrderStatus.PENDING },
            }),
            // 4️⃣ Active orders currently in progress (cooking, pickup, delivery)
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
            // 5️⃣ Orders waiting for the customer to approve vendor updates
            prisma_1.default.order.count({
                where: {
                    vendorId,
                    status: client_1.OrderStatus.WAITING_CUSTOMER_APPROVAL,
                },
            }),
            // 6️⃣ Total revenue earned from completed orders
            prisma_1.default.order.aggregate({
                _sum: { totalPrice: true },
                where: { vendorId, status: client_1.OrderStatus.COMPLETED },
            }),
        ]);
        // 🧮 Safely extract revenue (fallback to 0 if no data)
        const totalRevenue = totalRevenueObj._sum.totalPrice ?? 0;
        // ✅ Send structured and descriptive response
        res.json({
            summary: {
                totalOrders,
                completedOrders,
                pendingOrders,
                inProgressOrders,
                awaitingApprovalOrders,
                totalRevenue,
            },
            metadata: {
                vendorId,
                lastUpdated: new Date().toISOString(),
            },
        });
    }
    catch (err) {
        console.error("❌ Vendor order stats error:", err);
        res.status(500).json({ error: "Server error" });
    }
};
exports.getVendorOrderStats = getVendorOrderStats;
/**📊 Get Customer Order Statistics (with 7-day order trend)
 * Provides customers with their key order insights:
 * - Total, completed, pending, in-progress, and awaiting-payment orders
 * - Total amount spent on completed orders
 * - 7-day trend chart data (orders per day)
 */
const getCustomerOrderStats = async (req, res) => {
    try {
        if (req.user?.role !== client_1.Role.CUSTOMER) {
            res.status(403).json((0, codeMessage_1.errorResponse)("FORBIDDEN", "Unauthorized access: Customers only"));
            return;
        }
        const customerId = req.user.id;
        const today = new Date();
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(today.getDate() - 6);
        const last7Days = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(sevenDaysAgo);
            d.setDate(sevenDaysAgo.getDate() + i);
            return d.toISOString().slice(0, 10);
        });
        const [totalOrders, completedOrders, pendingOrders, inProgressOrders, awaitingPaymentOrders, totalSpentObj, last7DaysOrders,] = await Promise.all([
            prisma_1.default.order.count({ where: { customerId } }),
            prisma_1.default.order.count({ where: { customerId, status: client_1.OrderStatus.COMPLETED } }),
            prisma_1.default.order.count({ where: { customerId, status: client_1.OrderStatus.PENDING } }),
            prisma_1.default.order.count({
                where: {
                    customerId,
                    status: { in: [client_1.OrderStatus.COOKING, client_1.OrderStatus.READY_FOR_PICKUP, client_1.OrderStatus.OUT_FOR_DELIVERY] },
                },
            }),
            prisma_1.default.order.count({ where: { customerId, status: client_1.OrderStatus.AWAITING_PAYMENT } }),
            prisma_1.default.order.aggregate({ _sum: { totalPrice: true }, where: { customerId, status: client_1.OrderStatus.COMPLETED } }),
            prisma_1.default.order.groupBy({
                by: ["createdAt"],
                where: { customerId, createdAt: { gte: sevenDaysAgo, lte: today } },
                _count: { id: true },
            }),
        ]);
        const ordersPerDay = last7Days.map((date) => {
            const dayRecord = last7DaysOrders.find((o) => o.createdAt.toISOString().slice(0, 10) === date);
            return { date, orders: dayRecord?._count.id ?? 0 };
        });
        const totalSpent = totalSpentObj._sum.totalPrice ?? 0;
        res.status(200).json((0, codeMessage_1.successResponse)("CUSTOMER_ORDER_STATS_RETRIEVED", "Customer order stats retrieved successfully", {
            totalOrders,
            completedOrders,
            pendingOrders,
            inProgressOrders,
            awaitingPaymentOrders,
            totalSpent,
            last7DaysOrders: ordersPerDay,
        }));
    }
    catch (err) {
        console.error("❌ Customer order stats error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to retrieve customer order stats"));
    }
};
exports.getCustomerOrderStats = getCustomerOrderStats;
const getVendorReport = async (req, res) => {
    try {
        if (!req.user || req.user.role !== client_1.Role.VENDOR) {
            res.status(403).json((0, codeMessage_1.errorResponse)("FORBIDDEN", "Unauthorized access"));
            return;
        }
        const vendorId = req.user.id;
        const now = (0, dayjs_1.default)();
        const startOfToday = now.startOf("day").toDate();
        const startOfWeek = now.startOf("week").toDate();
        const startOfMonth = now.startOf("month").toDate();
        const startOfYear = now.startOf("year").toDate();
        const [revenueAgg, totalOrders, completedOrders, itemsSoldAgg] = await Promise.all([
            prisma_1.default.order.aggregate({ _sum: { totalPrice: true }, where: { vendorId, status: client_1.OrderStatus.COMPLETED } }),
            prisma_1.default.order.count({ where: { vendorId } }),
            prisma_1.default.order.count({ where: { vendorId, status: client_1.OrderStatus.COMPLETED } }),
            prisma_1.default.orderItem.aggregate({ _sum: { quantity: true }, where: { order: { vendorId, status: client_1.OrderStatus.COMPLETED } } }),
        ]);
        const totalRevenue = revenueAgg._sum.totalPrice ?? 0;
        const totalItemsSold = itemsSoldAgg._sum.quantity ?? 0;
        const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
        const getStatsFromDate = async (from) => {
            const orders = await prisma_1.default.order.findMany({
                where: { vendorId, createdAt: { gte: from }, status: client_1.OrderStatus.COMPLETED },
                select: { totalPrice: true },
            });
            return { orders: orders.length, revenue: orders.reduce((sum, o) => sum + o.totalPrice, 0) };
        };
        const [todayStats, weekStats, monthStats, yearStats] = await Promise.all([
            getStatsFromDate(startOfToday),
            getStatsFromDate(startOfWeek),
            getStatsFromDate(startOfMonth),
            getStatsFromDate(startOfYear),
        ]);
        const past7Days = await Promise.all([...Array(7)].map(async (_, i) => {
            const day = now.subtract(i, "day");
            const start = day.startOf("day").toDate();
            const end = day.endOf("day").toDate();
            const orders = await prisma_1.default.order.findMany({
                where: { vendorId, status: client_1.OrderStatus.COMPLETED, createdAt: { gte: start, lte: end } },
                select: { totalPrice: true },
            });
            return { date: day.format("YYYY-MM-DD"), count: orders.length, revenue: orders.reduce((sum, o) => sum + o.totalPrice, 0) };
        }));
        const topProductsAgg = await prisma_1.default.orderItem.groupBy({
            by: ["productId"],
            where: { order: { vendorId, status: client_1.OrderStatus.COMPLETED } },
            _sum: { quantity: true, subtotal: true },
            orderBy: { _sum: { quantity: "desc" } },
            take: 5,
        });
        const productDetails = await prisma_1.default.product.findMany({
            where: { id: { in: topProductsAgg.map((p) => p.productId) } },
            select: { id: true, name: true },
        });
        const topProducts = topProductsAgg.map((p) => {
            const product = productDetails.find((d) => d.id === p.productId);
            return { productId: p.productId, name: product?.name ?? "Unknown Product", sold: p._sum.quantity ?? 0, revenue: p._sum.subtotal ?? 0 };
        });
        res.status(200).json((0, codeMessage_1.successResponse)("VENDOR_REPORT_SUCCESS", "Vendor report retrieved successfully", {
            summary: {
                totalRevenue,
                totalOrders,
                completedOrders,
                totalItemsSold,
                averageOrderValue: Number(averageOrderValue.toFixed(2)),
            },
            timeline: { today: todayStats, week: weekStats, month: monthStats, year: yearStats },
            daily: past7Days.reverse(),
            topProducts,
        }));
    }
    catch (error) {
        console.error("❌ Vendor report error:", error);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to fetch vendor report"));
    }
};
exports.getVendorReport = getVendorReport;
// ✅ Fetch My Notifications (with cache)
const getMyNotifications = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
            return;
        }
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;
        const cacheKey = `notifications:${userId}:page:${page}:limit:${limit}`;
        // ✅ Try cache first
        const cached = await redis_1.redisNotifications.get(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached);
            res.status(200).json((0, codeMessage_1.successResponse)("NOTIFICATIONS_RETRIEVED_CACHE", "Notifications retrieved from cache", parsed));
            return;
        }
        // ✅ Otherwise, query DB
        const [notifications, total, unreadCount] = await Promise.all([
            prisma_1.default.notification.findMany({
                where: { userId },
                orderBy: { createdAt: "desc" },
                take: limit,
                skip,
            }),
            prisma_1.default.notification.count({ where: { userId } }),
            prisma_1.default.notification.count({ where: { userId, read: false } }),
        ]);
        const payload = {
            unreadCount,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
            notifications,
        };
        // ✅ Store in cache (expires in 60s)
        await redis_1.redisNotifications.set(cacheKey, JSON.stringify(payload), { EX: 60 });
        // ✅ Store unread count separately for quick updates
        await redis_1.redisNotifications.set(`notif:unread:${userId}`, unreadCount);
        res.status(200).json((0, codeMessage_1.successResponse)("NOTIFICATIONS_RETRIEVED", "Notifications retrieved successfully", payload));
    }
    catch (err) {
        console.error("❌ getMyNotifications Error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to retrieve notifications"));
    }
};
exports.getMyNotifications = getMyNotifications;
// ✅ Mark Single Notification as Read
const markNotificationAsRead = async (req, res) => {
    try {
        const { notificationId } = req.params;
        const userId = req.user?.id;
        if (!userId) {
            res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
            return;
        }
        const notification = await prisma_1.default.notification.findUnique({
            where: { id: notificationId },
        });
        if (!notification || notification.userId !== userId) {
            res.status(403).json((0, codeMessage_1.errorResponse)("FORBIDDEN", "Unauthorized or notification not found"));
            return;
        }
        if (notification.read) {
            res.status(200).json((0, codeMessage_1.successResponse)("ALREADY_READ", "Notification already marked as read"));
            return;
        }
        // ✅ Update DB
        const updatedNotification = await prisma_1.default.notification.update({
            where: { id: notificationId },
            data: { read: true },
        });
        // ✅ Update Redis unread count
        const redisKey = `notif:unread:${userId}`;
        const currentCount = parseInt((await redis_1.redisNotifications.get(redisKey)) || "0");
        const newCount = Math.max(currentCount - 1, 0);
        await redis_1.redisNotifications.set(redisKey, newCount);
        // ✅ Invalidate notifications cache for this user (so getMyNotifications refetches)
        const keys = await redis_1.redisNotifications.keys(`notifications:${userId}:*`);
        if (keys.length > 0)
            await redis_1.redisNotifications.del(keys);
        // ✅ Emit socket badge update
        const io = (0, socket_1.getIO)();
        io.to(userId).emit("unreadCountUpdate", { unreadCount: newCount });
        // ✅ Record activity for audit/logs
        await (0, recordActivityBundle_1.recordActivityBundle)({
            actorId: userId,
            actions: [
                {
                    type: client_1.ActivityType.GENERAL,
                    title: "Notification Read",
                    message: `Notification ${notificationId} marked as read.`,
                    targetId: userId,
                    socketEvent: "GENERAL",
                    metadata: {
                        type: "NOTIFICATION_STATUS",
                        route: `/notifications/${notificationId}`, // 🌐 Web route (optional but consistent)
                        target: {
                            screen: "notification_detail", // 📱 Flutter route name
                            id: notificationId
                        },
                        notificationId,
                        userId,
                        read: true,
                        frontendEvent: "NOTIFICATION_MARKED_READ"
                    }
                }
            ],
            audit: {
                action: "NOTIFICATION_MARKED_READ",
                metadata: {
                    notificationId,
                    userId
                }
            },
            notifyRealtime: true, // can still broadcast socket updates
            notifyPush: false // no push for read status
        });
        res.status(200).json((0, codeMessage_1.successResponse)("NOTIFICATION_MARKED_READ", "Notification marked as read successfully", {
            notification: updatedNotification,
            unreadCount: newCount,
        }));
    }
    catch (err) {
        console.error("❌ markNotificationAsRead Error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to mark notification as read"));
    }
};
exports.markNotificationAsRead = markNotificationAsRead;
// ✅ Mark All Notifications as Read
const markAllNotificationsAsRead = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            res.status(401).json((0, codeMessage_1.errorResponse)("UNAUTHORIZED", "Unauthorized"));
            return;
        }
        const updated = await prisma_1.default.notification.updateMany({
            where: { userId, read: false },
            data: { read: true },
        });
        // ✅ Reset unread count in Redis
        const redisKey = `notif:unread:${userId}`;
        await redis_1.redisNotifications.set(redisKey, 0);
        // ✅ Invalidate notifications cache
        const keys = await redis_1.redisNotifications.keys(`notifications:${userId}:*`);
        if (keys.length > 0)
            await redis_1.redisNotifications.del(keys);
        // ✅ Emit socket badge update
        const io = (0, socket_1.getIO)();
        io.to(userId).emit("unreadCountUpdate", { unreadCount: 0 });
        if (updated.count > 0) {
            await (0, recordActivityBundle_1.recordActivityBundle)({
                actorId: userId,
                actions: [
                    {
                        type: client_1.ActivityType.GENERAL,
                        title: "All Notifications Read",
                        message: `${updated.count} notifications marked as read.`,
                        targetId: userId,
                        socketEvent: "GENERAL",
                        metadata: { count: updated.count },
                    },
                ],
                audit: { action: "ALL_NOTIFICATIONS_MARKED_READ", metadata: { userId, count: updated.count } },
                notifyRealtime: true,
                notifyPush: false,
            });
        }
        res.status(200).json((0, codeMessage_1.successResponse)("ALL_NOTIFICATIONS_MARKED_READ", `${updated.count} notifications marked as read successfully`, { count: updated.count, unreadCount: 0 }));
    }
    catch (err) {
        console.error("❌ markAllNotificationsAsRead Error:", err);
        res.status(500).json((0, codeMessage_1.errorResponse)("SERVER_ERROR", "Failed to mark notifications as read"));
    }
};
exports.markAllNotificationsAsRead = markAllNotificationsAsRead;

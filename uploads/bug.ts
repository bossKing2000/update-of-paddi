export const updateOrderStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;
    const userId = req.user?.id;
    const userRole = req.user?.role as Role | undefined;

    // 🔒 1. Authentication
    if (!userId || !userRole) {
      res.status(401).json(errorResponse("UNAUTHORIZED", "Unauthorized"));
      return;
    }

    // 🛑 2. Prevent system-managed transitions
    if (status === OrderStatus.PAYMENT_CONFIRMED) {
      res.status(403).json(errorResponse("FORBIDDEN", "Payment confirmations are system-managed only"));
      return;
    }

    // ⚙️ 3. Validate input
    if (!status || !Object.values(OrderStatus).includes(status)) {
      res.status(400).json(errorResponse("INVALID_STATUS", "Invalid or missing order status"));
      return;
    }

    // 🔍 4. Fetch order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: { select: { isLive: true, productSchedule: { select: { goLiveAt: true, takeDownAt: true } } } } } } },
    });

    if (!order) {
      res.status(404).json(errorResponse("NOT_FOUND", "Order not found"));
      return;
    }

    // 🎭 5. Verify ownership
    const isVendor = userId === order.vendorId;
    const isCustomer = userId === order.customerId;
    if (!isVendor && !isCustomer) {
      res.status(403).json(errorResponse("FORBIDDEN", "Unauthorized user"));
      return;
    }

    const currentStatus = order.status;

    // 📜 6. Allowed transitions
    const transitionRules: Record<OrderStatus, { from: OrderStatus[]; allowedRoles: Role[] }> = {
      // 👇 Initial states
      PENDING: { from: [], allowedRoles: [] },

      // Vendor must review before accepting
      WAITING_VENDOR_CONFIRMATION: {
        from: [],
        allowedRoles: [Role.CUSTOMER],
      },

      // Vendor responds — possibly with price adjustment
      WAITING_CUSTOMER_APPROVAL: {
        from: [OrderStatus.WAITING_VENDOR_CONFIRMATION],
        allowedRoles: [Role.VENDOR],
      },

      // Customer accepts vendor quote → now can pay
      AWAITING_PAYMENT: {
        from: [
          OrderStatus.WAITING_CUSTOMER_APPROVAL,
          OrderStatus.WAITING_VENDOR_CONFIRMATION,
        ],
        allowedRoles: [Role.CUSTOMER, Role.VENDOR],
      },

      // System handles payment confirmation
      PAYMENT_CONFIRMED: { from: [OrderStatus.AWAITING_PAYMENT], allowedRoles: [] },

      // Vendor starts cooking
      COOKING: { from: [OrderStatus.PAYMENT_CONFIRMED], allowedRoles: [Role.VENDOR] },

      // Optional delivery flow
      READY_FOR_PICKUP: { from: [OrderStatus.COOKING], allowedRoles: [Role.VENDOR] },
      OUT_FOR_DELIVERY: { from: [OrderStatus.READY_FOR_PICKUP], allowedRoles: [Role.VENDOR] },
      COMPLETED: { from: [OrderStatus.OUT_FOR_DELIVERY], allowedRoles: [Role.VENDOR] },

      // Cancel rules
      CANCELLED: {
        from: [
          OrderStatus.PENDING,
          OrderStatus.WAITING_VENDOR_CONFIRMATION,
          OrderStatus.WAITING_CUSTOMER_APPROVAL,
          OrderStatus.AWAITING_PAYMENT,
          OrderStatus.PAYMENT_CONFIRMED,
          OrderStatus.COOKING,
          OrderStatus.OUT_FOR_DELIVERY,
        ],
        allowedRoles: [Role.CUSTOMER, Role.VENDOR],
      },

      FAILED_DELIVERY: { from: [OrderStatus.OUT_FOR_DELIVERY], allowedRoles: [Role.VENDOR] },


      // System-managed payment timeout (auto cancel)
PAYMENT_EXPIRED: {
  from: [OrderStatus.AWAITING_PAYMENT],
  allowedRoles: [], // system only
},

// Automatically cancelled due to unpaid order
CANCELLED_UNPAID: {
  from: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_EXPIRED],
  allowedRoles: [], // system only
},



      
    };

    // 🧩 7. Validate transition
    const rule = transitionRules[status as OrderStatus];
    if (!rule) {
      res.status(400).json(errorResponse("INVALID_TRANSITION", "Invalid status transition"));
      return;
    }

    if (!rule.from.includes(currentStatus)) {
      res.status(400).json(
        errorResponse("INVALID_TRANSITION", `Cannot transition from ${currentStatus} to ${status}`)
      );
      return;
    }

    if (!rule.allowedRoles.includes(userRole)) {
      res.status(403).json(errorResponse("FORBIDDEN", "You are not allowed to perform this transition"));
      return;
    }

    // 🔄 8. Build update data
    let updateData: Partial<Order> = { status: status as OrderStatus };

    // ✅ AWAITING_PAYMENT: check product live state and clear any grace
    if (status === OrderStatus.AWAITING_PAYMENT) {
      const firstItem = order.items?.[0];
      const product = firstItem?.product;

      if (!product) {
        res.status(400).json(errorResponse("INVALID_ORDER", "Order has no product to validate live status"));
        return;
      }

      const now = new Date();
      const sched = product.productSchedule;
      let productIsLive = false;

      if (product.isLive) {
        productIsLive = true;
      } else if (sched?.goLiveAt && sched?.takeDownAt) {
        const go = new Date(sched.goLiveAt).getTime();
        const take = new Date(sched.takeDownAt).getTime();
        productIsLive = now.getTime() >= go && now.getTime() <= take;
      }

      if (!productIsLive) {
        res.status(400).json(errorResponse("PRODUCT_OFFLINE", "Product is not live — cannot move to AWAITING_PAYMENT"));
        return;
      }

      // Clear previous payment timestamps (no grace active yet)
      // updateData.paymentInitiatedAt = null;
      // updateData.paymentExpiresAt = null;
    }

    // 💡 Automatically mark expired payments as cancelled
    if (
      order.paymentExpiresAt &&
      new Date() > order.paymentExpiresAt &&
      status !== OrderStatus.CANCELLED
    ) {
      updateData.status = OrderStatus.CANCELLED;
      updateData.cancelledAt = new Date();
      updateData.cancellationReason = "PAYMENT_EXPIRED";
    }

    // 🟥 Manual cancellation
    if (status === OrderStatus.CANCELLED) {
      updateData.cancelledAt = new Date();
      updateData.cancellationReason = isVendor ? "VENDOR_CANCELLED" : "CUSTOMER_CANCELLED";
    }

    // 💾 9. Update in DB
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: updateData,
    });

    // 🔔 10. Notify the other user
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

    // ✅ 11. Return response
    res.status(200).json(
      successResponse("ORDER_STATUS_UPDATED", `Order status updated to ${status}`, {
        order: updatedOrder,
      })
    );
  } catch (err) {
    console.error("❌ updateOrderStatus Error:", err);
    res.status(500).json(errorResponse("SERVER_ERROR", "Failed to update order status"));
  }
};








export const initiateOrderPayment = async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, mobileSdk = false } = req.body;
    const userId = req.user?.id;

    // 🔒 1️⃣ Authentication
    if (!userId) {
      return res.status(401).json(errorResponse("UNAUTHORIZED", "Unauthorized"));
    }

    // 🧩 2️⃣ Validate request
    const parsed = startPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request data",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // 🔍 3️⃣ Fetch order + product schedules
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        payments: true,
        Product: {
          select: {
            id: true,
            name: true,
            productSchedule: {
              select: { takeDownAt: true, graceMinutes: true },
            },
          },
        },
      },
    });

    if (!order || order.customerId !== userId) {
      return res.status(400).json(errorResponse("INVALID_ORDER", "Invalid order for payment"));
    }

    // 🚫 4️⃣ Ensure eligible status
    if (order.status !== "AWAITING_PAYMENT") {
      return res.status(400).json(errorResponse("NOT_READY_FOR_PAYMENT", "Order is not eligible for payment"));
    }

    // 💰 5️⃣ Prevent duplicate successful payments
    const hasPaid = order.payments.some((p) => p.status.toLowerCase() === "success");
    if (hasPaid) {
      return res.status(400).json(errorResponse("ALREADY_PAID", "Order already paid for"));
    }

    // ⏳ 6️⃣ Check product schedules
    const now = new Date();
    let paymentWindowExpiresAt = new Date(now.getTime() + 15 * 60 * 1000); // default 15 min

    // Check all products for takeDownAt + graceMinutes
    for (const product of order.Product) {
      const schedule = product.productSchedule;
      if (schedule?.takeDownAt) {
        const grace = schedule.graceMinutes ?? 15;
        const effectiveClose = new Date(schedule.takeDownAt.getTime() + grace * 60 * 1000);

        if (now >= effectiveClose) {
          return res.status(400).json(
            errorResponse("PRODUCT_OFFLINE", `Product "${product.name}" is currently offline and cannot accept new orders.`)
          );
        }

        // Use the earliest closing among all products
        paymentWindowExpiresAt = new Date(Math.min(paymentWindowExpiresAt.getTime(), effectiveClose.getTime()));
      }
    }


        // 🌟 7️⃣ Update order to protect it from cleanup
    await prisma.order.update({
      where: { id: orderId },
      data: {
        protectedUntil: paymentWindowExpiresAt, // shields order from cancellation until this time
      },
    });



    // 🌍 7️⃣ Gather client info for audit trail
    const { ip, userAgent, deviceId, country, city } = getClientInfo(req);
    const channel =
      mobileSdk || req.headers["x-device-channel"]?.toString().toLowerCase() === "mobile"
        ? "mobile"
        : "web";

    // 📱 8️⃣ MOBILE SDK FLOW
    if (mobileSdk) {
      const reference = `order_${orderId}_${Date.now()}`;

      await prisma.payment.create({
        data: {
          amount: order.totalPrice,
          reference,
          status: "pending",
          expiresAt: paymentWindowExpiresAt,
          channel,
          ipAddress: ip,
          deviceId: userAgent,
          geoCity: city || "unknown",
          geoCountry: country || "unknown",
          user: { connect: { id: userId } },
          order: { connect: { id: orderId } },
        },
      });

      return res.status(200).json({
        message: "Mobile payment initialized successfully",
        paymentData: {
          reference,
          amount: Math.round(order.totalPrice * 100), // kobo
          email: order.customer.email,
          publicKey: config.paystackPublicKey,
          metadata: { userId, orderId, platform: "mobile" },
        },
        expiresAt: paymentWindowExpiresAt,
      });
    }

    // 💻 9️⃣ WEB FLOW
    const paymentInit = await initializePayment(
      Math.round(order.totalPrice * 100),
      order.customer.email,
      { userId, orderId, platform: "web" }
    );

    await prisma.payment.create({
      data: {
        amount: order.totalPrice,
        reference: paymentInit.reference,
        status: "pending",
        expiresAt: paymentWindowExpiresAt,
        channel,
        ipAddress: ip,
        deviceId: userAgent,
        geoCity: city || "unknown",
        geoCountry: country || "unknown",
        user: { connect: { id: userId } },
        order: { connect: { id: orderId } },
      },
    });

    // ✅ 10️⃣ Response
    return res.status(201).json({
      message: "Payment initialized successfully",
      paymentUrl: paymentInit.authorization_url,
      reference: paymentInit.reference,
      expiresAt: paymentWindowExpiresAt,
      paymentProtectedWindow: order.protectedUntil
    });
  } catch (error: any) {
    console.error("❌ Payment initiation error:", error);
    return res.status(500).json(errorResponse("PAYMENT_INIT_FAILED", error?.message || "Failed to initiate payment"));
  }
};

























import { OrderStatus } from "@prisma/client";
import prisma from "../../config/prismaClient";

/**
 * 🧹 Automatically cancels expired or invalid orders in batches.
 * - Cancels only AWAITING_PAYMENT orders
 * - Respects product schedules, liveUntil, manual offline, and payment expiration
 * - Safe against infinite loops / CPU spikes
 */
export const runOrderCleanupJob = async (batchSize = 1000) => {
  const now = new Date(); // UTC-aware
  const graceMinutesDefault = 15;
  let offlineUpdated = 0;

  try {
    console.log("🧹 Running order cleanup job...", now.toISOString());

    let loopCounter = 0;
    while (true) {
      loopCounter++;
      if (loopCounter > 1000) {
        console.error(
          "⚠️ Cleanup loop hit 1000 iterations — breaking to prevent CPU spike"
        );
        break;
      }

      // Fetch orders where payment could expire or product went offline
      const batch = await prisma.order.findMany({
        where: {
          status: OrderStatus.AWAITING_PAYMENT,
          items: {
            some: {
              product: {
                OR: [
                  { isLive: false },
                  { productSchedule: { takeDownAt: { lt: now } } },
                ],
              },
            },
          },
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  isLive: true,
                  liveUntil: true, // <-- manual last live time
                  productSchedule: {
                    select: { takeDownAt: true, graceMinutes: true },
                  },
                },
              },
            },
          },
          payments: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        take: batchSize,
      });

      if (batch.length === 0) break;

      for (const order of batch) {
        const latestPayment = order.payments[0];
        const orderGrace = order.paymentGraceMinutes ?? graceMinutesDefault;

        // Determine if any product is offline
        const productOffline = order.items.some((item) => {
          const prod = item.product;
          const sch = prod.productSchedule;
          const grace = sch?.graceMinutes ?? orderGrace;

          const scheduledClose = sch?.takeDownAt
            ? new Date(sch.takeDownAt.getTime() + grace * 60000)
            : null;
          const liveUntilClose = prod.liveUntil ? new Date(prod.liveUntil) : null;

          return (
            !prod.isLive ||
            (scheduledClose && now > scheduledClose) ||
            (liveUntilClose && now > liveUntilClose)
          );
        });

        const paymentExpired = latestPayment?.expiresAt
          ? now > latestPayment.expiresAt
          : true;

        // 🔹 Diagnostic log: shows why the order may or may not cancel
        console.log({
          orderId: order.id,
          productOffline,
          paymentExpired,
          latestPaymentExpires: latestPayment?.expiresAt,
          now,
        });

        // Cancel if both product offline and payment expired (or no payment)
        if (!latestPayment || (productOffline && paymentExpired)) {
          console.log(
            `❌ Cancelling order ${order.id} — productOffline: ${productOffline}, paymentExpired: ${paymentExpired}`
          );
          await prisma.order.update({
            where: { id: order.id },
            data: {
              status: OrderStatus.CANCELLED,
              cancelledAt: now,
              cancellationReason: productOffline
                ? "PRODUCT_WENT_OFFLINE_BEFORE_PAYMENT"
                : "PAYMENT_EXPIRED",
              paymentStatus: "FAILED",
            },
          });
          offlineUpdated++;
        }
      }
    }

    console.log(`✅ Cleanup done → Offline cancelled: ${offlineUpdated}`);
  } catch (err) {
    console.error(
      "❌ Error in order cleanup job:",
      err instanceof Error ? err.message : err
    );
  }
};

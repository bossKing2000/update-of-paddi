// import prisma from "../../../lib/prisma";
// import { handleSuccessfulPayment, verifyPayment } from "../../../services/paymentService";
// import { Payment, Order, OrderItem } from "@prisma/client";
// import { OrderStatus } from "@prisma/client";

// /**
//  * 🧾 Verify pending payments in batches (CPU/memory efficient)
//  */
// export async function verifyPendingPayments(batchSize = 50) {
//   console.log("[VERIFY] 🔍 Checking for pending payments...");

//   try {
//     let lastId: string | null = null;

//     while (true) {
//       const pendingPayments: (Payment & { order: Order | null })[] = await prisma.payment.findMany({
//         where: { status: { in: ["pending", "initiated"] } },
//         include: { order: true },
//         orderBy: { id: "asc" },
//         take: batchSize,
//         cursor: lastId ? { id: lastId } : undefined,
//         skip: lastId ? 1 : 0,
//       });

//       if (pendingPayments.length === 0) break;

//       const now = new Date();

//       for (const payment of pendingPayments) {
//         try {
//           if (payment.expiresAt && now > payment.expiresAt) {
//             console.log(`[VERIFY] ⏰ Payment ${payment.reference} expired locally.`);

//             await prisma.$transaction([
//               prisma.payment.update({
//                 where: { id: payment.id },
//                 data: { status: "expired" },
//               }),
//               prisma.order.updateMany({
//                 where: { id: payment.orderId, status: "AWAITING_PAYMENT" },
//                 data: {
//                   status: "CANCELLED",
//                   cancellationReason: "PAYMENT_EXPIRED",
//                   cancelledAt: now,
//                 },
//               }),
//             ]);
//             continue;
//           }

//           const data = await verifyPayment(payment.reference);
//           if (data.status === "success" && payment.order) {
//             console.log(`[VERIFY] ✅ Payment ${payment.reference} confirmed by Paystack.`);
//             await handleSuccessfulPayment(payment.order, payment.reference);
//           }
//         } catch (err: any) {
//           console.error(`[VERIFY] ❌ Error verifying ${payment.reference}: ${err.message}`);
//         }
//       }

//       lastId = pendingPayments[pendingPayments.length - 1].id;
//       await new Promise((resolve) => setTimeout(resolve, 50));
//     }

//     console.log("[VERIFY] ✅ Pending payment verification completed.");
//   } catch (err: any) {
//     console.error(`[VERIFY] ❌ Failed to fetch pending payments: ${err.message}`);
//   }
// }


import prisma from "../../../lib/prisma";
import { handleSuccessfulPayment, verifyPayment, OrderFromHandler } from "../../../services/paymentService";
import { Payment, Order, OrderItem, Product } from "@prisma/client";
import { OrderStatus } from "@prisma/client";

// Define the type for the payment with complete order data
type PaymentWithCompleteOrder = Payment & {
  order: (Order & {
    items: (OrderItem & {
      product: {
        id: string;
        name: string;
        productSchedule: {
          takeDownAt: Date | null;
          graceMinutes: number | null;
        } | null;
      };
    })[];
  }) | null;
};

/**
 * 🧾 Verify pending payments in batches (CPU/memory efficient)
 */
export async function verifyPendingPayments(batchSize = 50) {
  console.log("[VERIFY] 🔍 Checking for pending payments...");

  try {
    let lastId: string | null = null;

    while (true) {
      // 🎯 FIXED: Fetch complete order data with products and schedules
      const pendingPayments: PaymentWithCompleteOrder[] = await prisma.payment.findMany({
        where: { 
          status: { in: ["pending", "initiated"] } 
        },
        include: { 
          order: {
            include: {
              items: {
                include: {
                  product: {
                    select: {
                      id: true,
                      name: true,
                      productSchedule: {
                        select: { 
                          takeDownAt: true, 
                          graceMinutes: true 
                        }
                      }
                    }
                  }
                }
              }
            }
          } 
        },
        orderBy: { id: "asc" },
        take: batchSize,
        cursor: lastId ? { id: lastId } : undefined,
        skip: lastId ? 1 : 0,
      });

      if (pendingPayments.length === 0) break;

      const now = new Date();

      for (const payment of pendingPayments) {
        try {
          // Check if payment expired locally
          if (payment.expiresAt && now > payment.expiresAt) {
            console.log(`[VERIFY] ⏰ Payment ${payment.reference} expired locally.`);

            await prisma.$transaction([
              prisma.payment.update({
                where: { id: payment.id },
                data: { status: "expired" },
              }),
              prisma.order.updateMany({
                where: { 
                  id: payment.orderId, 
                  status: "AWAITING_PAYMENT" 
                },
                data: {
                  status: "CANCELLED",
                  cancellationReason: "PAYMENT_EXPIRED",
                  cancelledAt: now,
                },
              }),
            ]);
            continue;
          }

          // Verify with Paystack
          const data = await verifyPayment(payment.reference);
          
          if (data.status === "success" && payment.order) {
            console.log(`[VERIFY] ✅ Payment ${payment.reference} confirmed by Paystack.`);
            
            // 🎯 FIXED: Transform order data to match handleSuccessfulPayment interface
            const orderForHandler: OrderFromHandler = {
              id: payment.order.id,
              customerId: payment.order.customerId,
              vendorId: payment.order.vendorId,
              totalPrice: payment.order.totalPrice,
              status: payment.order.status,
              paymentInitiatedAt: payment.order.paymentInitiatedAt,
              paymentGraceMinutes: payment.order.paymentGraceMinutes,
              // 🎯 CRITICAL: Map items to Product array with schedules
              Product: payment.order.items.map((item) => ({
                id: item.product.id,
                name: item.product.name,
                productSchedule: item.product.productSchedule
              }))
            };
            
            // Pass transformed order data to handleSuccessfulPayment
            await handleSuccessfulPayment(orderForHandler, payment.reference);
          }
        } catch (err: any) {
          console.error(`[VERIFY] ❌ Error verifying ${payment.reference}: ${err.message}`);
        }
      }

      lastId = pendingPayments[pendingPayments.length - 1].id;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log("[VERIFY] ✅ Pending payment verification completed.");
  } catch (err: any) {
    console.error(`[VERIFY] ❌ Failed to fetch pending payments: ${err.message}`);
  }
}
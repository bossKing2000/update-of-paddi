"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPendingPayments = verifyPendingPayments;
const prisma_1 = __importDefault(require("../../../lib/prisma"));
const paymentService_1 = require("../../../services/paymentService");
/**
 * 🧾 Verify pending payments in batches (CPU/memory efficient)
 */
async function verifyPendingPayments(batchSize = 50) {
    console.log("[VERIFY] 🔍 Checking for pending payments...");
    try {
        let lastId = null;
        while (true) {
            const pendingPayments = await prisma_1.default.payment.findMany({
                where: { status: { in: ["pending", "initiated"] } },
                include: { order: true },
                orderBy: { id: "asc" },
                take: batchSize,
                cursor: lastId ? { id: lastId } : undefined,
                skip: lastId ? 1 : 0,
            });
            if (pendingPayments.length === 0)
                break;
            const now = new Date();
            for (const payment of pendingPayments) {
                try {
                    if (payment.expiresAt && now > payment.expiresAt) {
                        console.log(`[VERIFY] ⏰ Payment ${payment.reference} expired locally.`);
                        await prisma_1.default.$transaction([
                            prisma_1.default.payment.update({
                                where: { id: payment.id },
                                data: { status: "expired" },
                            }),
                            prisma_1.default.order.updateMany({
                                where: { id: payment.orderId, status: "AWAITING_PAYMENT" },
                                data: {
                                    status: "CANCELLED",
                                    cancellationReason: "PAYMENT_EXPIRED",
                                    cancelledAt: now,
                                },
                            }),
                        ]);
                        continue;
                    }
                    const data = await (0, paymentService_1.verifyPayment)(payment.reference);
                    if (data.status === "success" && payment.order) {
                        console.log(`[VERIFY] ✅ Payment ${payment.reference} confirmed by Paystack.`);
                        await (0, paymentService_1.handleSuccessfulPayment)(payment.order, payment.reference);
                    }
                }
                catch (err) {
                    console.error(`[VERIFY] ❌ Error verifying ${payment.reference}: ${err.message}`);
                }
            }
            lastId = pendingPayments[pendingPayments.length - 1].id;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        console.log("[VERIFY] ✅ Pending payment verification completed.");
    }
    catch (err) {
        console.error(`[VERIFY] ❌ Failed to fetch pending payments: ${err.message}`);
    }
}

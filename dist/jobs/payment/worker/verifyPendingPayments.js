"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPendingPayments = verifyPendingPayments;
const prisma_1 = __importDefault(require("../../../lib/prisma"));
const paymentService_1 = require("../../../services/paymentService");
const paymentFinalizer_service_1 = require("../../../services/paymentFinalizer.service");
const logger_1 = require("../../../lib/logger");
const client_1 = require("@prisma/client");
/**
 * Catch-up job for payments that succeeded at Paystack but somehow never
 * got confirmed here — the webhook didn't arrive (network blip on
 * Paystack's end, our server was mid-deploy, etc.) and the customer never
 * hit the post-redirect confirm endpoint either (closed the tab). Runs
 * periodically to reconcile against Paystack directly.
 *
 * Delegates the actual confirmation to the same finalizePaymentSuccess
 * used by the webhook and confirmPayment — this job's only job is to
 * find candidates and ask Paystack "did this actually succeed?"
 */
async function verifyPendingPayments(batchSize = 50) {
    logger_1.logger.info("Checking for pending payments to verify");
    let lastId = null;
    let checked = 0;
    let confirmed = 0;
    let expired = 0;
    try {
        while (true) {
            const pendingPayments = await prisma_1.default.payment.findMany({
                where: {
                    status: { in: [client_1.PaymentStatus.PENDING, client_1.PaymentStatus.INITIATED] },
                },
                orderBy: { id: "asc" },
                take: batchSize,
                cursor: lastId ? { id: lastId } : undefined,
                skip: lastId ? 1 : 0,
            });
            if (pendingPayments.length === 0)
                break;
            const now = new Date();
            for (const payment of pendingPayments) {
                checked++;
                try {
                    // Locally expired and never even queried Paystack — no point
                    // asking, just expire it. finalizePaymentSuccess's own lock
                    // handles races with a webhook that might still be in flight.
                    if (payment.expiresAt && now > payment.expiresAt) {
                        await prisma_1.default.$transaction([
                            prisma_1.default.payment.update({
                                where: { id: payment.id },
                                data: { status: client_1.PaymentStatus.EXPIRED },
                            }),
                            prisma_1.default.order.updateMany({
                                where: {
                                    id: payment.orderId,
                                    status: {
                                        in: [client_1.OrderStatus.AWAITING_PAYMENT, client_1.OrderStatus.PENDING],
                                    },
                                },
                                data: {
                                    status: client_1.OrderStatus.CANCELLED_UNPAID,
                                    cancellationReason: "PAYMENT_EXPIRED",
                                    cancelledAt: now,
                                    paymentStatus: client_1.PaymentStatus.EXPIRED,
                                },
                            }),
                        ]);
                        expired++;
                        continue;
                    }
                    const data = await (0, paymentService_1.verifyPayment)(payment.reference);
                    if (data.status === "success") {
                        const result = await (0, paymentFinalizer_service_1.finalizePaymentSuccess)({
                            reference: payment.reference,
                            amountInNaira: data.amount / 100,
                            customerIdFromGateway: data.metadata?.userId,
                            channel: data.channel,
                            paystackData: data,
                            authorization: data.authorization,
                        });
                        if (result.outcome === "SUCCESS")
                            confirmed++;
                        logger_1.logger.info({ reference: payment.reference, outcome: result.outcome }, "verifyPendingPayments: reconciled with Paystack");
                    }
                }
                catch (err) {
                    logger_1.logger.error({ err, reference: payment.reference }, "verifyPendingPayments: error checking payment");
                }
            }
            lastId = pendingPayments[pendingPayments.length - 1].id;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        logger_1.logger.info({ checked, confirmed, expired }, "verifyPendingPayments completed");
    }
    catch (err) {
        logger_1.logger.error({ err }, "verifyPendingPayments failed to fetch pending payments");
    }
}

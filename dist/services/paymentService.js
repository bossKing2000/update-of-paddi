"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPayment = exports.initializePayment = void 0;
exports.cancelOrdersForOfflineProduct = cancelOrdersForOfflineProduct;
// src/services/paymentService.ts
const client_1 = require("@prisma/client");
const axiosClient_1 = require("../lib/axiosClient");
const prisma_1 = __importDefault(require("../lib/prisma"));
const logger_1 = require("../lib/logger");
const time_1 = require("../utils/time");
/**
 * ----------------------------
 *  PAYSTACK PAYMENT FUNCTIONS
 * ----------------------------
 */
const initializePayment = async (amount, email, metadata) => {
    const response = await axiosClient_1.paystack.post("/transaction/initialize", { email, amount, metadata });
    return response.data.data;
};
exports.initializePayment = initializePayment;
const verifyPayment = async (reference) => {
    const response = await axiosClient_1.paystack.get(`/transaction/verify/${reference}`);
    return response.data.data;
};
exports.verifyPayment = verifyPayment;
// NOTE: the payment-confirmation logic that used to live here
// (`handleSuccessfulPayment`) has been consolidated into
// `services/paymentFinalizer.service.ts`'s `finalizePaymentSuccess`. It
// had diverged from the webhook handler's own (separate, more thorough)
// confirmation logic — no amount validation, no customer-consistency
// check, and it always failed to attach a receipt (passed the Paystack
// reference where a Payment row's `id` was expected). Every entry point
// that can learn a payment succeeded — the webhook, confirmPayment,
// chargeSavedCard, and the verifyPendingPayments job — now calls the one
// canonical implementation instead.
/**
 * ----------------------------
 * CANCEL ORDERS FOR SPECIFIC OFFLINE PRODUCT
 * ----------------------------
 * Cancels AWAITING_PAYMENT orders containing a product that's gone
 * offline, but only once that order's own payment window has also
 * expired — a customer who's already mid-payment shouldn't have their
 * order yanked out from under them just because the vendor happened to
 * close up shop in the same few minutes.
 */
async function cancelOrdersForOfflineProduct(productId) {
    const now = (0, time_1.nowUtc)();
    const defaultGraceMinutes = 15;
    try {
        const orders = await prisma_1.default.order.findMany({
            where: { items: { some: { productId } }, status: client_1.OrderStatus.AWAITING_PAYMENT },
            include: {
                payments: { orderBy: { createdAt: "desc" }, take: 1 },
                items: { include: { product: { include: { productSchedule: { select: { takeDownAt: true, graceMinutes: true } } } } } },
            },
        });
        for (const order of orders) {
            const latestPayment = order.payments[0];
            const orderGrace = order.paymentGraceMinutes ?? defaultGraceMinutes;
            const productLiveUntil = order.items.reduce((earliest, item) => {
                const sch = item.product.productSchedule;
                if (!sch?.takeDownAt)
                    return earliest;
                const takeDownUtc = (0, time_1.toUtc)(sch.takeDownAt);
                const grace = sch.graceMinutes ?? orderGrace;
                const effectiveClose = (0, time_1.addMinutesUtc)(takeDownUtc, grace);
                return earliest ? new Date(Math.min(earliest.getTime(), effectiveClose.getTime())) : effectiveClose;
            }, null);
            const productOffline = productLiveUntil && (0, time_1.isAfterUtc)(now, productLiveUntil);
            const paymentExpired = latestPayment?.expiresAt && (0, time_1.isAfterUtc)(now, latestPayment.expiresAt);
            if (!latestPayment || (productOffline && paymentExpired)) {
                await prisma_1.default.order.update({
                    where: { id: order.id },
                    data: {
                        status: client_1.OrderStatus.CANCELLED,
                        cancelledAt: now,
                        cancellationReason: productOffline ? "PRODUCT_WENT_OFFLINE_BEFORE_PAYMENT" : "PAYMENT_EXPIRED",
                        paymentStatus: "FAILED",
                    },
                });
            }
        }
        logger_1.logger.info({ productId, cancelledCount: orders.length }, "cancelOrdersForOfflineProduct completed");
    }
    catch (err) {
        logger_1.logger.error({ err, productId }, "cancelOrdersForOfflineProduct failed");
    }
}

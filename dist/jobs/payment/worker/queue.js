"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processWebhooks = processWebhooks;
const prisma_1 = __importDefault(require("../../../lib/prisma"));
const paymentService_1 = require("../../../services/paymentService");
async function processWebhooks() {
    const pendingEvents = await prisma_1.default.webhookEvent.findMany({
        where: { status: 'pending' },
    });
    for (const evt of pendingEvents) {
        try {
            // Mark as processing
            await prisma_1.default.webhookEvent.update({
                where: { id: evt.id },
                data: { status: 'processing' },
            });
            if (!evt.payload) {
                await prisma_1.default.webhookEvent.update({
                    where: { id: evt.id },
                    data: { status: 'failed' },
                });
                continue;
            }
            const payload = evt.payload;
            // Check if payment already exists and is successful
            const payment = await prisma_1.default.payment.findUnique({
                where: { reference: payload.data.reference },
            });
            if (payment?.status === 'success') {
                await prisma_1.default.webhookEvent.update({
                    where: { id: evt.id },
                    data: { status: 'done', processedAt: new Date() },
                });
                continue;
            }
            // Fetch the full order object
            const order = await prisma_1.default.order.findUnique({
                where: { id: payload.data.metadata.orderId },
            });
            if (!order) {
                console.error(`[WEBHOOK] Order not found for ID ${payload.data.metadata.orderId}`);
                await prisma_1.default.webhookEvent.update({
                    where: { id: evt.id },
                    data: { status: 'failed' },
                });
                continue;
            }
            // Call the payment handler with the full Order object
            await (0, paymentService_1.handleSuccessfulPayment)(order, payload.data.reference);
            // Mark webhook as done
            await prisma_1.default.webhookEvent.update({
                where: { id: evt.id },
                data: { status: 'done', processedAt: new Date() },
            });
        }
        catch (err) {
            console.error('[WEBHOOK] Processing error:', err.message || err);
            await prisma_1.default.webhookEvent.update({
                where: { id: evt.id },
                data: { status: 'failed' },
            });
        }
    }
}
// Run every few seconds / minutes
setInterval(processWebhooks, 5000);

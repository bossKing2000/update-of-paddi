import prisma from "../../../lib/prisma";
import { handleSuccessfulPayment } from "../../../services/paymentService";

type PaystackWebhookPayload = {
  event: string;
  data: {
    reference: string;
    metadata: { orderId: string };
  };
};

export async function processWebhooks() {
  const pendingEvents = await prisma.webhookEvent.findMany({
    where: { status: 'pending' },
  });

  for (const evt of pendingEvents) {
    try {
      // Mark as processing
      await prisma.webhookEvent.update({
        where: { id: evt.id },
        data: { status: 'processing' },
      });

      if (!evt.payload) {
        await prisma.webhookEvent.update({
          where: { id: evt.id },
          data: { status: 'failed' },
        });
        continue;
      }

      const payload = evt.payload as PaystackWebhookPayload;

      // Check if payment already exists and is successful
      const payment = await prisma.payment.findUnique({
        where: { reference: payload.data.reference },
      });

      if (payment?.status === 'success') {
        await prisma.webhookEvent.update({
          where: { id: evt.id },
          data: { status: 'done', processedAt: new Date() },
        });
        continue;
      }

      // Fetch the full order object
      const order = await prisma.order.findUnique({
        where: { id: payload.data.metadata.orderId },
      });

      if (!order) {
        console.error(`[WEBHOOK] Order not found for ID ${payload.data.metadata.orderId}`);
        await prisma.webhookEvent.update({
          where: { id: evt.id },
          data: { status: 'failed' },
        });
        continue;
      }

      // Call the payment handler with the full Order object
      await handleSuccessfulPayment(order, payload.data.reference);

      // Mark webhook as done
      await prisma.webhookEvent.update({
        where: { id: evt.id },
        data: { status: 'done', processedAt: new Date() },
      });

    } catch (err: any) {
      console.error('[WEBHOOK] Processing error:', err.message || err);
      await prisma.webhookEvent.update({
        where: { id: evt.id },
        data: { status: 'failed' },
      });
    }
  }
}

// Run every few seconds / minutes
setInterval(processWebhooks, 5000);

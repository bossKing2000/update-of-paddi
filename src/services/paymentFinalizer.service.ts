import {
  PaymentStatus,
  OrderStatus,
  Order,
  ActivityType,
} from "@prisma/client";
import retry from "async-retry";
import prisma from "../lib/prisma";
import { logger } from "../lib/logger";
import { generateReceipt } from "../utils/generate Receipt/generateReceipt";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { nowUtc, toUtc, isBeforeUtc } from "../utils/time";

const LOCK_STALE_MS = 2 * 60 * 1000; // a lock older than this is treated as abandoned (crashed process), not "in progress"

export interface FinalizePaymentInput {
  reference: string;
  amountInNaira: number;
  /** metadata.userId from the payment gateway, when available, for a cross-check against the order's actual customer */
  customerIdFromGateway?: string;
  channel?: string;
  paystackData?: unknown;
  authorization?: {
    reusable?: boolean;
    authorization_code?: string;
    last4?: string;
    brand?: string;
  };
}

export type FinalizeOutcome =
  | "SUCCESS"
  | "ALREADY_PROCESSED"
  | "LOCKED"
  | "PAYMENT_NOT_FOUND"
  | "AMOUNT_MISMATCH"
  | "CUSTOMER_MISMATCH"
  | "LATE_PAYMENT";

export interface FinalizeResult {
  outcome: FinalizeOutcome;
  orders?: Order[];
}

/**
 * Confirms a payment succeeded and applies every downstream effect:
 * validates it, marks the payment + all associated orders (a checkout can
 * span multiple vendors, and therefore multiple orders sharing one
 * idempotencyKey) as paid, generates a receipt, saves a reusable card if
 * offered, and notifies both customer and vendor(s).
 *
 * Safe to call from multiple entry points concurrently — acquires a
 * per-payment lock first (self-healing: a lock left stuck by a crashed
 * process is reclaimed after 2 minutes rather than blocking forever).
 */
export async function finalizePaymentSuccess(
  input: FinalizePaymentInput,
): Promise<FinalizeResult> {
  const { reference } = input;

  const lock = await prisma.payment.updateMany({
    where: {
      reference,
      OR: [
        { isProcessing: false },
        { processingStartedAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } },
      ],
    },
    data: { isProcessing: true, processingStartedAt: new Date() },
  });

  if (lock.count === 0) {
    const exists = await prisma.payment.findUnique({
      where: { reference },
      select: { id: true },
    });
    if (!exists) return { outcome: "PAYMENT_NOT_FOUND" };
    // Someone else (webhook, confirmPayment, the catch-up job) is
    // finalizing this exact reference right now — don't race them.
    logger.info(
      { reference },
      "Payment finalization already in progress elsewhere, skipping",
    );
    return { outcome: "LOCKED" };
  }

  try {
    return await runFinalizer(input);
  } finally {
    await prisma.payment
      .updateMany({
        where: { reference, isProcessing: true },
        data: { isProcessing: false, processingStartedAt: null },
      })
      .catch((err) =>
        logger.error(
          { err, reference },
          "Failed to release payment processing lock",
        ),
      );
  }
}

async function getOrdersForPayment(payment: {
  orderId: string;
  idempotencyKey: string | null;
}): Promise<Order[]> {
  if (payment.idempotencyKey) {
    const orders = await prisma.order.findMany({
      where: { idempotencyKey: payment.idempotencyKey },
    });
    if (orders.length > 0) return orders;
  }
  const order = await prisma.order.findUnique({
    where: { id: payment.orderId },
  });
  return order ? [order] : [];
}

async function runFinalizer(
  input: FinalizePaymentInput,
): Promise<FinalizeResult> {
  const {
    reference,
    amountInNaira,
    customerIdFromGateway,
    channel,
    paystackData,
    authorization,
  } = input;

  // Only the actual database writes below are wrapped in retry — reads
  // and validation are simple and not worth retrying on their own. bail()
  // is reserved for genuinely non-retryable write conflicts (e.g. a
  // concurrent unique-constraint violation); every other terminal outcome
  // (not found, mismatch, late) is returned normally without throwing —
  // those aren't errors to retry, they're legitimate final answers.
  return retry(
    async (bail: (err: unknown) => void): Promise<FinalizeResult> => {
      const payment = await prisma.payment.findUnique({ where: { reference } });
      if (!payment) return { outcome: "PAYMENT_NOT_FOUND" };

      const orders = await getOrdersForPayment(payment);
      if (orders.length === 0) return { outcome: "PAYMENT_NOT_FOUND" };

      // Idempotency — if this reference was already finalized (e.g. the
      // webhook and confirmPayment both reached here moments apart, one
      // after the other's lock released), just make sure every order
      // reflects it and stop. No error, no re-processing.
      if (payment.status === PaymentStatus.SUCCESS) {
        const outOfSync = orders.filter(
          (o) => o.paymentStatus !== PaymentStatus.SUCCESS,
        );
        if (outOfSync.length > 0) {
          await prisma.order.updateMany({
            where: { id: { in: outOfSync.map((o) => o.id) } },
            data: { paymentStatus: PaymentStatus.SUCCESS },
          });
        }
        return { outcome: "ALREADY_PROCESSED", orders };
      }

      const customerId = orders[0].customerId;

      if (customerIdFromGateway && customerIdFromGateway !== customerId) {
        await prisma.payment.update({
          where: { reference },
          data: {
            status: PaymentStatus.FAILED,
            paystackData: paystackData as any,
          },
        });
        logger.warn(
          { reference, customerId, customerIdFromGateway },
          "Payment customer mismatch",
        );
        return { outcome: "CUSTOMER_MISMATCH" };
      }

      // Amount is validated against the sum of every order in the batch,
      // not a single order — a multi-vendor checkout pays for all of them
      // in one Paystack transaction.
      const expectedTotal = orders.reduce((sum, o) => sum + o.totalPrice, 0);
      if (Math.abs(amountInNaira - expectedTotal) > 1) {
        await prisma.payment.update({
          where: { reference },
          data: {
            status: PaymentStatus.AMOUNT_MISMATCH,
            paystackData: paystackData as any,
          },
        });
        logger.warn(
          { reference, expectedTotal, amountInNaira },
          "Payment amount mismatch",
        );
        return { outcome: "AMOUNT_MISMATCH" };
      }

      // Timing safety: an order stays protected until protectedUntil, or
      // until its payment reference expires — whichever is later. A batch
      // payment covering several orders uses the latest protection window
      // among them (paying late for one vendor in the cart shouldn't
      // punish the others).
      const now = nowUtc();
      const protections = orders
        .map((o) => (o.protectedUntil ? toUtc(o.protectedUntil) : null))
        .filter((d): d is Date => !!d);
      const latestProtection =
        protections.length > 0
          ? new Date(Math.max(...protections.map((d) => d.getTime())))
          : null;
      const expiresAtUtc = payment.expiresAt ? toUtc(payment.expiresAt) : null;

      const isWithinProtection = latestProtection
        ? isBeforeUtc(now, latestProtection)
        : false;
      const isBeforeExpiry = expiresAtUtc
        ? isBeforeUtc(now, expiresAtUtc)
        : false;

      if (!isWithinProtection && !isBeforeExpiry) {
        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { reference },
            data: {
              status: PaymentStatus.LATE_PAYMENT,
              paystackData: paystackData as any,
            },
          });
          for (const order of orders) {
            if (
              order.status === OrderStatus.AWAITING_PAYMENT ||
              order.status === OrderStatus.PENDING
            ) {
              await tx.order.update({
                where: { id: order.id },
                data: {
                  status: OrderStatus.CANCELLED_UNPAID,
                  cancellationReason: "LATE_PAYMENT",
                  cancelledAt: now,
                  paymentStatus: PaymentStatus.LATE_PAYMENT,
                },
              });
            }
          }
        });
        logger.warn(
          { reference, orderIds: orders.map((o) => o.id) },
          "Late payment received after protection window",
        );
        return { outcome: "LATE_PAYMENT" };
      }

      if (authorization?.reusable && authorization.authorization_code) {
        try {
          await prisma.userPaymentMethod.upsert({
            where: { cardToken: authorization.authorization_code },
            create: {
              userId: customerId,
              cardToken: authorization.authorization_code,
              last4: authorization.last4 || "",
              brand: (authorization.brand || "unknown").toLowerCase(),
              isDefault: false,
            },
            update: { updatedAt: now },
          });
        } catch (err) {
          logger.warn(
            { err, reference },
            "Failed to save reusable card (non-critical)",
          );
        }
      }

      try {
        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { reference },
            data: {
              status: PaymentStatus.SUCCESS,
              completedAt: now,
              channel: channel || payment.channel,
              paystackData: paystackData as any,
            },
          });

          for (const order of orders) {
            const isFreshConfirmation =
              order.status === OrderStatus.AWAITING_PAYMENT ||
              order.status === OrderStatus.PENDING;
            await tx.order.update({
              where: { id: order.id },
              data: {
                status: isFreshConfirmation
                  ? OrderStatus.PAYMENT_CONFIRMED
                  : order.status,
                paymentStatus: PaymentStatus.SUCCESS,
                paidAt: order.paidAt || now,
              },
            });
          }
        });
      } catch (err: any) {
        if (err.code === "P2002" || err.code === "P2025") {
          bail(err);
          throw err; // unreachable after bail(), but keeps TS control-flow analysis happy
        }
        throw err; // transient — let async-retry try again
      }

      // Receipt generation is best-effort — a failure here shouldn't undo
      // an already-confirmed payment. (Previously this always failed
      // silently: every caller passed the Paystack `reference` where
      // generateReceipt actually expects the Payment row's own `id`.)
      try {
        const receipt = await generateReceipt(payment.id);
        logger.info({ reference, pdfUrl: receipt.pdfUrl }, "Receipt generated");
      } catch (err) {
        logger.warn(
          { err, reference },
          "Receipt generation failed (non-critical)",
        );
      }

      for (const order of orders) {
        await recordActivityBundle({
          actorId: customerId,
          orderId: order.id,
          actions: [
            {
              type: ActivityType.PAYMENT_SUCCESS,
              title: "Payment Successful",
              message: `Your payment for order #${order.id} was confirmed.`,
              targetId: customerId,
              socketEvent: "PAYMENT",
              metadata: {
                type: "PAYMENT_SUCCESS",
                route: `/orders/${order.id}`,
                orderId: order.id,
                reference,
                amount: amountInNaira,
                frontendEvent: "PAYMENT_CONFIRMED",
              },
            },
            {
              type: ActivityType.NEW_PAID_ORDER,
              title: "New Paid Order",
              message: `You have received a new paid order #${order.id}.`,
              targetId: order.vendorId,
              socketEvent: "ORDER",
              metadata: {
                type: "NEW_PAID_ORDER",
                route: `/vendor/orders/${order.id}`,
                orderId: order.id,
                vendorId: order.vendorId,
                customerId,
                reference,
                amount: amountInNaira,
                frontendEvent: "NEW_PAID_ORDER_RECEIVED",
              },
            },
          ],
          audit: {
            action: "PAYMENT_SUCCESS",
            metadata: {
              orderId: order.id,
              reference,
              amount: amountInNaira,
              customerId,
              vendorId: order.vendorId,
            },
          },
          notifyRealtime: true,
          notifyPush: true,
        });
      }

      logger.info(
        { reference, orderIds: orders.map((o) => o.id), amount: amountInNaira },
        "Payment finalized successfully",
      );
      return { outcome: "SUCCESS", orders };
    },
    { retries: 3, factor: 2, minTimeout: 500, maxTimeout: 2000 },
  );
}

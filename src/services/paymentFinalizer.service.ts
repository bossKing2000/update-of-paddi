import {
  PaymentStatus,
  OrderStatus,
  Order,
  ActivityType,
  RefundStatus,
  Prisma,
} from "@prisma/client";
import retry from "async-retry";
import prisma from "../lib/prisma";
import { restoreStockForOrders } from "./inventory.service";
import { clearProductCache } from "./clearCaches";
import { logger } from "../lib/logger";
import { fileRefundOwed } from "./refundObligation.service";
import { generateReceipt } from "../utils/generate Receipt/generateReceipt";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { nowUtc, toUtc, isBeforeUtc } from "../utils/time";

const LOCK_STALE_MS = 2 * 60 * 1000; // a lock older than this is treated as abandoned (crashed process), not "in progress"

// Every charge this system initiates is NGN (see initializePayment and the
// transfer/recipient calls). Returned amounts are verified against it.
const EXPECTED_CURRENCY = "NGN";

export interface FinalizePaymentInput {
  reference: string;
  // Integer kobo (Phase 3A). Paystack reports amounts in integer kobo, and
  // order totals are stored as integer kobo, so both sides of the comparison
  // are kobo. Callers must pass the raw gateway amount (no / 100).
  amountKobo: number;
  /** ISO currency reported by the provider for this transaction, when supplied. */
  currency?: string;
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
  /** Payment captured, but at least one order was already cancelled and now has a filed refund obligation. */
  | "SUCCESS_REFUND_PENDING"
  | "ALREADY_PROCESSED"
  | "LOCKED"
  | "PAYMENT_NOT_FOUND"
  | "AMOUNT_MISMATCH"
  | "CUSTOMER_MISMATCH"
  | "LATE_PAYMENT"
  /**
   * FIN-07-02: a capture was verified for a payment this system had already
   * expired locally. The payment stays EXPIRED and one refund obligation was
   * filed per unfulfillable order; nothing else was written.
   */
  | "LATE_CAPTURE_REFUND_FILED";

export interface FinalizeResult {
  outcome: FinalizeOutcome;
  orders?: Order[];
  /** Orders that were already cancelled and received a refund request for this captured payment. */
  refundPendingOrderIds?: string[];
}

/**
 * Phase 3.2.6 (F-A3): orders that can never reach fulfilment again but
 * whose payment was captured by this run. A confirmed customer charge must
 * never sit on a dead order with no recoverable obligation, so each one
 * gets exactly one order-bounded PENDING refund request.
 *
 * This mirrors the paid-cancel guard in `updateOrderStatus` (order-scoped
 * `requestedAmountKobo`, never the payment total) with one deliberate
 * tightening: the open-request check is scoped to THIS order rather than the
 * whole payment, so a multi-vendor batch where two orders died can still
 * file one obligation per order instead of the first request masking the
 * rest. Over-refund remains impossible — the admin submit path always
 * re-bounds the amount by the remaining balance.
 */
const REFUND_OWED_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.CANCELLED_UNPAID,
];

/**
 * FIN-07-02 — reason recorded on obligations filed for a capture that arrived
 * after the reference was already expired locally. Shares the `LATE_PAYMENT`
 * token used by the expiry paths' `cancellationReason`, so both the order and
 * the obligation can be found from either record.
 */
const LATE_CAPTURE_REFUND_REASON =
  "LATE_PAYMENT: payment captured after the local payment window expired";

async function fileRefundOwedForCancelledOrder(
  tx: Prisma.TransactionClient,
  args: {
    orderId: string;
    customerId: string;
    paymentRef: string;
    // Integer kobo (Phase 3A). Order.totalPrice is stored in kobo; pass it
    // directly — no * 100, which would double-convert.
    totalPriceKobo: number;
    reason: string;
  },
): Promise<boolean> {
  const existing = await tx.refundRequest.findFirst({
    where: {
      paymentRef: args.paymentRef,
      orderId: args.orderId,
      status: {
        in: [
          RefundStatus.PENDING,
          RefundStatus.APPROVED,
          RefundStatus.PROCESSING,
        ],
      },
    },
    select: { id: true },
  });
  if (existing) return false;

  // C-2: conflict-tolerant insert (ON CONFLICT DO NOTHING against the partial
  // unique index), so a concurrent finalizer cannot produce a duplicate open
  // obligation. Because the conflict never raises, it cannot reach the
  // P2002/P2025 catch that calls bail() and permanently fails the job.
  // `created` is false when a concurrent writer won, which correctly reports
  // "this call did not file an obligation" to the caller.
  const { created } = await fileRefundOwed(tx, {
    userId: args.customerId,
    paymentRef: args.paymentRef,
    reason: args.reason,
    orderId: args.orderId,
    // Order-bounded, never the payment total (a batch payment covers
    // several vendors' orders and only this one is dead).
    requestedAmountKobo: args.totalPriceKobo,
  });
  return created;
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
    amountKobo,
    currency,
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
        const statusOutOfSync = orders.filter(
          (o) => o.status === OrderStatus.AWAITING_PAYMENT || o.status === OrderStatus.PENDING,
        );
        if (outOfSync.length > 0 || statusOutOfSync.length > 0) {
          await prisma.$transaction(async (tx) => {
            if (outOfSync.length > 0) {
              // Payment truth only — this write never moves an order
              // status, so it cannot resurrect a cancelled order.
              //
              // Phase 3.2.10 (F2-01): the marker write is predicated on the
              // same unresolved set the success path uses
              // (`PENDING, INITIATED`). Without it, a duplicate
              // `charge.success` for a fully refunded order flipped
              // `paymentStatus: REFUNDED` back to `SUCCESS`, leaving the
              // order's financial markers contradicting its refund
              // history. The excluded values are exactly those that record
              // a decision that must stand:
              //   REFUNDED        — terminal refund (refundFinalizer)
              //   EXPIRED         — expiry worker settled the payment
              //   LATE_PAYMENT    — late-payment branch killed the order
              //   AMOUNT_MISMATCH / FAILED — deliberate verdicts
              // An EXPIRED/CANCELLED order is deliberately left untouched
              // rather than re-marked: this branch has no refund obligation
              // to file, so aligning such a marker here would re-create the
              // very "captured payment with no refund owed" state the
              // success path refuses to create.
              //
              // No order-status predicate is needed: this write cannot
              // change `status`, and the protected markers live on
              // `paymentStatus`. `count === 0` simply means every candidate
              // had already reached a settled marker (or was concurrently
              // updated) — nothing here branches on that count, so a lost
              // race never produces a compensating write.
              const truthSync = await tx.order.updateMany({
                where: {
                  id: { in: outOfSync.map((o) => o.id) },
                  paymentStatus: {
                    in: [PaymentStatus.PENDING, PaymentStatus.INITIATED],
                  },
                },
                data: { paymentStatus: PaymentStatus.SUCCESS },
              });
              if (truthSync.count === 0) {
                logger.info(
                  {
                    reference,
                    orderIds: outOfSync.map((o) => o.id),
                  },
                  "Payment-truth re-sync matched no unresolved orders; settled markers preserved",
                );
              }
            }
            // Phase 3.2.8 (F-2): the confirmation re-sync is a
            // per-order conditional claim on the same payable-pending set
            // the success path uses. The previous bulk write filtered only
            // on id, so a cancellation that landed between the read above
            // and this transaction was overwritten back to
            // PAYMENT_CONFIRMED. `count === 0` means a competing
            // transition won; the loser writes nothing and has no
            // winner-only side effects to run here.
            for (const order of statusOutOfSync) {
              await tx.order.updateMany({
                where: {
                  id: order.id,
                  status: {
                    in: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PENDING],
                  },
                },
                data: {
                  status: OrderStatus.PAYMENT_CONFIRMED,
                  paidAt: order.paidAt ?? orders[0].paidAt ?? new Date(),
                },
              });
            }
          });
        }
        return { outcome: "ALREADY_PROCESSED", orders };
      }

      // FIN-07-02. The provider has reported a CAPTURED charge for a payment
      // this system already expired locally — `verifyPendingPayments` settles a
      // reference to EXPIRED as soon as `expiresAt` passes, WITHOUT asking the
      // provider whether the charge actually succeeded. A charge that completes
      // in that window (slow 3-D Secure, bank transfer, a delayed webhook) was
      // therefore captured against a record that can never fulfil anything.
      //
      // Before this branch that money produced no obligation at all: the
      // terminal guard below returned ALREADY_PROCESSED with zero writes, the
      // webhook answered 200, and Paystack's retries were suppressed by the
      // replay claim. The order-expiry cron then cancelled the order, and the
      // captured funds had no queryable record of being owed back.
      //
      // What this branch deliberately does NOT do, per the agreed policy:
      //   * it never rewrites `Payment.status` — EXPIRED stays EXPIRED, so the
      //     terminal record is preserved and no F-A1 claim is bypassed;
      //   * it never touches `Order.status` — a cancelled order stays
      //     cancelled, and stock restoration is left to the path that owns it;
      //   * it never calls Paystack — the obligation is a PENDING RefundRequest
      //     that an administrator approves through the existing workflow.
      //
      // It is reached only for EXPIRED. Every other settled state (LATE_PAYMENT,
      // AMOUNT_MISMATCH, FAILED, REFUNDED) still falls through to the terminal
      // guard below with zero writes, which `paymentRaceHardening.test.ts`
      // asserts and this change leaves intact.
      if (payment.status === PaymentStatus.EXPIRED) {
        // Same three checks the success path applies, but non-mutating: an
        // EXPIRED payment cannot be claimed, so a mismatch here must leave it
        // exactly as it is rather than overwrite a terminal record.
        if (
          input.customerIdFromGateway &&
          input.customerIdFromGateway !== orders[0].customerId
        ) {
          logger.warn(
            { reference, customerId: orders[0].customerId, gatewayCustomerId: input.customerIdFromGateway },
            "Expired payment received a success event for a different customer; refusing to file an obligation",
          );
          return { outcome: "ALREADY_PROCESSED", orders };
        }
        if (String(input.currency ?? "").toUpperCase() !== EXPECTED_CURRENCY) {
          logger.warn(
            { reference, currency: input.currency ?? null },
            "Expired payment received a success event in a non-NGN currency; refusing to file an obligation",
          );
          return { outcome: "ALREADY_PROCESSED", orders };
        }
        // Multi-vendor batches pay one transaction for several orders, so the
        // expected total is the sum across the batch — exactly as the success
        // path computes it. Both sides are integer kobo (Phase 3A), so the
        // comparison is exact; no / 100 and no naira/kobo mixing.
        const expectedTotal = orders.reduce((sum, o) => sum + o.totalPrice, 0);
        if (
          !Number.isFinite(amountKobo) ||
          !Number.isFinite(expectedTotal) ||
          amountKobo !== expectedTotal
        ) {
          logger.warn(
            { reference, expectedTotal, amountKobo: input.amountKobo },
            "Expired payment received a success event for an unexpected amount; refusing to file an obligation",
          );
          return { outcome: "ALREADY_PROCESSED", orders };
        }

        const refundPendingOrderIds: string[] = [];
        await prisma.$transaction(async (tx) => {
          // Authoritative re-read: `orders` is a pre-transaction snapshot.
          for (const snapshot of orders) {
            const current = await tx.order.findUnique({
              where: { id: snapshot.id },
              select: { status: true, customerId: true, totalPrice: true },
            });
            if (!current) continue;
            // Only orders that can no longer be fulfilled owe money back. An
            // order still in a payable-pending state is deliberately left to
            // the expiry path that owns it — this branch must not cancel it.
            if (!REFUND_OWED_ORDER_STATUSES.includes(current.status)) continue;

            // `fileRefundOwedForCancelledOrder` re-checks for an open request on
            // (paymentRef, orderId) before creating, so a repeated webhook or a
            // reconciliation pass cannot file a second obligation. Concurrent
            // finalizations of the same reference are serialized by the
            // per-payment lock taken in `finalizePaymentSuccess`, which closes
            // the find-then-create window.
            await fileRefundOwedForCancelledOrder(tx, {
              orderId: snapshot.id,
              customerId: current.customerId,
              paymentRef: reference,
              totalPriceKobo: current.totalPrice,
              // Leads with the same token the expiry path writes on the order's
              // cancellationReason, so the obligation is findable from either
              // record.
              reason: LATE_CAPTURE_REFUND_REASON,
            });
            refundPendingOrderIds.push(snapshot.id);
          }
        });

        logger.warn(
          { reference, orderIds: orders.map((o) => o.id), filedForOrderIds: refundPendingOrderIds },
          refundPendingOrderIds.length > 0
            ? "Capture confirmed for an expired payment — refund obligations filed"
            : "Capture confirmed for an expired payment — no refundable order found",
        );
        return {
          outcome: "LATE_CAPTURE_REFUND_FILED",
          orders,
          refundPendingOrderIds,
        };
      }
      // that is STILL pending may be decided by this run. A delayed or
      // duplicate success event for an EXPIRED, LATE_PAYMENT,
      // AMOUNT_MISMATCH, FAILED, REFUNDED, or otherwise settled payment
      // must not rewrite that terminal record — recovery for those states
      // is manual refund or a fresh payment reference, never an overwrite.
      // Returning ALREADY_PROCESSED keeps the invocation idempotent with
      // zero writes and no retry.
      if (
        payment.status !== PaymentStatus.PENDING &&
        payment.status !== PaymentStatus.INITIATED
      ) {
        logger.info(
          { reference, status: payment.status },
          "Payment already settled; ignoring duplicate success event",
        );
        return { outcome: "ALREADY_PROCESSED", orders };
      }

      const customerId = orders[0].customerId;

      // Phase 3.2.6 (F-A1): every payment-status write below is a
      // CONDITIONAL claim on [PENDING, INITIATED]. The terminal guard above
      // is a pre-transaction read, so an expiry worker or a second
      // finalizer can settle this reference in the window between that read
      // and the write. An unconditional update would then overwrite that
      // newer terminal record. `count === 0` means the transition was lost:
      // this run writes nothing and reports the payment as already settled
      // rather than fabricating a mismatch/failure verdict over a record it
      // no longer owns.
      const claimPaymentStatus = async (
        status: PaymentStatus,
      ): Promise<boolean> => {
        const claimed = await prisma.payment.updateMany({
          where: {
            reference,
            status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
          },
          data: { status, paystackData: paystackData as any },
        });
        if (claimed.count === 0) {
          logger.warn(
            { reference, attemptedStatus: status },
            "Payment status claim lost to a concurrent transition",
          );
          return false;
        }
        return true;
      };

      if (customerIdFromGateway && customerIdFromGateway !== customerId) {
        if (!(await claimPaymentStatus(PaymentStatus.FAILED))) {
          return { outcome: "ALREADY_PROCESSED", orders };
        }
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
      // Batch F: currency is fail-closed. Every charge this system creates
      // is NGN, and Paystack reports the settled currency on verify and
      // charge payloads. A missing or non-NGN currency takes the same
      // mismatch path as a wrong amount: the money is held for review, no
      // order is touched.
      if (String(currency ?? "").toUpperCase() !== EXPECTED_CURRENCY) {
        if (!(await claimPaymentStatus(PaymentStatus.AMOUNT_MISMATCH))) {
          return { outcome: "ALREADY_PROCESSED", orders };
        }
        logger.warn(
          { reference, currency: currency ?? null },
          "Payment currency mismatch",
        );
        return { outcome: "AMOUNT_MISMATCH" };
      }
      // Stage F (E-01): both sides MUST be finite before comparison.
      // Stage F (E-01): both sides MUST be finite before comparison.
      // `Math.abs(NaN - x) > 1` is false, so without this guard a missing
      // or malformed gateway amount (undefined/100 = NaN) would sail
      // through as "matching". Malformed values take the same
      // AMOUNT_MISMATCH path as genuine mismatches — tolerance unchanged.
      // Both sides are integer kobo (Phase 3A) — the gateway amount and the
      // order totals originate from the same checkout, so the comparison is
      // exact. No / 100, no naira/kobo mixing, no tolerance dust.
      if (
        !Number.isFinite(amountKobo) ||
        !Number.isFinite(expectedTotal) ||
        amountKobo !== expectedTotal
      ) {
        if (!(await claimPaymentStatus(PaymentStatus.AMOUNT_MISMATCH))) {
          return { outcome: "ALREADY_PROCESSED", orders };
        }
        logger.warn(
          { reference, expectedTotal, amountKobo },
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
        const killedOrderIds: string[] = [];
        const lateRefundOwedOrderIds: string[] = [];
        let restoredProductIds: string[] = [];
        // P3.2-01: every write below is conditional. The orders array above
        // is a pre-lock snapshot, so a concurrent expiry, cancellation, or
        // success may have moved an order (or settled this payment) between
        // that read and this transaction. Only the execution that wins each
        // conditional transition may perform its dependent side effects.
        let paymentTransitioned = false;
        await prisma.$transaction(async (tx) => {
          // Only a still-pending payment may become LATE_PAYMENT. If a
          // concurrent success or expiry already settled it, count === 0
          // and this execution must touch nothing — not orders, not stock.
          const paymentClaimed = await tx.payment.updateMany({
            where: {
              reference,
              status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
            },
            data: {
              status: PaymentStatus.LATE_PAYMENT,
              paystackData: paystackData as any,
            },
          });
          if (paymentClaimed.count === 0) {
            logger.warn(
              { reference },
              "Late-payment branch lost the payment transition race; leaving state untouched",
            );
            return;
          }
          paymentTransitioned = true;
          for (const order of orders) {
            // Per-order CAS: the stale snapshot only nominates candidates.
            // count === 1 proves THIS execution moved the order out of a
            // payable-pending state, and only then does it own the
            // reservation release for that order.
            const claimed = await tx.order.updateMany({
              where: {
                id: order.id,
                status: {
                  in: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PENDING],
                },
              },
              data: {
                status: OrderStatus.CANCELLED_UNPAID,
                cancellationReason: "LATE_PAYMENT",
                cancelledAt: now,
                paymentStatus: PaymentStatus.LATE_PAYMENT,
              },
            });
            if (claimed.count === 1) killedOrderIds.push(order.id);
          }
          // The unpaid orders die here, so their checkout-time stock
          // reservations die with them — atomically, in the same tx, and
          // only for orders this execution actually transitioned.
          restoredProductIds = await restoreStockForOrders(tx, killedOrderIds);

          // FIN-07-01. This branch is reached because the provider has just
          // reported a CAPTURED charge — the money is real and taken — and the
          // orders it covers can no longer be fulfilled. Without an obligation,
          // the customer has paid for orders that were killed here and nothing
          // in the database records that the money is owed back.
          //
          // The F-A3 success path already files exactly this obligation for an
          // order that was cancelled *before* the capture. A late capture is
          // the same financial situation arriving through the other door, so it
          // reuses the same helper and the same order-scoped dedupe rather than
          // introducing a parallel mechanism.
          //
          // Placed at the end of the transaction so the CAS -> restoreStock
          // adjacency above (and the invariant documented with it) is unchanged.
          //
          // Safety properties, unchanged from the rest of this branch:
          //   * Scoped to `killedOrderIds`. The per-order CAS is the idempotency
          //     boundary — an order a concurrent execution already cancelled
          //     returns count === 0 here and gets no second obligation.
          //   * Filed inside the same transaction as the capture, so it cannot
          //     be lost to a later crash and cannot outlive a rollback.
          //   * The helper itself re-checks for an open request on
          //     (paymentRef, orderId) before creating, so a rerun that does win
          //     the CAS again still files exactly one.
          //   * A failure here rolls the whole branch back and rethrows, so
          //     async-retry replays it against an untouched PENDING payment
          //     rather than leaving a killed order with no obligation.
          for (const orderId of killedOrderIds) {
            // Authoritative re-read. The `orders` snapshot is taken before
            // this transaction; the F-A3 path re-reads for the same reason, so
            // the recorded amount is the order's own total rather than a
            // possibly stale value.
            const current = await tx.order.findUnique({
              where: { id: orderId },
              select: { customerId: true, totalPrice: true },
            });
            if (!current) continue;
            await fileRefundOwedForCancelledOrder(tx, {
              orderId,
              customerId: current.customerId,
              paymentRef: reference,
              totalPriceKobo: current.totalPrice,
              // Leads with the same token the order's cancellationReason
              // carries (`LATE_PAYMENT`), so an operator can find the
              // obligation from either record.
              reason: "LATE_PAYMENT: payment captured after the order protection window expired",
            });
            lateRefundOwedOrderIds.push(orderId);
          }
        });
        if (!paymentTransitioned) {
          // Another execution settled the payment concurrently (success,
          // expiry, or a prior late run). Nothing was written, so there is
          // nothing to sweep and nothing to retry — report the reference as
          // already handled rather than as a fresh late payment.
          return { outcome: "ALREADY_PROCESSED", orders };
        }
        // Post-commit: the restored portions are purchasable again in the
        // database, so sweep the cached product rows that still show the old
        // stock. Best-effort — a failure only costs display staleness until
        // TTL expiry; it must never undo or re-trigger the committed restore.
        await Promise.all(
          [...new Set(restoredProductIds)].map((productId) =>
            clearProductCache(productId)
              .then((result) => {
                // The helper reports incomplete sweeps via its return, not
                // exceptions. `result &&` tolerates test doubles that stub
                // the helper as returning undefined.
                if (result && !result.ok) {
                  logger.warn(
                    { productId, reference, failures: result.failures },
                    "Product cache invalidation incomplete after late-payment stock restore",
                  );
                }
              })
              .catch((err) => {
                // Defensive only: the helper contract is never-throw, so
                // reaching here means the contract itself broke.
                logger.warn(
                  { err, productId, reference },
                  "Product cache invalidation threw unexpectedly after late-payment stock restore",
                );
              }),
          ),
        );
        logger.warn(
          { reference, orderIds: orders.map((o) => o.id) },
          "Late payment received after protection window",
        );
        if (lateRefundOwedOrderIds.length > 0) {
          logger.warn(
            { reference, orderIds: lateRefundOwedOrderIds },
            "Late payment captured for cancelled orders — refund obligations filed",
          );
        }
        return {
          outcome: "LATE_PAYMENT",
          orders,
          refundPendingOrderIds: lateRefundOwedOrderIds,
        };
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

      // Phase 3.2.6 (F-A1 + F-A3). The payment write is a conditional claim:
      // only a still-pending reference may become SUCCESS, so an expiry (or
      // another finalizer) that settled it first is never overwritten. The
      // per-order confirmation stays a CAS, and orders that lost it are
      // re-read from the database to decide what happens next — a stale
      // snapshot must not authorize anything.
      //
      // F-A3: an order that can never be fulfilled again (already CANCELLED
      // or CANCELLED_UNPAID) but whose payment was just captured MUST get a
      // durable refund obligation, otherwise the customer paid for nothing
      // and no record even says so. That obligation is filed in the same
      // transaction as the capture, so it cannot be lost to a later crash.
      const refundPendingOrderIds: string[] = [];
      let paymentClaimed = false;
      try {
        await prisma.$transaction(async (tx) => {
          const paymentUpdate = await tx.payment.updateMany({
            where: {
              reference,
              status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
            },
            data: {
              status: PaymentStatus.SUCCESS,
              completedAt: now,
              channel: channel || payment.channel,
              paystackData: paystackData as any,
            },
          });
          if (paymentUpdate.count === 0) {
            // Lost: another transition owns this record. Touch nothing —
            // no order writes, no receipt, no notification.
            logger.warn(
              { reference },
              "Payment success claim lost to a concurrent transition",
            );
            return;
          }
          paymentClaimed = true;

          for (const order of orders) {
            // Batch A (P3.2-01 success branch): the orders array is a
            // pre-transaction snapshot, so a concurrent expiry,
            // cancellation, or retry may have advanced an order since.
            // Only orders still in a payable-pending state move to
            // PAYMENT_CONFIRMED. Anything already advanced keeps its
            // status; payment truth is recorded only on rows whose
            // paymentStatus is itself still pending, so settled rows
            // (SUCCESS, EXPIRED, LATE_PAYMENT, REFUNDED, …) are never
            // clobbered by a stale success event.
            const confirmed = await tx.order.updateMany({
              where: {
                id: order.id,
                status: {
                  in: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PENDING],
                },
              },
              data: {
                status: OrderStatus.PAYMENT_CONFIRMED,
                paymentStatus: PaymentStatus.SUCCESS,
                paidAt: order.paidAt || now,
              },
            });
            if (confirmed.count === 1) continue;

            // Authoritative re-read — the snapshot may be stale.
            const current = await tx.order.findUnique({
              where: { id: order.id },
              select: { status: true, customerId: true, totalPrice: true },
            });
            if (!current) continue;

            await tx.order.updateMany({
              where: {
                id: order.id,
                paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
              },
              data: { paymentStatus: PaymentStatus.SUCCESS },
            });

            if (!REFUND_OWED_ORDER_STATUSES.includes(current.status)) continue;

            await fileRefundOwedForCancelledOrder(tx, {
              orderId: order.id,
              customerId: current.customerId,
              paymentRef: reference,
              totalPriceKobo: current.totalPrice,
              reason: "Payment received after the order was cancelled",
            });
            refundPendingOrderIds.push(order.id);
          }
        });
      } catch (err: any) {
        if (err.code === "P2002" || err.code === "P2025") {
          bail(err);
          throw err; // unreachable after bail(), but keeps TS control-flow analysis happy
        }
        throw err; // transient — let async-retry try again
      }

      if (!paymentClaimed) {
        // Another execution settled this payment while we were deciding.
        // The terminal state is left exactly as its owner wrote it, and no
        // winner-only side effect below runs.
        return { outcome: "ALREADY_PROCESSED", orders };
      }

      if (refundPendingOrderIds.length > 0) {
        logger.warn(
          { reference, orderIds: refundPendingOrderIds },
          "Payment captured for cancelled order(s); refund requested",
        );
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
                amount: amountKobo,
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
                amount: amountKobo,
                frontendEvent: "NEW_PAID_ORDER_RECEIVED",
              },
            },
          ],
          audit: {
            action: "PAYMENT_SUCCESS",
            metadata: {
              orderId: order.id,
              reference,
              amount: amountKobo,
              customerId,
              vendorId: order.vendorId,
            },
          },
          notifyRealtime: true,
          notifyPush: true,
        });
      }

      logger.info(
        { reference, orderIds: orders.map((o) => o.id), amount: amountKobo },
        "Payment finalized successfully",
      );

      // Phase 9.3: invalidate affected vendor dashboard caches after a
      // confirmed payment changes revenue/order aggregates. Best-effort and
      // non-throwing — a Redis failure only costs a stale dashboard until TTL.
      await Promise.all(
        [...new Set(orders.map((o) => o.vendorId))].map((vendorId) =>
          clearProductCache(undefined, vendorId).catch((err) =>
            logger.warn({ err, vendorId, reference }, "Dashboard cache invalidation after payment finalization failed"),
          ),
        ),
      );

      return {
        outcome:
          refundPendingOrderIds.length > 0
            ? "SUCCESS_REFUND_PENDING"
            : "SUCCESS",
        orders,
        refundPendingOrderIds,
      };
    },
    { retries: 3, factor: 2, minTimeout: 500, maxTimeout: 2000 },
  );
}

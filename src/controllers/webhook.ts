import { Request, Response } from "express";
import crypto from "crypto";
import { validatePaystackSignature } from "../utils/paystack";
import prisma from "../lib/prisma";
import { redisPayments } from "../lib/redis";
import { logger } from "../lib/logger";
import { createAuditLog } from "../utils/auditLog.service";
import { finalizePaymentSuccess } from "../services/paymentFinalizer.service";
import { matchRefundRequest, completeRefund, failRefund } from "../services/refundFinalizer.service";

// Events that only report Paystack's own transaction/refund lifecycle,
// not a charge. Handled separately from the charge.success finalize path.
const REFUND_EVENTS = [
  "refund.pending",
  "refund.processing",
  "refund.needs-attention",
  "refund.failed",
  "refund.processed",
] as const;

// ==================== CONSTANTS ====================
// Paystack retries live webhooks: every 3 mins for 4 tries, then hourly for 72h (https://paystack.com/docs/payments/webhooks/#go-live-checklist).
// Previously 24h meant legitimate retries after day 1 were incorrectly rejected as replays.
const REPLAY_TTL_SECONDS = 72 * 60 * 60; // 72 hours — matches Paystack's full retry window
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const MAX_REQUESTS_PER_WINDOW = 100;

// ==================== RATE LIMITING (Redis-backed) ====================
// Previously an in-memory Map keyed by IP. That only works within a
// single process — on any multi-instance deployment (the normal case in
// production) each instance had its own independent counter, so the
// limit was never actually enforced against the real aggregate request
// rate. Redis makes the counter shared and correct regardless of how
// many instances are running.
async function checkRateLimit(
  ip: string,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const key = `webhook:ratelimit:${ip}`;
  const count = await redisPayments.incr(key);
  if (count === 1) {
    await redisPayments.expire(key, RATE_LIMIT_WINDOW_SECONDS);
  }
  if (count > MAX_REQUESTS_PER_WINDOW) {
    const ttl = await redisPayments.ttl(key);
    return {
      allowed: false,
      retryAfter: ttl > 0 ? ttl : RATE_LIMIT_WINDOW_SECONDS,
    };
  }
  return { allowed: true };
}

// ==================== REPLAY PROTECTION (Redis-backed) ====================
// Same fix as rate limiting: an in-memory Map means a webhook retried
// against a different instance (or after a restart/deploy) was never
// recognized as a replay. Also fixed: the old dedup key included
// `process.pid` and a fresh timestamp, which meant a genuine Paystack
// retry of the exact same event looked like a brand-new, never-seen
// webhook every time — replay protection that could never actually fire.
// The key here is derived only from the event's own stable fields.
function computeWebhookId(eventPayload: any): string {
  // Refund events key off transaction_reference/refund_reference instead
  // of `reference` (charge/transfer events). Falling back to `reference`
  // only would make every refund event for a given amount collide on the
  // same replay-dedup key regardless of which transaction it belongs to.
  const stable = {
    event: eventPayload?.event,
    reference: eventPayload?.data?.reference ?? eventPayload?.data?.transaction_reference,
    refundReference: eventPayload?.data?.refund_reference,
    amount: eventPayload?.data?.amount,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex");
}

async function claimWebhookOnce(webhookId: string): Promise<boolean> {
  // SET ... NX EX is an atomic "claim if not already claimed" — no
  // separate check-then-set race window.
  const result = await redisPayments.set(`webhook:seen:${webhookId}`, "1", {
    NX: true,
    EX: REPLAY_TTL_SECONDS,
  });
  return result !== null;
}

// ==================== VALIDATION ====================
function validatePaystackWebhook(payload: any): {
  valid: boolean;
  data?: {
    event: string;
    data: {
      reference: string;
      amount: number;
      channel?: string;
      metadata?: { orderId?: string; userId?: string };
      authorization?: {
        authorization_code: string;
        last4: string;
        brand: string;
        reusable: boolean;
        channel?: string;
      };
      // refund.* events only
      status?: string;
      transaction_reference?: string;
      refund_reference?: string | null;
    };
  };
  error?: string;
} {
  if (!payload || typeof payload !== "object")
    return { valid: false, error: "Invalid payload format" };

  const isRefundEvent = (REFUND_EVENTS as readonly string[]).includes(payload.event);
  if (
    !isRefundEvent &&
    !["charge.success", "transfer.success", "transfer.failed"].includes(
      payload.event,
    )
  )
    return { valid: false, error: "Unsupported event type" };

  if (isRefundEvent) {
    // Refund events identify the transaction via transaction_reference,
    // not `reference` — see https://paystack.com/docs/payments/refunds/#listen-to-notifications
    if (!payload.data?.transaction_reference)
      return { valid: false, error: "Missing transaction_reference" };
    return { valid: true, data: payload };
  }

  if (!payload.data?.reference)
    return { valid: false, error: "Missing reference" };
  if (!payload.data?.amount) return { valid: false, error: "Missing amount" };
  return { valid: true, data: payload };
}

// ==================== MAIN WEBHOOK HANDLER ====================

export const paystackWebhookHandler = async (req: Request, res: Response) => {
  const startTime = Date.now();
  const requestId = crypto.randomBytes(16).toString("hex");
  const log = logger.child({ requestId, scope: "webhook" });
  let claimedWebhookId: string | null = null;

  try {
    // 1) RATE LIMITING
    const rateLimitResult = await checkRateLimit(req.ip || "unknown");
    if (!rateLimitResult.allowed) {
      log.warn({ ip: req.ip }, "Webhook rate limited");
      await createAuditLog({
        userId: null,
        action: "WEBHOOK_RATE_LIMITED",
        metadata: { requestId, ip: req.ip },
      });
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfter: rateLimitResult.retryAfter,
      });
    }

    // 2) VALIDATE RAW BODY & SIGNATURE
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      log.error(
        "Raw body must be a Buffer — check express.raw() is mounted before this route",
      );
      return res.status(400).send("Invalid body format");
    }

    const signature = req.headers["x-paystack-signature"] as string | undefined;
    if (!signature || !validatePaystackSignature(rawBody, signature)) {
      log.warn({ ip: req.ip }, "Invalid webhook signature");
      await createAuditLog({
        userId: null,
        action: "WEBHOOK_SIGNATURE_INVALID",
        metadata: { requestId, ip: req.ip },
      });
      return res.status(401).send("Unauthorized: Invalid signature");
    }

    // 3) PARSE PAYLOAD
    let eventPayload: any;
    try {
      eventPayload = JSON.parse(rawBody.toString());
    } catch {
      log.error("Failed to parse webhook JSON");
      return res.status(400).send("Invalid JSON");
    }

    const validation = validatePaystackWebhook(eventPayload);
    if (!validation.valid || !validation.data) {
      log.error(
        { error: validation.error },
        "Webhook payload validation failed",
      );
      return res.status(400).send(`Invalid payload: ${validation.error}`);
    }

    const { data, event } = validation.data;

    // 4) REPLAY PROTECTION
    const webhookId = computeWebhookId(eventPayload);
    claimedWebhookId = webhookId;
    const claimed = await claimWebhookOnce(webhookId);
    if (!claimed) {
      log.info(
        { reference: data.reference },
        "Replay detected, already processed",
      );
      return res.status(200).send("Webhook already processed");
    }

    const { reference, amount, metadata, authorization, channel } = data;

    await createAuditLog({
      userId: metadata?.userId || null,
      action: "WEBHOOK_RECEIVED",
      metadata: {
        requestId,
        webhookId,
        reference: reference || data.transaction_reference,
        amount,
        ip: req.ip,
      },
    });

    // 5a) REFUND LIFECYCLE. The admin's POST /refund only tells Paystack
    // to start a refund — it responds "pending"/"queued", not "done".
    // These events are the actual confirmation. Only refund.processed
    // and refund.failed change any record; the others (pending,
    // processing, needs-attention) are logged for visibility only.
    if ((REFUND_EVENTS as readonly string[]).includes(event)) {
      const transactionReference = data.transaction_reference!;
      const refundReference = data.refund_reference ?? undefined;
      const amountKobo = data.amount != null ? Number(data.amount) : undefined;

      if (event !== "refund.processed" && event !== "refund.failed") {
        log.info({ event, transactionReference, refundReference }, "Refund status update (non-terminal)");
        return res.status(200).send("Refund webhook acknowledged");
      }

      const match = await matchRefundRequest({ transactionReference, refundReference, amountKobo });

      if (match.kind === "amount_mismatch") {
        // A PROCESSING refund exists for this payment, but none of the
        // candidates requested the amount this webhook reports. Refusing
        // to complete an unexpected amount is the existing (correct)
        // safety behavior — what was missing was making it observable
        // instead of a silent 200.
        logger.error(
          {
            event,
            paymentRef: transactionReference,
            transactionReference,
            refundReference,
            expectedAmountsKobo: match.candidates.map((c) => c.requestedAmountKobo),
            receivedAmountKobo: amountKobo,
            candidateRefundRequestIds: match.candidates.map((c) => c.id),
          },
          "Refund webhook amount mismatch — refusing to complete",
        );
        await createAuditLog({
          userId: null,
          action: "REFUND_WEBHOOK_AMOUNT_MISMATCH",
          metadata: {
            event,
            transactionReference,
            refundReference,
            expectedAmountsKobo: match.candidates.map((c) => c.requestedAmountKobo),
            receivedAmountKobo: amountKobo,
            candidateRefundRequestIds: match.candidates.map((c) => c.id),
          },
        });
        // 200 so Paystack doesn't retry-storm us over something a retry
        // can't fix — the mismatch is now logged/audited for a human to
        // investigate, but the ledger and every RefundRequest are untouched.
        return res.status(200).send("Refund webhook received — amount did not match any pending refund, left unresolved");
      }

      if (match.kind === "ambiguous") {
        // Two or more same-amount partial refunds are PROCESSING with no
        // recorded Paystack id yet — we cannot tell which one this event
        // confirms. Guessing risks completing the wrong RefundRequest.
        logger.error(
          {
            event,
            transactionReference,
            refundReference,
            amountKobo,
            candidateRefundRequestIds: match.candidates.map((c) => c.id),
          },
          "Refund webhook matched multiple ambiguous PROCESSING refund requests — refusing to guess",
        );
        await createAuditLog({
          userId: null,
          action: "REFUND_WEBHOOK_AMBIGUOUS_MATCH",
          metadata: {
            event,
            transactionReference,
            refundReference,
            amountKobo,
            candidateRefundRequestIds: match.candidates.map((c) => c.id),
          },
        });
        return res.status(200).send("Refund webhook received — ambiguous match, left unresolved for reconciliation");
      }

      if (match.kind === "not_found") {
        // Not necessarily a problem — could be a refund from before this
        // matching logic existed, or a duplicate delivery for a request
        // that's already resolved and had its id cleared. Informational.
        log.info(
          { event, transactionReference, refundReference, amountKobo },
          "Refund webhook: no matching request found (already resolved, or not ours)",
        );
        return res.status(200).send("Refund webhook ignored — no matching request");
      }

      const refundRequest = match.request;

      if (event === "refund.processed") {
        const result = await completeRefund(refundRequest.id, { paystackRefundId: refundReference ?? null, source: "webhook" });
        log.info({ refundRequestId: refundRequest.id, transactionReference, result }, "Refund processed");
      } else {
        const result = await failRefund(refundRequest.id, { source: "webhook" });
        log.warn({ refundRequestId: refundRequest.id, transactionReference, result }, "Refund failed");
      }

      return res.status(200).send("Refund webhook processed");
    }

    // 5) SETTLE RIDER TRANSFERS. Wallets are debited only once a signed
    // transfer-success webhook arrives; a transfer failure releases the
    // reservation by marking the withdrawal FAILED without a wallet debit.
    if (event === "transfer.success" || event === "transfer.failed") {
      const vendorPayout = await prisma.vendorPayout.findFirst({
        where: { OR: [{ reference: data.reference }, { id: data.reference }] },
      });
      if (vendorPayout) {
        const expectedAmount = Math.round(vendorPayout.amount * 100);
        if (Number(data.amount) !== expectedAmount) {
          log.warn(
            {
              payoutId: vendorPayout.id,
              reference: data.reference,
              expectedAmount,
              receivedAmount: data.amount,
            },
            "Vendor payout webhook amount mismatch",
          );
          return res.status(200).send("Vendor payout webhook ignored");
        }

        if (vendorPayout.status !== "PROCESSING")
          return res.status(200).send("Vendor payout already settled");
        const settled = await prisma.vendorPayout.updateMany({
          where: { id: vendorPayout.id, status: "PROCESSING" },
          data:
            event === "transfer.success"
              ? { status: "PAID", paidAt: new Date(), failureReason: null }
              : {
                  status: "FAILED",
                  failureReason: String(
                    eventPayload.data?.gateway_response ||
                      eventPayload.data?.message ||
                      "Transfer failed",
                  ).slice(0, 500),
                },
        });
        if (settled.count === 1) {
          await createAuditLog({
            userId: null,
            action:
              event === "transfer.success"
                ? "VENDOR_PAYOUT_TRANSFER_SUCCEEDED"
                : "VENDOR_PAYOUT_TRANSFER_FAILED",
            metadata: {
              payoutId: vendorPayout.id,
              vendorId: vendorPayout.vendorId,
              reference: data.reference,
              amount: vendorPayout.amount,
            },
          });
        }
        return res.status(200).send("Vendor payout webhook processed");
      }

      const withdrawal = await prisma.riderWithdrawal.findUnique({
        where: { reference: data.reference },
      });
      if (!withdrawal) return res.status(200).send("Transfer webhook ignored");
      if (withdrawal.status !== "PROCESSING")
        return res.status(200).send("Transfer already settled");
      if (event === "transfer.success") {
        await prisma.$transaction([
          prisma.riderWithdrawal.update({
            where: { id: withdrawal.id },
            data: { status: "PAID", processedAt: new Date() },
          }),
          prisma.deliveryPerson.update({
            where: { id: withdrawal.deliveryPersonId },
            data: { walletBalance: { decrement: withdrawal.amount } },
          }),
        ]);
        await createAuditLog({
          userId: null,
          action: "RIDER_WITHDRAWAL_TRANSFER_SUCCEEDED",
          metadata: {
            withdrawalId: withdrawal.id,
            reference: data.reference,
            amount: withdrawal.amount,
          },
        });
      } else {
        await prisma.riderWithdrawal.update({
          where: { id: withdrawal.id },
          data: {
            status: "FAILED",
            failureReason: (
              eventPayload.data?.gateway_response ||
              eventPayload.data?.message ||
              "Transfer failed"
            ).slice(0, 500),
            processedAt: new Date(),
          },
        });
        await createAuditLog({
          userId: null,
          action: "RIDER_WITHDRAWAL_TRANSFER_FAILED",
          metadata: { withdrawalId: withdrawal.id, reference: data.reference },
        });
      }
      return res.status(200).send("Transfer webhook processed");
    }

    // 6) FINALIZE — the one canonical implementation, shared with
    // confirmPayment, chargeSavedCard, and the verifyPendingPayments job.
    const result = await finalizePaymentSuccess({
      reference,
      amountInNaira: amount / 100,
      customerIdFromGateway: metadata?.userId,
      channel,
      paystackData: eventPayload.data,
      authorization,
    });

    log.info(
      {
        reference,
        outcome: result.outcome,
        processingTimeMs: Date.now() - startTime,
      },
      "Webhook processed",
    );

    // Paystack only cares that we acknowledged receipt — always 200
    // unless the request itself was malformed/unauthorized (handled
    // above). The actual outcome is in the logs/audit trail.
    return res.status(200).send("Webhook processed");
  } catch (error: any) {
    if (claimedWebhookId) {
      await redisPayments
        .del(`webhook:seen:${claimedWebhookId}`)
        .catch((cleanupError) =>
          log.warn(
            { err: cleanupError, webhookId: claimedWebhookId },
            "Failed to release webhook replay claim",
          ),
        );
    }
    log.error(
      { err: error, processingTimeMs: Date.now() - startTime },
      "Webhook processing failed",
    );
    // Still 200 — Paystack will retry on non-2xx, and retries of a
    // genuinely broken payload won't succeed differently. Errors are
    // fully visible in logs/audit; a human investigates from there.
    return res.status(200).send("Webhook received (see logs for details)");
  }
};

// ==================== UTILITY ENDPOINTS ====================

export const webhookHealthCheck = async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redisPayments.ping();
    return res.status(200).json({ status: "ok" });
  } catch (err) {
    logger.error({ err }, "Webhook health check failed");
    return res.status(503).json({ status: "degraded" });
  }
};

export const webhookStats = async (_req: Request, res: Response) => {
  const [pending, success, failed] = await Promise.all([
    prisma.payment.count({ where: { status: "PENDING" } }),
    prisma.payment.count({ where: { status: "SUCCESS" } }),
    prisma.payment.count({
      where: { status: { in: ["FAILED", "AMOUNT_MISMATCH", "LATE_PAYMENT"] } },
    }),
  ]);
  return res.status(200).json({ pending, success, failed });
};

export const cleanupWebhooks = async (_req: Request, res: Response) => {
  // Redis TTLs (REPLAY_TTL_SECONDS) already handle cleanup automatically
  // — nothing to do manually here anymore. Kept as a route for backward
  // compatibility with anything that calls it.
  return res.status(200).json({
    message:
      "Replay-protection entries expire automatically via Redis TTL — no manual cleanup needed",
  });
};

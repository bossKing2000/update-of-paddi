import { Request, Response } from "express";
import crypto from "crypto";
import { validatePaystackSignature } from "../utils/paystack";
import prisma from "../lib/prisma";
import { redisPayments } from "../lib/redis";
import {
  acquireWebhookClaim,
  completeWebhookClaim,
  releaseWebhookClaim,
  newClaimToken,
  type ClaimOutcome,
  type WebhookClaim,
} from "../services/webhookReplayClaim.service";
import { logger } from "../lib/logger";
import { createAuditLog } from "../utils/auditLog.service";
import {
  settleRiderWithdrawalFailed,
  settleRiderWithdrawalPaid,
} from "../services/riderWithdrawalSettlement.service";
import {
  settleVendorPayoutFailed,
  settleVendorPayoutPaid,
} from "../services/vendorPayoutSettlement.service";
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

// The claim lifecycle itself lives in webhookReplayClaim.service.ts: an
// explicit inflight lease (owner-fenced, short TTL) promoted to a durable
// done key, so a claim that is created but never completed cannot suppress
// redelivery for the whole replay window.

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
    !["charge.success", "charge.failed", "transfer.success", "transfer.failed"].includes(
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
  let claimHeld = false;
  // Hoisted so the catch-all can release the lease; `claimHeld` is the
  // authoritative "we currently hold one" flag.
  let claim: WebhookClaim | null = null;

  try {
    // 1) RATE LIMITING. Batch C: a Redis failure here means the event was
    // NOT processed, so answer 503 (retryable) instead of letting the
    // catch-all below acknowledge it with 200 — Paystack only retries
    // non-2xx, and a 200 would silently drop a real payment event.
    let rateLimitResult: { allowed: boolean; retryAfter?: number };
    try {
      rateLimitResult = await checkRateLimit(req.ip || "unknown");
    } catch (err) {
      log.error({ err, ip: req.ip }, "Webhook rate limiter unavailable");
      return res.status(503).send("Webhook infrastructure unavailable, retry later");
    }
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

    // 4) REPLAY PROTECTION. Batch C: same fail-closed reasoning as rate
    // limiting — if the claim store is down the event was not processed.
    // Phase 3.2.8 (F-1): acquisition is a three-way decision, not a
    // boolean. DONE is a genuine duplicate. BUSY means another worker holds
    // a live lease — it is NOT completed, so it must not be acknowledged as
    // processed; the provider is told to retry instead, and the retry
    // either finds the event done or acquires it once the lease lapses.
    const webhookId = computeWebhookId(eventPayload);
    const heldClaim: WebhookClaim = { webhookId, token: newClaimToken() };
    claim = heldClaim;
    let outcome: ClaimOutcome;
    try {
      outcome = await acquireWebhookClaim(redisPayments, webhookId, heldClaim.token);
    } catch (err) {
      log.error({ err, webhookId }, "Webhook replay store unavailable");
      return res.status(503).send("Webhook infrastructure unavailable, retry later");
    }
    if (outcome === "DONE") {
      log.info(
        { reference: data.reference },
        "Replay detected, already processed",
      );
      return res.status(200).send("Webhook already processed");
    }
    if (outcome === "BUSY") {
      // Another worker is mid-flight. Not an acknowledgement: if that
      // worker dies, the lease lapses and a later delivery must be able to
      // process the event.
      log.info(
        { reference: data.reference },
        "Webhook already in flight on another worker",
      );
      return res.status(503).send("Webhook already being processed, retry later");
    }
    claimHeld = true;

    /**
     * Terminal exit for this event. A non-503 status means the handler
     * reached a decision — durably recorded, a deliberate no-op, or a
     * permanent rejection — so the event is promoted to `done` and future
     * deliveries are cheap duplicates. Completion is owner-checked: if the
     * lease already lapsed and someone else owns the event, this call does
     * nothing and the event stays eligible for retry.
     */
    const finish = async (code: number, body: string) => {
      if (!claimHeld) return res.status(code).send(body);
      try {
        const completed = await completeWebhookClaim(redisPayments, heldClaim);
        if (!completed) {
          log.warn(
            { webhookId },
            "Webhook lease lost before completion; event left retryable",
          );
        }
      } catch (err) {
        // A Redis failure while recording completion must not be turned
        // into a false acknowledgement: release our lease and let the
        // provider retry rather than confirming an unrecorded event.
        log.error({ err, webhookId }, "Failed to record webhook completion");
        try {
          await releaseWebhookClaim(redisPayments, heldClaim);
        } catch {
          /* lease lapses on its own */
        }
        claimHeld = false;
        return res.status(503).send("Webhook completion could not be recorded, retry later");
      }
      return res.status(code).send(body);
    };

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
        return await finish(200, "Refund webhook acknowledged");
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
        return await finish(200, "Refund webhook received — amount did not match any pending refund, left unresolved");
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
        return await finish(200, "Refund webhook received — ambiguous match, left unresolved for reconciliation");
      }

      if (match.kind === "not_found") {
        // Not necessarily a problem — could be a refund from before this
        // matching logic existed, or a duplicate delivery for a request
        // that's already resolved and had its id cleared. Informational.
        log.info(
          { event, transactionReference, refundReference, amountKobo },
          "Refund webhook: no matching request found (already resolved, or not ours)",
        );
        return await finish(200, "Refund webhook ignored — no matching request");
      }

      const refundRequest = match.request;

      if (event === "refund.processed") {
        const result = await completeRefund(refundRequest.id, { paystackRefundId: refundReference ?? null, source: "webhook" });
        log.info({ refundRequestId: refundRequest.id, transactionReference, result }, "Refund processed");
      } else {
        const result = await failRefund(refundRequest.id, { source: "webhook" });
        log.warn({ refundRequestId: refundRequest.id, transactionReference, result }, "Refund failed");
      }

      return await finish(200, "Refund webhook processed");
    }

    // 5) SETTLE RIDER TRANSFERS. Wallets are debited only once a signed
    // transfer-success webhook arrives; a transfer failure releases the
    // reservation by marking the withdrawal FAILED without a wallet debit.
    if (event === "transfer.success" || event === "transfer.failed") {
      const vendorPayout = await prisma.vendorPayout.findFirst({
        where: { OR: [{ reference: data.reference }, { id: data.reference }] },
      });
      if (vendorPayout) {
        // vendorPayout.amount is already integer kobo (Phase 3A). Paystack's
        // data.amount is also integer kobo. Compare directly — no * 100,
        // which would double-convert and corrupt the amount.
        const expectedAmountKobo = Number(vendorPayout.amount);
        if (Number(data.amount) !== expectedAmountKobo) {
          log.warn(
            {
              payoutId: vendorPayout.id,
              reference: data.reference,
              expectedAmount: expectedAmountKobo,
              receivedAmount: data.amount,
            },
            "Vendor payout webhook amount mismatch",
          );
          return await finish(200, "Vendor payout webhook ignored");
        }

        if (vendorPayout.status !== "PROCESSING")
          return await finish(200, "Vendor payout already settled");
        // N-06: settlement goes through the shared helper so the
        // PROCESSING -> PAID / FAILED CAS lives in exactly one place.
        // A verified success keeps the order claims (the money is genuinely
        // paid out); a verified failure releases them in the SAME
        // transaction, so those orders return to the eligible pool instead
        // of being stranded against a dead payout. Only the CAS winner
        // releases anything, so a concurrent reconciler or webhook can never
        // produce a double release.
        const settlement =
          event === "transfer.success"
            ? await settleVendorPayoutPaid(vendorPayout.id)
            : await settleVendorPayoutFailed(
                vendorPayout.id,
                String(
                  eventPayload.data?.gateway_response ||
                    eventPayload.data?.message ||
                    "Transfer failed",
                ).slice(0, 500),
              );
        const settled =
          settlement.outcome === "SETTLED" ? { count: 1 } : { count: 0 };
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
        return await finish(200, "Vendor payout webhook processed");
      }

      const withdrawal = await prisma.riderWithdrawal.findUnique({
        where: { reference: data.reference },
      });
      if (!withdrawal) return await finish(200, "Transfer webhook ignored");
      if (withdrawal.status !== "PROCESSING")
        return await finish(200, "Transfer already settled");
      if (event === "transfer.success") {
        // Batch G: verify the settled amount like the vendor path does.
        // Reference uniqueness already binds the event to this withdrawal;
        // the amount check additionally refuses a mismatched success
        // instead of debiting the wallet for money that never moved.
        // withdrawal.amount is already integer kobo (Phase 3A); compare
        // directly — no * 100.
        const expectedWithdrawalKobo = withdrawal.amount;
        if (Number(data.amount) !== expectedWithdrawalKobo) {
          log.warn(
            {
              withdrawalId: withdrawal.id,
              reference: data.reference,
              expectedAmount: expectedWithdrawalKobo,
              receivedAmount: data.amount,
            },
            "Rider withdrawal webhook amount mismatch",
          );
          return await finish(200, "Rider withdrawal webhook ignored");
        }
        // N-03: settlement is delegated to the shared helper used by the
        // reconciliation worker too, so the compare-and-set that guarantees
        // "a withdrawal debits its wallet at most once" is defined in exactly
        // one place. `settled === false` means another webhook/reconciler
        // already won the transition and did (or did not) the debit.
        const settlement = await settleRiderWithdrawalPaid(withdrawal.id);
        if (settlement.outcome === "SETTLED") {
          await createAuditLog({
            userId: null,
            action: "RIDER_WITHDRAWAL_TRANSFER_SUCCEEDED",
            metadata: {
              withdrawalId: withdrawal.id,
              reference: data.reference,
              amount: withdrawal.amount,
            },
          });
        }
      } else {
        // N-03: same CAS discipline. A duplicate `transfer.failed` is a
        // no-op, a late/duplicate failure can never reverse a withdrawal
        // that already settled as PAID, and a failed transfer never touches
        // the wallet.
        const settlement = await settleRiderWithdrawalFailed(
          withdrawal.id,
          (
            eventPayload.data?.gateway_response ||
            eventPayload.data?.message ||
            "Transfer failed"
          ).slice(0, 500),
        );
        if (settlement.outcome === "SETTLED") {
          await createAuditLog({
            userId: null,
            action: "RIDER_WITHDRAWAL_TRANSFER_FAILED",
            metadata: {
              withdrawalId: withdrawal.id,
              reference: data.reference,
            },
          });
        }
      }
      return await finish(200, "Transfer webhook processed");
    }

    // 5b) FAILED CHARGES. Batch C: previously `charge.failed` was rejected
    // as an unsupported event, so a failed card charge sat PENDING until the
    // expiry crons cancelled it. A verified failure now records FAILED —
    // but only from a still-pending payment (conditional transition, so a
    // duplicate/delayed/reordered event can never overwrite SUCCESS or any
    // other settled state). No order is cancelled and no stock is restored
    // here: the expiry worker owns that via its own CAS when the order is
    // still eligible. Observable via audit log either way.
    if (event === "charge.failed") {
      const failed = await prisma.payment.updateMany({
        where: {
          reference,
          status: { in: ["PENDING", "INITIATED"] },
        },
        data: {
          status: "FAILED",
          paystackData: eventPayload.data,
        },
      });
      await createAuditLog({
        userId: metadata?.userId || null,
        action: "PAYMENT_CHARGE_FAILED",
        metadata: {
          requestId,
          webhookId,
          reference,
          amount,
          transitioned: failed.count === 1,
          gatewayResponse:
            eventPayload.data?.gateway_response || eventPayload.data?.message || null,
        },
      });
      return await finish(200, "Charge failure recorded");
    }

    // 6) FINALIZE — the one canonical implementation, shared with
    // confirmPayment, chargeSavedCard, and the verifyPendingPayments job.
    const result = await finalizePaymentSuccess({
      reference,
      amountKobo: amount, // integer kobo from Paystack (Phase 3A)
      currency: eventPayload.data?.currency,
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
    return await finish(200, "Webhook processed");
  } catch (error: any) {
    // Phase 3.2.8 (F-1): release the lease with an owner-checked script so
    // a stale worker whose lease already lapsed (and was re-acquired by
    // someone else) cannot clear the live owner's claim. The previous
    // blind `del webhook:seen:<id>` could delete another worker's
    // protection, and a failed `del` left an orphan claim suppressing the
    // event for the entire 72h replay window.
    if (claimHeld && claim) {
      claimHeld = false;
      try {
        const released = await releaseWebhookClaim(redisPayments, claim);
        if (!released) {
          log.warn(
            { webhookId: claim.webhookId },
            "Webhook lease no longer owned; leaving it to its current owner",
          );
        }
      } catch (cleanupError) {
        log.warn(
          { err: cleanupError, webhookId: claim.webhookId },
          "Failed to release webhook lease",
        );
      }
    }
    log.error(
      { err: error, processingTimeMs: Date.now() - startTime },
      "Webhook processing failed",
    );
    // Retryable, not an acknowledgement. The lease was released (or will
    // lapse within its short TTL), so the provider's resend passes replay
    // protection and the event is processed rather than silently dropped.
    //
    // Releasing after a partially-committed failure is safe because every
    // downstream financial effect is idempotent behind a compare-and-set
    // (the finalizer's payment claim, the vendor/rider transfer settlement
    // helpers, and the refund finalizer's PROCESSING-only transition), so a
    // redelivery re-reads the settled record instead of moving money twice.
    //
    // Only the error and timings are logged — never the signature, the raw
    // body, the claim token, or any credential.
    return res.status(503).send("Webhook processing failed, please retry");
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

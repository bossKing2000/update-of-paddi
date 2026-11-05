import cron from "node-cron";
import { runOrderCleanupJob } from "../workers jobs/orderCleanupJob";
import { runExpireAwaitingPaymentJob } from "../workers jobs/expireAwaitingPaymentJob";
import { runExpireUnconfirmedVendorOrders } from "../workers jobs/expireUnconfirmedVendorOrders";
import { verifyPendingPayments } from "../payment/worker/verifyPendingPayments";
import { verifyExpiredPayments } from "../payment/worker/verifyExpiredPayments";
import { verifyPendingRefunds } from "../payment/worker/verifyPendingRefunds";
import { verifyPendingRiderWithdrawals } from "../payment/worker/verifyPendingRiderWithdrawals";
import { verifyPendingVendorPayouts } from "../payment/worker/verifyPendingVendorPayouts";
import { DeliveryAssignmentService } from "../../services/deliveryAssignment";
import { logger } from "../../lib/logger";

/**
 * 🧹 Order Cleanup Job (offline vendor/product)
 * Runs every 3 minutes to cancel stale or unpaid orders.
 */
cron.schedule("*/3 * * * *", async () => {
  try {
    await runOrderCleanupJob();
  } catch (err) {
    logger.error({ err }, "[CRON] Order cleanup job failed");
  }
});

/**
 * 🧹 Expire Abandoned AWAITING_PAYMENT Orders
 * Runs every 5 minutes to expire orders where payment window passed
 * and no successful payment exists. Respects isProcessing lock.
 */
cron.schedule("*/5 * * * *", async () => {
  try {
    await runExpireAwaitingPaymentJob();
  } catch (err) {
    logger.error({ err }, "[CRON] Expire awaiting payment job failed");
  }
});

/**
 * ⏰ Expire Unconfirmed PAYMENT_CONFIRMED Orders (3C vendor timeout)
 * Runs every 2 minutes to auto-cancel paid orders a vendor never confirmed
 * within 10 minutes, file order-bounded refunds, and notify customers.
 */
cron.schedule("*/2 * * * *", async () => {
  try {
    await runExpireUnconfirmedVendorOrders();
  } catch (err) {
    logger.error({ err }, "[CRON] Expire unconfirmed vendor orders failed");
  }
});

/**
 * 💳 Verify Pending Payments Job
 * Runs every 1 minute to auto-verify stuck or delayed transactions.
 */
cron.schedule("*/1 * * * *", async () => {
  try {
    await verifyPendingPayments();
  } catch (err) {
    logger.error({ err }, "[CRON] Verify pending payments failed");
  }
});

/**
 * 💸 Recover Captures on Already-EXPIRED Payments (FIN-07-03c)
 * Runs every 5 minutes.
 *
 * `verifyPendingPayments` above settles a reference to EXPIRED the moment
 * `expiresAt` passes, WITHOUT asking Paystack, and EXPIRED rows are excluded
 * from its `[PENDING, INITIATED]` predicate — so a charge that Paystack
 * captured while the `charge.success` webhook was lost in transit could never
 * be discovered again, and the FIN-07-02 refund-obligation branch was
 * unreachable.
 *
 * This sweep closes that discovery path for references that expired inside a
 * bounded window only. It never writes Payment.status or Order, never restores
 * stock, and routes every confirmed capture through the canonical
 * `finalizePaymentSuccess`. See verifyExpiredPayments.ts for the bounds and
 * the known limitations.
 */
cron.schedule("*/5 * * * *", async () => {
  try {
    await verifyExpiredPayments();
  } catch (err) {
    logger.error({ err }, "[CRON] Verify expired payments recovery failed");
  }
});

/**
 * 💸 Reconcile PROCESSING Refunds
 * Runs every 10 minutes. Catches refunds whose Paystack outcome is
 * unknown — a webhook that never arrived, or a crash between reserving
 * the amount and recording Paystack's refund id. Never resubmits a
 * refund; only reads Paystack's existing records and reconciles local
 * state to match. See verifyPendingRefunds.ts.
 */
cron.schedule("*/10 * * * *", async () => {
  try {
    await verifyPendingRefunds();
  } catch (err) {
    logger.error({ err }, "[CRON] Verify pending refunds failed");
  }
});

/**
 * 🛵 Reconcile PROCESSING Rider Withdrawals
 * Runs every 5 minutes. A rider withdrawal whose Paystack transfer outcome
 * was never learned (timeout, connection reset, 5xx — O-B now keeps these
 * PROCESSING on purpose, because the transfer may exist) is resolved by
 * asking Paystack what happened to the transfer that already exists, via
 * its stored reference. NEVER initiates another transfer, never creates a
 * withdrawal, never mints a reference. Anything Paystack cannot confirm
 * authoritatively is left PROCESSING with funds still reserved.
 * See verifyPendingRiderWithdrawals.ts.
 */
cron.schedule("*/5 * * * *", async () => {
  try {
    await verifyPendingRiderWithdrawals();
  } catch (err) {
    logger.error({ err }, "[CRON] Verify pending rider withdrawals failed");
  }
});

/**
 * 💸 Reconcile PROCESSING Vendor Payouts
 * Runs every 10 minutes. A payout whose Paystack transfer outcome was never
 * learned (timeout, connection reset, 5xx — deliberately left PROCESSING so a
 * retry cannot transfer twice) is resolved by asking Paystack about the
 * transfer that already exists, using its stored reference. NEVER initiates
 * another transfer. A verified failure also releases the payout's order claims
 * so those orders can be paid in a future run; anything Paystack cannot
 * confirm authoritatively stays PROCESSING with its orders still claimed.
 * See verifyPendingVendorPayouts.ts.
 */
cron.schedule("*/10 * * * *", async () => {
  try {
    await verifyPendingVendorPayouts();
  } catch (err) {
    logger.error({ err }, "[CRON] Verify pending vendor payouts failed");
  }
});

/**
 * 🚚 Expire Stale Delivery Broadcasts
 * Runs every 1 minute — catches broadcasts whose 30-second acceptance
 * window passed with no driver responding, and retries assignment.
 * Previously this logic existed but was never scheduled anywhere, so an
 * order broadcast to drivers who never responded (neither accepted nor
 * declined) would sit unassigned forever.
 */
cron.schedule("*/1 * * * *", async () => {
  try {
    await DeliveryAssignmentService.expireOldBroadcasts();
  } catch (err) {
    logger.error({ err }, "[CRON] Expire delivery broadcasts job failed");
  }
});

/**
 * 🔍 Stranded Delivery Dispatch Observation (READ-ONLY, opt-in)
 *
 * Logs how many orders currently look stranded in delivery dispatch. It
 * performs NO writes: no assignOrder, no broadcast or assignment changes, no
 * Order updates, no socket emissions, no notifications. It exists to measure a
 * problem before anything acts on it.
 *
 * Disabled unless RECONCILE_STRANDED_DISPATCH_ENABLED is exactly "true", in
 * which case the job is never registered and the candidate query never runs.
 * That default matters: a scan that only reads is harmless, but it also adds
 * query load on the hottest tables, so it stays opt-in until its cost is known.
 *
 * COVERAGE IS INCOMPLETE BY DESIGN. Each page restarts from the beginning —
 * there is no persisted and no module-level cursor — so a run cut short by
 * MAX_PAGES can miss candidates indefinitely, and its log line says so via
 * `truncated`. Orders that fail to recover write nothing, so nothing about
 * them changes between runs either. Fixing that needs persisted state, which is
 * deliberately out of scope.
 *
 * `noOverlap` prevents overlapping executions WITHIN THIS PROCESS ONLY. It is
 * NOT a distributed lock: with N application instances this job runs N times
 * concurrently. The candidate query is read-only so that is wasteful rather
 * than unsafe, but the load multiplies by N. Do not enable in a multi-instance
 * deployment without measuring that first.
 */
if (DeliveryAssignmentService.RECONCILE_ENABLED) {
  cron.schedule(
    "*/1 * * * *",
    async () => {
      try {
        await DeliveryAssignmentService.observeStrandedDispatches();
      } catch (err) {
        logger.error({ err }, "[CRON] Stranded dispatch observation job failed");
      }
    },
    { noOverlap: true, name: "stranded-dispatch-observation" },
  );
}

import cron from "node-cron";
import { runOrderCleanupJob } from "../workers jobs/orderCleanupJob";
import { runExpireAwaitingPaymentJob } from "../workers jobs/expireAwaitingPaymentJob";
import { verifyPendingPayments } from "../payment/worker/verifyPendingPayments";
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

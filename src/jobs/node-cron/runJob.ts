import cron from "node-cron";
import { runOrderCleanupJob } from "../workers jobs/orderCleanupJob";
import { runExpireAwaitingPaymentJob } from "../workers jobs/expireAwaitingPaymentJob";
import { verifyPendingPayments } from "../payment/worker/verifyPendingPayments";
import { verifyPendingRefunds } from "../payment/worker/verifyPendingRefunds";
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

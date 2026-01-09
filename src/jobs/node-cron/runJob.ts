import cron from "node-cron";
import { runOrderCleanupJob } from "../workers jobs/orderCleanupJob";
import { verifyPendingPayments } from "../payment/worker/verifyPendingPayments";
import { fixLiveStatusJob } from "../workers jobs/fixLiveStatusJob";

/**
 * 🧹 Order Cleanup Job
 * Runs every 5 minutes to cancel stale or unpaid orders.
 */

cron.schedule("*/50 * * * * *", async () => {
  try {
    await runOrderCleanupJob(); 
  } catch (err) {
    console.error("[CRON] Order cleanup job failed:", err);
  }
}); 


/**
 * 💳 Verify Pending Payments Job
 * Runs every 1 minute to auto-verify stuck or delayed transactions.s
 */
// cron.schedule("*/5 * * * * *", async () => {
//   try {
//     await verifyPendingPayments();
//   } catch (err) {
//     console.error("[CRON] Verify pending payments failed:", err);
//   }
// });


/**
 * 🟢 Fix Live Status Job
 * Runs every 1 minute to ensure product `isLive` status matches schedule.
 */
// In your cron setup
cron.schedule('*/5 * * * * ', () => {
  console.log('⏰ Running scheduled product status fix...');
  fixLiveStatusJob(false)
    .then(result => {
      console.log(`✅ Scheduled check: Updated ${result.updatedCount} products`);
    })
    .catch(err => {
      console.error('⚠️ Scheduled check failed:', err.message);
    });
});


// console.log("[CRON] 🕒 Order cleanup and payment verification jobs scheduled.");

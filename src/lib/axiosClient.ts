import axios from 'axios';
import config from '../config/config';

/**
 * Paystack request timeout, in milliseconds.
 *
 * FIN-07-03a. This client previously had no `timeout`, which in Axios means
 * "wait forever". `verifyPendingPayments` calls `verifyPayment` on every
 * payment still inside its expiry window, and `runJob.ts` starts that worker
 * on a one-minute cron schedule without awaiting the previous invocation — so
 * a hung gateway request could stall the worker's pagination loop indefinitely
 * while further runs piled up behind it.
 *
 * 15000 ms follows the repository's existing Axios convention
 * (`src/jobs/loadTest.ts`). It is deliberately generous: a false timeout here
 * would abort verification for a payment that may well have succeeded, so the
 * value is chosen to fire only on a genuinely stuck socket.
 *
 * This bounds request duration only. It does NOT add retries — a retry of a
 * money-moving Paystack call is not safe to introduce blindly — and it does not
 * treat a timeout as evidence that Paystack declined or failed to process a
 * payment. Callers already handle a thrown request by leaving the payment
 * alone for a later attempt; see `verifyPendingPayments`.
 *
 * Scoped to this instance: the three consumers (`paymentService`,
 * `payoutService`, `refundService`) are all Paystack API calls, and no other
 * HTTP client in the application is affected.
 */
export const PAYSTACK_REQUEST_TIMEOUT_MS = 15000;

export const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  timeout: PAYSTACK_REQUEST_TIMEOUT_MS,
  headers: {
    Authorization: `Bearer ${config.paystackSecret}`,
    'Content-Type': 'application/json',
  },
});
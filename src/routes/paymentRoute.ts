import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { paymentRateLimiter, otpRateLimiter } from '../middlewares/rateLimiter.middleware';
import {
  initiateOrderPayment,
  confirmPayment,
  getAllPaymentsForUser,
  requestRefund,
  getMyRefunds,
  verifyPaymentBeforeFulfillment,
  saveCardToken,
  getSavedCards,
  setDefaultCard,
  deleteSavedCard,
  chargeSavedCard,
  submitOtp,
} from '../controllers/paymentController';
import { getReceipt } from '../controllers/receceipt';

const router = Router();
router.use(authenticate);

// Payment endpoints — rate-limited per audit H1
router.post('/start', paymentRateLimiter, initiateOrderPayment);
router.get('/confirm/:reference', paymentRateLimiter, confirmPayment);
router.get('/user', getAllPaymentsForUser);
router.post('/refund', requestRefund);
router.get('/refunds', getMyRefunds);

// Verification endpoint
router.get('/orders/:orderId/verify-payment', verifyPaymentBeforeFulfillment);

// Saved cards — stricter rate limit for OTP/brute-force protection
router.post('/cards/save', saveCardToken);
router.post('/cards/charge', otpRateLimiter, chargeSavedCard);
router.post('/cards/submit-otp', otpRateLimiter, submitOtp);
router.get('/cards', getSavedCards);
router.put('/cards/default', setDefaultCard);
router.delete('/cards/:cardId', deleteSavedCard);

// Receipt — authenticated + ownership-checked (see receceipt.ts)
router.get('/receipt/:paymentId', getReceipt);

export default router;

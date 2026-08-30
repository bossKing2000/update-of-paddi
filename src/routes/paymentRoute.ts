import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
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

// Payment endpoints
router.post('/start', initiateOrderPayment);
router.get('/confirm/:reference', confirmPayment);
router.get('/user', getAllPaymentsForUser);
router.post('/refund', requestRefund);
router.get('/refunds', getMyRefunds);

// Verification endpoint
router.get('/orders/:orderId/verify-payment', verifyPaymentBeforeFulfillment);

// Saved cards
router.post('/cards/save', saveCardToken);
router.post('/cards/charge', chargeSavedCard); // was commented out — brought online, see paymentController.ts
router.post('/cards/submit-otp', submitOtp); // was commented out — brought online alongside chargeSavedCard
router.get('/cards', getSavedCards);
router.put('/cards/default', setDefaultCard);
router.delete('/cards/:cardId', deleteSavedCard);

// Receipt — previously unauthenticated with no ownership check
router.get('/receipt/:paymentId', getReceipt);

export default router;

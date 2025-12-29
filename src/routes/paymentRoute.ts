import { Router } from 'express';
import { authenticate,} from '../middlewares/auth.middleware';
import {initiateOrderPayment,confirmPayment,getAllPaymentsForUser,requestRefund,verifyPaymentBeforeFulfillment,saveCardToken,getSavedCards,setDefaultCard,deleteSavedCard} from '../controllers/paymentController';
import { getReceipt } from '../controllers/receceipt';

const router = Router();


// 💳 Payment endpoints
router.post('/start', authenticate, initiateOrderPayment);
router.get('/confirm/:reference', authenticate, confirmPayment);
router.get('/user', authenticate, getAllPaymentsForUser);
router.post('/refund', authenticate, requestRefund);


// 🔍 Verification endpoint
router.get('/orders/:orderId/verify-payment', authenticate, verifyPaymentBeforeFulfillment);


// In your paymentRoutes.ts
router.post('/cards/save', authenticate, saveCardToken);
// router.post('/cards/charge', authenticate, chargeSavedCard);
router.get('/cards', authenticate, getSavedCards);
router.put('/cards/default', authenticate, setDefaultCard);
router.delete('/cards/:cardId', authenticate, deleteSavedCard);
// router.post('/cards/submit-otp', authenticate, submitOtp);

router.get('/pay',authenticate,getAllPaymentsForUser);
router.get('/:paymentId',getReceipt);



export default router;


          
          
          
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const paymentController_1 = require("../controllers/paymentController");
const receceipt_1 = require("../controllers/receceipt");
const router = (0, express_1.Router)();
// 💳 Payment endpoints
router.post('/start', auth_middleware_1.authenticate, paymentController_1.initiateOrderPayment);
router.get('/confirm/:reference', auth_middleware_1.authenticate, paymentController_1.confirmPayment);
router.get('/user', auth_middleware_1.authenticate, paymentController_1.getAllPaymentsForUser);
router.post('/refund', auth_middleware_1.authenticate, paymentController_1.requestRefund);
// 🔍 Verification endpoint
router.get('/orders/:orderId/verify-payment', auth_middleware_1.authenticate, paymentController_1.verifyPaymentBeforeFulfillment);
// In your paymentRoutes.ts
router.post('/cards/save', auth_middleware_1.authenticate, paymentController_1.saveCardToken);
// router.post('/cards/charge', authenticate, chargeSavedCard);
router.get('/cards', auth_middleware_1.authenticate, paymentController_1.getSavedCards);
router.put('/cards/default', auth_middleware_1.authenticate, paymentController_1.setDefaultCard);
router.delete('/cards/:cardId', auth_middleware_1.authenticate, paymentController_1.deleteSavedCard);
// router.post('/cards/submit-otp', authenticate, submitOtp);
router.get('/pay', auth_middleware_1.authenticate, paymentController_1.getAllPaymentsForUser);
router.get('/:paymentId', receceipt_1.getReceipt);
exports.default = router;

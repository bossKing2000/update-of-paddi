"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const paymentController_1 = require("../controllers/paymentController");
const receceipt_1 = require("../controllers/receceipt");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.authenticate);
// Payment endpoints
router.post('/start', paymentController_1.initiateOrderPayment);
router.get('/confirm/:reference', paymentController_1.confirmPayment);
router.get('/user', paymentController_1.getAllPaymentsForUser);
router.post('/refund', paymentController_1.requestRefund);
// Verification endpoint
router.get('/orders/:orderId/verify-payment', paymentController_1.verifyPaymentBeforeFulfillment);
// Saved cards
router.post('/cards/save', paymentController_1.saveCardToken);
router.post('/cards/charge', paymentController_1.chargeSavedCard); // was commented out — brought online, see paymentController.ts
router.post('/cards/submit-otp', paymentController_1.submitOtp); // was commented out — brought online alongside chargeSavedCard
router.get('/cards', paymentController_1.getSavedCards);
router.put('/cards/default', paymentController_1.setDefaultCard);
router.delete('/cards/:cardId', paymentController_1.deleteSavedCard);
// Receipt — previously unauthenticated with no ownership check
router.get('/receipt/:paymentId', receceipt_1.getReceipt);
exports.default = router;

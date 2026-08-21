const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('advanced customer contract surface', () => {
  const controller = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'orderController.ts'), 'utf8');
  const router = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'orderRouter.ts'), 'utf8');
  const payment = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'paymentController.ts'), 'utf8');

  it('exposes customer-owned special-request history and individual offer decisions', () => {
    assert.match(controller, /export const getMySpecialRequests/);
    assert.match(controller, /export const rejectSpecialOffer/);
    assert.match(router, /router\.get\("\/special-requests", authorizeCustomer, getMySpecialRequests\)/);
    assert.match(router, /router\.patch\("\/special-offers\/:offerId\/reject", authorizeCustomer, rejectSpecialOffer\)/);
  });

  it('registers static special-request history before the dynamic order ID route', () => {
    assert.ok(router.indexOf('router.get("/special-requests"') < router.indexOf('router.get("/:orderId"'));
  });

  it('keeps saved-card OTP continuation available for customer payment flows', () => {
    assert.match(payment, /chargeSavedCardSchema/);
    assert.match(payment, /requiresOtp: true/);
    assert.match(payment, /submitOtpSchema/);
  });
});

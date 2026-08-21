const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('rider operations contract surface', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  const controller = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'riderOperationsController.ts'), 'utf8');
  const router = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'riderOperations.routes.ts'), 'utf8');
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'webhook.ts'), 'utf8');
  const deliveryService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'deliveryAssignment.ts'), 'utf8');
  const deliveryRouter = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'deliveryRouter.ts'), 'utf8');

  it('models a rider-scoped account, idempotent withdrawal ledger, proof, vehicle, and support ticket', () => {
    for (const model of ['RiderPayoutAccount', 'RiderWithdrawal', 'DeliveryProof', 'RiderVehicle', 'RiderSupportTicket']) {
      assert.match(schema, new RegExp(`model ${model} \\{`));
    }
    assert.match(schema, /@@unique\(\[deliveryPersonId, idempotencyKey\]\)/);
    assert.match(schema, /model DeliveryProof[\s\S]*assignmentId\s+String\s+@unique/);
  });

  it('reserves money before admin processing and debits the wallet only from transfer-success settlement', () => {
    assert.match(controller, /TransactionIsolationLevel\.Serializable/);
    assert.match(controller, /status: "PROCESSING"/);
    assert.match(webhook, /event === 'transfer.success'/);
    assert.match(webhook, /walletBalance: \{ decrement: withdrawal.amount \}/);
    assert.match(webhook, /event === 'transfer.failed'/);
  });

  it('enforces rider and admin role gates while allowing proof access only through controller involvement checks', () => {
    assert.match(router, /riderOperationsRoutes\.use\(authenticate, authorizeDeliveryPerson\)/);
    assert.match(router, /riderOperationsAdminRoutes\.use\(authenticate, authorizeAdmin\)/);
    assert.match(router, /riderProofReadRoutes\.use\(authenticate\)/);
    assert.match(controller, /You do not have access to this delivery proof/);
  });

  it('requires proof before delivery completion and static delivery paths precede the dynamic assignment ID route', () => {
    const deliveryController = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'deliveryControllers.ts'), 'utf8');
    assert.match(deliveryController, /Submit a valid proof of delivery before completing this assignment/);
    assert.ok(deliveryRouter.indexOf('/driver/:driverId/history') < deliveryRouter.indexOf('/:assignmentId'));
  });

  it('provides a rider-owned live offer queue with per-rider decline tracking', () => {
    assert.match(schema, /declinedDriverIds\s+String\[\]\s+@default\(\[\]\)/);
    assert.match(deliveryService, /getBroadcastOffersForDriver/);
    assert.match(deliveryService, /declineBroadcast/);
    assert.match(deliveryRouter, /router\.get\("\/offers", authorizeDeliveryPerson/);
    assert.match(deliveryRouter, /router\.patch\("\/broadcast\/:broadcastId\/decline", authorizeDeliveryPerson/);
  });
});

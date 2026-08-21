# Rider Operations Backend Validation

This guide validates the rider payout, proof-of-delivery, vehicle, and support APIs added in the rider operations completion pass. Run it in a **non-production Paystack environment** first.

## 1. Migration and type generation

```bash
cd path/to/backend
pnpm install
pnpm prisma migrate deploy
pnpm prisma generate
pnpm build
pnpm test -- rider-operations-contract-surface.test.js
```

The required migration is:

```text
prisma/migrations/20260821130000_rider_operations/migration.sql
```

Do not manually mark the migration as applied. The migration creates the payout, withdrawal, proof, vehicle, and support tables along with their PostgreSQL enum types and foreign keys.

## 2. Required configuration

| Configuration | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL migration and operations data. |
| `PAYSTACK_SECRET_KEY` / existing Paystack configuration | Bank resolution, recipient creation, and transfer initiation. |
| Paystack webhook endpoint | Receive signed `transfer.success` and `transfer.failed` events. |
| `CLOUDINARY_URL` | Store proof-of-delivery and vehicle-document images. |
| Redis configuration | Existing signed-webhook replay protection and rate limits. |

The existing webhook endpoint is `POST /api/payments/webhook`. Configure Paystack to send transfer events to the same signed endpoint used for customer payments.

## 3. Rider API acceptance flow

| Journey | Required validation |
|---|---|
| Bank destination | Sign in as a `DELIVERY` user, load `GET /api/rider/payouts/banks`, then save a 10-digit account through `PUT /api/rider/payouts/bank-details`. Confirm the returned name comes from Paystack and full account numbers are masked in summaries. |
| Withdrawal request | Create delivery earnings, ensure rider KYC is `VERIFIED`, then submit `POST /api/rider/payouts/withdrawals` with `{ amount, idempotencyKey }`. Retry the same key and confirm it returns the existing request. Attempt an amount above available balance and confirm rejection. |
| Admin processing | Sign in as `ADMIN`, inspect `GET /api/admin/rider/withdrawals`, then call `POST /api/admin/rider/withdrawals/:withdrawalId/process`. Confirm the withdrawal becomes `PROCESSING` and wallet balance is unchanged. |
| Transfer webhook | Send a signed Paystack `transfer.success` event using the withdrawal reference. Confirm exactly one wallet decrement and `PAID` state. Repeat the webhook and confirm it does not decrement again. Test `transfer.failed` and confirm `FAILED` state with no wallet debit. |
| Delivery proof | Move a rider assignment to `PICKED_UP` or `EN_ROUTE`. Upload one image with `POST /api/rider/assignments/:assignmentId/proof` (`multipart/form-data`, field `proof`). Confirm `DELIVERED` is rejected before proof and allowed after a submitted proof. Confirm only the rider, linked customer, linked vendor, and admin can read `GET /api/delivery/assignments/:assignmentId/proof`. |
| Vehicle review | Save `PUT /api/rider/vehicle`, upload an image to `POST /api/rider/vehicle/document`, then approve/reject/suspend it as admin through `PATCH /api/admin/rider/vehicles/:deliveryPersonId/review`. Every rider edit/document upload should reset state to `PENDING`. |
| Rider support | Submit/list rider tickets through `/api/rider/support/tickets`, then update status as admin through `PATCH /api/admin/rider/support/tickets/:ticketId`. Confirm riders cannot list other riders’ tickets. |

## 4. Operating rules

> Rider withdrawals are **manual-approval payouts**. Creating a withdrawal reserves the balance but does not debit it. Wallet balance is reduced only when a signed Paystack `transfer.success` webhook settles the corresponding `PROCESSING` withdrawal.

Do not process rider withdrawals from a production account until Paystack recipient creation, transfer webhooks, Redis replay protection, and admin access controls have been validated in a safe environment.

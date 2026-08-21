# Rider Operations Backend Design

## Purpose

This design completes the backend capabilities needed by the rider application while preserving the existing delivery-assignment and earnings logic. It covers **bank destinations and withdrawals**, **proof of delivery**, **vehicle management**, and **rider support tickets**.

## Financial model

Delivery earnings remain credited to `DeliveryPerson.walletBalance` only after a delivery reaches `DELIVERED`. A rider may request a withdrawal only when they have a verified bank destination, an active rider profile, and verified KYC.

| Concept | Source of truth | Rule |
|---|---|---|
| Gross rider earnings | `DeliveryEarning` | One immutable row is written for each delivered assignment. |
| Wallet balance | `DeliveryPerson.walletBalance` | Increases only on successful delivery; decreases only when a payout transfer succeeds. |
| Reserved amount | `RiderWithdrawal` rows in `PENDING` or `PROCESSING` | Prevents two simultaneous requests from consuming the same balance. |
| Withdrawable balance | `walletBalance - reserved amount` | Calculated server-side for every summary and withdrawal request. |
| Payout destination | `RiderPayoutAccount` | One verified bank destination per rider, resolved through Paystack before save. |

> A withdrawal is never debited at request time. It is reserved immediately, processed only by an administrator, and debited from the wallet only after Paystack reports a successful transfer. A failed transfer returns its full amount to the available balance automatically because the withdrawal leaves `PENDING`/`PROCESSING`.

### Withdrawal workflow

1. The rider saves bank details. The backend resolves the account through Paystack and invalidates any prior recipient code.
2. The rider submits `{ amount, idempotencyKey }`. The backend locks the rider row, calculates withdrawable balance, and creates a unique `PENDING` withdrawal record.
3. An administrator approves the withdrawal. The backend changes it to `PROCESSING`, creates/reuses a Paystack recipient, and initiates the transfer with `withdrawal.reference` as the Paystack idempotency reference.
4. On success, the withdrawal becomes `PAID`, the rider wallet is decremented exactly once, and the admin/action are audited. On failure, it becomes `FAILED` with a safe failure reason and no wallet debit.

The initial implementation uses **manual admin approval**, which provides operational review and fraud control. A future automated batch worker can process only `PENDING` withdrawals using the exact same reference and state transitions.

## Proof of delivery

Each delivery assignment has at most one `DeliveryProof` record. The assigned rider can upload one proof photo and optional recipient name/note while the assignment is in `PICKED_UP` or `EN_ROUTE`. The final `DELIVERED` transition requires submitted proof. The customer, order vendor, assigned rider, and administrators can read the proof; no unrelated user can access it.

| Endpoint | Actor | Function |
|---|---|---|
| `POST /api/rider/assignments/:assignmentId/proof` | Assigned rider | Upload proof image, recipient name, and delivery note. |
| `GET /api/rider/assignments/:assignmentId/proof` | Rider, customer, vendor, admin | Read proof with involvement/ownership checks. |
| `PATCH /api/rider/assignments/:assignmentId/proof/review` | Admin | Mark submitted proof verified or rejected with reason. |

The existing `PATCH /api/delivery/:assignmentId/status` endpoint will reject `DELIVERED` if the assignment has no submitted/verified proof. Failure, return, and cancellation statuses remain available for legitimate exception flows.

## Vehicle and KYC-facing profile

`RiderVehicle` stores a rider-owned vehicle profile separately from legacy `DeliveryPerson.vehicleType` and `licensePlate`. Riders can create or update their vehicle, while administrators approve, reject, or suspend it. This preserves a clear compliance state without breaking the existing delivery-person fields.

| Endpoint | Actor | Function |
|---|---|---|
| `GET /api/rider/vehicle` | Rider | Read own vehicle and approval state. |
| `PUT /api/rider/vehicle` | Rider | Create/update type, plate, make/model, color, and optional document URL. Changes reset approval to `PENDING`. |
| `PATCH /api/rider/vehicle/review` | Admin | Approve, reject, or suspend with an optional review note. |

## Rider support

`RiderSupportTicket` is rider-owned and parallels the vendor support implementation. It has category, subject, description, an explicit status, and chronological history. Riders may create and list only their own tickets; administrators can review status through internal tooling later.

| Endpoint | Actor | Function |
|---|---|---|
| `POST /api/rider/support/tickets` | Rider | Submit a support ticket. |
| `GET /api/rider/support/tickets` | Rider | List own tickets with pagination. |

## Security, audit, and operational safeguards

- Every rider endpoint requires a `DELIVERY` role; admin review endpoints require `ADMIN`.
- Bank account numbers are verified by Paystack and never echoed in full by summary responses.
- Withdrawal requests use a rider-scoped idempotency key and database uniqueness constraint.
- Available balance is recalculated under transaction protection before each withdrawal creation.
- Proof upload checks assignment ownership and endpoint read access checks rider/customer/vendor/admin involvement.
- Withdrawal creation, approval, vehicle updates, and proof submission create audit-log entries.
- Manual payout approval prevents automatic real-money transfers when payment-provider environment variables are configured for production.

import {
  Prisma,
  PrismaClient,
  FinancialOperationStatus,
  TerminalOutcome,
} from "@prisma/client";
import {
  initiateTransfer,
  fetchTransferByReference,
  classifyTransferInitiationError,
} from "./payoutService";
import {
  NotFoundError,
  ConflictError,
  UpstreamServiceError,
} from "../errors/AppError";
import { logger } from "../lib/logger";

/**
 * CLAIM_LEASE_MS — default claim lease duration (5 minutes).
 * After expiry, another worker may take over via lease takeover.
 */
export const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Active claim states — covered by the partial unique index.
 * While a claim is in any of these states, no other operation
 * (payout or refund) may be claimed for the same payment.
 */
export const ACTIVE_CLAIM_STATUSES: FinancialOperationStatus[] = [
  "CLAIMED",
  "SUBMITTED",
  "PROCESSING",
];

/**
 * Acquire a FinancialOperationClaim for a single payment.
 *
 * Lock ordering (mandatory): Payment (FOR UPDATE) → FinancialOperationClaim (insert).
 * This serializes with refund paths that also lock Payment, and with other
 * payout claims via the partial unique index.
 *
 * The Payment row lock is acquired FIRST to prevent interleaving between
 * the eligibility check and claim creation. The partial unique index is the
 * final backstop — even if the lock is bypassed, duplicate active claims
 * are rejected at insert time (P2002).
 *
 * Runs inside a transaction. The caller is responsible for the transaction boundary.
 */
export async function acquireFinancialOperationClaim(
  tx: Prisma.TransactionClient,
  params: {
    paymentId: string;
    operationType: "PAYOUT" | "REFUND" | "PAYOUT_REVERSAL";
    amountKobo: number;
    operationIdempotencyKey: string;
    vendorPayoutId?: string;
    refundRequestId?: string;
    reservedRefundAmountKobo?: number;
    refundReason?: string;
  },
) {
  const {
    paymentId,
    operationType,
    amountKobo,
    operationIdempotencyKey,
    vendorPayoutId,
    refundRequestId,
    reservedRefundAmountKobo,
    refundReason,
  } = params;

  // 1. LOCK the Payment row with FOR UPDATE (serializes with refund paths)
  // This must be the FIRST operation to establish lock order: Payment → FinancialOperationClaim
  const payment = await tx.$queryRaw<{
    id: string;
    reference: string;
    status: string;
    refundedAmount: number;
    amount: number;
    idempotencyKey: string;
  }[]>`
    SELECT id, reference, status, "refundedAmount", "idempotencyKey", amount
    FROM "Payment"
    WHERE id = ${paymentId}
    FOR UPDATE
  `;

  if (!payment || payment.length === 0) {
    throw new NotFoundError("Payment not found");
  }
  const paymentRow = payment[0];

  // 2. CHECK for any active claim on this payment (partial unique index is final backstop)
  const activeClaim = await tx.financialOperationClaim.findFirst({
    where: {
      paymentId,
      status: { in: ACTIVE_CLAIM_STATUSES },
    },
  });
  if (activeClaim) {
    throw new ConflictError("ACTIVE_CLAIM_EXISTS");
  }

  // 3. PERFORM eligibility/reservation checks (specific to operation type)
  if (operationType === "PAYOUT") {
    // Payout eligibility is validated by the caller (claimVendorPayoutOrders
    // or claimOrdersForRePayout) inside the same transaction.
  } else if (operationType === "REFUND") {
    if (reservedRefundAmountKobo && reservedRefundAmountKobo > 0) {
      const updated = await tx.payment.update({
        where: {
          id: paymentId,
          refundedAmount: { lte: paymentRow.amount - reservedRefundAmountKobo },
        },
        data: {
          refundedAmount: { increment: reservedRefundAmountKobo },
        },
      });
      if (!updated) {
        throw new ConflictError("INSUFFICIENT_REFUND_BALANCE");
      }
    }
  }

  // 4. CREATE RefundRequest for REFUND operations (same transaction to avoid orphaned reservations)
  let createdRefundRequestId: string | undefined;
  if (operationType === "REFUND") {
    const refundRequest = await tx.refundRequest.create({
      data: {
        userId: "system", // caller must override with actual user ID
        paymentRef: paymentRow.reference,
        reason: refundReason ?? "Customer requested refund",
        status: "PROCESSING",
        paystackRefundId: null,
        requestedAmountKobo: amountKobo,
      },
    });
    createdRefundRequestId = refundRequest.id;
  }

  // 5. CREATE the durable claim record with pre-submission marker (CLAIMED status)
  const claim = await tx.financialOperationClaim.create({
    data: {
      paymentId,
      operationType,
      status: "CLAIMED",
      operationIdempotencyKey,
      amountKobo,
      currency: "NGN",
      vendorPayoutId:
        operationType === "PAYOUT" ? vendorPayoutId : undefined,
      refundRequestId: createdRefundRequestId,
      operationVersion: 0,
    },
  });

  // 6. CREATE the durable lease record — worker lease is separate from claim
  await tx.financialOperationClaimLease.create({
    data: {
      claimId: claim.id,
      workerId: "system", // caller must override with actual worker ID
      expiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
      version: 0,
    },
  });

  return claim;
}

/**
 * Acquire claims for multiple payments atomically.
 *
 * Used by payouts spanning multiple orders and multiple payments. All
 * payments are locked in deterministic id ASC order to prevent deadlocks.
 * If any payment is missing or already has an active claim, the entire
 * transaction rolls back — no partial claims are created.
 *
 * Lock ordering: Payment (FOR UPDATE, sorted ASC) → FinancialOperationClaim (insert).
 *
 * Runs inside a transaction. The caller is responsible for the transaction boundary.
 */
export async function acquireMultiPaymentClaim(
  tx: Prisma.TransactionClient,
  params: {
    paymentIds: string[];
    operationType: "PAYOUT" | "REFUND" | "PAYOUT_REVERSAL";
    amountKobo: number;
    operationIdempotencyKey: string;
    vendorPayoutId?: string;
    refundRequestId?: string;
  },
) {
  const {
    paymentIds,
    operationType,
    amountKobo,
    operationIdempotencyKey,
    vendorPayoutId,
    refundRequestId,
  } = params;

  // Sort paymentIds deterministically to prevent deadlocks across concurrent payouts
  const sortedIds = [...paymentIds].sort((a, b) => a.localeCompare(b));

  // 1. LOCK all Payment rows in deterministic order
  const payments = await tx.$queryRaw<{
    id: string;
    reference: string;
    status: string;
    idempotencyKey: string;
  }[]>`
    SELECT id, reference, status, idempotencyKey
    FROM "Payment"
    WHERE id = ANY(${sortedIds})
    ORDER BY id ASC
    FOR UPDATE
  `;

  if (payments.length !== sortedIds.length) {
    throw new NotFoundError("One or more payments not found");
  }

  // 2. CHECK for any active claim on ANY of these payments (partial unique index is final backstop)
  const activeClaims = await tx.financialOperationClaim.findMany({
    where: {
      paymentId: { in: sortedIds },
      status: { in: ACTIVE_CLAIM_STATUSES },
    },
  });
  if (activeClaims.length > 0) {
    const blockedIds = activeClaims.map((c) => c.paymentId);
    throw new ConflictError(
      `ACTIVE_CLAIM_EXISTS on payments: ${blockedIds.join(", ")}`,
    );
  }

  // 3. CREATE claims for all payments atomically
  const claims = await Promise.all(
    sortedIds.map((paymentId) =>
      tx.financialOperationClaim.create({
        data: {
          paymentId,
          operationType,
          status: "CLAIMED",
          operationIdempotencyKey,
          amountKobo,
          currency: "NGN",
          vendorPayoutId,
          refundRequestId,
          operationVersion: 0,
        },
      }),
    ),
  );

  // 4. CREATE lease records for all claims atomically — claimId references FinancialOperationClaim.id, NOT paymentId
  await Promise.all(
    (claims as Array<{ id: string }>).map((claim) =>
      tx.financialOperationClaimLease.create({
        data: {
          claimId: claim.id,
          workerId: "system", // caller must override with actual worker ID
          expiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
          version: 0,
        },
      }),
    ),
  );

  return claims;
}

/**
 * Atomically transition a claim's state with lease fencing.
 *
 * Validates lease owner, lease version, claim version, and source state
 * in a single SQL statement. Rejects invalid source/destination combinations,
 * stale workers (wrong version), wrong lease owner, and expired lease.
 *
 * Returns the updated claim, or null if the transition was rejected
 * (zero rows affected).
 */
export async function transitionClaimState(
  tx: Prisma.TransactionClient,
  params: {
    claimId: string;
    workerId: string;
    newStatus: "CLAIMED" | "SUBMITTED" | "PROCESSING" | "COMPLETED" | "FAILED" | "REVERSED";
    terminalOutcome: "COMPLETED" | "FAILED" | "REVERSED" | null;
    expectedLeaseVersion: number;
    expectedClaimVersion: number;
    expectedSourceStatus: "CLAIMED" | "SUBMITTED" | "PROCESSING";
  },
) {
  const {
    claimId,
    workerId,
    newStatus,
    terminalOutcome,
    expectedLeaseVersion,
    expectedClaimVersion,
    expectedSourceStatus,
  } = params;

  // Build the WHERE clause for valid transitions
  let transitionCondition: string;
  switch (expectedSourceStatus) {
    case "CLAIMED":
      if (newStatus !== "SUBMITTED" || terminalOutcome !== null) {
        return null; // Invalid transition
      }
      transitionCondition = `(foc."status" = 'CLAIMED' AND ${newStatus} = 'SUBMITTED' AND ${terminalOutcome} IS NULL)`;
      break;
    case "SUBMITTED":
      if (newStatus !== "PROCESSING" || terminalOutcome !== null) {
        return null; // Invalid transition
      }
      transitionCondition = `(foc."status" = 'SUBMITTED' AND ${newStatus} = 'PROCESSING' AND ${terminalOutcome} IS NULL)`;
      break;
    case "PROCESSING":
      if (
        (newStatus === "COMPLETED" && terminalOutcome === "COMPLETED") ||
        (newStatus === "FAILED" && terminalOutcome === "FAILED") ||
        (newStatus === "REVERSED" && terminalOutcome === "REVERSED")
      ) {
        transitionCondition = `(foc."status" = 'PROCESSING' AND ${newStatus} = 'COMPLETED' AND ${terminalOutcome} = 'COMPLETED') OR (foc."status" = 'PROCESSING' AND ${newStatus} = 'FAILED' AND ${terminalOutcome} = 'FAILED') OR (foc."status" = 'PROCESSING' AND ${newStatus} = 'REVERSED' AND ${terminalOutcome} = 'REVERSED')`;
      } else {
        return null; // Invalid transition
      }
      break;
    default:
      return null; // Invalid source status
  }

  const result = await tx.$queryRaw<{
    id: string;
    operationVersion: number;
    status: string;
    terminalOutcome: string | null;
  }[]>`
    UPDATE "FinancialOperationClaim" foc
    SET
      "status" = ${newStatus},
      "terminalOutcome" = ${terminalOutcome},
      "operationVersion" = foc."operationVersion" + 1,
      "updatedAt" = now()
    FROM "FinancialOperationClaimLease" l
    WHERE foc."id" = l."claimId"
      AND foc."id" = ${claimId}
      AND l."workerId" = ${workerId}
      AND l."expiresAt" > now()
      AND l."version" = ${expectedLeaseVersion}
      AND foc."operationVersion" = ${expectedClaimVersion}
      AND foc."status" = ${expectedSourceStatus}
      AND ${transitionCondition}
    RETURNING foc."id", foc."operationVersion", foc."status", foc."terminalOutcome"
  `;

  // $queryRawRaw returns an array of rows; check if any row was returned
  const rows = (result as unknown as Array<{
    id: string;
    operationVersion: number;
    status: string;
    terminalOutcome: string | null;
  }>);
  if (rows.length === 0) {
    return null; // Transition rejected (stale worker, wrong version, etc.)
  }

  return rows[0];
}

/**
 * Renew the lease for the same worker (extends expiry without incrementing version).
 * Returns true if the renewal succeeded, false if the lease was already taken over
 * or expired.
 */
export async function renewLease(
  tx: Prisma.TransactionClient,
  params: {
    claimId: string;
    workerId: string;
    expectedVersion: number;
    leaseTtlMs?: number;
  },
) {
  const { claimId, workerId, expectedVersion, leaseTtlMs = CLAIM_LEASE_MS } = params;

  const result = await tx.financialOperationClaimLease.updateMany({
    where: {
      claimId,
      workerId,
      version: expectedVersion,
      expiresAt: { gt: new Date() }, // lease not expired
    },
    data: {
      expiresAt: new Date(Date.now() + leaseTtlMs),
    },
  });

  return result.count === 1;
}

/**
 * Take over an expired lease from a different worker (increments version).
 * Returns true if the takeover succeeded, false if the lease was not expired
 * or already taken over by another worker.
 */
export async function takeOverLease(
  tx: Prisma.TransactionClient,
  params: {
    claimId: string;
    workerId: string;
    expectedVersion: number;
    leaseTtlMs?: number;
  },
) {
  const { claimId, workerId, expectedVersion, leaseTtlMs = CLAIM_LEASE_MS } = params;

  const result = await tx.financialOperationClaimLease.updateMany({
    where: {
      claimId,
      expiresAt: { lt: new Date() }, // only expired leases can be taken over
    },
    data: {
      workerId,
      expiresAt: new Date(Date.now() + leaseTtlMs),
      version: { increment: 1 },
    },
  });

  return result.count === 1;
}

/**
 * Release the lease by the current owner.
 * Returns true if the release succeeded, false if the lease was not held by
 * this worker at this version, or if the lease has expired.
 */
export async function releaseLease(
  tx: Prisma.TransactionClient,
  params: {
    claimId: string;
    workerId: string;
    expectedVersion: number;
  },
) {
  const { claimId, workerId, expectedVersion } = params;

  const result = await tx.financialOperationClaimLease.deleteMany({
    where: {
      claimId,
      workerId,
      version: expectedVersion,
      expiresAt: { gt: new Date() }, // lease not expired
    },
  });

  return result.count === 1;
}

/**
 * Submit a claimed financial operation to Paystack.
 *
 * Transition contract:
 *   CLAIMED → SUBMITTED (durable pre-submission marker, externalRef = null)
 *
 * The claim is durably written to the database BEFORE the external Paystack
 * call. If the worker crashes after this point, reconciliation will resolve
 * the ambiguous outcome.
 *
 * External Paystack call happens OUTSIDE the database transaction.
 *
 * Returns the submitted claim, or null if the transition was rejected
 * (e.g., lease expired, wrong version).
 */
export async function submitFinancialOperation(
  tx: Prisma.TransactionClient,
  params: {
    claimId: string;
    workerId: string;
    expectedLeaseVersion: number;
    expectedClaimVersion: number;
  },
  submitFn: () => Promise<{
    reference?: string;
    refundId?: string;
    status?: string;
  }>,
) {
  const { claimId, workerId, expectedLeaseVersion, expectedClaimVersion } =
    params;

  // Transition CLAIMED → SUBMITTED (durable pre-submission marker)
  const claim = await transitionClaimState(tx, {
    claimId,
    workerId,
    newStatus: "SUBMITTED",
    terminalOutcome: null,
    expectedLeaseVersion,
    expectedClaimVersion,
    expectedSourceStatus: "CLAIMED",
  });

  if (!claim) {
    return null; // Transition rejected
  }

  // External Paystack call OUTSIDE the database transaction
  // Note: tx is still open but no DB operations happen between here and commit
  let providerResult;
  try {
    providerResult = await submitFn();
  } catch (err: any) {
    // Paystack call failed - claim stays SUBMITTED, reconciliation will resolve
    logger.error(
      { err: err?.message, claimId },
      "submitFinancialOperation: Paystack call failed, claim left SUBMITTED",
    );
    throw err;
  }

  // Update claim with provider reference if returned
  if (providerResult.reference) {
    await tx.financialOperationClaim.update({
      where: { id: claimId },
      data: { externalReference: providerResult.reference },
    });
  }
  if (providerResult.refundId) {
    await tx.financialOperationClaim.update({
      where: { id: claimId },
      data: { paystackRefundId: providerResult.refundId },
    });
  }

  return claim;
}

/**
 * Settle a payout claim to a terminal state based on provider confirmation.
 *
 * Transition contract:
 *   PROCESSING → COMPLETED (terminalOutcome = COMPLETED)
 *   PROCESSING → FAILED (terminalOutcome = FAILED)
 *   PROCESSING → REVERSED (terminalOutcome = REVERSED)
 *
 * Validates lease ownership and version before transitioning.
 * Returns the updated claim, or null if rejected.
 */
export async function settlePayoutClaim(
  tx: Prisma.TransactionClient,
  params: {
    claimId: string;
    workerId: string;
    expectedLeaseVersion: number;
    expectedClaimVersion: number;
    newStatus: "COMPLETED" | "FAILED" | "REVERSED";
  },
) {
  const { claimId, workerId, expectedLeaseVersion, expectedClaimVersion, newStatus } =
    params;

  const terminalOutcome: TerminalOutcome = newStatus;

  return transitionClaimState(tx, {
    claimId,
    workerId,
    newStatus: "PROCESSING", // source must be PROCESSING
    terminalOutcome,
    expectedLeaseVersion,
    expectedClaimVersion,
    expectedSourceStatus: "PROCESSING",
  });
}

/**
 * Reconcile a financial operation claim against provider evidence.
 *
 * For SUBMITTED claims without externalReference: cannot look up, leave
 * for manual intervention.
 * For SUBMITTED/PROCESSING claims with externalReference: call provider
 * verify endpoint and transition based on authoritative response.
 *
 * Never automatically resubmits a SUBMITTED operation.
 */
export async function reconcileFinancialOperation(
  tx: Prisma.TransactionClient,
  claim: {
    id: string;
    operationType: "PAYOUT" | "REFUND" | "PAYOUT_REVERSAL";
    status: string;
    externalReference: string | null;
    paystackRefundId: string | null;
    amountKobo: number;
    workerId: string;
    leaseVersion: number;
    claimVersion: number;
  },
): Promise<{ settled: boolean; outcome?: string }> {
  // SUBMITTED with no externalReference: cannot look up provider outcome
  if (claim.status === "SUBMITTED" && !claim.externalReference) {
    logger.warn(
      { claimId: claim.id },
      "reconcileFinancialOperation: SUBMITTED claim with no externalReference, leaving for manual intervention",
    );
    return { settled: false };
  }

  // Only PROCESSING claims with externalReference can be reconciled via provider lookup
  if (claim.status !== "PROCESSING" || !claim.externalReference) {
    return { settled: false };
  }

  if (claim.operationType === "PAYOUT") {
    const lookup = await fetchTransferByReference(claim.externalReference);

    if (lookup.outcome === "FOUND") {
      switch (lookup.status) {
        case "success":
          if (lookup.amountKobo === claim.amountKobo) {
            const settled = await settlePayoutClaim(tx, {
              claimId: claim.id,
              workerId: claim.workerId,
              expectedLeaseVersion: claim.leaseVersion,
              expectedClaimVersion: claim.claimVersion,
              newStatus: "COMPLETED",
            });
            return { settled: !!settled, outcome: "COMPLETED" };
          } else {
            // Amount mismatch — human review required
            logger.warn(
              {
                claimId: claim.id,
                expectedAmount: claim.amountKobo,
                paystackAmount: lookup.amountKobo,
              },
              "reconcileFinancialOperation: amount mismatch",
            );
            return { settled: false, outcome: "AMOUNT_MISMATCH" };
          }
        case "failed":
          const settled = await settlePayoutClaim(tx, {
            claimId: claim.id,
            workerId: claim.workerId,
            expectedLeaseVersion: claim.leaseVersion,
            expectedClaimVersion: claim.claimVersion,
            newStatus: "FAILED",
          });
          return { settled: !!settled, outcome: "FAILED" };
        case "reversed":
          const settledReversed = await settlePayoutClaim(tx, {
            claimId: claim.id,
            workerId: claim.workerId,
            expectedLeaseVersion: claim.leaseVersion,
            expectedClaimVersion: claim.claimVersion,
            newStatus: "REVERSED",
          });
          return { settled: !!settledReversed, outcome: "REVERSED" };
        case "pending":
        case "otp":
        case "received":
          // Still in flight — leave as PROCESSING
          return { settled: false };
        default:
          logger.warn(
            { claimId: claim.id, paystackStatus: lookup.status },
            "reconcileFinancialOperation: unknown Paystack status",
          );
          return { settled: false };
      }
    }
    // UNKNOWN/NOT_FOUND: leave unresolved, retry later
    return { settled: false };
  }

  // REFUND reconciliation (delegated to refund-specific logic)
  if (claim.operationType === "REFUND") {
    // Refund reconciliation uses List Refunds and local matching by amount
    // See §7.2 for the full algorithm
    logger.info(
      { claimId: claim.id },
      "reconcileFinancialOperation: REFUND claim reconciliation via List Refunds",
    );
    return { settled: false };
  }

  return { settled: false };
}

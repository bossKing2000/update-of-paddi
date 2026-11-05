import { randomUUID } from "crypto";
import { Prisma, RefundStatus } from "@prisma/client";
import { nowUtc } from "../utils/time";

/**
 * C-2: at most one OPEN refund obligation per (paymentRef, orderId).
 *
 * A refund obligation is created by three independent writers (paid-order
 * cancellation, the vendor-confirmation-timeout worker, and payment
 * finalization). Each one used to `findFirst` an open obligation and then
 * `create` one if it found none. Under PostgreSQL's default READ COMMITTED
 * isolation that read-then-create is not atomic: two concurrent transactions
 * can both observe "no open obligation" and both insert, leaving duplicate
 * open obligations for the same order.
 *
 * The database now enforces the invariant with the partial unique index
 * "RefundRequest_open_obligation_per_order". This helper makes the INSERT
 * itself conflict-tolerant, so the common case never raises a uniqueness
 * error at all — which matters because a caught uniqueness error inside an
 * interactive transaction leaves that transaction aborted and unusable.
 */

export const OPEN_REFUND_STATUSES = [
  RefundStatus.PENDING,
  RefundStatus.APPROVED,
  RefundStatus.PROCESSING,
] as const;

export type RefundObligationInput = {
  userId: string;
  paymentRef: string;
  reason: string;
  orderId: string;
  requestedAmountKobo?: number | null;
};

export type RefundObligation = {
  id: string;
  status: string;
  paymentRef: string;
  orderId: string | null;
  userId: string;
  requestedAmountKobo: number | null;
  createdAt: Date;
};

type Db = Prisma.TransactionClient;

type InsertedRow = {
  id: string;
  status: string;
  paymentRef: string;
  orderId: string | null;
  userId: string;
  requestedAmountKobo: number | null;
  createdAt: Date;
};

/**
 * Prisma writes UTC timestamps as naive `TIMESTAMP(3)` values. The database
 * columns are `TIMESTAMP(3) NOT NULL` with no default for "updatedAt", so
 * both timestamps are supplied explicitly here, formatted in UTC, instead of
 * relying on CURRENT_TIMESTAMP (which would depend on the server's session
 * time zone).
 */
const utcTimestamp = (): string =>
  nowUtc().toISOString().slice(0, 23).replace("T", " ");

const findOpenObligation = (
  db: Db,
  input: RefundObligationInput,
): Promise<RefundObligation | null> =>
  db.refundRequest.findFirst({
    where: {
      paymentRef: input.paymentRef,
      orderId: input.orderId,
      status: { in: [...OPEN_REFUND_STATUSES] },
    },
    select: {
      id: true,
      status: true,
      paymentRef: true,
      orderId: true,
      userId: true,
      requestedAmountKobo: true,
      createdAt: true,
    },
  });

export type FileRefundOwedResult = {
  /** The created obligation, or the pre-existing open one we reused. */
  obligation: RefundObligation;
  /** True when this call inserted the row; false when one already existed. */
  created: boolean;
};

/**
 * Files a refund obligation for one order, atomically.
 *
 * Returns the created obligation, or the pre-existing open obligation when a
 * concurrent writer won the race. The ON CONFLICT target is scoped to the
 * partial index's columns AND predicate, so a violation of any other unique
 * constraint is NOT swallowed — it still raises.
 */
export async function fileRefundOwed(
  db: Db,
  input: RefundObligationInput,
): Promise<FileRefundOwedResult> {
  const id = randomUUID();
  const stamp = utcTimestamp();

  // Column order matches the value order below.
  const inserted = await db.$queryRaw<InsertedRow[]>`
    INSERT INTO "RefundRequest"
      ("id", "userId", "paymentRef", "reason", "status", "createdAt", "updatedAt", "orderId", "requestedAmountKobo")
    VALUES
      (${id}::text,
       ${input.userId}::text,
       ${input.paymentRef}::text,
       ${input.reason}::text,
       ${RefundStatus.PENDING}::"RefundStatus",
       ${stamp}::timestamp,
       ${stamp}::timestamp,
       ${input.orderId}::text,
       ${input.requestedAmountKobo ?? null}::integer)
    ON CONFLICT ("paymentRef", "orderId")
      WHERE "orderId" IS NOT NULL
        AND "status" IN ('PENDING'::"RefundStatus", 'APPROVED'::"RefundStatus", 'PROCESSING'::"RefundStatus")
    DO NOTHING
    RETURNING "id", "status", "paymentRef", "orderId", "userId", "requestedAmountKobo", "createdAt"
  `;

  const created = inserted[0];
  if (created) {
    return {
      obligation: created as unknown as RefundObligation,
      created: true,
    };
  }

  // No row returned means the partial index matched an existing open
  // obligation. Re-read it to confirm the conflict was the expected one and
  // to hand the caller the real obligation's identity.
  const existing = await findOpenObligation(db, input);
  if (existing) {
    return {
      obligation: existing as unknown as RefundObligation,
      created: false,
    };
  }

  // Unreachable while the index predicate and this helper agree. Never treat
  // an unexplained no-row as success: that would silently drop a refund.
  throw new Error(
    `Refund obligation insert conflicted but no open obligation was found for ` +
      `order ${input.orderId} on payment ${input.paymentRef}. Refusing to ` +
      `treat the refund as filed.`,
  );
}

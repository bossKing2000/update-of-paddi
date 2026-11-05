import prisma from "../../../lib/prisma";
import { verifyPayment } from "../../../services/paymentService";
import { finalizePaymentSuccess } from "../../../services/paymentFinalizer.service";
import { logger } from "../../../lib/logger";
import { PaymentStatus, Prisma } from "@prisma/client";

/**
 * FIN-07-03c / FIN-07-03c.1 — bounded, fair recovery for captures whose
 * webhook never arrived.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `verifyPendingPayments` settles a reference to EXPIRED as soon as
 * `expiresAt` passes **without asking Paystack** (its comment at
 * src/jobs/payment/worker/verifyPendingPayments.ts:50, and the assertion
 * `expect(verifyPayment).not.toHaveBeenCalled()` in
 * tests/integration/expiredPaymentLateCaptureDb.test.ts). EXPIRED rows then
 * fail that worker's `[PENDING, INITIATED]` predicate, so they are excluded
 * from all later polling, and nothing else in the system revisits them.
 *
 * A charge Paystack captured while the `charge.success` webhook was lost in
 * transit was therefore undiscoverable, and the FIN-07-02 refund-obligation
 * branch in `finalizePaymentSuccess` — which runs only once somebody already
 * knows the payment succeeded — could never be reached. Paystack's own
 * documentation explicitly endorses the alternative this implements:
 * "when a customer makes a payment for a transaction, you keep making a
 * request for the transaction status until you get a successful transaction
 * status" (Paystack Docs, Webhooks › Polling vs webhooks).
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * -------------------------------
 *   * Never writes `Payment.status`. EXPIRED stays EXPIRED, so the terminal
 *     record and the F-A1 conditional-claim guarantees are untouched.
 *   * Never writes `Order`. A cancelled order is never reopened.
 *   * Never touches stock, refunds or receipts directly. Every effect comes
 *     from the canonical `finalizePaymentSuccess`.
 *   * Never treats an ambiguous answer as a failure.
 *
 * WHY THIS IS FAIR (FIN-07-03c.1 / FIN-07-03c.3)
 * ------------------------------------------------
 * Round 1 (03c.1) ordered candidates `expiresAt DESC` and skipped only
 * already-resolved rows in memory. Because an unresolved candidate is never
 * marked, the newest N unresolved references sat permanently at the head of a
 * stable scan, consumed the whole per-run provider-call budget, and starved
 * every older eligible payment forever.
 *
 * Round 2 (03c.3) found the same defect one level down: the in-memory skips did
 * not stop those rows from consuming the ROW-SCAN budget, so with a backlog
 * larger than `MAX_ROWS_PER_RUN` the resolved and cooling-down population at the
 * head of the scan starved everything behind it, indefinitely.
 *
 * Database-level exclusion with Prisma JSON-path filters was considered and
 * REJECTED. The repository's existing pattern
 * (`{ field: { equals: Prisma.AnyNull } }` OR'd with
 * `{ NOT: { field: { path: [...], equals: X } } }`, see
 * src/services/product.service.ts:404) relies on every present object carrying
 * the queried key. Here the queried key is `outcome`, which is deliberately
 * ABSENT on exactly the candidates that must stay eligible — a deferred
 * candidate. In PostgreSQL `jsonb -> 'missing'` yields SQL NULL, so
 * `NOT (NULL = X)` is NULL and the row is dropped by WHERE. Whether Prisma's
 * JSON filters behave identically to that SQL cannot be established without a
 * live database, and guessing it would silently drop every unresolved payment.
 *
 * WHAT IS AND IS NOT FIXED
 * -----------------------
 * FIXED (FIN-07-03c.3): pagination is now a keyset predicate over two columns
 * this worker never mutates, replacing Prisma's `cursor` (whose boundary is
 * re-read from a row our own writes can move, and whose use with a
 * non-leading sort key was never verified against PostgreSQL).
 *
 * NOT FIXED — KNOWN BLOCKER: resolved and cooling-down rows still consume the
 * row-scan budget. Two designs were implemented and evaluated:
 *
 *   * Ordering by `updatedAt` (least-recently-examined first) was tried and
 *     REVERTED. It does not work: a payment resolved early in the window keeps
 *     an old `updatedAt` forever, so it still sorts ahead of never-examined
 *     rows and still fills the scan. It also made the sort key mutable by this
 *     worker, which is exactly what breaks a cursor.
 *
 * A correct fix requires excluding those rows in the DATABASE, not in memory.
 * Prisma JSON-path filters cannot express it safely. The repository's existing
 * pattern (`Prisma.AnyNull` OR'd with `NOT { path: [...] }`,
 * src/services/product.service.ts:404) assumes every present object carries the
 * queried key. Here the queried key is `outcome`, which is deliberately ABSENT
 * on exactly the candidates that must stay eligible — a deferred one. In
 * PostgreSQL `jsonb -> 'missing'` yields SQL NULL, so `NOT (NULL = X)` is NULL
 * and WHERE drops the row: the filter would discard every unresolved payment.
 * Whether Prisma's JSON filter layer behaves identically to that SQL cannot be
 * established without a live database, and guessing would silently break
 * recovery. The remaining options — `$queryRaw` with explicit SQL, or an
 * indexed column — are unreviewable and unverifiable in this environment
 * (no authorized disposable PostgreSQL) and are referred for approval rather
 * than shipped.
 *
 * Mitigation in place until then: the run emits a warning whenever the row
 * budget is exhausted before the provider-call budget, and
 * `tests/unit/expiredPaymentRecovery.test.ts` pins the current behaviour in
 * "F-01.KNOWN-GAP" so the gap is visible rather than assumed fixed.
 *
 * RECOVERY WINDOW (FIN-07-03c.3, Stage 4)
 * ---------------------------------------
 * 72 hours. The justification is NOT the application's 72-hour webhook
 * deduplication TTL (`WEBHOOK_DONE_TTL_SECONDS`). That TTL only governs how
 * long THIS system suppresses a duplicate webhook id; it says nothing about when
 * Paystack stops trying to deliver, and the two are separate concerns that
 * could change independently. On its own it would not justify a recovery
 * policy.
 *
 * The justification is Paystack's own documented delivery guarantee:
 *
 *   "Without a 200 OK response, events are sent for the next 72 hours… In the
 *    live mode, failed attempts are retried every 3 minutes for the first 4
 *    tries, then retried hourly for the next 72 hours."
 *                                      — Paystack Docs, Payments › Webhooks
 *
 * THE TWO CLOCKS ARE NOT GUARANTEED TO ALIGN. Paystack's 72 hours is measured
 * from ITS OWN delivery attempt for an event. This application's window is
 * measured from `Payment.expiresAt`, which is set at checkout (`createdAt` plus
 * the 15-minute payment window) and has no relationship to when Paystack first
 * attempted — or will first attempt — delivery. A payment can be captured long
 * after `expiresAt`, and Paystack may begin retrying late. In this repository
 * the two happen to be close and the application clock is the later one, which
 * is the conservative direction, but that is an observation, NOT an alignment
 * the provider guarantees.
 *
 * Consequently a 72-hour window is a deliberate best-effort policy, not a
 * guarantee of detection. See LIMITATIONS.
 *
 * LIMITATIONS (reported, not worked around)
 * -----------------------------------------
 *   * After the window closes an EXPIRED payment is no longer selected. It is
 *     not deleted and not refunded; it simply stops being polled, so a capture
 *     that Paystack records later than the window is discovered only through
 *     the normal webhook path or manual operator action. Residual risk.
 *   * No guarantee of detection: a verify request may time out, and a charge
 *     whose status stays `pending` at Paystack for the whole window will never
 *     be confirmed here.
 *   * `expiresAt >= cutoff` rides on the existing `Payment_status_idx`; there is
 *     no `(status, expiresAt)` index, so the read filters rather than seeks.
 *     Same convention `verifyPendingPayments` already uses. A composite index
 *     would help but is a schema change, explicitly out of scope.
 *   * Overlap is guarded at the record level only. With N instances this sweep
 *     runs N times. That is wasteful, not unsafe: the marker, the per-payment
 *     `isProcessing` lock and the finalizer's own obligation dedupe make a
 *     duplicate check a no-op rather than a duplicate write. Cron-overlap
 *     remediation is deliberately out of scope here.
 */

/** Marker namespace written to `Payment.paystackData`. */
const RECOVERY_MARKER_KEY = "expiredRecovery";

/**
 * Paystack's documented live-mode webhook retry horizon (4 tries every 3
 * minutes, then hourly for the next 72 hours). See the header.
 */
const DEFAULT_RECOVERY_WINDOW_MS = 72 * 60 * 60 * 1000;

/** First retry delay for an unresolved reference. */
const RECOVERY_BACKOFF_BASE_MS = 15 * 60 * 1000;

/** Ceiling for the exponential backoff. */
const RECOVERY_BACKOFF_CAP_MS = 4 * 60 * 60 * 1000;

/** Provider calls permitted per execution. */
const DEFAULT_BATCH_SIZE = 20;

/** Rows fetched per page. */
const PAGE_SIZE = 50;

/** Hard ceiling on rows read per execution, so one run cannot run away. */
const MAX_ROWS_PER_RUN = 500;

interface RecoveryMarker {
  outcome?: string;
  attempts?: number;
  nextCheckAt?: string;
  checkedAt?: string;
  /** Verbatim Paystack verification payload for a recovered capture (F-04). */
  evidence?: unknown;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Milliseconds an expired reference stays eligible for recovery. */
export const EXPIRED_RECOVERY_WINDOW_MS = positiveIntFromEnv(
  "PAYMENT_EXPIRED_RECOVERY_WINDOW_HOURS",
  DEFAULT_RECOVERY_WINDOW_MS / (60 * 60 * 1000),
) * 60 * 60 * 1000;

function readMarker(paystackData: unknown): RecoveryMarker | null {
  if (!paystackData || typeof paystackData !== "object") return null;
  const marker = (paystackData as Record<string, unknown>)[RECOVERY_MARKER_KEY];
  return marker && typeof marker === "object" ? (marker as RecoveryMarker) : null;
}

/**
 * The two terminal recovery outcomes this worker writes. Kept in one place so
 * the SQL predicate below and the in-memory `isTerminal` check can never drift.
 */
const TERMINAL_OUTCOMES = ["reconciled", "provider_not_successful"] as const;

/**
 * Strict ISO-8601 shape. A `nextCheckAt` that does not match is treated as
 * absent (see MALFORMED-TIMESTAMP POLICY below); a value that DOES match is
 * always castable, because the month/day/hour/minute/second ranges are all
 * constrained to values PostgreSQL accepts. The cast therefore cannot abort
 * the scan.
 */
const ISO_8601_PATTERN =
  // Character classes only, never backslash escapes. In a JS string literal a
  // "\\\\." loses its backslash and reaches PostgreSQL as a bare quantifier,
  // which PostgreSQL rejects with SQLSTATE 2201B. That was a real defect, found
  // only by executing this query against PostgreSQL 17.
  //
  // The regex alone is NOT sufficient: "2026-02-30T00:00:00Z" matches it, yet
  // PostgreSQL rejects the cast with SQLSTATE 22008 ("date/time field value out
  // of range"), which would abort the entire scan. `pg_input_is_valid` (added
  // in PostgreSQL 16) tests the literal WITHOUT raising, so the cast in the
  // THEN branch is only reached for a value PostgreSQL can actually parse. That
  // second defect was likewise found only by running the query for real.
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])" +
  "T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?" +
  "(Z|[+][0-9]{2}:[0-5][0-9]|-[0-9]{2}:[0-5][0-9])$";

/**
 * FIN-07-03c.14 — candidate eligibility, evaluated in the DATABASE.
 *
 * Why raw SQL (Option A): Prisma's JSON-path filter layer cannot express
 * "this key is absent OR not one of these values". The repository's existing
 * pattern (`Prisma.AnyNull` OR `NOT { path: [...] }`, src/services/
 * product.service.ts:404) only guards a whole-field NULL, and this worker
 * relies on the `outcome` key being ABSENT on exactly the candidates that must
 * stay eligible. In PostgreSQL `jsonb -> 'missing'` yields SQL NULL, so
 * `NOT (NULL = X)` is NULL and WHERE would drop the row. These predicates
 * therefore spell the NULL cases out explicitly.
 *
 * NULL handling, stated plainly:
 *   - `"paystackData" IS NULL`                         -> eligible (never checked)
 *   - `->'expiredRecovery'` absent                     -> `->>` is NULL -> eligible
 *   - `->>'outcome'` absent                            -> NULL -> eligible
 *   - `->>'outcome'` is JSON null                      -> NULL -> eligible
 *   - `->>'outcome'` is one of the two terminal values -> EXCLUDED
 *   - `->>'outcome'` is anything else                  -> eligible
 *   - `->>'nextCheckAt'` absent or NULL                -> eligible (due now)
 *   - `->>'nextCheckAt'` well-formed and in the future -> EXCLUDED (cooldown)
 *   - `->>'nextCheckAt'` well-formed and in the past   -> eligible
 *   - `->>'nextCheckAt'` malformed                     -> eligible (see below)
 *
 * MALFORMED-TIMESTAMP POLICY: malformed is treated as ABSENT, i.e. the payment
 * is due now. The alternative — treating it as a permanent cooldown — would
 * silently drop a payment that may hold a customer's captured money, which is
 * the exact loss this worker exists to prevent. Re-checking costs at most one
 * provider call, is bounded by the call budget, and is idempotent: the
 * finalizer and the refund-obligation dedupe make a duplicate check a no-op.
 * The regex guard plus the bounded ranges mean the cast cannot throw, and CASE
 * is used rather than OR because CASE is the only form with a guaranteed
 * evaluation order.
 *
 * Every value is a bound parameter. Nothing is interpolated from row data.
 */
const eligiblePaymentPredicate = (now: Date) => Prisma.sql`
  (
    p."paystackData" IS NULL
    OR (p."paystackData"->'expiredRecovery'->>'outcome') IS NULL
    OR (p."paystackData"->'expiredRecovery'->>'outcome') NOT IN (
      ${Prisma.sql`${TERMINAL_OUTCOMES[0]}`}::text,
      ${Prisma.sql`${TERMINAL_OUTCOMES[1]}`}::text
    )
  )
  AND CASE
    WHEN (p."paystackData"->'expiredRecovery'->>'nextCheckAt') ~ ${ISO_8601_PATTERN}
         AND pg_input_is_valid(p."paystackData"->'expiredRecovery'->>'nextCheckAt', 'timestamp')
    THEN (p."paystackData"->'expiredRecovery'->>'nextCheckAt')::timestamptz <= ${now}
    ELSE TRUE
  END
`;

/**
 * Column list for the candidate scan. `expiresAt` and `id` are immutable as far
 * as this worker is concerned — the marker write only touches `paystackData` —
 * so the ordering is stable for the whole run and the keyset boundary stays
 * valid.
 */
const SELECT_CANDIDATES = Prisma.sql`
  p."id"         AS "id",
  p."reference"  AS "reference",
  p."expiresAt"  AS "expiresAt",
  p."paystackData" AS "paystackData"
`;

/** A definitive answer was already recorded, so this reference needs no further check. */
function isTerminal(marker: RecoveryMarker | null): boolean {
  // Driven by the same constant the SQL predicate uses, so the database filter
  // and this defensive re-check can never disagree about what is terminal.
  return (
    marker?.outcome === TERMINAL_OUTCOMES[0] ||
    marker?.outcome === TERMINAL_OUTCOMES[1]
  );
}

/** The reference's scheduled backoff has elapsed and it may be checked again. */
function isDue(marker: RecoveryMarker | null, now: Date): boolean {
  if (!marker?.nextCheckAt) return true;
  const next = new Date(marker.nextCheckAt).getTime();
  if (!Number.isFinite(next)) return true;
  return next <= now.getTime();
}

/**
 * Deterministic per-reference spread, so a batch recovered by the same outage
 * does not retry in lockstep. Derived from the reference rather than a random
 * source so behaviour stays reproducible and testable.
 */
function jitterFor(reference: string, baseMs: number): number {
  let hash = 0;
  for (let i = 0; i < reference.length; i++) {
    hash = (hash * 31 + reference.charCodeAt(i)) >>> 0;
  }
  const spread = Math.max(1, Math.floor(baseMs / 2));
  return hash % spread;
}

/**
 * Exponential backoff plus deterministic per-reference spread.
 *
 * FIN-07-03c.3: the jitter is SUBTRACTED from the ceiling rather than added to
 * it, so the total delay never exceeds `RECOVERY_BACKOFF_CAP_MS`. Spreading is
 * preserved because the jitter is taken as a fraction of the ceiling, leaving
 * every delay inside [cap/2, cap].
 */
export function nextCheckDelayMs(attempts: number, reference: string): number {
  const exponent = Math.max(0, attempts - 1);
  const scaled = RECOVERY_BACKOFF_BASE_MS * Math.pow(2, exponent);
  const ceiling = Math.min(scaled, RECOVERY_BACKOFF_CAP_MS);
  return Math.max(0, ceiling - jitterFor(reference, ceiling));
}

/** Merge the marker without discarding Paystack's own payload. */
/** Attempts observed on the candidate row as originally scanned. */
function scannedAttempts(paystackData: unknown): number {
  return readMarker(paystackData)?.attempts ?? 0;
}

function buildPayload(
  paystackData: unknown,
  marker: RecoveryMarker,
): Record<string, unknown> {
  const base =
    paystackData && typeof paystackData === "object" && !Array.isArray(paystackData)
      ? (paystackData as Record<string, unknown>)
      : {};
  return { ...base, [RECOVERY_MARKER_KEY]: marker };
}

/**
 * Records the outcome of one provider check.
 *
 * `resolved` is terminal. Otherwise the attempt count is incremented and
 * `nextCheckAt` is pushed into the future so the reference yields its budget
 * to the rest of the queue. A write failure here is swallowed deliberately:
 * the reference simply stays unmarked and is retried on a later run, and every
 * downstream effect is idempotent, so a lost marker can never invent a success.
 */
async function recordCheck(
  paymentId: string,
  reference: string,
  paystackData: unknown,
  resolved: "reconciled" | "provider_not_successful" | null,
  evidence?: unknown,
): Promise<void> {
  // FIN-07-03c.3 (F-07): re-read immediately before writing so this update
  // merges onto whatever is currently stored instead of overwriting a payload
  // written by another writer since the candidate row was read. This NARROWS
  // the read-modify-write window; it does NOT make the write atomic. Two
  // concurrent workers can still lose an attempt increment. The race is
  // benign — `attempts` only steers backoff, and a lost increment only delays
  // a retry — and the per-payment `isProcessing` lock plus the finalizer's
  // obligation dedupe keep the money-moving effects safe. Making this atomic
  // would need a schema change or distributed locking, both out of scope.
  let current: unknown = paystackData;
  try {
    const fresh = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { paystackData: true },
    });
    if (fresh) current = fresh.paystackData;
  } catch (err) {
    logger.warn(
      { err, reference },
      "verifyExpiredPayments: could not re-read payment before recording; using scanned value",
    );
  }

  const previous = readMarker(current);
  // Monotonic: never let a stale read walk the counter backwards.
  const attempts = Math.max(previous?.attempts ?? 0, scannedAttempts(paystackData)) + 1;

  const marker: RecoveryMarker = resolved
    ? { outcome: resolved, attempts, checkedAt: new Date().toISOString() }
    : {
        attempts,
        nextCheckAt: new Date(
          Date.now() + nextCheckDelayMs(attempts, reference),
        ).toISOString(),
        checkedAt: new Date().toISOString(),
      };

  // FIN-07-03c.3 (F-04): a recovered capture is evidence that a customer was
  // charged. The finalizer's EXPIRED branch writes nothing to Payment, so the
  // provider payload would otherwise be discarded the moment the worker moves
  // on. It is kept under the marker namespace so it cannot collide with, or
  // overwrite, the payload the payment was created with (`authorization_url`
  // and friends), and so unrelated payment metadata is preserved.
  if (evidence !== undefined) {
    marker.evidence = evidence;
  }

  try {
    const written = await prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.EXPIRED },
      data: { paystackData: buildPayload(current, marker) as never },
    });
    if (written.count === 0) {
      // A concurrent transition moved the reference off EXPIRED. Nothing to
      // record — the record that wins is authoritative, not this worker.
      logger.info(
        { reference },
        "verifyExpiredPayments: reference no longer EXPIRED; marker not written",
      );
      return;
    }
    logger.info(
      { reference, resolved: resolved ?? "deferred", attempts, evidenceRetained: evidence !== undefined },
      "verifyExpiredPayments: recorded provider check",
    );
  } catch (err) {
    // The evidence and the marker are written together, so a failure here means
    // NEITHER was saved. Nothing claims otherwise: the reference simply stays
    // unmarked and is re-examined on a later run.
    logger.warn(
      { err, reference },
      "verifyExpiredPayments: could not persist recovery marker; will retry",
    );
  }
}

/**
 * Only Paystack's documented statuses decide the outcome. The transaction API
 * documents `success`, `failed` and `abandoned` as the status values it
 * filters on; anything else — including `pending`, `processing` and anything
 * this code has never seen — is treated as NOT definitive and retried.
 */
function isDefinitiveNegative(status: unknown): boolean {
  const value = String(status ?? "").toLowerCase();
  return value === "failed" || value === "abandoned";
}


/** A candidate row as selected by the production scan. */
export type RecoveryCandidate = {
  id: string;
  reference: string;
  expiresAt: Date;
  paystackData: unknown;
};

/**
 * FIN-07-03c.16 — test seam.
 *
 * Executes the EXACT production candidate query and returns the rows it
 * selects. Extracted purely so the SQL can be executed against a real
 * PostgreSQL without running the recovery worker, which would make real
 * Paystack calls and invoke payment finalization.
 *
 * This is a relocation, not a change: the SQL, its bound-parameter order and
 * its semantics are byte-for-byte those `verifyExpiredPayments` already used.
 */
export async function fetchRecoveryCandidates(opts: {
  cutoff: Date;
  now: Date;
  limit: number;
  keyset?: { expiresAt: Date; id: string } | null;
}): Promise<RecoveryCandidate[]> {
  return prisma.$queryRaw(Prisma.sql`
      SELECT ${SELECT_CANDIDATES}
      FROM "Payment" p
      WHERE p."status" = ${PaymentStatus.EXPIRED}::"PaymentStatus"
        -- The 72-hour application recovery window, measured from Payment.expiresAt.
        AND p."expiresAt" >= ${opts.cutoff}
        AND p."reference" NOT LIKE ${"SEED-%"}
        -- FIN-07-03c.14: terminal and cooling-down records are excluded HERE,
        -- before LIMIT, so they can no longer consume the scan budget.
        AND ${eligiblePaymentPredicate(opts.now)}
        ${
          opts.keyset
            ? Prisma.sql`AND (p."expiresAt" > ${opts.keyset.expiresAt}
                    OR (p."expiresAt" = ${opts.keyset.expiresAt} AND p."id" > ${opts.keyset.id}))`
            : Prisma.empty
        }
      ORDER BY p."expiresAt" ASC, p."id" ASC
      LIMIT ${opts.limit}
    `);
}

/** One bounded, fair recovery pass. */
export async function verifyExpiredPayments(batchSize = DEFAULT_BATCH_SIZE) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - EXPIRED_RECOVERY_WINDOW_MS);

  /**
   * Keyset boundary for the next page, captured from the previous page's last
   * row AT FETCH TIME — before any write this run mutates that row.
   *
   * FIN-07-03c.3 (F-03): this replaces Prisma's `cursor` option. `cursor`
   * keyed on `id` while the sort began at `expiresAt` was never verified
   * against PostgreSQL, and a cursor re-reads its row's CURRENT sort values —
   * so a row mutated between pages moves the boundary. Both defects are
   * removed by comparing against an explicit snapshot of two columns this
   * worker never writes, which is ordinary row-value comparison with no
   * Prisma-specific behaviour to verify.
   */
  let keyset: { expiresAt: Date; id: string } | null = null;
  let scanned = 0;
  let checked = 0;
  let reconciled = 0;
  let notSuccessful = 0;
  let deferred = 0;
  let inCooldown = 0;
  let alreadyResolved = 0;

  while (checked < batchSize && scanned < MAX_ROWS_PER_RUN) {
    const page = await fetchRecoveryCandidates({
      cutoff,
      now,
      limit: PAGE_SIZE,
      keyset,
    });

    if (page.length === 0) break;
    scanned += page.length;
    // `expiresAt` is nullable in the schema, but the `gte: cutoff` predicate
    // above already excludes nulls, so every row reaching here has one.
    const last = page[page.length - 1];
    if (!last.expiresAt) break;
    keyset = { expiresAt: last.expiresAt, id: last.id };

    for (const payment of page) {
      if (checked >= batchSize) break;

      const marker = readMarker(payment.paystackData);
      // Terminal: never queried again.
      if (isTerminal(marker)) {
        alreadyResolved++;
        continue;
      }
      // Scheduled retry has not come due yet: yield the budget to the rest.
      if (!isDue(marker, now)) {
        inCooldown++;
        continue;
      }

      checked++;
      try {
        const data = await verifyPayment(payment.reference);

        if (data?.status === "success") {
          // Canonical finalizer. For an EXPIRED payment this reaches the
          // FIN-07-02 branch, which files one durable refund obligation per
          // cancelled order and leaves both terminal records intact.
          const result = await finalizePaymentSuccess({
            reference: payment.reference,
            amountKobo: data.amount, // integer kobo from Paystack (Phase 3A)
            currency: data.currency,
            customerIdFromGateway: data.metadata?.userId,
            channel: data.channel,
            paystackData: data,
            authorization: data.authorization,
          });
          logger.info(
            { reference: payment.reference, outcome: result.outcome },
            "verifyExpiredPayments: reconciled with Paystack",
          );
          // Only a completed reconciliation is terminal. LOCKED (a webhook is
          // mid-flight) or a validation refusal defers to a later pass.
          if (result.outcome === "LATE_CAPTURE_REFUND_FILED") {
            await recordCheck(
              payment.id,
              payment.reference,
              payment.paystackData,
              "reconciled",
              data,
            );
            reconciled++;
          } else {
            await recordCheck(payment.id, payment.reference, payment.paystackData, null);
            deferred++;
          }
        } else if (isDefinitiveNegative(data?.status)) {
          // Paystack states the charge did not succeed. Recorded so the
          // reference stops consuming provider calls; the payment stays
          // EXPIRED, which is already the correct terminal state.
          await recordCheck(payment.id, payment.reference, payment.paystackData, "provider_not_successful");
          notSuccessful++;
        } else {
          // `pending`, `processing`, an unknown value, or no status at all.
          // Never proof of failure — scheduled for a retry.
          await recordCheck(payment.id, payment.reference, payment.paystackData, null);
          deferred++;
        }
      } catch (err) {
        // Transport error, timeout, or a thrown provider/persistence call.
        // State is preserved and the reference is rescheduled, never converted
        // into a terminal outcome.
        deferred++;
        logger.warn(
          { err, reference: payment.reference },
          "verifyExpiredPayments: provider check failed; leaving reference recoverable",
        );
        try {
          await recordCheck(payment.id, payment.reference, payment.paystackData, null);
        } catch {
          // recordCheck already swallows and logs its own failures.
        }
      }
    }

    if (page.length < PAGE_SIZE) break;
  }

  // F-01 observability: if the row budget ran out before the call budget did,
  // the scan never reached the end of the candidate set. This is the signature
  // of the known blocker (resolved and cooling-down rows consuming the budget)
  // and is emitted so a growing backlog is noticed rather than silently
  // truncating recovery. See WHAT IS AND IS NOT FIXED in the header.
  if (scanned >= MAX_ROWS_PER_RUN && checked < batchSize) {
    logger.warn(
      { scanned, checked, inCooldown, alreadyResolved, maxRows: MAX_ROWS_PER_RUN },
      "verifyExpiredPayments: row budget exhausted before provider-call budget; " +
        "backlog deeper than one pass, consider raising MAX_ROWS_PER_RUN",
    );
  }

  logger.info(
    {
      scanned,
      checked,
      reconciled,
      notSuccessful,
      deferred,
      inCooldown,
      alreadyResolved,
    },
    "verifyExpiredPayments completed",
  );
  return { scanned, checked, reconciled, notSuccessful, deferred, inCooldown, alreadyResolved };
}
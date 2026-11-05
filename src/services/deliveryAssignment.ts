import { ActivityType, OrderStatus, DeliveryStatus, DeliveryPersonStatus, DeliveryBroadcastStatus, PaymentStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { getIO } from "../socket";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { runOrderCompletionSideEffects } from "./orderCompletionSideEffects";
import { logger } from "../lib/logger";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "../errors/AppError";
import haversine from "haversine-distance";
import {
  ACTIVE_DELIVERY_STATUSES as SHARED_ACTIVE_DELIVERY_STATUSES,
  DISPATCHABLE_ORDER_STATUSES,
  isTerminalOrderStatus,
  reconcileActiveDeliveryAssignments,
} from "./deliveryAssignmentReconciliation";
import { assertOrderNotSettled, creditDeliveryEarning } from "./deliveryEarning";

const MAX_STACK = 3; // max concurrent active assignments per driver
const BROADCAST_WINDOW_SECONDS = 30;
const TOP_DRIVERS_PER_BROADCAST = 5;

/** One row of the stranded-dispatch candidate scan. Read-only; never written. */
interface StrandedScanRow {
  id: string;
  /** `GREATEST` over both artifact tables; `'-infinity'` when neither has one. */
  latest_artifact: Date | null;
  has_expired_pending: boolean;
}

/** Result of reading one bounded page of stranded-dispatch candidates. */
interface StrandedScanPage {
  ids: string[];
  /** Cursor for the next page; equals `afterId` when the page was empty. */
  lastId: string | null;
  /** True when the page was full, so more candidates may exist beyond it. */
  returnedFullPage: boolean;
  count: number;
  noArtifactCount: number;
  expiredPendingCount: number;
  /** Age in seconds of the oldest artifact seen on this page; null if none. */
  oldestAgeSeconds: number | null;
  durationMs: number;
}

/**
 * N-05A: the order-state conditions under which a delivery event is allowed to
 * mirror itself onto the main `Order` row.
 *
 * The delivery workflow is a second writer of `Order.status`, so every mirror
 * write must obey the same invariants the canonical transition path enforces
 * in `orderController.updateOrderStatus` (transition table + payment gate).
 * Mirroring without these predicates let a driver DELIVERED silently overwrite
 * a CANCELLED order that already had a refund filed — producing an order that
 * was simultaneously refundable and vendor-payout-eligible — and could complete
 * an unpaid order outright.
 *
 * Predicates deliberately mirror the canonical table:
 *   OUT_FOR_DELIVERY  <- READY_FOR_PICKUP  (vendor transition, mirrored by PICKED_UP)
 *   COMPLETED         <- OUT_FOR_DELIVERY, and only when payment SUCCEEDED
 *   FAILED_DELIVERY   <- OUT_FOR_DELIVERY
 *
 * Anything else (CANCELLED, CANCELLED_UNPAID, PAYMENT_EXPIRED,
 * AWAITING_PAYMENT, PENDING, …) matches nothing, so it can never be
 * overwritten. OUT_FOR_DELIVERY is idempotent by also accepting itself, so a
 * driver picking up an order the vendor already moved forward is a no-op
 * rather than a spurious rejection.
 */
const ORDER_MIRROR_PREDICATES: Partial<Record<OrderStatus, Prisma.OrderWhereInput>> = {
  [OrderStatus.OUT_FOR_DELIVERY]: {
    status: { in: [OrderStatus.READY_FOR_PICKUP, OrderStatus.OUT_FOR_DELIVERY] },
  },
  [OrderStatus.COMPLETED]: {
    status: OrderStatus.OUT_FOR_DELIVERY,
    paymentStatus: PaymentStatus.SUCCESS,
  },
  [OrderStatus.FAILED_DELIVERY]: {
    status: OrderStatus.OUT_FOR_DELIVERY,
  },
};

/**
 * N-05B: the order states a driver may legally be dispatched for.
 *
 * Derived from the canonical transition table in
 * `orderController.updateOrderStatus` — the only orders that can still
 * physically be delivered are the ones the vendor has handed over:
 *
 *   COOKING <- PAYMENT_CONFIRMED      (vendor)
 *   READY_FOR_PICKUP <- COOKING       (vendor)   ← dispatchable
 *   OUT_FOR_DELIVERY <- READY_FOR_PICKUP (vendor) ← dispatchable (reassignment)
 *   COMPLETED <- OUT_FOR_DELIVERY     (customer)  — terminal
 *
 * `READY_FOR_PICKUP` is the state a vendor puts an order in when the food is
 * bagged and waiting for a rider, which is exactly the dispatch trigger.
 *
 * `OUT_FOR_DELIVERY` is included on purpose: assigning a driver does NOT move
 * the order forward (only `updateOrderStatus` and the N-05A `PICKED_UP` mirror
 * write `Order.status`), and both automatic reassignment paths re-enter
 * `assignOrder` for an order the vendor may already have moved on —
 * `expireOldBroadcasts` (broadcast timed out) and `handleDecline` (driver
 * declined). Excluding it would make those legitimate retries fail on a
 * perfectly good order. It is also what N-05A already treats as idempotent for
 * the `PICKED_UP` mirror, so both writers now agree on the same boundary.
 *
 * Everything else is non-dispatchable: not-started states (PENDING,
 * WAITING_VENDOR_CONFIRMATION, WAITING_CUSTOMER_APPROVAL, AWAITING_PAYMENT),
 * pre-dispatch states (PAYMENT_CONFIRMED, COOKING), and terminal/dead-end
 * states (CANCELLED, CANCELLED_UNPAID, PAYMENT_EXPIRED, COMPLETED,
 * FAILED_DELIVERY — the canonical table has no transition out of
 * FAILED_DELIVERY either).
 */


/**
 * N-05B: assignment statuses that still own an order's delivery. Used only for
 * the per-order "already dispatched" guard — deliberately separate from the
 * per-driver stacking counts above, which have their own (narrower) notion of
 * "active" and are out of scope here.
 *
 * EN_ROUTE is included because a driver physically holding the order is
 * mid-delivery: accepting another assignment for the same order would let two
 * riders be paid for one delivery.
 *
 * F4-1: the list itself now lives in `deliveryAssignmentReconciliation.ts`
 * (unchanged values — a pure move) so that the INV-1 reconciliation predicate
 * and this per-order guard can never drift apart.
 */
const ACTIVE_DELIVERY_STATUSES = SHARED_ACTIVE_DELIVERY_STATUSES;

/**
 * The per-driver stacking statuses `assignOrder` counts against MAX_STACK.
 *
 * N-05C: extracted verbatim from the inline list `assignOrder` already used so
 * that `acceptBroadcast` can enforce *the same* capacity rule instead of
 * introducing a second one. Values are unchanged — note this set is
 * deliberately still narrower than ACTIVE_DELIVERY_STATUSES above (it omits
 * EN_ROUTE); unifying the two is F5 and has been implemented. The capacity
 * set now mirrors the active delivery set because a driver who is EN_ROUTE
 * is still actively handling an order and cannot take another.
 */
const DRIVER_STACK_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.ACCEPTED,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.EN_ROUTE,
];

// Valid status transitions a driver can make themselves via updateStatus.
// ASSIGNED/ACCEPTED/DECLINED are handled by their own dedicated,
// ownership-checked methods above, not through this generic endpoint.
const DELIVERY_TRANSITIONS: Partial<Record<DeliveryStatus, DeliveryStatus[]>> = {
  [DeliveryStatus.PICKED_UP]: [DeliveryStatus.ACCEPTED],
  [DeliveryStatus.EN_ROUTE]: [DeliveryStatus.PICKED_UP],
  [DeliveryStatus.DELIVERED]: [DeliveryStatus.EN_ROUTE, DeliveryStatus.PICKED_UP],
  [DeliveryStatus.FAILED]: [DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE],
  [DeliveryStatus.RETURNED]: [DeliveryStatus.FAILED],
  [DeliveryStatus.CANCELLED]: [DeliveryStatus.ASSIGNED, DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE],
};

/** Pure, independently-testable transition check — see tests/unit/deliveryTransitions.test.ts */
export function isValidDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  const allowedFrom = DELIVERY_TRANSITIONS[to];
  return !!allowedFrom && allowedFrom.includes(from);
}

export class DeliveryAssignmentService {
  /**
   * Expires broadcasts whose window has passed with no driver accepting,
   * and retries assignment for their order. Previously this function
   * existed but was never called from anywhere — broadcasts that timed
   * out with no response just sat in PENDING forever, and the order was
   * never reassigned or escalated. Now wired into a scheduled job (see
   * jobs/node-cron/runJob.ts).
   *
   * N-05B follow-up: the expiry write is a COMPARE-AND-SET, not a bare
   * update.
   *
   * The candidate read above filters `status: PENDING`, but a filter on the
   * read does not constrain the write. A driver can accept a broadcast in the
   * window between the `findMany` and the write, and the old unconditional
   * `update({ where: { id } })` then flipped that live, already-ACCEPTED
   * broadcast to EXPIRED — destroying `acceptedDriverId` and prompting a
   * second `assignOrder` for an order that had just been dispatched.
   *
   * The write below therefore matches `status: PENDING` as well as the id, so
   * it is a single atomic statement:
   *
   *     UPDATE "DeliveryBroadcast" SET status = 'EXPIRED'
   *     WHERE id = $id AND status = 'PENDING'
   *
   * `count === 1` means this sweep is the one that expired the offer and owns
   * the reassignment. `count === 0` means someone else already transitioned
   * it — normally a driver accepting. That is the race being correctly
   * resolved, not an error: this worker skips the row entirely, leaving the
   * accepted broadcast (and its accepting driver) untouched and issuing no
   * competing dispatch. This is the same compare-and-set that broadcast
   * acceptance itself uses a few hundred lines below, so the two writers of
   * broadcast status cannot drift apart.
   */
  static async expireOldBroadcasts() {
    const now = new Date();
    const expired = await prisma.deliveryBroadcast.findMany({
      where: { status: DeliveryBroadcastStatus.PENDING, expiresAt: { lt: now } },
    });

    let expiredCount = 0;

    for (const b of expired) {
      const claimed = await prisma.deliveryBroadcast.updateMany({
        where: { id: b.id, status: DeliveryBroadcastStatus.PENDING },
        data: { status: DeliveryBroadcastStatus.EXPIRED },
      });

      // Another writer transitioned this broadcast first — most likely the
      // driver accepting it. Do not reassign, and do not report it as expired.
      if (claimed.count !== 1) continue;

      expiredCount += 1;

      try {
        await this.assignOrder(b.orderId);
      } catch (err) {
        logger.warn({ err, orderId: b.orderId, broadcastId: b.id }, "Failed to reassign order after broadcast expiry");
      }
    }

    if (expiredCount > 0) logger.info({ count: expiredCount }, "Expired stale delivery broadcasts and retried assignment");
    return expiredCount;
  }

  /* ── stranded-dispatch OBSERVATION (read-only) ─────────────────────────── */

  /**
   * Opt-in, default OFF. Strict opt-in: any other value (including "1", "TRUE",
   * "yes") leaves the job unregistered.
   */
  static readonly RECONCILE_ENABLED =
    process.env.RECONCILE_STRANDED_DISPATCH_ENABLED === "true";

  /**
   * Reads a positive integer from the environment, or returns null.
   *
   * There are deliberately NO defaults here. A missing or malformed batch size
   * must stop the job rather than silently pick one — the safe value depends on
   * an online-driver population and a database budget this code cannot see.
   */
  private static readPositiveIntEnv(name: string, min: number): number | null {
    const raw = process.env[name];
    if (raw === undefined || raw === "") {
      logger.error({ name }, "Stranded-dispatch scan disabled: required configuration is missing");
      return null;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      logger.error({ name, reason: "must be an integer >= " + min }, "Stranded-dispatch scan disabled: invalid configuration");
      return null;
    }
    return value;
  }

  /**
   * Reads one page of orders that appear to be stranded in delivery dispatch.
   *
   * OBSERVATION ONLY. This method performs no writes of any kind: it does not
   * call `assignOrder`, does not create or modify a `DeliveryBroadcast` or
   * `DeliveryAssignment`, does not touch `Order`, and emits no socket event or
   * notification. Its sole output is a structured log line. Recovery remains
   * unimplemented on purpose — see the class-level notes on scan limits below.
   *
   * The eligibility predicate mirrors, and never replaces, the guards that
   * `claimOrderForDispatch` enforces transactionally:
   *
   *   - `Order.status` in DISPATCHABLE_ORDER_STATUSES   (mirrors :483)
   *   - `Order.paymentStatus = SUCCESS`                 (mirrors :484)
   *   - no assignment in ACTIVE_DELIVERY_STATUSES       (mirrors :538)
   *   - no broadcast that is PENDING *and* unexpired     (mirrors :542-548)
   *
   * A PENDING broadcast whose `expiresAt` has passed is deliberately NOT
   * excluded: `claimOrderForDispatch` counts only unexpired PENDING broadcasts,
   * so an expired offer does not block a future dispatch and is exactly the
   * state the expiry sweep would clear.
   *
   * AGE SIGNAL — `GREATEST` over BOTH artifact tables, with `'-infinity'`
   * fallbacks. Two details are load-bearing:
   *
   *   1. `GREATEST`, not `COALESCE(MAX(b), MAX(a))`. A coalesce returns the
   *      broadcast timestamp whenever any broadcast exists, ignoring a newer
   *      assignment — so an order whose driver declined 5 minutes after its
   *      broadcast would look 5 minutes staler than it is and be recovered late.
   *   2. `'-infinity'` when neither table has a row. A `NULL` here would make
   *      the comparison `NULL`, which is not true, so an order that has NEVER
   *      been dispatched would be excluded — precisely the case most worth
   *      surfacing.
   *
   * `NULLIF(..., '-infinity')` wraps the SELECT list only. `'-infinity'` stays
   * inside the WHERE comparison, where it is evaluated server-side and never
   * leaves PostgreSQL; the projection converts it to a real SQL NULL so the
   * driver receives a nullable timestamp. This matters because Prisma's engine
   * CANNOT deserialise `-infinity` — it is year -271821, far outside JS Date's
   * ±8.64e15 ms range — and fails the whole query with "value too large to
   * decode". Selecting the raw sentinel would break every scan that saw a
   * never-dispatched order, which is the most common candidate of all.
   * `NULL` is also what the row handling below already expects.
   *
   * TIMEZONE — every comparison against the current instant uses
   * `now() AT TIME ZONE 'UTC'`, never bare `now()`.
   *
   * `expiresAt`, `createdAt` and `updatedAt` are all `timestamp without time
   * zone` columns (verified in information_schema) holding UTC wall-clock
   * values: the application writes JS `Date`s, and `createdAt`'s
   * `CURRENT_TIMESTAMP` default is only equal to UTC when the session runs in
   * UTC. Bare `now()` is `timestamptz`, so comparing it to a naive column makes
   * PostgreSQL reinterpret the stored UTC value in the session TimeZone. Under
   * `Africa/Lagos` that shifts every comparison by 60 minutes — an integration
   * run captured `latest_artifact` returning exactly one hour BEFORE the
   * `createdAt` that had been persisted, and a genuinely live broadcast
   * (`expiresAt` 30s in the future) read as expired, so the order was reported
   * as stranded while a valid offer was open.
   *
   * `AT TIME ZONE 'UTC'` yields a `timestamp without time zone`, making the
   * comparison like-for-like and independent of the session or host timezone.
   * This matters for correctness, not tidiness: this query decides which paid
   * orders get escalated, and the rest of this file already avoids the hazard
   * by comparing JS `Date`s in Prisma rather than using SQL `now()`
   * (see `expireOldBroadcasts` and `acceptBroadcast`).
   *
   * `Order.updatedAt` is deliberately NOT used: `claimOrderRow` (:485) writes
   * only `updatedAt`, and every other writer of that column does the same, so it
   * moves on any write and survives rollback. It measures "recently touched",
   * not "recently dispatched".
   *
   * @param pageSize   max candidate rows to return
   * @param graceMinutes how old the newest dispatch artifact must be
   * @param afterId    exclusive lower bound on `Order.id`, or null for the
   *                    first page. `Order.id` is a Prisma `String` with a uuid
   *                    default — a text column, not a native uuid — so both
   *                    sides are compared as text.
   */
  static async scanStrandedDispatches(
    pageSize: number,
    graceMinutes: number,
    afterId: string | null,
  ): Promise<StrandedScanPage> {
    const startedAt = Date.now();

    // Every value below is bound as a query parameter. The enum literals are
    // interpolated through `Prisma.sql` so each one carries its own
    // `::"EnumName"` cast: `Prisma.join` alone emits `?, ?, ?` with no type
    // context, which PostgreSQL cannot compare against a typed enum column.
    const rows = await prisma.$queryRaw<StrandedScanRow[]>`
      SELECT
        o."id"                       AS id,
        NULLIF(
          GREATEST(
            COALESCE((SELECT max(b."createdAt") FROM "DeliveryBroadcast"  b WHERE b."orderId" = o."id"), '-infinity'::timestamptz),
            COALESCE((SELECT max(a."createdAt") FROM "DeliveryAssignment" a WHERE a."orderId" = o."id"), '-infinity'::timestamptz)
          ),
          '-infinity'::timestamptz
        )                         AS latest_artifact,
        EXISTS (
          SELECT 1 FROM "DeliveryBroadcast" pb
          WHERE pb."orderId" = o."id"
            AND pb."status" = ${DeliveryBroadcastStatus.PENDING}::"DeliveryBroadcastStatus"
            AND pb."expiresAt" <= (now() AT TIME ZONE 'UTC')
        )                           AS has_expired_pending
      FROM "Order" o
      WHERE o."status" IN (${Prisma.join(
        DISPATCHABLE_ORDER_STATUSES.map((s) => Prisma.sql`${s}::"OrderStatus"`),
      )})
        AND o."paymentStatus" = ${PaymentStatus.SUCCESS}::"PaymentStatus"
        AND NOT EXISTS (
          SELECT 1 FROM "DeliveryAssignment" a2
          WHERE a2."orderId" = o."id"
            AND a2."status" IN (${Prisma.join(
              ACTIVE_DELIVERY_STATUSES.map((s) => Prisma.sql`${s}::"DeliveryStatus"`),
            )})
        )
        AND NOT EXISTS (
          SELECT 1 FROM "DeliveryBroadcast" b2
          WHERE b2."orderId" = o."id"
            AND b2."status" = ${DeliveryBroadcastStatus.PENDING}::"DeliveryBroadcastStatus"
            AND b2."expiresAt" > (now() AT TIME ZONE 'UTC')
        )
        AND GREATEST(
              COALESCE((SELECT max(b3."createdAt") FROM "DeliveryBroadcast"  b3 WHERE b3."orderId" = o."id"), '-infinity'::timestamptz),
              COALESCE((SELECT max(a3."createdAt") FROM "DeliveryAssignment" a3 WHERE a3."orderId" = o."id"), '-infinity'::timestamptz)
            ) < (now() AT TIME ZONE 'UTC') - make_interval(mins => ${graceMinutes}::int)
        AND (${afterId}::text IS NULL OR o."id" > ${afterId}::text)
      ORDER BY o."id"
      LIMIT ${pageSize}::int
    `;

    const withArtifact = rows.filter((r) => r.latest_artifact !== null);
    const artifactDates = withArtifact.map((r) => r.latest_artifact as Date);
    const oldestAgeSeconds = artifactDates.length
      ? Math.max(...artifactDates.map((d) => Math.floor((Date.now() - d.getTime()) / 1000)))
      : null;

    return {
      ids: rows.map((r) => r.id),
      lastId: rows.length ? rows[rows.length - 1].id : afterId,
      returnedFullPage: rows.length === pageSize,
      count: rows.length,
      noArtifactCount: rows.length - withArtifact.length,
      expiredPendingCount: rows.filter((r) => r.has_expired_pending).length,
      oldestAgeSeconds,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * One scheduled observation pass. Reads candidates in bounded pages and logs
   * what it found. Writes nothing and recovers nothing.
   *
   * Coverage is deliberately incomplete and this method does not pretend
   * otherwise. Every page restarts from the beginning — there is no persisted
   * and no module-level cursor — so a run that is cut short by `maxPages` will
   * examine the same leading candidates next time and can indefinitely miss
   * the ones behind them. Orders that fail to recover write nothing, so nothing
   * about them changes between runs either. `truncated` is reported precisely
   * so that this is visible in logs rather than discovered in production.
   *
   * Raising `maxPages` improves coverage and lengthens the run; the two cannot
   * both be maximised without persisted state, which is out of scope here.
   */
  static async observeStrandedDispatches(): Promise<void> {
    if (!this.RECONCILE_ENABLED) return;

    const pageSize = this.readPositiveIntEnv("RECONCILE_STRANDED_DISPATCH_PAGE_SIZE", 1);
    const graceMinutes = this.readPositiveIntEnv("RECONCILE_STRANDED_DISPATCH_GRACE_MINUTES", 1);
    const maxPages = this.readPositiveIntEnv("RECONCILE_STRANDED_DISPATCH_MAX_PAGES", 1);
    if (pageSize === null || graceMinutes === null || maxPages === null) {
      logger.error({}, "Stranded-dispatch scan skipped: invalid configuration");
      return;
    }

    let afterId: string | null = null;
    let pages = 0;
    let total = 0;
    let noArtifact = 0;
    let expiredPending = 0;
    let oldestAgeSeconds: number | null = null;
    const runStartedAt = Date.now();
    let truncated = false;

    try {
      while (pages < maxPages) {
        const page = await this.scanStrandedDispatches(pageSize, graceMinutes, afterId);
        pages += 1;
        total += page.count;
        noArtifact += page.noArtifactCount;
        expiredPending += page.expiredPendingCount;
        if (page.oldestAgeSeconds !== null && (oldestAgeSeconds === null || page.oldestAgeSeconds > oldestAgeSeconds)) {
          oldestAgeSeconds = page.oldestAgeSeconds;
        }

        // A short page means the keyset is exhausted, not that we ran out of
        // pages; either way there is nothing further to read this run.
        if (!page.returnedFullPage) break;
        afterId = page.lastId;
      }

      // Only meaningful if the final page was full AND we still had budget.
      truncated = pages === maxPages && afterId !== null;
    } catch (err) {
      logger.error({ err, pages, scannedSoFar: total }, "Stranded-dispatch scan failed");
      throw err;
    }

    // Ids are intentionally NOT logged: order identifiers are operational data
    // and the summary below answers "how bad is it" without exposing them.
    logger.info(
      {
        candidateCount: total,
        pagesRead: pages,
        pageSize,
        maxPages,
        graceMinutes,
        noArtifactCount: noArtifact,
        expiredPendingCount: expiredPending,
        oldestArtifactAgeSeconds: oldestAgeSeconds,
        durationMs: Date.now() - runStartedAt,
        truncated,
      },
      truncated
        ? "Stranded-dispatch observation: scan stopped at its configured page limit; more candidates may exist"
        : "Stranded-dispatch observation: candidate set exhausted",
    );
  }

  static async findAvailableDrivers(lat: number, lng: number) {
    const activeDrivers = await prisma.deliveryPerson.findMany({
      where: { isOnline: true, status: DeliveryPersonStatus.ACTIVE, user: { isEmailVerified: true } },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });

    const driversWithDistance = activeDrivers.map((driver) => {
      const distance = haversine({ lat, lon: lng }, { lat: driver.latitude || 0, lon: driver.longitude || 0 }) / 1000;
      return {
        id: driver.user.id,
        name: driver.user.name,
        avatarUrl: driver.user.avatarUrl,
        status: driver.status,
        isOnline: driver.isOnline,
        vehicleType: driver.vehicleType,
        distance: parseFloat(distance.toFixed(2)),
      };
    });

    return driversWithDistance.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Driver accepts a broadcast offer, which creates the real assignment.
   *
   * N-05C (F2): this used to be a second, unguarded dispatch entry point. It
   * checked only the broadcast and the driver's identity and then created an
   * ACCEPTED assignment — never reading the order. A broadcast is created
   * `READY_FOR_PICKUP + SUCCESS` but stays PENDING for up to
   * BROADCAST_WINDOW_SECONDS, and the expiry sweep is a 1-minute cron, so an
   * offer could legitimately still be PENDING while the customer cancelled, the
   * payment expired, or the order otherwise stopped being dispatchable. The
   * result was a usable assignment on a dead order — exactly what N-05B now
   * prevents in `assignOrder`.
   *
   * Every check below therefore re-validates current state inside the existing
   * transaction, immediately before the insert, reusing N-05B's constants rather
   * than restating them:
   *
   *   broadcast:  still PENDING, still addressed to this driver, not declined,
   *               and not past `expiresAt` (a PENDING-but-expired broadcast has
   *               not necessarily been swept yet, so it must be refused here
   *               rather than trusted to `expireOldBroadcasts`)
   *   order:      re-read now — DISPATCHABLE_ORDER_STATUSES + payment SUCCESS,
   *               enforced by the same `assertDispatchable` `assignOrder` uses
   *   driver:     online / ACTIVE / email-verified, re-checked now rather than
   *               assumed from broadcast creation time
   *   capacity:   same MAX_STACK rule as direct assignment
   *   uniqueness: same ACTIVE_DELIVERY_STATUSES per-order guard
   *
   * The DB-level residual (two drivers accepting the same broadcast
   * concurrently) is NOT solved here — that needs a partial unique index and is
   * tracked separately as F3.
   */
  /**
   * The exact dispatch-eligibility predicate, in one place.
   *
   * `findAvailableDrivers` / `assignOrder` apply it in SQL (isOnline + ACTIVE +
   * isEmailVerified); acceptBroadcast applies it in code, twice: as a fail-fast
   * before the driver-row lock, and — since Task 4 — again under that lock, so
   * the two can never drift apart.
   */
  private static isDispatchEligible(
    driver: {
      isOnline: boolean;
      status: DeliveryPersonStatus;
      user?: { isEmailVerified: boolean } | null;
    } | null,
  ): boolean {
    return (
      !!driver &&
      driver.isOnline &&
      driver.status === DeliveryPersonStatus.ACTIVE &&
      !!driver.user?.isEmailVerified
    );
  }

  static async acceptBroadcast(broadcastId: string, driverId: string) {
    return prisma.$transaction(async (tx) => {
      const broadcast = await tx.deliveryBroadcast.findUnique({ where: { id: broadcastId } });
      if (!broadcast) throw new NotFoundError("Broadcast");
      if (broadcast.status !== DeliveryBroadcastStatus.PENDING) throw new ConflictError("Broadcast already accepted or expired");
      if (!broadcast.driverIds.includes(driverId)) throw new ForbiddenError("You are not part of this broadcast");
      if (broadcast.declinedDriverIds.includes(driverId)) throw new ConflictError("You already declined this delivery offer");
      // N-05C: `expiresAt` is authoritative for the offer window. The cron
      // sweep runs once a minute, so an expired offer is routinely still
      // PENDING here — refusing on its own terms keeps acceptance correct
      // without depending on sweeper timing. F3 Stage 1 re-checks the window
      // under the Order row lock as well, so the offer must still be open at the
      // moment the order is actually claimed, not merely at request start.
      if (broadcast.expiresAt <= new Date()) throw new ConflictError("This delivery offer is no longer available");

      // N-05C: re-read the order at acceptance time. The broadcast row carries
      // only `orderId` — it is a stale snapshot of dispatchability by the time
      // anyone accepts it.
      const order = await tx.order.findUnique({
        where: { id: broadcast.orderId },
        select: { status: true, paymentStatus: true },
      });
      if (!order) throw new NotFoundError("Order");
      // Same predicate, same error semantics as assignOrder's fast gate.
      this.assertDispatchable(order);

      const deliveryPerson = await tx.deliveryPerson.findUnique({
        where: { userId: driverId },
        include: { user: { select: { isEmailVerified: true } } },
      });
      if (!deliveryPerson) throw new NotFoundError("Driver profile");

      // N-05C: the driver was eligible when the offer went out; that is not a
      // guarantee they are eligible now. These are the exact conditions
      // `assignOrder` screens every candidate driver on.
      if (!this.isDispatchEligible(deliveryPerson)) {
        throw new ConflictError("You are not currently available for deliveries");
      }

      // N-05C: the same per-order uniqueness guard `claimOrderForDispatch`
      // applies, so an offer cannot become a second active assignment for an
      // order that was dispatched directly in the meantime. Kept as a
      // fail-fast; the authoritative version runs inside the Order-row claim
      // below, where it cannot miss a competing transaction's insert.
      const liveAssignments = await tx.deliveryAssignment.count({
        where: { orderId: broadcast.orderId, status: { in: ACTIVE_DELIVERY_STATUSES } },
      });
      if (liveAssignments > 0) {
        throw new ConflictError("This order already has an active delivery assignment");
      }

      // N-05C: the same MAX_STACK capacity rule `assignOrder` applies, so
      // accepting an offer cannot exceed capacity the direct path would refuse.
      // F5 (EN_ROUTE capacity semantics) is deliberately left untouched.
      const driverLoad = await tx.deliveryAssignment.count({
        where: { deliveryPersonId: deliveryPerson.id, status: { in: DRIVER_STACK_STATUSES } },
      });
      if (driverLoad >= MAX_STACK) {
        throw new ConflictError("Selected driver unavailable or exceeds stacking limit");
      }

      // ── F3 Stage 1 ────────────────────────────────────────────────────────
      // The creation now runs inside `claimOrderForBroadcastAcceptance`, which
      // takes the SAME Order-row lock `assignOrder` takes. That single change
      // closes both residual F3 gaps:
      //
      //   - direct assign vs broadcast acceptance: both serialize on the Order
      //     row, so whichever claims second re-reads the first's committed
      //     assignment and refuses instead of creating a second one;
      //   - acceptance vs cancellation / payment expiry / completion: the claim
      //     re-asserts status + payment under that lock, so a transition that
      //     committed first matches zero rows and the whole acceptance rolls
      //     back, leaving no orphan assignment.
      //
      // F5-B: driver-row serialization boundary for capacity-safe broadcast
      // acceptance. The driver row is locked FIRST (before the Order-row lock),
      // then capacity is re-checked under the lock, then the order is claimed,
      // then the assignment is created — all in one transaction.
      // Lock ordering: Driver → Order → Assignment (consistent with F3/F6).
      await tx.$queryRaw`SELECT id FROM "DeliveryPerson" WHERE id = ${deliveryPerson.id} FOR UPDATE`;

      // ── Task 4: eligibility is re-asserted UNDER the driver-row lock ───────
      // The read above is a plain SELECT: it is a snapshot taken before the
      // lock, and `setDeliveryPersonStatus` (admin.controller.ts) suspends a
      // rider with `prisma.deliveryPerson.update`, which takes an implicit
      // FOR UPDATE on this same row. So a suspension could commit between the
      // pre-lock check and the lock below, and nothing between them re-read
      // `status` — the assignment was created for a rider who was already
      // ineligible. The F5-B lock was correct for capacity but eligibility was
      // never re-checked under it.
      //
      // Re-reading here closes it, and only because this transaction is READ
      // COMMITTED (no isolationLevel is passed to $transaction, so PostgreSQL's
      // default applies). Under Read Committed each statement takes a fresh
      // snapshot, so once FOR UPDATE has returned we are reading the version
      // every concurrent writer had to wait for. PostgreSQL, 13.3.2: a
      // `SELECT FOR UPDATE` "will wait for a concurrent transaction ... and
      // will then lock and return the updated row". Ordering:
      //
      //   Suspension first  -> it holds FOR UPDATE, we block at the lock above,
      //                       it commits, our re-read below observes SUSPENDED
      //                       and refuses. Nothing is written.
      //   Acceptance first  -> we hold FOR UPDATE, the rider is eligible, the
      //                       assignment is created and commits; the suspension
      //                       then blocks at its own UPDATE until we finish, so
      //                       acceptance is linearised strictly BEFORE the
      //                       suspension. That is the serialisation policy: the
      //                       holder of the driver-row lock wins.
      //
      // Raising the isolation level instead would be wrong here: under
      // REPEATABLE READ / SERIALIZABLE PostgreSQL aborts with SQLSTATE 40001
      // ("could not serialize access due to concurrent update", 13.2.2), and
      // this path has no serialization-failure retry, so a suspension would
      // turn into a 500 rather than a correct refusal.
      //
      // Lock order is unchanged — Driver -> Order -> Assignment (see F5-B
      // above) — so this adds no new lock and no new deadlock surface.
      const lockedDriver = await tx.deliveryPerson.findUnique({
        where: { userId: driverId },
        include: { user: { select: { isEmailVerified: true } } },
      });
      if (!lockedDriver) throw new NotFoundError("Driver profile");
      if (!this.isDispatchEligible(lockedDriver)) {
        throw new ConflictError("You are not currently available for deliveries");
      }

      // Re-validate capacity under the driver lock — this is the authoritative check.
      const driverLoadRecheck = await tx.deliveryAssignment.count({
        where: { deliveryPersonId: deliveryPerson.id, status: { in: DRIVER_STACK_STATUSES } },
      });
      if (driverLoadRecheck >= MAX_STACK) {
        throw new ConflictError("Selected driver unavailable or exceeds stacking limit");
      }

      const assignment = await this.claimOrderForBroadcastAcceptance(
        tx,
        broadcast.orderId,
        async (t) => {
          // Everything in here runs while the Order row lock is held.
          //
          // Re-check the offer window here, not only at the top of the
          // transaction: it must still be open at the instant the order is
          // claimed.
          if (broadcast.expiresAt <= new Date()) {
            throw new ConflictError("This delivery offer is no longer available");
          }

          return t.deliveryAssignment.create({
            data: {
              orderId: broadcast.orderId,
              deliveryPersonId: deliveryPerson.id,
              status: DeliveryStatus.ACCEPTED,
              acceptedAt: new Date(),
              timeoutSeconds: 30,
              attempts: 1,
            },
          });
        },
      );

      // N-05C: consume the offer with a compare-and-set instead of an
      // unconditional update, so an offer that another transaction already
      // consumed is never silently overwritten (and, because this throw rolls
      // the whole transaction back, never leaves the assignment created above
      // behind either). Same Prisma API N-04A/N-01/N-06 already use for their
      // CAS writes — no schema change, no migration.
      const consumed = await tx.deliveryBroadcast.updateMany({
        where: { id: broadcastId, status: DeliveryBroadcastStatus.PENDING },
        data: { status: DeliveryBroadcastStatus.ACCEPTED, acceptedDriverId: driverId },
      });
      if (consumed.count !== 1) {
        throw new ConflictError("Broadcast already accepted or expired");
      }

      const io = getIO();
      for (const otherDriverId of broadcast.driverIds.filter((d) => d !== driverId)) {
        io.to(otherDriverId).emit("deliveryExpired", { broadcastId, orderId: broadcast.orderId });
      }
      io.to(driverId).emit("deliveryAccepted", { broadcastId, orderId: broadcast.orderId, assignmentId: assignment.id });

      await recordActivityBundle({
        actorId: driverId,
        orderId: broadcast.orderId,
        actions: [
          { type: ActivityType.GENERAL, title: "Delivery Accepted", message: `You accepted order #${broadcast.orderId}`, targetId: driverId, socketEvent: "ORDER" },
        ],
        audit: { action: "DELIVERY_ACCEPTED", metadata: { broadcastId, driverId, assignmentId: assignment.id } },
        notifyRealtime: true,
        notifyPush: true,
      });

      return assignment;
    });
  }

  static async getBroadcastOffersForDriver(driverId: string) {
    const now = new Date();
    return prisma.deliveryBroadcast.findMany({
      where: { status: DeliveryBroadcastStatus.PENDING, expiresAt: { gt: now }, driverIds: { has: driverId }, NOT: { declinedDriverIds: { has: driverId } } },
      orderBy: { createdAt: "desc" },
      include: {
        order: {
          include: {
            customer: { select: { id: true, name: true, phoneNumber: true } },
            vendor: { select: { id: true, name: true, brandName: true, phoneNumber: true } },
            address: { select: { id: true, label: true, street: true, city: true, latitude: true, longitude: true } },
          },
        },
      },
    });
  }

  static async declineBroadcast(broadcastId: string, driverId: string) {
    return prisma.$transaction(async (tx) => {
      const broadcast = await tx.deliveryBroadcast.findUnique({ where: { id: broadcastId } });
      if (!broadcast) throw new NotFoundError("Broadcast");
      if (broadcast.status !== DeliveryBroadcastStatus.PENDING || broadcast.expiresAt <= new Date()) throw new ConflictError("This delivery offer is no longer available");
      if (!broadcast.driverIds.includes(driverId)) throw new ForbiddenError("You are not part of this broadcast");
      if (broadcast.declinedDriverIds.includes(driverId)) return broadcast;
      return tx.deliveryBroadcast.update({ where: { id: broadcastId }, data: { declinedDriverIds: { push: driverId } } });
    });
  }

  /**
   * N-05B fast gate, applied to the order as read at the start of
   * `assignOrder`. Purely a fail-fast on obviously ineligible orders so the
   * caller gets a precise reason before any driver is scanned, broadcast or
   * row written. It is NOT the concurrency guard — the transactional
   * re-validation in `claimOrderForDispatch` below is.
   */
  private static assertDispatchable(order: { status: OrderStatus; paymentStatus: PaymentStatus | null }) {
    if (!DISPATCHABLE_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictError(
        `A driver cannot be assigned to an order in ${order.status} state`,
      );
    }
    if (order.paymentStatus !== PaymentStatus.SUCCESS) {
      throw new ConflictError("Order must be paid before a driver can be assigned");
    }
  }

  /**
   * N-05B / F3 Stage 1: the Order-row serialization boundary.
   *
   * This conditional `updateMany` is the single point at which dispatch writes
   * take a row lock on the order. It compiles to
   * `UPDATE "Order" SET "updatedAt" = $now WHERE id = $id AND status IN (...) AND paymentStatus = $status`,
   * which does three things that matter:
   *
   *   1. It LOCKS the row for the rest of the transaction, so any competing
   *      writer (customer cancel, payment expiry, order cleanup, the N-05A
   *      completion mirror, or the *other* dispatch entry point) blocks here
   *      instead of interleaving.
   *   2. When a competing writer already committed, Postgres re-evaluates the
   *      predicate against that newer row version rather than blindly applying
   *      — so `count === 0` means "someone changed this order first".
   *   3. It re-asserts the full dispatch predicate (status + payment) at the
   *      exact moment of creation, not just when the order was read earlier.
   *
   * The only field written is `updatedAt`; there is no dedicated dispatch-lock
   * column and adding one is a migration (out of scope).
   */
  private static async claimOrderRow(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const claimed = await tx.order.updateMany({
      where: {
        id: orderId,
        status: { in: DISPATCHABLE_ORDER_STATUSES },
        paymentStatus: PaymentStatus.SUCCESS,
      },
      data: { updatedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictError(
        "This order is no longer dispatchable — it was cancelled, expired or changed state. Reload and try again.",
      );
    }
  }

  /**
   * N-05B: at most one active assignment per order.
   *
   * Read *under* the Order-row lock taken by `claimOrderRow`, which is what
   * makes it authoritative rather than a bare pre-flight check: a competing
   * dispatch transaction cannot be between its own claim and its own insert
   * while we run this, so we cannot miss its assignment.
   *
   * Reassignment is legitimate (see handleDecline / expireOldBroadcasts) but
   * always goes through a DECLINED assignment or an EXPIRED broadcast first, so
   * anything active here means the order is already being delivered.
   */
  private static async assertNoActiveAssignment(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    const liveAssignments = await tx.deliveryAssignment.count({
      where: { orderId, status: { in: ACTIVE_DELIVERY_STATUSES } },
    });
    if (liveAssignments > 0) {
      throw new ConflictError("This order already has an active delivery assignment");
    }
  }

  /**
   * N-05B: re-validate the order and create the dispatch row inside a single
   * transaction, immediately before the write.
   *
   * A pre-read cannot close the assignment-vs-cancellation race: a cancel that
   * commits between the read above and the create below would still leave an
   * assignment on a dead order. The claim below is the real guard.
   *
   * `create` runs while the Order row lock is still held.
   */
  private static async claimOrderForDispatch<T>(
    tx: Prisma.TransactionClient,
    orderId: string,
    create: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    await this.claimOrderRow(tx, orderId);
    // F4-4: a settled order (one that already paid a rider) is never handed to
    // another rider. This runs under the Order row lock taken just above, so it
    // is an authoritative decision rather than a preflight that could go stale.
    await assertOrderNotSettled(tx, orderId);
    await this.assertNoActiveAssignment(tx, orderId);

    // A pending broadcast counts too: two live offers for one order would let
    // two drivers accept it.
    const liveBroadcast = await tx.deliveryBroadcast.count({
      where: {
        orderId,
        status: DeliveryBroadcastStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
    });
    if (liveBroadcast > 0) {
      throw new ConflictError("A delivery request for this order is already open");
    }

    return create(tx);
  }

  /**
   * F3 Stage 1: the same Order-row serialization boundary for broadcast
   * acceptance, minus the live-broadcast guard.
   *
   * Why a separate entry point rather than calling `claimOrderForDispatch`:
   * that helper rejects when a live broadcast exists for the order, and while
   * accepting a broadcast *that very broadcast is live and belongs to this
   * operation* — calling it directly would make every acceptance reject its own
   * offer. Everything else (the Order row lock, the dispatchability + payment
   * predicate, the one-active-assignment rule) is shared with the direct path,
   * so the two entry points cannot drift.
   *
   * This closes the two residual F3 races:
   *
   *   - direct assign vs broadcast acceptance — both now serialize on the
   *     Order row, so whichever claims second re-reads the first's committed
   *     assignment and refuses;
   *   - broadcast acceptance vs cancellation / payment expiry / completion —
   *     the claim re-asserts the predicate under the row lock, so a transition
   *     that committed first makes `claimOrderRow` match zero rows and the
   *     whole acceptance rolls back.
   *
   * The DB-level backstop for two drivers accepting concurrently is still
   * outstanding (F3 Stage 2, a partial unique index).
   */
  private static async claimOrderForBroadcastAcceptance<T>(
    tx: Prisma.TransactionClient,
    orderId: string,
    create: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    await this.claimOrderRow(tx, orderId);
    // F4-4: accepting an offer for an order that already paid a rider would
    // hand the delivery to a second rider. Same Order-row-lock guarantee as the
    // dispatch path above.
    await assertOrderNotSettled(tx, orderId);
    await this.assertNoActiveAssignment(tx, orderId);
    // Deliberately NO live-broadcast check — see above.
    return create(tx);
  }

  /**
   * Assigns a delivery. Two modes:
   *  - Manual (driverId provided): a specific driver is picked directly.
   *    Callers MUST verify authorization before calling this with a
   *    driverId — this function itself only checks the driver is
   *    actually available, not who's allowed to pick them. That
   *    authorization boundary lives in the controller (only the order's
   *    own vendor, or an admin, may manually assign — never the driver
   *    picking themselves).
   *  - Auto (no driverId): broadcasts to the nearest available drivers,
   *    first to accept gets it. This is the default/safe path.
   *
   * N-05B: the order must be dispatchable and paid (see
   * `DISPATCHABLE_ORDER_STATUSES`), and the dispatch row is created only after
   * a transactional re-validation of that predicate — so a cancelled, expired
   * or already-dispatched order is never handed to a driver.
   */
  static async assignOrder(orderId: string, driverId?: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { vendor: true } });
    if (!order) throw new NotFoundError("Order");
    if (!order.vendor) throw new NotFoundError("Vendor");

    this.assertDispatchable(order);

    const vendorAddress = await prisma.address.findFirst({
      where: { userId: order.vendorId, isDefault: true },
      select: { latitude: true, longitude: true },
    });
    if (!vendorAddress?.latitude || !vendorAddress?.longitude) throw new ValidationError("Vendor location missing — set a default address with coordinates first");

    const vendorLocation = { lat: vendorAddress.latitude, lon: vendorAddress.longitude };

    const drivers = await prisma.deliveryPerson.findMany({
      where: { isOnline: true, status: DeliveryPersonStatus.ACTIVE, user: { isEmailVerified: true } },
      select: { id: true, userId: true, latitude: true, longitude: true, user: { select: { name: true, email: true } } },
    });
    if (drivers.length === 0) throw new ConflictError("No available drivers");

    // Capacity for every candidate in ONE grouped query.
    //
    // This used to be `Promise.all(drivers.map(...))` issuing one
    // `deliveryAssignment.count()` per online driver. That fanned out to
    // `drivers.length` simultaneous queries, so a single dispatch request scaled
    // its connection usage with the size of the entire online-driver population
    // and could exhaust the pool (Prisma P2037, "too many database connections
    // opened"). The work was also unbounded while only the five nearest drivers
    // are ever used (TOP_DRIVERS_PER_BROADCAST below).
    //
    // `groupBy` returns a row only for drivers that actually hold a matching
    // assignment, so a missing key means zero — identical to a `count` of 0.
    // Everything downstream (eligible set, MAX_STACK filter, distance, ordering,
    // broadcast limit) is unchanged, and the authoritative capacity check remains
    // the recount taken under the DeliveryPerson row lock in the transaction.
    const activeLoadByPerson = new Map<string, number>();
    const activeLoads = await prisma.deliveryAssignment.groupBy({
      by: ["deliveryPersonId"],
      where: {
        deliveryPersonId: { in: drivers.map((d) => d.id) },
        status: { in: DRIVER_STACK_STATUSES },
      },
      _count: { _all: true },
    });
    for (const load of activeLoads) {
      activeLoadByPerson.set(load.deliveryPersonId, load._count._all);
    }

    const driversWithInfo = drivers.map((driver) => {
      const distanceKm = haversine(vendorLocation, { lat: driver.latitude || 0, lon: driver.longitude || 0 }) / 1000;
      return {
        ...driver,
        distance: parseFloat(distanceKm.toFixed(2)),
        activeAssignments: activeLoadByPerson.get(driver.id) ?? 0,
      };
    });

    const availableDrivers = driversWithInfo
      .filter((d) => d.activeAssignments < MAX_STACK)
      .sort((a, b) => a.distance - b.distance);

    // ── MANUAL ASSIGNMENT ──
    if (driverId) {
      const manualDriver = availableDrivers.find((d) => d.userId === driverId);
      if (!manualDriver) throw new ConflictError("Selected driver unavailable or exceeds stacking limit");

      const batchId = manualDriver.activeAssignments > 0 ? `batch_${Date.now()}_${manualDriver.id}` : null;

      // N-05B + F5-B: created inside the claim transaction — an assignment only exists
      // for an order that was still dispatchable at the moment of creation.
      // F5-B: driver-row serialization boundary for capacity-safe manual assignment.
      // The driver row is locked first, then capacity is re-checked under the lock,
      // then the order is claimed (F3), then the assignment is created — all in one transaction.
      const assignment = await prisma.$transaction(async (tx) => {
        // F5-B: serialize per-driver capacity by locking the DeliveryPerson row.
        await tx.$queryRaw`SELECT id FROM "DeliveryPerson" WHERE id = ${manualDriver.id} FOR UPDATE`;

        // ── Task 5: re-assert eligibility UNDER the driver-row lock ──────────
        // The candidate set above (`:979-982`) was read on the GLOBAL client,
        // OUTSIDE this transaction, so it is a stale snapshot by the time the
        // lock is taken. `setDeliveryPersonStatus` suspends a rider with
        // `prisma.deliveryPerson.update`, which takes an implicit FOR UPDATE
        // on this same row (PostgreSQL 13.3.2), so a suspension could commit
        // inside that window — and the F5-B lock below only ever re-checked
        // CAPACITY, never eligibility. An assignment was therefore created for
        // a rider who was already suspended.
        //
        // Same resolution as acceptBroadcast (see the comment above its own
        // post-lock re-check): the transaction is READ COMMITTED (no
        // isolationLevel is passed to $transaction), so once FOR UPDATE has
        // returned we are reading the version every concurrent writer had to
        // wait for. Ordering:
        //
        //   Suspension first -> it holds FOR UPDATE, we block above, it
        //                      commits, the re-read below observes SUSPENDED
        //                      and refuses. Nothing is written.
        //   Assignment first -> we hold FOR UPDATE, the rider is eligible, the
        //                      assignment is created and commits; the suspension
        //                      blocks at its own UPDATE until we finish, so the
        //                      assignment is ordered strictly BEFORE it.
        //
        // Policy is unchanged: this re-asserts the identical predicate the SQL
        // filter above applies (isOnline + ACTIVE + email verified), via the
        // same `isDispatchEligible` helper `acceptBroadcast` uses, so the two
        // entry points cannot drift. Raising the isolation level instead would
        // be wrong here — PostgreSQL would abort with SQLSTATE 40001 and this
        // path has no serialization-failure retry.
        //
        // Re-read by the locked row's own id, not by userId, so it is provably
        // the row this transaction holds the lock on. Lock order is unchanged:
        // Driver -> Order -> Assignment, so no new lock and no new deadlock
        // surface.
        const lockedDriver = await tx.deliveryPerson.findUnique({
          where: { id: manualDriver.id },
          include: { user: { select: { isEmailVerified: true } } },
        });
        if (!lockedDriver || !this.isDispatchEligible(lockedDriver)) {
          // Same message the pre-transaction rejection uses, so the established
          // error contract for "this driver cannot be assigned" is unchanged.
          throw new ConflictError("Selected driver unavailable or exceeds stacking limit");
        }

        // Re-validate capacity under the lock — this is the authoritative check.
        const driverLoad = await tx.deliveryAssignment.count({
          where: { deliveryPersonId: manualDriver.id, status: { in: DRIVER_STACK_STATUSES } },
        });
        if (driverLoad >= MAX_STACK) {
          throw new ConflictError("Selected driver unavailable or exceeds stacking limit");
        }

        // N-05B: created inside the claim transaction — an assignment only exists
        // for an order that was still dispatchable at the moment of creation.
        return this.claimOrderForDispatch(tx, order.id, (t) =>
          t.deliveryAssignment.create({
            data: { orderId: order.id, deliveryPersonId: manualDriver.id, timeoutSeconds: 30, attempts: 1, batchId },
            include: { order: true, deliveryPerson: { include: { user: true } } },
          }),
        );
      });

      await recordActivityBundle({
        actorId: manualDriver.userId,
        orderId: order.id,
        actions: [
          {
            type: ActivityType.GENERAL,
            title: "New Delivery Assigned",
            message: `You have been assigned order #${order.id}`,
            targetId: manualDriver.userId,
            socketEvent: "ORDER",
            metadata: { orderId: order.id, batchId, timeoutSeconds: assignment.timeoutSeconds },
          },
        ],
        audit: { action: "DELIVERY_ASSIGNED_MANUAL", metadata: { assignmentId: assignment.id, orderId: order.id, driverId: manualDriver.id } },
        notifyRealtime: true,
        notifyPush: true,
      });

      return { ...assignment, distance: manualDriver.distance };
    }

    // ── AUTO ASSIGNMENT (broadcast) ──
    if (availableDrivers.length === 0) throw new ConflictError("No drivers available within stacking limit");

    const topDrivers = availableDrivers.slice(0, TOP_DRIVERS_PER_BROADCAST);
    const driverIds = topDrivers.map((d) => d.userId);
    const expiresAt = new Date(Date.now() + BROADCAST_WINDOW_SECONDS * 1000);

    // N-05B: same claim — an offer is never broadcast for an order that is no
    // longer dispatchable or already has a live offer.
    const broadcast = await prisma.$transaction((tx) =>
      this.claimOrderForDispatch(tx, order.id, (t) =>
        t.deliveryBroadcast.create({
          data: { orderId: order.id, driverIds, expiresAt, status: DeliveryBroadcastStatus.PENDING },
        }),
      ),
    );

    // N-05B follow-up: this emission is POST-COMMIT. `getIO()` throws when
    // Socket.IO has not been initialised (socket.ts:87-89), and unguarded that
    // throw propagated out of `assignOrder` — so a broadcast that had already
    // been committed and persisted surfaced to the HTTP caller as a 500. The
    // caller would reasonably retry, and the retry would be refused by the
    // live-broadcast guard in `claimOrderForDispatch`, leaving a vendor
    // convinced their dispatch failed when it had in fact succeeded.
    //
    // The scope is deliberately narrow: ONLY this post-commit emission is
    // isolated. Database and dispatch errors above still propagate unchanged,
    // `recordActivityBundle` below is untouched, and the successful path is
    // byte-for-byte the same event name, recipients and payload as before.
    //
    // A lost emission is recoverable — the broadcast row is already committed
    // with its driver list and `expiresAt`, and `getBroadcastOffersForDriver`
    // reads exactly that row, so a driver who reconnects still sees the offer.
    // Reliable push delivery is a separate concern (an outbox) and is not
    // addressed here.
    try {
      const io = getIO();
      for (const d of topDrivers) {
        io.to(d.userId).emit("deliveryRequest", { broadcastId: broadcast.id, orderId: order.id, expiresAt });
      }
    } catch (err) {
      logger.warn(
        { err, orderId: order.id, broadcastId: broadcast.id },
        "Dispatch committed but realtime delivery-request emission failed",
      );
    }

    await recordActivityBundle({
      actorId: "SYSTEM",
      orderId: order.id,
      actions: topDrivers.map((d) => ({
        type: ActivityType.GENERAL,
        title: "New Delivery Request",
        message: `A new order (#${order.id}) is available for pickup.`,
        targetId: d.userId,
        socketEvent: "DELIVERY_REQUEST",
        metadata: { orderId: order.id, broadcastId: broadcast.id, expiresAt },
      })),
      audit: { action: "DELIVERY_BROADCAST_INITIATED", metadata: { broadcastId: broadcast.id, orderId: order.id, driverIds } },
      notifyRealtime: true,
      notifyPush: true,
    });

    return { success: true, broadcast };
  }

  /**
   * Resolves the caller's assignment ownership. Every mutation below that
   * takes an assignmentId + driverId (userId) verifies the assignment
   * actually belongs to that driver — previously acceptAssignment skipped
   * this check entirely, meaning any authenticated driver could accept an
   * assignment broadcast to (or already claimed by) someone else.
   */
  private static async resolveOwnedAssignment(assignmentId: string, driverUserId: string) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverUserId } });
    if (!deliveryPerson) throw new NotFoundError("Driver profile");

    const assignment = await prisma.deliveryAssignment.findUnique({ where: { id: assignmentId }, include: { order: true } });
    if (!assignment) throw new NotFoundError("Assignment");
    if (assignment.deliveryPersonId !== deliveryPerson.id) throw new ForbiddenError("This assignment doesn't belong to you");

    return { deliveryPerson, assignment };
  }

  /**
   * F6: the atomic `ASSIGNED -> ACCEPTED / DECLINED` compare-and-set.
   *
   * Both acceptAssignment and handleDecline used to read the status, assert it
   * was ASSIGNED in application code, and then write with an UNCONDITIONAL
   * `update({ where: { id } })`. That is a classic TOCTOU: two concurrent
   * requests could both read ASSIGNED and both write, so an assignment could
   * leave ASSIGNED twice and the winner was decided by which write landed last.
   * An accept and a decline racing produced contradictory notifications to the
   * customer and vendor, and two racing accepts notified everyone twice.
   *
   * The state transition itself is now conditional:
   *
   *     UPDATE "DeliveryAssignment" SET status = ...
   *     WHERE id = ? AND status = 'ASSIGNED'
   *
   * which PostgreSQL executes as a single atomic statement. Exactly one caller
   * can match the row, so `count === 1` is the authoritative "you won". A
   * loser sees `count === 0` and is rejected BEFORE any side effect runs.
   *
   * Deliberately no surrounding transaction or row lock: a conditional single-
   * statement UPDATE is already atomic, and the previous code had no
   * transaction either — so this adds correctness without adding lock scope or
   * changing any transaction boundary.
   *
   * `updateMany` cannot `include`, so the row is re-read on the success path to
   * build the same payload shape the callers have always received. That re-read
   * is only for the response; the decision was already made by the CAS.
   */
  private static async compareAndSetAssignmentFromAssigned(
    assignmentId: string,
    data: Prisma.DeliveryAssignmentUpdateManyMutationInput,
    verb: "accept" | "decline",
  ): Promise<void> {
    const claimed = await prisma.deliveryAssignment.updateMany({
      where: { id: assignmentId, status: DeliveryStatus.ASSIGNED },
      data,
    });

    if (claimed.count !== 1) {
      // Lost the race, or the assignment is no longer ASSIGNED. Report the
      // status the winner left behind using the existing conflict semantics.
      const current = await prisma.deliveryAssignment.findUnique({
        where: { id: assignmentId },
        select: { status: true },
      });
      if (!current) throw new NotFoundError("Assignment");
      throw new ConflictError(`Cannot ${verb} an assignment in ${current.status} status`);
    }
  }

  static async acceptAssignment(assignmentId: string, driverId: string) {
    // Authorization first, unchanged: existence + ownership.
    const { assignment: existing } = await this.resolveOwnedAssignment(assignmentId, driverId);
    // Fail-fast validation, unchanged. The CAS below is what actually decides.
    if (existing.status !== DeliveryStatus.ASSIGNED) throw new ConflictError(`Cannot accept an assignment in ${existing.status} status`);

    // F6: atomic ASSIGNED -> ACCEPTED. Throws before any side effect on loss.
    await this.compareAndSetAssignmentFromAssigned(
      assignmentId,
      { status: DeliveryStatus.ACCEPTED, acceptedAt: new Date() },
      "accept",
    );
    // `updateMany` cannot include relations; re-read for the response payload
    // only. The decision was already made by the CAS above.
    const assignment = (await prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: { order: true, deliveryPerson: { include: { user: true } } },
    }))!;

    // ── side effects: only ever reached when the CAS above succeeded ──
    const driverUser = assignment.deliveryPerson.user;

    await recordActivityBundle({
      actorId: driverId,
      orderId: assignment.order.id,
      actions: [
        { type: ActivityType.GENERAL, title: "Driver Accepted", message: `Your driver ${driverUser.name} accepted order #${assignment.order.id}`, targetId: assignment.order.customerId, socketEvent: "ORDER", metadata: { orderId: assignment.order.id, driverId } },
        { type: ActivityType.GENERAL, title: "Driver Accepted", message: `Driver ${driverUser.name} accepted order #${assignment.order.id}`, targetId: assignment.order.vendorId, socketEvent: "ORDER", metadata: { orderId: assignment.order.id, driverId } },
      ],
      audit: { action: "DELIVERY_ACCEPTED", metadata: { assignmentId, orderId: assignment.order.id, driverId } },
      notifyRealtime: true,
      notifyPush: true,
    });

    await this.broadcastDriverLocation(driverId);
    return assignment;
  }

  /** Handle driver decline (driver-initiated, ownership-checked) */
  static async handleDecline(assignmentId: string, driverId: string) {
    // Authorization first, unchanged: existence + ownership.
    const { assignment: existing } = await this.resolveOwnedAssignment(assignmentId, driverId);
    // Fail-fast validation, unchanged. The CAS below is what actually decides.
    if (existing.status !== DeliveryStatus.ASSIGNED) throw new ConflictError(`Cannot decline an assignment in ${existing.status} status`);

    // F6: atomic ASSIGNED -> DECLINED. The `attempts` counter now increments
    // exactly once per real decline instead of once per racing request.
    await this.compareAndSetAssignmentFromAssigned(
      assignmentId,
      { status: DeliveryStatus.DECLINED, declinedAt: new Date(), attempts: { increment: 1 } },
      "decline",
    );
    // Response payload only — see acceptAssignment above.
    const assignment = (await prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: { order: true, deliveryPerson: { select: { userId: true } } },
    }))!;

    // ── side effects: only ever reached when the CAS above succeeded ──
    await recordActivityBundle({
      actorId: assignment.deliveryPerson.userId,
      orderId: assignment.order.id,
      actions: [
        { type: ActivityType.GENERAL, title: "Driver Declined", message: `A driver declined order #${assignment.order.id}, reassigning...`, targetId: assignment.order.vendorId, socketEvent: "ORDER", metadata: { orderId: assignment.order.id, assignmentId } },
      ],
      audit: { action: "DELIVERY_DECLINED", metadata: { assignmentId, orderId: assignment.order.id, driverId: assignment.deliveryPersonId } },
      notifyRealtime: true,
      notifyPush: true,
    });

    // Reassignment is a side effect too: it opens a fresh broadcast via
    // assignOrder. It must never run for a decline that lost the CAS.
    try {
      await this.assignOrder(assignment.orderId);
    } catch (err) {
      logger.warn({ err, orderId: assignment.orderId }, "Failed to reassign order after decline");
    }

    return assignment;
  }

  static async getActiveAssignmentsForDriver(driverId: string) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverId } });
    if (!deliveryPerson) throw new NotFoundError("Driver profile");

    return prisma.deliveryAssignment.findMany({
      where: { deliveryPersonId: deliveryPerson.id, status: { in: DRIVER_STACK_STATUSES } },
      include: {
        order: { include: { customer: { select: { id: true, name: true, avatarUrl: true } }, vendor: { select: { id: true, brandName: true, brandLogo: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Broadcast live driver location to customer & vendor for any active
   * assignment. Previously this queried `deliveryPersonId: driverId`
   * where `driverId` was actually the caller's userId — a type
   * confusion that meant this silently matched zero assignments (userId
   * and DeliveryPerson.id are different values), so location updates
   * never actually reached anyone after a driver accepted a delivery.
   */
  static async broadcastDriverLocation(driverUserId: string) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverUserId } });
    if (!deliveryPerson) return;

    const assignments = await prisma.deliveryAssignment.findMany({
      where: { deliveryPersonId: deliveryPerson.id, status: { in: [DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE] } },
      include: { order: { select: { customerId: true, vendorId: true } } },
    });

    if (assignments.length === 0) return;

    const io = getIO();
    const location = { lat: deliveryPerson.latitude, lng: deliveryPerson.longitude };
    for (const assignment of assignments) {
      io.to(assignment.order.customerId).emit("driverLocationUpdate", location);
      io.to(assignment.order.vendorId).emit("driverLocationUpdate", location);
    }
  }

  /**
   * Updates a driver's live GPS position. Previously there was no
   * endpoint anywhere that ever called this — DeliveryPerson.latitude/
   * longitude could only ever be whatever was set at registration, which
   * meant "find nearby drivers" and live location broadcasting were both
   * working off permanently stale coordinates.
   */
  static async updateDriverLocation(driverUserId: string, latitude: number, longitude: number) {
    const deliveryPerson = await prisma.deliveryPerson.update({
      where: { userId: driverUserId },
      data: { latitude, longitude, lastSeenAt: new Date() },
    });

    await prisma.driverLocationLog.create({
      data: { driverId: deliveryPerson.id, latitude, longitude },
    });

    await this.broadcastDriverLocation(driverUserId);
    return deliveryPerson;
  }

  static async setOnlineStatus(driverUserId: string, isOnline: boolean) {
    return prisma.deliveryPerson.update({ where: { userId: driverUserId }, data: { isOnline, lastSeenAt: new Date() } });
  }

  /**
   * Driver-driven delivery status transition.
   *
   * F4-1 changed three things here, all mechanical:
   *
   * 1. ATOMICITY. This used to be four independent atomic units — assignment
   *    UPDATE, activity log, Order mirror UPDATE, then a separate
   *    `$transaction([wallet, earning])`. A crash between the Order mirror and
   *    the earning transaction left `Order = COMPLETED` with
   *    `DeliveryAssignment = DELIVERED` but NO earning and NO wallet credit:
   *    a completed delivery nobody was paid for. Assignment, order mirror,
   *    wallet and earning now all commit together.
   *
   * 2. ASSIGNMENT CAS (extends F6). The status transition was validated against
   *    a pre-read and then written UNCONDITIONALLY
   *    (`update({ where: { id } })`), so two concurrent driver updates could
   *    both pass validation and both write. It is now a conditional UPDATE
   *    (`where: { id, status: <the status we validated> }`), so exactly one
   *    caller can win and a loser performs no side effect at all — the same
   *    pattern F6 introduced for accept/decline.
   *
   * 3. ORDER-TERMINAL GUARD (INV-1). Advancing a delivery to an ACTIVE status
   *    (PICKED_UP / EN_ROUTE) on an order that has already gone terminal would
   *    re-create exactly the orphan F4-1 exists to remove. Such a request is
   *    refused, and any active assignment left on that order is reconciled as
   *    part of the same transaction so a pre-existing orphan self-heals instead
   *    of being preserved.
   *
   * LOCK ORDER — `[DeliveryPerson] -> Order -> DeliveryAssignment`
   *
   * This transaction takes NO DeliveryPerson lock: it never creates a
   * stack-consuming assignment, so it has no capacity decision to serialise
   * (F5-B's driver lock is only needed by the dispatch paths). It locks the
   * Order row FIRST, then CASes the assignment. That is the same relative
   * Order -> Assignment order used by F3's `claimOrderRow` and by the F4-1
   * terminal reconcilers, so no path can hold an assignment while waiting for
   * an order that another path holds while waiting for that assignment.
   *
   * The Order row is locked with a bare `SELECT ... FOR UPDATE` rather than a
   * write: the narrowest lock that establishes the ordering, with no spurious
   * `updatedAt` mutation. The decision that matters is still made by the
   * existing conditional mirror (`ORDER_MIRROR_PREDICATES`), unchanged.
   */
  static async updateStatus(assignmentId: string, driverId: string, status: DeliveryStatus) {
    const { deliveryPerson, assignment } = await this.resolveOwnedAssignment(assignmentId, driverId);

    if (!(status in DELIVERY_TRANSITIONS)) throw new ValidationError(`${status} cannot be set directly through this endpoint`);
    if (!isValidDeliveryTransition(assignment.status, status)) {
      throw new ConflictError(`Cannot transition from ${assignment.status} to ${status}`);
    }

    // The status we validated above becomes the CAS predicate, so a racing
    // update that already moved the row makes this one match nothing.
    const expectedStatus = assignment.status;
    const orderId = assignment.orderId;
    // PICKED_UP / EN_ROUTE are the only active targets; leaving an order
    // terminal while the assignment is still active is the INV-1 violation.
    const targetIsActive = status === DeliveryStatus.PICKED_UP || status === DeliveryStatus.EN_ROUTE;

    const outcome = await prisma.$transaction(async (tx) => {
      // 1. Order row lock FIRST (see lock-order note above).
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, customerId: true, deliveryFee: true },
      });
      if (!order) throw new NotFoundError("Order");

      // 2. INV-1 guard: refuse to advance a delivery on a dead order, and heal
      //    any active assignment stranded on it. Committed (not thrown) so the
      //    reconciliation survives; the conflict is raised after commit.
      if (targetIsActive && isTerminalOrderStatus(order.status)) {
        await reconcileActiveDeliveryAssignments(tx, orderId);
        return { rejectedOrderTerminal: true as const, order, assignment: null };
      }

      // 3. F6-style CAS on the assignment.
      const claimed = await tx.deliveryAssignment.updateMany({
        where: { id: assignmentId, status: expectedStatus },
        data: {
          status,
          ...(status === DeliveryStatus.PICKED_UP ? { startedAt: new Date() } : {}),
          ...(status === DeliveryStatus.DELIVERED ? { completedAt: new Date() } : {}),
        },
      });
      if (claimed.count !== 1) {
        const current = await tx.deliveryAssignment.findUnique({
          where: { id: assignmentId },
          select: { status: true },
        });
        if (!current) throw new NotFoundError("Assignment");
        throw new ConflictError(`Cannot transition from ${current.status} to ${status}`);
      }

      // 4. Mirror onto the Order table. Unchanged semantics: the conditional
      //    predicate is the authority, and `orderTransitioned` means "this run
      //    actually moved the order".
      let orderTransitioned = false;
      let mainOrderStatus: OrderStatus | undefined;
      switch (status) {
        case DeliveryStatus.PICKED_UP:
          mainOrderStatus = OrderStatus.OUT_FOR_DELIVERY;
          break;
        case DeliveryStatus.DELIVERED:
          mainOrderStatus = OrderStatus.COMPLETED;
          break;
        case DeliveryStatus.CANCELLED:
        case DeliveryStatus.FAILED:
        case DeliveryStatus.RETURNED:
          mainOrderStatus = OrderStatus.FAILED_DELIVERY;
          break;
      }
      if (mainOrderStatus) {
        const mirrored = await tx.order.updateMany({
          where: { id: orderId, ...ORDER_MIRROR_PREDICATES[mainOrderStatus] },
          data: { status: mainOrderStatus },
        });
        orderTransitioned = mirrored.count === 1;
        if (!orderTransitioned) {
          logger.warn(
            { assignmentId, orderId, driverId, deliveryStatus: status, attemptedOrderStatus: mainOrderStatus },
            "Delivery status not mirrored onto order — order is not in a completable state",
          );
        }
      }

      // 5. Rider credit — SAME transaction as the order completion.
      //
      //    Eligibility is unchanged from N-05A: only a DELIVERED assignment on
      //    an order this run actually completed earns. The amount is unchanged
      //    too — it now lives in the shared `creditDeliveryEarning` helper,
      //    which is the SAME code the canonical customer-completion path uses
      //    (F4-2). There is one earning implementation and one amount, so the
      //    two completion routes can never disagree or double-pay: whoever wins
      //    the Order row transition creates the earning, and the loser's call
      //    short-circuits on the helper's exactly-once read.
      if (status === DeliveryStatus.DELIVERED && orderTransitioned) {
        // F4-4: name the authenticated rider so the helper can tell a genuine
        // same-rider retry from a different rider completing a settled order.
        await creditDeliveryEarning(tx, orderId, { riderId: deliveryPerson.id });
      }

      const updated = await tx.deliveryAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        include: { order: true },
      });

      return {
        rejectedOrderTerminal: false as const,
        orderTransitioned,
        order,
        assignment: updated,
      };
    });

    if (outcome.rejectedOrderTerminal) {
      throw new ConflictError(
        `Order is ${outcome.order.status} — delivery cannot be advanced`,
      );
    }

    const updated = outcome.assignment!;

    // 6. Notifications and loyalty credits stay OUTSIDE the transaction, as
    //    they always have been: they are best-effort, and holding the Order row
    //    lock across socket IO would be a lock-scope regression. Reaching here
    //    means this run WON the assignment CAS, so they fire at most once.
    await recordActivityBundle({
      actorId: driverId,
      orderId: updated.order.id,
      actions: [
        { type: ActivityType.GENERAL, title: `Order ${status}`, message: `Order #${updated.order.id} is now ${status}`, targetId: updated.order.customerId, socketEvent: "ORDER", metadata: { orderId: updated.order.id, assignmentId, status } },
        { type: ActivityType.GENERAL, title: `Order ${status}`, message: `Order #${updated.order.id} is now ${status}`, targetId: updated.order.vendorId, socketEvent: "ORDER", metadata: { orderId: updated.order.id, assignmentId, status } },
      ],
      audit: { action: "DELIVERY_STATUS_UPDATED", metadata: { assignmentId, orderId: updated.order.id, driverId, newStatus: status } },
      notifyRealtime: true,
      notifyPush: true,
    });

    if (status === DeliveryStatus.DELIVERED && !outcome.orderTransitioned) {
      logger.warn(
        { assignmentId, orderId, driverId },
        "Delivery recorded but order completion was rejected — no driver earning credited",
      );
    }

    // N-05C (F1): the driver path is a second writer of Order.status =
    // COMPLETED, so it must award the same completion effects the canonical
    // path does. Gated on the same `orderTransitioned` as the earning above.
    if (status === DeliveryStatus.DELIVERED && outcome.orderTransitioned) {
      runOrderCompletionSideEffects(updated.orderId, updated.order.customerId);
    }

    // N-05A: a delivery that cannot legally complete the order is a genuine
    // conflict, not a silent success. The assignment write above is already
    // committed (and DELIVERED is terminal, so INV-1 holds); raising here
    // preserves that pre-existing behaviour of recording the delivery while
    // telling the caller the order was not completed.
    if (status === DeliveryStatus.DELIVERED && !outcome.orderTransitioned) {
      throw new ConflictError(
        `Order cannot be completed from its current state — delivery recorded without completion`,
      );
    }

    return updated;
  }

  static async getAssignmentById(assignmentId: string) {
    const assignment = await prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: { order: { include: { customer: true, vendor: true } }, deliveryPerson: { include: { user: true } } },
    });
    if (!assignment) throw new NotFoundError("Assignment");
    return assignment;
  }

  /**
   * Get past assignments for a driver. Previously queried
   * `deliveryPersonId: driverId` where `driverId` was the caller's
   * userId — the same type confusion as broadcastDriverLocation had,
   * meaning this almost always returned an empty list for any real
   * caller.
   */
  static async getDriverHistory(driverUserId: string, limit = 50) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverUserId } });
    if (!deliveryPerson) throw new NotFoundError("Driver profile");

    return prisma.deliveryAssignment.findMany({
      where: { deliveryPersonId: deliveryPerson.id, status: { in: [DeliveryStatus.DELIVERED, DeliveryStatus.FAILED, DeliveryStatus.RETURNED, DeliveryStatus.CANCELLED] } },
      include: { order: { include: { customer: true, vendor: true } }, deliveryPerson: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  static async getDriverAnalytics(driverUserId: string) {
    const deliveryPerson = await prisma.deliveryPerson.findUnique({ where: { userId: driverUserId } });
    if (!deliveryPerson) throw new NotFoundError("Driver profile");

    const [completed, failed] = await Promise.all([
      prisma.deliveryAssignment.count({ where: { deliveryPersonId: deliveryPerson.id, status: DeliveryStatus.DELIVERED } }),
      prisma.deliveryAssignment.count({ where: { deliveryPersonId: deliveryPerson.id, status: { in: [DeliveryStatus.FAILED, DeliveryStatus.CANCELLED, DeliveryStatus.RETURNED] } } }),
    ]);

    return { completed, failed, totalDeliveries: deliveryPerson.totalDeliveries, walletBalance: deliveryPerson.walletBalance, rating: deliveryPerson.rating };
  }

  static async getCustomerHistory(customerId: string, limit = 50) {
    return prisma.deliveryAssignment.findMany({
      where: { order: { customerId }, status: { in: [DeliveryStatus.DELIVERED, DeliveryStatus.FAILED, DeliveryStatus.RETURNED, DeliveryStatus.CANCELLED] } },
      include: { order: { include: { vendor: true } }, deliveryPerson: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}

import { DateTime } from "luxon";
import { ValidationError, ConflictError } from "../errors/AppError";
import prisma from "../lib/prisma";

/**
 * Phase 3D — Scheduling, cut-off and daily-cap helpers.
 *
 * Timezone policy (explicit and consistent):
 *   All timestamps are stored and compared in UTC. The vendor's operational
 *   "day" and cut-off times are interpreted in Africa/Lagos. A scheduled
 *   order's `scheduledAt` is a UTC instant; cut-off / day-bucketing is done
 *   by converting to Africa/Lagos.
 *
 * This module is pure where possible (no Paystack, no sockets) and every
 * mutating helper is designed to run inside a Prisma transaction so that
 * cap increments and order creation commit or roll back together.
 */

export const LAGOS_TZ = "Africa/Lagos";

/** Latest date a customer may request for fulfillment. */
export const SCHEDULE_MAX_DAYS_AHEAD = 30;

/** Earliest fulfillment: must be strictly in the future. */
export const SCHEDULE_MIN_FUTURE_MINUTES = 15;

/**
 * Parses and validates an optional `scheduledAt` ISO string.
 * Returns null when the caller wants an immediate order (no scheduling).
 * Throws ValidationError for malformed, past, or too-far-out dates.
 */
export function parseScheduledAt(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;

  const text = String(raw).trim();
  if (text === "") return null;

  const dt = DateTime.fromISO(text, { zone: LAGOS_TZ });
  if (!dt.isValid) {
    throw new ValidationError("scheduledAt must be a valid ISO-8601 date/time");
  }

  // Normalise to a UTC instant for storage/comparison.
  const scheduled = dt.toUTC();

  const now = DateTime.now().setZone(LAGOS_TZ);
  const minAllowed = now.plus({ minutes: SCHEDULE_MIN_FUTURE_MINUTES });
  if (scheduled < minAllowed.toUTC()) {
    throw new ValidationError(
      `scheduledAt must be at least ${SCHEDULE_MIN_FUTURE_MINUTES} minutes in the future`,
    );
  }

  const maxAllowed = now.plus({ days: SCHEDULE_MAX_DAYS_AHEAD }).startOf("day");
  if (scheduled > maxAllowed.toUTC()) {
    throw new ValidationError(
      `scheduledAt must be within ${SCHEDULE_MAX_DAYS_AHEAD} days from now`,
    );
  }

  return scheduled.toJSDate();
}

/**
 * Builds the start of the Africa/Lagos calendar day for a given instant.
 * Used to bucket orders into vendor business days for daily caps and cut-off.
 */
export function lagosDayStart(instant: Date): Date {
  return DateTime.fromJSDate(instant, { zone: LAGOS_TZ })
    .startOf("day")
    .toJSDate();
}

/**
 * Parses a vendor "HH:MM" cut-off time (Africa/Lagos) into a DateTime for a
 * given Lagos date. Returns null when no cut-off is configured.
 */
export function cutOffForDate(
  lagosDate: Date,
  cutoffTime: string | null | undefined,
): DateTime | null {
  if (!cutoffTime) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(cutoffTime).trim());
  if (!match) return null;
  const [, hh, mm] = match;
  const hour = Number(hh);
  const minute = Number(mm);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return DateTime.fromJSDate(lagosDate, { zone: LAGOS_TZ })
    .set({ hour, minute })
    .startOf("minute");
}

/**
 * Checkout-time cut-off validation. When a vendor has a cut-off time and the
 * requested fulfillment day is "today" (Africa/Lagos), the order must be
 * placed before the cut-off; otherwise it must be scheduled for a later day.
 *
 * Returns null when the request is acceptable, or a ValidationError when it
 * is not.
 */
export function validateCutOff({
  now,
  scheduledAt,
  cutoffTime,
}: {
  now: DateTime;
  scheduledAt: Date | null;
  cutoffTime: string | null | undefined;
}): ValidationError | null {
  if (!cutoffTime) return null;

  const todayLagos = now.startOf("day");
  const cutoffToday = cutOffForDate(todayLagos.toJSDate(), cutoffTime);
  if (!cutoffToday) return null;

  // Already past today's cut-off: same-day fulfillment is no longer possible.
  const pastCutoff = now > cutoffToday;

  if (scheduledAt === null) {
    // Immediate order requested after today's cut-off.
    if (pastCutoff) {
      return new ValidationError(
        "Same-day orders are no longer being accepted after the vendor's cut-off time. Schedule for a later day.",
      );
    }
    return null;
  }

  const scheduledLagos = DateTime.fromJSDate(scheduledAt, { zone: LAGOS_TZ });
  const scheduledDay = scheduledLagos.startOf("day");

  // If the customer wants fulfillment today but we are past the cut-off, reject.
  if (pastCutoff && scheduledDay.equals(todayLagos)) {
    return new ValidationError(
      "The vendor's cut-off time has passed for today. Please schedule for a later day.",
    );
  }

  return null;
}

/**
 * Atomically reserves one unit of a product's daily cap inside a transaction,
 * then rejects the checkout if the cap would be exceeded.
 *
 * Serialised on the ProductDailyCounter row, so concurrent checkouts cannot
 * both pass a cap on the strength of the same pre-increment count. A durable
 * DailyCapReservation row is created for the (order, product, day) so that
 * release is idempotent per reservation — see releaseDailyCap.
 *
 * Must be called within the same transaction that creates the order, so a
 * reservation can never exist without its order (and vice versa).
 *
 * orderId is required because checkout reserves capacity before the Order
 * row exists; the caller generates the order id upfront and passes it here
 * and again to tx.order.create.
 */
export async function reserveDailyCap(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  productId: string,
  dayStart: Date,
  dailyCap: number | null | undefined,
  orderId: string,
): Promise<void> {
  if (dailyCap === null || dailyCap === undefined) return;
  // A cap of zero means no orders may be placed today.
  if (dailyCap === 0) {
    throw new ConflictError(
      "This product's daily order limit has been reached. Please choose another day.",
    );
  }

  // If this order already holds an unreleased reservation for this product
  // and day, capacity is already counted — nothing to do (idempotent re-reserve).
  const existing = await tx.dailyCapReservation.findFirst({
    where: { orderId, productId, day: dayStart, released: false },
    select: { id: true },
  });
  if (existing) return;

  // Claim capacity: conditional increment serialized on the counter row.
  // PostgreSQL re-reads the latest committed row value under the row lock
  // (READ COMMITTED), so two concurrent transactions cannot both pass on the
  // strength of the same pre-increment count. If no counter row exists yet
  // (first reservation for this product+day), create it with count 1.
  let counter = await tx.productDailyCounter.findUnique({
    where: { productId_date: { productId, date: dayStart } },
    select: { count: true },
  });

  if (counter) {
    if (counter.count >= dailyCap) {
      throw new ConflictError(
        "This product's daily order limit has been reached. Please choose another day.",
      );
    }
    const updated = await tx.productDailyCounter.updateMany({
      where: { productId, date: dayStart, count: { lt: dailyCap } },
      data: { count: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new ConflictError(
        "This product's daily order limit has been reached. Please choose another day.",
      );
    }
  } else {
    // No counter row yet: dailyCap >= 1 here, so count 1 is within the cap.
    try {
      await tx.productDailyCounter.create({
        data: { productId, date: dayStart, count: 1 },
      });
    } catch (err: any) {
      // Two concurrent transactions both observed no row and raced to create.
      // One wins; the loser re-fetches and conditionally increments.
      if (err?.code !== "P2002") throw err;
      const row = await tx.productDailyCounter.findUnique({
        where: { productId_date: { productId, date: dayStart } },
        select: { count: true },
      });
      if (!row || row.count >= dailyCap) {
        throw new ConflictError(
          "This product's daily order limit has been reached. Please choose another day.",
        );
      }
      const updated = await tx.productDailyCounter.updateMany({
        where: { productId, date: dayStart, count: { lt: dailyCap } },
        data: { count: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new ConflictError(
          "This product's daily order limit has been reached. Please choose another day.",
        );
      }
    }
  }

  // Record the reservation. If a previously-released reservation exists for
  // this order+product+day, reactivate it instead of creating a duplicate.
  // P2002 (unique violation on orderId+productId+day) means a concurrent
  // writer created it; reactivate that row.
  try {
    await tx.dailyCapReservation.create({
      data: { orderId, productId, day: dayStart, quantity: 1, released: false },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      await tx.dailyCapReservation.updateMany({
        where: { orderId, productId, day: dayStart, released: true },
        data: { released: false },
      });
      return;
    }
    throw err;
  }
}

/**
 * Releases one unit of a product's daily cap for one order's reservation.
 *
 * Idempotent per reservation: the reservation row is transitioned
 * released=false -> released=true with a conditional UPDATE; only the
 * winning execution decrements the counter. Repeated or concurrent releases
 * of the same reservation decrement capacity exactly once, and can never
 * decrement capacity belonging to another order.
 */
export async function releaseDailyCap(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  orderId: string,
  productId: string,
  dayStart: Date,
): Promise<void> {
  const released = await tx.dailyCapReservation.updateMany({
    where: { orderId, productId, day: dayStart, released: false },
    data: { released: true },
  });
  // Only the execution that transitioned the reservation decrements the
  // counter; count === 0 means another release already won.
  if (released.count === 1) {
    await tx.productDailyCounter.updateMany({
      where: { productId, date: dayStart, count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });
  }
}

/**
 * Releases the daily-cap units consumed by an order that is being cancelled
 * or expired before fulfilment. Only products that actually carry a dailyCap
 * are touched. Safe to call repeatedly (each reservation released once).
 *
 * The bucket day is taken from each reservation's stored day (the fulfilment
 * day used at reservation), so cancellation and expiry release exactly the
 * capacity that was reserved.
 */
export async function releaseOrderDailyCaps(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  order: { id: string },
): Promise<void> {
  const reservations = await tx.dailyCapReservation.findMany({
    where: { orderId: order.id, released: false },
    select: { productId: true, day: true },
  });
  for (const reservation of reservations) {
    await releaseDailyCap(tx, order.id, reservation.productId, reservation.day);
  }
}

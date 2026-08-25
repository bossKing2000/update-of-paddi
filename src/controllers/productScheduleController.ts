import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import { productLiveQueue } from "../jobs/workers jobs/productLiveWorker";
import { productDeactivateQueue } from "../jobs/workers jobs/productDeactivateJob";
import { addMinutesUtc, isBeforeUtc, nowUtc, toUtc } from "../utils/time";
import { ensureString } from "../utils/paramUtils";
import { clearProductFromCarts } from "../services/product.service";
import { Request, Response } from "express";
import { clearProductCache } from "../services/clearCaches";
import { recordActivityBundle } from "../utils/activityUtils/recordActivityBundle";
import { ActivityType } from "@prisma/client";
import { sendSuccess } from "../utils/apiResponse";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors/AppError";
import { logger } from "../lib/logger";
import {
  evaluateProductSchedule,
} from "../services/scheduleRules.service";
import { resolveVendorTimezone } from "../services/vendorAvailability.service";
import { invalidateMarketplaceDiscoveryCaches } from "../services/clearCaches";
import { weeklyScheduleSchema } from "../validations/productScheduleSchema";

/**
 * Vendor schedules a product to go live, or goes live immediately
 */
export const goLive = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);
  const { goLiveAt, takeDownAt, graceMinutes = 15 } = req.body;

  if (!req.user || req.user.role !== "VENDOR")
    throw new ForbiddenError("Only vendors can perform this.");
  if (!goLiveAt || !takeDownAt)
    throw new ValidationError("goLiveAt and takeDownAt are required.");

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { vendor: true, productSchedule: true },
  });
  if (!product || product.vendorId !== req.user.id)
    throw new NotFoundError("Product");

  const liveTime = toUtc(goLiveAt);
  const endTime = toUtc(takeDownAt);
  const now = nowUtc();

  if (!isBeforeUtc(liveTime, endTime))
    throw new ValidationError("takeDownAt must be after goLiveAt.");

  const isImmediate = liveTime <= now;

  await prisma.$transaction([
    prisma.productSchedule.upsert({
      where: { productId },
      create: {
        productId,
        goLiveAt: liveTime,
        takeDownAt: endTime,
        graceMinutes,
        isLive: isImmediate,
        type: "ONE_TIME",
        enabled: true, // a fresh one-time schedule re-enables the row
      },
      update: {
        goLiveAt: liveTime,
        takeDownAt: endTime,
        graceMinutes,
        isLive: isImmediate,
        // Re-scheduling via go-live converts the row back to ONE_TIME and
        // clears any weekly windows — one authoritative schedule per
        // product, last write wins.
        type: "ONE_TIME",
        enabled: true,
      },
    }),
    prisma.product.update({
      where: { id: productId },
      data: { isLive: isImmediate, liveUntil: endTime },
    }),
  ]);

  // A weekly schedule (if any) was replaced by this one-time schedule.
  const schedRow = await prisma.productSchedule.findUnique({
    where: { productId },
    select: { id: true },
  });
  if (schedRow) {
    await prisma.productScheduleWindow.deleteMany({ where: { scheduleId: schedRow.id } });
  }

  // Extend pending payments' expiry so a customer mid-checkout isn't cut
  // off right as the vendor extends their live window.
  // Fixed: was comparing against 'pending' (lowercase) — Payment.status
  // is an enum now (uppercase values), so this raw SQL silently matched
  // zero rows after that change. This predates the Payments-domain pass
  // and lived undetected here since it's outside Prisma's typed query
  // API (a raw SQL string), so the earlier codebase-wide sweep for
  // Payment.status literals didn't catch it.
  const paymentExpiry = addMinutesUtc(endTime, graceMinutes);
  await prisma.$executeRaw`
    UPDATE "Payment"
    SET "expiresAt" = GREATEST(COALESCE("expiresAt", NOW()), ${paymentExpiry})
    WHERE "status" = 'PENDING'
      AND "orderId" IN (
        SELECT "id" FROM "Order"
        WHERE "status" = 'AWAITING_PAYMENT'
          AND EXISTS (
            SELECT 1 FROM "OrderItem"
            WHERE "OrderItem"."orderId" = "Order"."id"
              AND "OrderItem"."productId" = ${productId}
          )
      )
  `;

  const nowTime = nowUtc();

  if (!isImmediate) {
    await productLiveQueue.add(
      "makeLive",
      { productId, vendorId: req.user.id },
      { delay: Math.max(0, liveTime.getTime() - nowTime.getTime()) },
    );
  } else {
    await clearProductCache(productId, req.user.id);

    await recordActivityBundle({
      actorId: req.user.id,
      actions: [
        {
          type: ActivityType.GENERAL,
          title: "Product is live!",
          message: `Your product "${product.name}" is now live and will be taken down at ${endTime.toISOString()} (UTC).`,
          targetId: req.user.id,
          socketEvent: "GENERAL",
          metadata: { productId, goLiveAt: liveTime, liveUntil: endTime },
        },
      ],
      audit: {
        action: "PRODUCT_LIVE_NOW",
        metadata: { productId, vendorId: req.user.id },
      },
      notifyRealtime: true,
      notifyPush: true,
    });
  }

  await productDeactivateQueue.add(
    "takeDown",
    { productId },
    { delay: Math.max(0, endTime.getTime() - nowTime.getTime()) },
  );

  const message = isImmediate
    ? `Product is now live! Will be taken down at ${endTime.toISOString()} (UTC).`
    : `Product scheduled successfully (UTC). Will go live at ${liveTime.toISOString()}.`;

  return sendSuccess(
    res,
    {
      isLive: isImmediate,
      goLiveAt: liveTime.toISOString(),
      liveUntil: endTime.toISOString(),
      graceMinutes,
    },
    message,
  );
};

/**
 * POST /:id/schedule/take-down — vendor takes their own product down immediately.
 *
 * Previously had NO ownership check at all (didn't even look at req.user),
 * and the route itself had no authentication middleware either — meaning
 * literally anyone on the internet, logged in or not, could take down any
 * vendor's product just by knowing its id. Both holes are closed: route
 * now requires auth, and this verifies the product actually belongs to
 * the caller.
 */
export const takeDown = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);
  if (!req.user) throw new ForbiddenError("Authentication required");

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new NotFoundError("Product");
  if (product.vendorId !== req.user.id && req.user.role !== "ADMIN") {
    throw new ForbiddenError("You can only take down your own products");
  }

  await prisma.$transaction([
    prisma.productSchedule.updateMany({
      where: { productId },
      data: {
        isLive: false,
        goLiveAt: null,
        takeDownAt: null,
        graceMinutes: 0,
        // Vendor Live separation: taking the product down disables BOTH
        // schedule modes (one-time window cleared; weekly paused). This is
        // a product-availability action and never touches User.isLive.
        enabled: false,
      },
    }),
    prisma.product.update({
      where: { id: productId },
      data: { isLive: false, liveUntil: null },
    }),
  ]);

  await invalidateMarketplaceDiscoveryCaches();

  // clearProductCache already does a comprehensive SCAN-based invalidation
  // across every relevant key pattern and every Redis instance — the
  // extra manual per-key deletes and a second duplicate SCAN loop that
  // used to run right after it were redundant work doing the same thing
  // twice.
  await clearProductCache(productId, product.vendorId);
  await clearProductFromCarts(productId);

  await recordActivityBundle({
    actorId: req.user.id,
    actions: [
      {
        type: ActivityType.GENERAL,
        title: "Product taken down",
        message: `Your product "${product.name}" has been taken down.`,
        targetId: product.vendorId,
        socketEvent: "GENERAL",
        metadata: { productId },
      },
    ],
    audit: {
      action: "PRODUCT_TAKEN_DOWN",
      metadata: { productId, vendorId: product.vendorId },
    },
    notifyRealtime: true,
    notifyPush: true,
  });

  return sendSuccess(res, {}, "Product taken down successfully.");
};

/**
 * POST /:id/schedule/extend-grace
 */
export const extendGrace = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);
  const { extraMinutes } = req.body;

  if (!req.user) throw new ForbiddenError("Authentication required");
  if (!extraMinutes || extraMinutes <= 0)
    throw new ValidationError("extraMinutes must be positive.");

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new NotFoundError("Product");
  if (product.vendorId !== req.user.id && req.user.role !== "ADMIN") {
    throw new ForbiddenError("You can only extend grace on your own products");
  }

  const schedule = await prisma.productSchedule.findUnique({
    where: { productId },
  });
  if (!schedule || !schedule.isLive)
    throw new ValidationError("Product is not currently live.");

  // Was previously run twice in a row (identical update called twice) —
  // a single update is all that's needed.
  await prisma.productSchedule.update({
    where: { productId },
    data: { graceMinutes: (schedule.graceMinutes || 0) + extraMinutes },
  });

  await productDeactivateQueue.add(
    "finalDeactivate",
    { productId },
    { delay: extraMinutes * 60 * 1000 },
  );

  await recordActivityBundle({
    actorId: req.user.id,
    actions: [
      {
        type: ActivityType.GENERAL,
        title: "Grace period extended",
        message: `The grace period for your product "${product.name}" has been extended by ${extraMinutes} minutes.`,
        targetId: req.user.id,
        socketEvent: "GENERAL",
        metadata: { productId, extraMinutes },
      },
    ],
    audit: {
      action: "GRACE_PERIOD_EXTENDED",
      metadata: { productId, vendorId: req.user.id, extraMinutes },
    },
    notifyRealtime: true,
    notifyPush: true,
  });

  return sendSuccess(res, {}, "Grace period extended successfully.");
};

/**
 * Ensures all products' live statuses match their schedules. This is an
 * internal maintenance endpoint (also runs on a cron via fixLiveStatusJob)
 * — restricted to admin, since it was previously reachable by anyone with
 * no authentication at all.
 */
export const fixLiveStatuses = async (_req: Request, res: Response) => {
  const now = new Date();
  logger.info(
    { now: now.toISOString() },
    "Running product live-status fixer via controller",
  );

  const products = await prisma.product.findMany({
    where: { productSchedule: { isNot: null } },
    include: {
      productSchedule: {
        select: {
          id: true,
          goLiveAt: true,
          takeDownAt: true,
          graceMinutes: true,
          isLive: true,
        },
      },
    },
  });

  let updatedCount = 0;
  const updates: string[] = [];

  for (const product of products) {
    const sched = product.productSchedule;
    if (!sched || !sched.goLiveAt || !sched.takeDownAt) continue;

    const goLiveAt = new Date(sched.goLiveAt);
    const takeDownAt = new Date(sched.takeDownAt);

    const graceExpiry = new Date(takeDownAt);
    if (sched.graceMinutes && sched.graceMinutes > 0)
      graceExpiry.setMinutes(graceExpiry.getMinutes() + sched.graceMinutes);

    const shouldBeLive = now >= goLiveAt && now <= graceExpiry;

    const productLiveMismatch = product.isLive !== shouldBeLive;
    const productLiveUntilMismatch =
      !product.liveUntil ||
      product.liveUntil.getTime() !== takeDownAt.getTime();
    const scheduleLiveMismatch = sched.isLive !== shouldBeLive;

    if (
      !productLiveMismatch &&
      !scheduleLiveMismatch &&
      !productLiveUntilMismatch
    )
      continue;

    const ops = [];
    if (productLiveMismatch || productLiveUntilMismatch) {
      ops.push(
        prisma.product.update({
          where: { id: product.id },
          data: {
            isLive: shouldBeLive,
            liveUntil: takeDownAt,
            updatedAt: new Date(),
          },
        }),
      );
    }
    if (scheduleLiveMismatch) {
      ops.push(
        prisma.productSchedule.update({
          where: { id: sched.id },
          data: { isLive: shouldBeLive },
        }),
      );
    }

    if (ops.length > 0) {
      await prisma.$transaction(ops);
      await clearProductCache(product.id).catch((err) =>
        logger.warn(
          { err, productId: product.id },
          "Failed to invalidate cache",
        ),
      );
      updates.push(
        `Product "${product.name}" (${product.id}) -> ${shouldBeLive ? "LIVE" : "OFFLINE"}`,
      );
      updatedCount++;
    }
  }

  return sendSuccess(
    res,
    { updatedCount, updates },
    "Product live statuses updated successfully.",
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY recurring schedules (mature scheduling system)
//
// A product has exactly ONE ProductSchedule row; its `type` selects the
// evaluation mode (ONE_TIME = legacy absolute window, WEEKLY = recurring
// windows evaluated in the vendor's effective timezone). Creating a weekly
// schedule replaces whatever was there — last write wins, never ambiguous.
// ─────────────────────────────────────────────────────────────────────────────

const HHMM_TO_MINUTE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (hhmm: string): number => {
  const m = HHMM_TO_MINUTE.exec(hhmm);
  if (!m) throw new ValidationError(`Invalid time "${hhmm}". Use 24h HH:mm.`);
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
};

async function loadOwnedProduct(productId: string, req: AuthRequest) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { vendor: { select: { id: true, timezone: true, operatingHours: true } } },
  });
  if (!product) throw new NotFoundError("Product");
  if (product.vendorId !== req.user!.id && req.user!.role !== "ADMIN") {
    throw new ForbiddenError("You can only manage schedules for your own products");
  }
  return product;
}

/** GET /api/product/:id/schedule — full schedule + live evaluation for editors. */
export const getWeeklySchedule = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { vendor: { select: { timezone: true, operatingHours: true } } },
  });
  if (!product) throw new NotFoundError("Product");

  const schedule = await prisma.productSchedule.findUnique({
    where: { productId },
    include: { windows: { orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }] } },
  });

  const tz = resolveVendorTimezone(product.vendor?.timezone, product.vendor?.operatingHours);
  const currentlyActive = evaluateProductSchedule(schedule as any, new Date(), tz, product.isLive);
  return sendSuccess(res, {
    productId,
    timezone: tz,
    type: schedule?.type ?? null,
    enabled: schedule ? !!(schedule as any).enabled : false,
    startDate: schedule?.startDate ?? null,
    endDate: schedule?.endDate ?? null,
    goLiveAt: schedule?.goLiveAt ?? null,
    takeDownAt: schedule?.takeDownAt ?? null,
    graceMinutes: schedule?.graceMinutes ?? null,
    isLive: product.isLive,
    currentlyActive,
    windows:
      schedule?.windows.map((w: any) => ({
        id: w.id,
        dayOfWeek: w.dayOfWeek,
        startTime: `${String(Math.floor(w.startMinute / 60)).padStart(2, "0")}:${String(w.startMinute % 60).padStart(2, "0")}`,
        endTime: `${String(Math.floor(w.endMinute / 60)).padStart(2, "0")}:${String(w.endMinute % 60).padStart(2, "0")}`,
        overnight: w.endMinute <= w.startMinute,
        enabled: w.enabled,
      })) ?? [],
  });
};

/**
 * PUT /api/product/:id/schedule/weekly
 * Creates or replaces the product's WEEKLY schedule atomically.
 * Body: { enabled?, startDate?, endDate?, windows: [{ dayOfWeek, startTime, endTime }] }
 */
export const putWeeklySchedule = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);
  const parsed = weeklyScheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid weekly schedule", parsed.error.flatten().fieldErrors);
  }

  const product = await loadOwnedProduct(productId, req);

  const { enabled = true, startDate, endDate, windows } = parsed.data;

  // Normalized minute intervals per day (overnight windows split across the
  // wrap for overlap detection only — storage keeps the single row).
  const byDay = new Map<number, Array<{ s: number; e: number }>>();
  const seen = new Set<string>();
  for (const w of windows) {
    const s = toMinutes(w.startTime);
    const e = toMinutes(w.endTime);
    if (s === e) throw new ValidationError(`Window ${w.startTime}–${w.endTime} has zero length.`);
    const key = `${w.dayOfWeek}-${w.startTime}-${w.endTime}`;
    if (seen.has(key)) {
      throw new ValidationError(
        `Duplicate window on day ${w.dayOfWeek}: ${w.startTime}–${w.endTime}.`,
      );
    }
    seen.add(key);

    // Expand into linear intervals (overnight wraps past 1440).
    const intervals = e > s ? [{ s, e }] : [{ s, e: 1440 }, { s: 0, e }];
    const list = byDay.get(w.dayOfWeek) ?? [];
    for (const iv of intervals) list.push(iv);
    byDay.set(w.dayOfWeek, list);
  }

  // Overlap detection within each day over the normalized intervals.
  for (const [day, intervals] of byDay) {
    intervals.sort((a, b) => a.s - b.s || a.e - b.e);
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i].s < intervals[i - 1].e) {
        throw new ValidationError(
          `Overlapping windows on day ${day}. Windows must not overlap.`,
        );
      }
    }
  }

  if (!product.vendorId) throw new NotFoundError("Vendor");

  const schedule = await prisma.$transaction(async (tx) => {
    const row = await tx.productSchedule.upsert({
      where: { productId },
      create: {
        productId,
        type: "WEEKLY",
        enabled,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
      },
      update: {
        type: "WEEKLY",
        enabled,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        // switching modes clears any leftover one-time window
        goLiveAt: null,
        takeDownAt: null,
        graceMinutes: 0,
      },
    });

    await tx.productScheduleWindow.deleteMany({ where: { scheduleId: row.id } });
    if (windows.length > 0 && enabled) {
      await tx.productScheduleWindow.createMany({
        data: windows.map((w) => ({
          scheduleId: row.id,
          dayOfWeek: w.dayOfWeek,
          startMinute: toMinutes(w.startTime),
          endMinute: toMinutes(w.endTime),
          enabled: true,
        })),
      });
    }

    return tx.productSchedule.findUnique({
      where: { productId },
      include: { windows: { orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }] } },
    });
  });

  // Mirror + discovery caches: weekly state changes marketplace visibility.
  await clearProductCache(productId, product.vendorId);
  await invalidateMarketplaceDiscoveryCaches();

  return sendSuccess(res, schedule, "Weekly schedule saved");
};

/**
 * DELETE /api/product/:id/schedule/weekly — disables recurrence without
 * deleting history. The row remains with enabled=false and no windows.
 */
export const disableWeeklySchedule = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.id);
  const product = await loadOwnedProduct(productId, req);

  const existing = await prisma.productSchedule.findUnique({ where: { productId } });
  if (!existing) throw new NotFoundError("Schedule");

  const updated = await prisma.productSchedule.update({
    where: { productId },
    data: { type: "WEEKLY", enabled: false },
  });
  await prisma.productScheduleWindow.deleteMany({ where: { scheduleId: existing.id } });

  await clearProductCache(productId, product.vendorId);
  await invalidateMarketplaceDiscoveryCaches();

  return sendSuccess(res, updated, "Weekly schedule disabled");
};

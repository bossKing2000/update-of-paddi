// ─────────────────────────────────────────────────────────────────────────────
// Recurring weekly schedule evaluation — the ONE authoritative implementation.
//
// Pure functions only (no Prisma/Redis) so they are trivially testable and
// reusable from the availability service, raw-SQL mapping code, workers and
// controllers. SQL mirrors of these rules exist in product.service.ts
// (VENDOR_OPERATING_SQL / weekly predicates) and are kept in sync by
// contract tests.
//
// Conventions:
//   dayOfWeek  0 = Sunday … 6 = Saturday (JS/Postgres EXTRACT(dow))
//   minutes    minutes from local midnight (0–1439); end may be up to 1440
//   overnight  endMinute <= startMinute ⇒ window crosses midnight into the
//              next day (e.g. Fri 22:00 → Sat 02:00)
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleWindowLike {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  enabled?: boolean;
}

export interface WeeklyScheduleLike {
  enabled?: boolean;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  windows?: (ScheduleWindowLike | null | undefined)[] | null;
}

/** Local calendar position for a moment in an IANA timezone. */
export function localCalendar(nowUtc: Date, timezone?: string | null): {
  dow: number; // 0 = Sunday … 6 = Saturday
  minuteOfDay: number; // 0–1439
  localDate: string; // YYYY-MM-DD in that timezone
} {
  let tz = timezone ?? "UTC";
  if (tz.trim() === "") tz = "UTC";

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(nowUtc);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dayMap[get("weekday")] ?? 0;
    const hour = parseInt(get("hour"), 10) % 24; // Intl can yield "24" at midnight
    const minute = parseInt(get("minute"), 10);
    const minuteOfDay = hour * 60 + minute;
    const localDate = `${get("year")}-${get("month")}-${get("day")}`;
    return { dow, minuteOfDay, localDate };
  } catch {
    // Unknown/invalid timezone string: evaluate as UTC rather than crashing.
    const dow = nowUtc.getUTCDay();
    return {
      dow,
      minuteOfDay: nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes(),
      localDate: nowUtc.toISOString().slice(0, 10),
    };
  }
}

/**
 * Whether a single window is active at a local calendar position.
 * Overnight handling: the evening side matches today's row; the post-midnight
 * tail matches YESTERDAY's row (endMinute <= startMinute marks overnight).
 */
export function isWindowActiveAt(
  w: ScheduleWindowLike,
  cal: { dow: number; minuteOfDay: number },
): boolean {
  if (w.enabled === false) return false;

  const overnight = w.endMinute <= w.startMinute;

  if (!overnight) {
    // start inclusive, end exclusive: [start, end)
    return w.dayOfWeek === cal.dow && cal.minuteOfDay >= w.startMinute && cal.minuteOfDay < w.endMinute;
  }

  // Evening part: today is the window's own day, at/after its start.
  if (w.dayOfWeek === cal.dow && cal.minuteOfDay >= w.startMinute) return true;

  // Post-midnight tail: today is the day AFTER the window's day,
  // before the (earlier-than-start) end time.
  const yesterdayDow = (cal.dow + 6) % 7;
  return w.dayOfWeek === yesterdayDow && cal.minuteOfDay < w.endMinute;
}

/** True when the moment falls inside any enabled window. */
export function evaluateWeeklyWindows(
  windows: (ScheduleWindowLike | null | undefined)[] | null | undefined,
  cal: { dow: number; minuteOfDay: number },
): boolean {
  for (const w of windows ?? []) {
    if (!w) continue;
    if (isWindowActiveAt(w, cal)) return true;
  }
  return false;
}

function toDateOnly(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** Inclusive date-range check against the LOCAL date (range bounds optional). */
export function isWithinScheduleRange(
  schedule: { startDate?: Date | string | null; endDate?: Date | string | null },
  localDate: string,
): boolean {
  const start = schedule.startDate ? toDateOnly(schedule.startDate) : null;
  const end = schedule.endDate ? toDateOnly(schedule.endDate) : null;
  if (start && localDate < start) return false;
  if (end && localDate > end) return false;
  return true;
}

export interface EvaluableProductSchedule extends WeeklyScheduleLike {
  type?: string | null; // 'ONE_TIME' | 'WEEKLY'
  goLiveAt?: Date | string | null;
  takeDownAt?: Date | string | null;
  graceMinutes?: number | null;
}

/**
 * Authoritative evaluation of ANY product schedule at a moment.
 *
 * WEEKLY   → enabled + within optional date range + inside a weekly window.
 * ONE_TIME / legacy rows without a type → absolute window with grace;
 *            missing/incomplete window defers to the stored mirror flag.
 *
 * `defaultIfNoWindow` is the stored Product.isLive mirror used exactly like
 * computeIsLive everywhere else (unscheduled products keep flag semantics).
 */
export function evaluateProductSchedule(
  schedule: EvaluableProductSchedule | null | undefined,
  nowUtc: Date,
  timezone: string | null | undefined,
  defaultIfNoWindow: boolean,
): boolean {
  if (!schedule) return defaultIfNoWindow;

  if ((schedule.type ?? "ONE_TIME") === "WEEKLY") {
    if (schedule.enabled === false) return false;
    const cal = localCalendar(nowUtc, timezone);
    if (!isWithinScheduleRange(schedule, cal.localDate)) return false;
    return evaluateWeeklyWindows(schedule.windows, cal);
  }

  // ── ONE_TIME (absolute) — same semantics as computeIsLive ──
  const goLive = schedule.goLiveAt ? new Date(schedule.goLiveAt).getTime() : 0;
  const takeDown = schedule.takeDownAt ? new Date(schedule.takeDownAt).getTime() : 0;
  if (!goLive || !takeDown) return defaultIfNoWindow;

  const grace = (schedule.graceMinutes ?? 0) * 60_000;
  const t = nowUtc.getTime();
  return t >= goLive && t <= takeDown + grace;
}

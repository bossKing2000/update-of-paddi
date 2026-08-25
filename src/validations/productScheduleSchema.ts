import { z } from "zod";

// 🟢 Schema for scheduling Go Live + Take Down
export const goLiveSchema = z.object({
  goLiveAt: z.string().datetime("Invalid goLiveAt date format."), // <── Missing field fixed
  takeDownAt: z.string().datetime("Invalid takeDownAt date format."),
  graceMinutes: z.number().min(0).max(300).optional(),
});

// ⏰ Schema for extending grace period
export const extendGraceSchema = z.object({
  extraMinutes: z.number().min(1, "extraMinutes must be at least 1."),
});

// ── WEEKLY recurring schedules ───────────────────────────────────────────────
// Times arrive as 24h "HH:mm" strings (vendor-local); stored as minutes
// from midnight. dayOfWeek follows the JS/Postgres convention: 0=Sunday…6=Saturday.
const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Time must be 24h HH:mm (e.g. \"14:30\").");

export const scheduleWindowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: hhmm,
  endTime: hhmm,
});

export const weeklyScheduleSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    windows: z.array(scheduleWindowSchema).max(28),
  })
  .superRefine((val, ctx) => {
    if (!val.enabled && val.windows.length > 0) {
      // allowed: saving a disabled draft is fine — no extra rule needed
    }
    if (val.enabled && val.windows.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An enabled weekly schedule needs at least one window. Disable it instead.",
      });
    }
    if (val.startDate && val.endDate && new Date(val.startDate) > new Date(val.endDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endDate must be on or after startDate.",
      });
    }

    // Duplicate + overlap detection per day, with overnight windows
    // normalized into linear intervals so wrap-around overlaps are caught.
    const byDay = new Map<number, Array<{ s: number; e: number }>>();
    const seen = new Set<string>();
    for (const w of val.windows) {
      const toMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3), 10);
      const s = toMin(w.startTime);
      const e = toMin(w.endTime);
      if (s === e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Zero-length window ${w.startTime}–${w.endTime} on day ${w.dayOfWeek}.`,
        });
        continue;
      }
      const key = `${w.dayOfWeek}-${w.startTime}-${w.endTime}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate window ${w.startTime}–${w.endTime} on day ${w.dayOfWeek}.`,
        });
        continue;
      }
      seen.add(key);
      const list = byDay.get(w.dayOfWeek) ?? [];
      if (e > s) list.push({ s, e });
      else {
        list.push({ s, e: 1440 }); // overnight evening part
        list.push({ s: 0, e }); // overnight morning part
      }
      byDay.set(w.dayOfWeek, list);
    }

    for (const [day, intervals] of byDay) {
      intervals.sort((a, b) => a.s - b.s || a.e - b.e);
      for (let i = 1; i < intervals.length; i++) {
        if (intervals[i].s < intervals[i - 1].e) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Overlapping windows on day ${day}. Adjust the times so windows don't intersect.`,
          });
          break;
        }
      }
    }
  });

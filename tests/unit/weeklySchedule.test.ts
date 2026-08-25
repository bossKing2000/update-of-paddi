import {
  evaluateProductSchedule,
  evaluateWeeklyWindows,
  isWindowActiveAt,
  localCalendar,
  isWithinScheduleRange,
} from "../../src/services/scheduleRules.service";

// Fixed reference moment: 2026-08-26 is a WEDNESDAY.
const wed = new Date("2026-08-26T12:00:00Z");

describe("localCalendar", () => {
  it("maps UTC moments onto weekday + minute-of-day", () => {
    const cal = localCalendar(new Date("2026-08-26T13:30:00Z"), "UTC");
    expect(cal.dow).toBe(3); // Wednesday
    expect(cal.minuteOfDay).toBe(13 * 60 + 30);
    expect(cal.localDate).toBe("2026-08-26");
  });

  it("respects the vendor timezone (14:00 UTC = 10:00 in New York)", () => {
    const cal = localCalendar(new Date("2026-08-26T14:00:00Z"), "America/New_York");
    expect(cal.minuteOfDay).toBe(10 * 60);
  });

  it("falls back to UTC for unknown timezones instead of crashing", () => {
    const cal = localCalendar(wed, "Not/AZone");
    expect(cal.dow).toBe(3);
  });
});

describe("single windows", () => {
  const w = { dayOfWeek: 3, startMinute: 12 * 60, endMinute: 18 * 60, enabled: true };

  it("active at the boundaries: inclusive start, exclusive end", () => {
    expect(isWindowActiveAt(w, { dow: 3, minuteOfDay: 12 * 60 })).toBe(true);
    expect(isWindowActiveAt(w, { dow: 3, minuteOfDay: 17 * 60 + 59 })).toBe(true);
    expect(isWindowActiveAt(w, { dow: 3, minuteOfDay: 18 * 60 })).toBe(false);
  });

  it("inactive on other days", () => {
    expect(isWindowActiveAt(w, { dow: 2, minuteOfDay: 13 * 60 })).toBe(false);
    expect(isWindowActiveAt(w, { dow: 4, minuteOfDay: 13 * 60 })).toBe(false);
  });

  it("disabled window never matches", () => {
    expect(isWindowActiveAt({ ...w, enabled: false }, { dow: 3, minuteOfDay: 13 * 60 })).toBe(false);
  });
});

describe("multiple windows per day", () => {
  // Monday lunch 12:00–15:00 + dinner 18:00–22:00
  const monday1 = { dayOfWeek: 1, startMinute: 720, endMinute: 900 };
  const monday2 = { dayOfWeek: 1, startMinute: 1080, endMinute: 1320 };

  const cal = (m: number) => ({ dow: 1, minuteOfDay: m });

  it("inside first window", () => {
    expect(evaluateWeeklyWindows([monday1, monday2], cal(780))).toBe(true);
  });

  it("between windows (the closed gap)", () => {
    expect(evaluateWeeklyWindows([monday1, monday2], cal(960))).toBe(false);
  });

  it("inside second window", () => {
    expect(evaluateWeeklyWindows([monday1, monday2], cal(1200))).toBe(true);
  });

  it("outside all windows", () => {
    expect(evaluateWeeklyWindows([monday1, monday2], cal(600))).toBe(false);
    expect(evaluateWeeklyWindows([monday1, monday2], cal(1400))).toBe(false);
  });
});

describe("overnight windows", () => {
  // Friday 22:00–02:00 (crosses midnight into Saturday)
  const fridayNight = { dayOfWeek: 5, startMinute: 22 * 60, endMinute: 2 * 60 };

  it("evening side: active Friday before midnight", () => {
    expect(isWindowActiveAt(fridayNight, { dow: 5, minuteOfDay: 23 * 60 })).toBe(true);
  });

  it("morning side: active SATURDAY after midnight (yesterday's tail)", () => {
    expect(isWindowActiveAt(fridayNight, { dow: 6, minuteOfDay: 60 })).toBe(true);
    expect(isWindowActiveAt(fridayNight, { dow: 6, minuteOfDay: 0 })).toBe(true);
  });

  it("outside the window", () => {
    expect(isWindowActiveAt(fridayNight, { dow: 6, minuteOfDay: 3 * 60 })).toBe(false); // Sat 03:00
    expect(isWindowActiveAt(fridayNight, { dow: 5, minuteOfDay: 21 * 60 })).toBe(false); // Fri 21:00
    expect(isWindowActiveAt(fridayNight, { dow: 3, minuteOfDay: 23 * 60 })).toBe(false); // Wednesday night
  });
});

describe("evaluateProductSchedule — WEEKLY mode", () => {
  const mkSchedule = (overrides: Record<string, unknown> = {}) => ({
    type: "WEEKLY",
    enabled: true,
    startDate: null,
    endDate: null,
    windows: [{ dayOfWeek: 3, startMinute: 600, endMinute: 1200 }], // Wed 10:00–20:00
    ...overrides,
  });

  it("Monday inactive, Tuesday inactive, Wednesday active", () => {
    const mon = mkSchedule();
    expect(
      evaluateProductSchedule(mon, new Date("2026-08-24T11:00:00Z"), null, false),
    ).toBe(false); // Monday
    expect(
      evaluateProductSchedule(mon, new Date("2026-08-25T11:00:00Z"), null, false),
    ).toBe(false); // Tuesday
    expect(
      evaluateProductSchedule(mon, new Date("2026-08-26T11:00:00Z"), null, false),
    ).toBe(true); // Wednesday 11:00 UTC inside 10–20
  });

  it("all seven days supported", () => {
    const everyDay = mkSchedule({
      windows: Array.from({ length: 7 }, (_, d) => ({
        dayOfWeek: d,
        startMinute: 0,
        endMinute: 1440,
      })),
    });
    for (let day = 16; day <= 22; day++) {
      expect(
        evaluateProductSchedule(everyDay, new Date(`2026-08-${day}T05:00:00Z`), null, false),
      ).toBe(true);
    }
  });

  it("schedule startDate gates availability (inclusive)", () => {
    const s = mkSchedule({ startDate: "2026-09-01" });
    expect(
      evaluateProductSchedule(s, new Date("2026-08-26T11:00:00Z"), null, false),
    ).toBe(false); // before range even though it's a Wednesday inside hours
    expect(
      evaluateProductSchedule(s, new Date("2026-09-02T11:00:00Z"), null, false),
    ).toBe(true); // first Wednesday of the range
  });

  it("schedule endDate gates availability (inclusive)", () => {
    const s = mkSchedule({ endDate: "2026-09-02" });
    expect(
      evaluateProductSchedule(s, new Date("2026-09-02T11:00:00Z"), null, false),
    ).toBe(true);
    expect(
      evaluateProductSchedule(s, new Date("2026-09-09T11:00:00Z"), null, false),
    ).toBe(false);
  });

  it("disabled schedule is never active", () => {
    expect(
      evaluateProductSchedule(mkSchedule({ enabled: false }), new Date("2026-08-26T11:00:00Z"), null, false),
    ).toBe(false);
  });

  it("evaluates in the VENDOR's timezone, not the server's", () => {
    // Window Wed 02:00–04:00 Lagos time (UTC+1). At 01:30 UTC it is 02:30
    // in Lagos → active; evaluated as pure UTC it would be inactive.
    const s = mkSchedule({
      windows: [{ dayOfWeek: 3, startMinute: 120, endMinute: 240 }],
    });
    expect(evaluateProductSchedule(s, new Date("2026-08-26T01:30:00Z"), "Africa/Lagos", false)).toBe(true);
    expect(evaluateProductSchedule(s, new Date("2026-08-26T01:30:00Z"), "UTC", false)).toBe(false);
  });
});

describe("evaluateProductSchedule — ONE_TIME compatibility", () => {
  const base = {
    type: "ONE_TIME",
    enabled: true,
    goLiveAt: new Date("2026-08-25T12:00:00Z"),
    takeDownAt: new Date("2026-08-27T20:00:00Z"),
    graceMinutes: 0,
  };

  it("before start → inactive", () => {
    expect(
      evaluateProductSchedule(base, new Date("2026-08-25T11:59:00Z"), null, false),
    ).toBe(false);
  });

  it("during schedule → active", () => {
    expect(
      evaluateProductSchedule(base, new Date("2026-08-26T12:00:00Z"), null, false),
    ).toBe(true);
  });

  it("after end → inactive", () => {
    expect(
      evaluateProductSchedule(base, new Date("2026-08-27T20:01:00Z"), null, false),
    ).toBe(false);
  });

  it("grace period extends past takeDownAt", () => {
    expect(
      evaluateProductSchedule({ ...base, graceMinutes: 30 }, new Date("2026-08-27T20:15:00Z"), null, false),
    ).toBe(true);
    expect(
      evaluateProductSchedule({ ...base, graceMinutes: 30 }, new Date("2026-08-27T20:31:00Z"), null, false),
    ).toBe(false);
  });

  it("missing/incomplete window defers to the stored mirror flag", () => {
    expect(evaluateProductSchedule(null, new Date(), null, true)).toBe(true);
    expect(
      evaluateProductSchedule({ type: "ONE_TIME", goLiveAt: null, takeDownAt: null }, wed, null, true),
    ).toBe(true);
    expect(
      evaluateProductSchedule({ type: "ONE_TIME", goLiveAt: null, takeDownAt: null }, wed, null, false),
    ).toBe(false);
  });
});

describe("range helper", () => {
  it("inclusive on both bounds", () => {
    const s = { startDate: "2026-09-01", endDate: "2026-09-07" };
    expect(isWithinScheduleRange(s, "2026-08-31")).toBe(false);
    expect(isWithinScheduleRange(s, "2026-09-01")).toBe(true);
    expect(isWithinScheduleRange(s, "2026-09-07")).toBe(true);
    expect(isWithinScheduleRange(s, "2026-09-08")).toBe(false);
  });

  it("open-ended ranges", () => {
    expect(isWithinScheduleRange({ startDate: "2026-09-01" }, "2027-01-01")).toBe(true);
    expect(isWithinScheduleRange({ endDate: "2026-09-01" }, "2020-01-01")).toBe(true);
    expect(isWithinScheduleRange({}, "2000-01-01")).toBe(true);
  });
});

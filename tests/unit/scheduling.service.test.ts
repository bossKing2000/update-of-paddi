import {
  parseScheduledAt,
  validateCutOff,
  lagosDayStart,
} from "../../src/services/scheduling.service";
import { DateTime } from "luxon";

const LAGOS = "Africa/Lagos";

function iso(lagosDateTimeString: string): Date {
  return DateTime.fromISO(lagosDateTimeString, { zone: LAGOS }).toJSDate();
}

describe("scheduling.service", () => {
  describe("parseScheduledAt", () => {
    it("returns null for immediate orders", () => {
      expect(parseScheduledAt(undefined)).toBeNull();
      expect(parseScheduledAt(null)).toBeNull();
      expect(parseScheduledAt("")).toBeNull();
    });

    it("parses a future ISO date into a UTC instant", () => {
      const nowLagos = DateTime.now().setZone(LAGOS);
      const future = nowLagos.plus({ hours: 3 }).toUTC();
      const d = parseScheduledAt(future.toISO());
      expect(d).not.toBeNull();
      expect((d as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it("rejects a date in the past", () => {
      const past = DateTime.now().setZone(LAGOS).minus({ hours: 1 });
      expect(() => parseScheduledAt(past.toISO())).toThrow(
        /minutes in the future/,
      );
    });

    it("rejects a malformed date", () => {
      expect(() => parseScheduledAt("not-a-date")).toThrow(
        /valid ISO-8601/,
      );
      expect(() => parseScheduledAt(12345 as any)).toThrow(/valid ISO-8601/);
    });

    it("rejects a date more than 30 days ahead", () => {
      const far = DateTime.now().setZone(LAGOS).plus({ days: 31 });
      expect(() => parseScheduledAt(far.toISO())).toThrow(
        /within 30 days/,
      );
    });

    it("accepts exactly 30 days ahead at start of day", () => {
      const exactly30 = DateTime.now()
        .setZone(LAGOS)
        .plus({ days: 30 })
        .startOf("day");
      expect(() => parseScheduledAt(exactly30.toISO())).not.toThrow();
    });
  });

  describe("lagosDayStart", () => {
    it("returns the start of the Lagos calendar day", () => {
      const instant = DateTime.fromISO("2026-10-26T14:30:00", {
        zone: LAGOS,
      }).toJSDate();
      const start = lagosDayStart(instant);
      const startLagos = DateTime.fromJSDate(start, { zone: LAGOS });
      expect(startLagos.hour).toBe(0);
      expect(startLagos.minute).toBe(0);
      expect(startLagos.day).toBe(26);
      expect(startLagos.month).toBe(10);
    });
  });

  describe("validateCutOff", () => {
    it("returns null when no cut-off is configured", () => {
      const now = DateTime.now().setZone(LAGOS);
      expect(
        validateCutOff({ now, scheduledAt: null, cutoffTime: null }),
      ).toBeNull();
    });

    it("rejects an immediate order placed after today's cut-off", () => {
      const now = DateTime.fromISO("2026-10-26T15:30:00", { zone: LAGOS });
      const err = validateCutOff({
        now,
        scheduledAt: null,
        cutoffTime: "14:00",
      });
      expect(err).toBeInstanceOf(Error);
    });

    it("accepts an immediate order placed before today's cut-off", () => {
      const now = DateTime.fromISO("2026-10-26T10:00:00", { zone: LAGOS });
      expect(
        validateCutOff({ now, scheduledAt: null, cutoffTime: "14:00" }),
      ).toBeNull();
    });

    it("accepts scheduling for a later day when past today's cut-off", () => {
      const now = DateTime.fromISO("2026-10-26T15:30:00", { zone: LAGOS });
      const tomorrow = now.plus({ days: 1 }).startOf("day").plus({ hours: 9 });
      expect(
        validateCutOff({
          now,
          scheduledAt: tomorrow.toJSDate(),
          cutoffTime: "14:00",
        }),
      ).toBeNull();
    });

    it("rejects scheduling for today when past the cut-off", () => {
      const now = DateTime.fromISO("2026-10-26T15:30:00", { zone: LAGOS });
      const todayNoon = now.startOf("day").plus({ hours: 12 });
      const err = validateCutOff({
        now,
        scheduledAt: todayNoon.toJSDate(),
        cutoffTime: "14:00",
      });
      expect(err).toBeInstanceOf(Error);
    });
  });
});

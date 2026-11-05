/**
 * Stage G (E-08) — timezone-safe expiry.
 *
 * Proves `toUtc(Date)` is idempotent for absolute instants on any host
 * timezone, and that payment expiry decisions do not shift with TZ.
 *
 * Run under multiple timezones, e.g.:
 *   TZ=UTC npx jest tests/unit/timeToUtc.test.ts
 *   TZ=Africa/Lagos npx jest tests/unit/timeToUtc.test.ts
 *   TZ=America/New_York npx jest tests/unit/timeToUtc.test.ts
 */
import { toUtc, isBeforeUtc, isAfterUtc, nowUtc } from "../../src/utils/time";

describe("E-08 toUtc(Date) is timezone-safe", () => {
  it("A. Date idempotence: same absolute instant, no host-offset shift", () => {
    const input = new Date("2026-10-07T12:00:00.000Z");
    const out = toUtc(input);
    expect(out.getTime()).toBe(input.getTime());
    // Must be a clone, not the same reference (callers may mutate).
    expect(out).not.toBe(input);
    expect(out.toISOString()).toBe("2026-10-07T12:00:00.000Z");
  });

  it("A2. number timestamp idempotence", () => {
    const ms = new Date("2026-10-07T12:00:00.000Z").getTime();
    expect(toUtc(ms).getTime()).toBe(ms);
  });

  it("B. expired payment (10 min past) remains expired via toUtc", () => {
    const now = nowUtc();
    const expired = new Date(now.getTime() - 10 * 60_000);
    // paymentController reuse guard: reuse only if now < expiresAt
    expect(isBeforeUtc(now, toUtc(expired))).toBe(false);
    // finalizer/cron expiry: now > expiresAt
    expect(isAfterUtc(now, toUtc(expired))).toBe(true);
  });

  it("C. future payment (10 min ahead) remains valid via toUtc", () => {
    const now = nowUtc();
    const future = new Date(now.getTime() + 10 * 60_000);
    expect(isBeforeUtc(now, toUtc(future))).toBe(true);
    expect(isAfterUtc(now, toUtc(future))).toBe(false);
  });

  it("D. boundary: 5s past is expired, 5s future is valid — no TZ shift flips it", () => {
    const now = nowUtc();
    const justExpired = new Date(now.getTime() - 5_000);
    const justValid = new Date(now.getTime() + 5_000);
    expect(isBeforeUtc(now, toUtc(justExpired))).toBe(false);
    expect(isBeforeUtc(now, toUtc(justValid))).toBe(true);
  });

  it("E. existing string parsing: Z / explicit offset / date-only are absolute", () => {
    const z = new Date("2026-10-07T12:00:00.000Z");
    expect(toUtc("2026-10-07T12:00:00.000Z").getTime()).toBe(z.getTime());

    const withOffset = new Date("2026-10-07T12:00:00+01:00");
    expect(toUtc("2026-10-07T12:00:00+01:00").getTime()).toBe(
      withOffset.getTime(),
    );

    const dateOnly = new Date("2026-10-07");
    expect(toUtc("2026-10-07").getTime()).toBe(dateOnly.getTime());
  });

  it("E2. timezone-naive wall-clock string is interpreted as UTC, host-independent", () => {
    // 12:00 wall-clock must equal 12:00Z on every host.
    expect(toUtc("2026-10-07T12:00:00").getTime()).toBe(
      Date.UTC(2026, 9, 7, 12, 0, 0),
    );
  });
});

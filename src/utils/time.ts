// utils/date.ts
/**
 * Returns the current time in UTC.
 */
export const nowUtc = (): Date => new Date();

/**
 * Converts any input date to a proper UTC Date object.
 *
 * Stage G (E-08): a JavaScript `Date` (and a unix timestamp) already
 * represents an absolute instant — it must NOT be shifted by the host
 * timezone offset. Only timezone-naive strings (wall-clock input with no
 * offset designator) are interpreted as UTC wall-clock and shifted.
 * Strings that already carry timezone information ('Z' or an explicit
 * numeric offset) and date-only strings (parsed as UTC per spec) are
 * returned as-is.
 */
export function toUtc(date: string | Date | number): Date {
  if (!date) return new Date();

  // E-08: Date instances are absolute instants — clone without shifting.
  if (date instanceof Date) return new Date(date.getTime());

  // E-08: unix timestamps are absolute instants — no shift.
  if (typeof date === "number") return new Date(date);

  const s = date.trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return d;

  // Date-only (YYYY-MM-DD) is parsed as UTC midnight per spec — absolute.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return d;

  // Explicit timezone designator ('Z' or numeric offset) — absolute.
  if (/([Zz]|[+-]\d{2}:?\d{2}|[+-]\d{4}|[+-]\d{2})$/.test(s)) return d;

  // Timezone-naive wall-clock string → interpret wall-clock as UTC.
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000);
}

/**
 * Adds a number of minutes to a UTC Date.
 */
export const addMinutesUtc = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * 60000);

/**
 * Returns the later of two UTC dates.
 */
export const maxUtc = (a: Date, b: Date): Date => (a.getTime() > b.getTime() ? a : b);

/**
 * Compares two UTC dates.
 */
export const isAfterUtc = (a: Date, b: Date): boolean => a.getTime() > b.getTime();
export const isBeforeUtc = (a: Date, b: Date): boolean => a.getTime() < b.getTime();

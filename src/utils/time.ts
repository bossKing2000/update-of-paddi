// utils/date.ts
/**
 * Returns the current time in UTC.
 */
export const nowUtc = (): Date => new Date();

/**
 * Converts any input date to a proper UTC Date object.
 * - If input is a string ending with 'Z', treat as UTC.
 * - If input is local (no 'Z'), convert to UTC.
 */
export function toUtc(date: string | Date | number): Date {
  if (!date) return new Date();

  const d = typeof date === "string" ? new Date(date) : new Date(date);

  // Already UTC ISO string
  if (typeof date === "string" && date.endsWith("Z")) {
    return d;
  }

  // Local time → shift to UTC
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

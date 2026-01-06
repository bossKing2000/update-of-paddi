"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBeforeUtc = exports.isAfterUtc = exports.maxUtc = exports.addMinutesUtc = exports.nowUtc = void 0;
exports.toUtc = toUtc;
// utils/date.ts
/**
 * Returns the current time in UTC.
 */
const nowUtc = () => new Date();
exports.nowUtc = nowUtc;
/**
 * Converts any input date to a proper UTC Date object.
 * - If input is a string ending with 'Z', treat as UTC.
 * - If input is local (no 'Z'), convert to UTC.
 */
function toUtc(date) {
    if (!date)
        return new Date();
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
const addMinutesUtc = (date, minutes) => new Date(date.getTime() + minutes * 60000);
exports.addMinutesUtc = addMinutesUtc;
/**
 * Returns the later of two UTC dates.
 */
const maxUtc = (a, b) => (a.getTime() > b.getTime() ? a : b);
exports.maxUtc = maxUtc;
/**
 * Compares two UTC dates.
 */
const isAfterUtc = (a, b) => a.getTime() > b.getTime();
exports.isAfterUtc = isAfterUtc;
const isBeforeUtc = (a, b) => a.getTime() < b.getTime();
exports.isBeforeUtc = isBeforeUtc;

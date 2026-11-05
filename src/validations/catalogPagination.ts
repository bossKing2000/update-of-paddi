/**
 * Shared catalog pagination parsing (catalog hardening B-4).
 *
 * WHY THIS EXISTS
 * ---------------
 * Five catalog routes read `page` / `limit` from the query string and each
 * used to parse them differently:
 *
 *   GET /api/product                        Math.max(parseInt(...), 1)
 *   GET /api/product/categories/:slug/...   Math.max(parseInt(...), 1)
 *   GET /api/product/p/search               Number(...) + isInteger check
 *   GET /api/product/p/most                 bare parseInt(...)  (no lower bound)
 *   GET /api/product/p/new                  bare parseInt(...)  (no lower bound)
 *
 * `parseInt("abc")` is `NaN`, and `Math.max(NaN, 1)` is still `NaN`, so a
 * malformed page/limit reached Prisma as `skip: NaN` / `take: NaN` and
 * surfaced as a 500 instead of a client error. A zero or negative limit on
 * the "most"/"new" rails reached Prisma as an invalid `take`.
 *
 * This helper is the ONE place a catalog route turns a raw query value into
 * a page/limit/skip triple:
 *
 *   - a value that is not a finite integer, is zero, or is negative is
 *     rejected with the project's standard 400 / VALIDATION_ERROR envelope;
 *   - an omitted or empty value falls back to the route's documented default;
 *   - a value ABOVE the route's maximum is CLAMPED to that maximum (the
 *     established, documented behaviour of these routes — not rejected), so
 *     an existing caller asking for a big page still gets a valid answer.
 *
 * The clamping rule is deliberately uniform across the five routes so the
 * "maximum" is a property of the route, not of the caller.
 */
import { ValidationError } from "../errors/AppError";

/** Default page for every catalog route (1-based). */
export const CATALOG_DEFAULT_PAGE = 1;

/** Default page size for the browse/search routes. */
export const CATALOG_DEFAULT_LIMIT = 20;

/** Maximum page size for the browse/search routes (limit is clamped to it). */
export const CATALOG_MAX_LIMIT = 20;

/** Default page size for the "most popular" rail. */
export const RAIL_DEFAULT_LIMIT = 50;

/** Maximum page size for the "most popular" and "new" rails. */
export const RAIL_MAX_LIMIT = 50;

/**
 * Maximum page value accepted by any catalog route.
 *
 * Rationale: `skip = (page - 1) * limit` is passed to Prisma as a JavaScript
 * number. If `skip` exceeds `Number.MAX_SAFE_INTEGER` it loses integer
 * precision, and an absurdly large offset is never a legitimate catalog
 * request. The bound is derived from the largest possible limit (the rail
 * maximum of 50) so that even `page * RAIL_MAX_LIMIT` cannot overflow the
 * safe-integer range:
 *
 *   MAX_SAFE_PAGE = floor(Number.MAX_SAFE_INTEGER / RAIL_MAX_LIMIT)
 *                 ≈ 180,143,985,094,819
 *
 * That is far beyond any real browsing depth, so the bound never affects a
 * genuine caller while making overflow impossible.
 */
export const MAX_SAFE_PAGE = Math.floor(
  Number.MAX_SAFE_INTEGER / RAIL_MAX_LIMIT,
);

export interface CatalogPagination {
  page: number;
  limit: number;
  skip: number;
}

export interface CatalogPaginationOptions {
  /** Page size used when the caller omits `limit`. */
  defaultLimit: number;
  /** Upper bound for `limit`. Values above it are clamped, not rejected. */
  maxLimit: number;
  /** Page used when the caller omits `page`. Defaults to 1. */
  defaultPage?: number;
}

/**
 * Decimal-integer-only pattern. Accepts plain digits (`"7"`, `"42"`) and
 * rejects every non-decimal numeric form that JavaScript's `Number()`
 * would otherwise coerce:
 *
 *   - hexadecimal  `"0x10"` -> `Number()` yields 16
 *   - scientific   `"1e5"`  -> `Number()` yields 100000
 *   - decimals     `"1.5"`  -> `Number()` yields 1.5 (non-integer)
 *   - signs        `"+7"`, `"-3"` -> `Number()` coerces them
 *   - non-finite   `"Infinity"`, `"NaN"`
 *
 * The contract is ordinary decimal integers, so only `^[0-9]+$` is valid.
 */
const DECIMAL_INTEGER = /^[0-9]+$/;

/**
 * Reads one query value as a positive integer.
 *
 * Returns `null` when the value is absent or blank (meaning "use the
 * default"). Throws the project's standard ValidationError (HTTP 400,
 * code VALIDATION_ERROR) for anything that is present but not a positive
 * decimal integer — including "abc", "1.5", "10abc", "0", "-1",
 * "Infinity", "NaN", "1,2", hexadecimal ("0x10"), scientific notation
 * ("1e5"), and repeated query parameters ("1,2").
 *
 * @param max - optional upper bound; values above it are rejected (used for
 *   `page` so that `(page - 1) * limit` cannot overflow the safe-integer
 *   range before reaching Prisma).
 */
function readPositiveInteger(
  raw: unknown,
  field: string,
  max?: number,
): number | null {
  if (raw === undefined || raw === null) return null;

  // A repeated query parameter arrives as an array. String() would turn it
  // into "1,2", which fails the decimal pattern below -> rejected. Good.
  const text = String(raw).trim();
  if (text === "") return null;

  // Reject every non-decimal form before Number() can coerce it.
  if (!DECIMAL_INTEGER.test(text)) {
    throw new ValidationError(`${field} must be a positive integer`);
  }

  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`${field} must not exceed ${max}`);
  }
  return value;
}

/**
 * Parses `page` / `limit` into a validated pagination triple.
 *
 * @throws {ValidationError} HTTP 400 / VALIDATION_ERROR for a malformed,
 *   zero or negative page/limit.
 */
export function parseCatalogPagination(
  raw: { page?: unknown; limit?: unknown } | null | undefined,
  options: CatalogPaginationOptions,
): CatalogPagination {
  const defaultPage = options.defaultPage ?? CATALOG_DEFAULT_PAGE;

  // `page` is bounded by MAX_SAFE_PAGE so that `(page - 1) * limit` cannot
  // overflow Number.MAX_SAFE_INTEGER even with the largest limit (50).
  const page = readPositiveInteger(raw?.page, "page", MAX_SAFE_PAGE) ??
    defaultPage;
  const requestedLimit =
    readPositiveInteger(raw?.limit, "limit") ?? options.defaultLimit;

  // Above-maximum limits are CLAMPED (the established contract of these
  // routes), not rejected. See the module header.
  const limit = Math.min(requestedLimit, options.maxLimit);

  // `skip` is bounded by construction: page <= MAX_SAFE_PAGE and
  // limit <= options.maxLimit <= RAIL_MAX_LIMIT, so
  // (page - 1) * limit <= MAX_SAFE_PAGE * RAIL_MAX_LIMIT <= MAX_SAFE_INTEGER.
  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

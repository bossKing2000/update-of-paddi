/**
 * B-4 — catalog pagination validation.
 *
 * Five catalog routes read `page` / `limit`. Before this batch each parsed
 * them differently and three of them let `NaN`, `0` or a negative value
 * reach Prisma as `skip` / `take`.
 *
 * These tests pin the ONE shared contract:
 *   - absent / blank  -> the route's documented default;
 *   - a positive integer -> used as-is;
 *   - above the maximum -> CLAMPED (never rejected);
 *   - anything else (non-numeric, non-integer, zero, negative) -> the
 *     project's standard 400 / VALIDATION_ERROR envelope.
 */
import {
  parseCatalogPagination,
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MAX_LIMIT,
  RAIL_DEFAULT_LIMIT,
  RAIL_MAX_LIMIT,
  CATALOG_DEFAULT_PAGE,
  MAX_SAFE_PAGE,
} from "../../src/validations/catalogPagination";
import { ValidationError } from "../../src/errors/AppError";

const BROWSE = { defaultLimit: CATALOG_DEFAULT_LIMIT, maxLimit: CATALOG_MAX_LIMIT };
const RAIL = { defaultLimit: RAIL_DEFAULT_LIMIT, maxLimit: RAIL_MAX_LIMIT };

describe("parseCatalogPagination — defaults", () => {
  it("uses the documented defaults when page and limit are absent", () => {
    expect(parseCatalogPagination({}, BROWSE)).toEqual({
      page: CATALOG_DEFAULT_PAGE,
      limit: CATALOG_DEFAULT_LIMIT,
      skip: 0,
    });
  });

  it("treats an empty string as absent", () => {
    expect(parseCatalogPagination({ page: "", limit: "" }, BROWSE)).toEqual({
      page: 1,
      limit: CATALOG_DEFAULT_LIMIT,
      skip: 0,
    });
  });

  it("treats a whitespace-only value as absent", () => {
    expect(parseCatalogPagination({ page: " ", limit: "  " }, BROWSE)).toEqual({
      page: 1,
      limit: CATALOG_DEFAULT_LIMIT,
      skip: 0,
    });
  });

  it("treats a null / undefined value as absent", () => {
    expect(parseCatalogPagination({ page: null, limit: undefined }, BROWSE)).toEqual({
      page: 1,
      limit: CATALOG_DEFAULT_LIMIT,
      skip: 0,
    });
  });

  it("honours the rail defaults", () => {
    expect(parseCatalogPagination({}, RAIL)).toEqual({
      page: 1,
      limit: RAIL_DEFAULT_LIMIT,
      skip: 0,
    });
  });
});

describe("parseCatalogPagination — MAX_SAFE_PAGE export", () => {
  it("derives MAX_SAFE_PAGE from MAX_SAFE_INTEGER / RAIL_MAX_LIMIT", () => {
    expect(MAX_SAFE_PAGE).toBe(
      Math.floor(Number.MAX_SAFE_INTEGER / RAIL_MAX_LIMIT),
    );
    expect(MAX_SAFE_PAGE).toBeGreaterThan(0);
  });
});

describe("parseCatalogPagination — decimal-only grammar", () => {
  it.each([
    ["0x10"],        // hexadecimal -> Number() would coerce to 16
    ["0XFF"],        // uppercase hex
    ["1e5"],         // scientific notation -> Number() would coerce to 100000
    ["1E5"],         // uppercase scientific
    ["1.5"],         // decimal fraction
    [".5"],          // leading-dot decimal
    ["+7"],          // explicit plus sign
    ["-3"],          // negative with sign
    [" InfinIty "],  // non-finite (case-insensitive)
    ["NaN"],         // non-finite
    [" 1e2 "],       // scientific with whitespace
  ])("rejects non-decimal page=%s", (page) => {
    expect(() => parseCatalogPagination({ page }, BROWSE)).toThrow(
      ValidationError,
    );
  });

  it.each([
    ["0x10"],
    ["1e5"],
    ["2.5"],
    ["+5"],
    ["-5"],
    ["Infinity"],
    ["NaN"],
  ])("rejects non-decimal limit=%s", (limit) => {
    expect(() => parseCatalogPagination({ limit }, BROWSE)).toThrow(
      ValidationError,
    );
  });

  it("rejects a decimal fraction even though it is finite", () => {
    expect(() => parseCatalogPagination({ page: "1.5" }, BROWSE)).toThrow(
      ValidationError,
    );
  });

  it("rejects a decimal fraction limit", () => {
    expect(() => parseCatalogPagination({ limit: "1.5" }, BROWSE)).toThrow(
      ValidationError,
    );
  });
});

describe("parseCatalogPagination — overflow and unsafe bounds", () => {
  it("rejects page beyond MAX_SAFE_PAGE (prevents skip overflow)", () => {
    expect(() =>
      parseCatalogPagination(
        { page: String(MAX_SAFE_PAGE + 1) },
        BROWSE,
      ),
    ).toThrow(ValidationError);
  });

  it("rejects page at Number.MAX_SAFE_INTEGER", () => {
    expect(() =>
      parseCatalogPagination({ page: String(Number.MAX_SAFE_INTEGER) }, BROWSE),
    ).toThrow(ValidationError);
  });

  it("rejects page beyond Number.MAX_SAFE_INTEGER as a string", () => {
    expect(() =>
      parseCatalogPagination(
        { page: "999999999999999999999" },
        BROWSE,
      ),
    ).toThrow(ValidationError);
  });

  it("accepts MAX_SAFE_PAGE itself (at the safe boundary)", () => {
    const parsed = parseCatalogPagination(
      { page: String(MAX_SAFE_PAGE) },
      BROWSE,
    );
    expect(parsed.page).toBe(MAX_SAFE_PAGE);
    expect(Number.isFinite(parsed.skip)).toBe(true);
  });

  it("never lets skip exceed Number.MAX_SAFE_INTEGER", () => {
    const parsed = parseCatalogPagination(
      { page: String(MAX_SAFE_PAGE), limit: String(RAIL_MAX_LIMIT) },
      RAIL,
    );
    expect(parsed.skip).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(parsed.skip)).toBe(true);
  });
});

describe("parseCatalogPagination — zero and negative values", () => {
  it.each(["0", "-1", "-5", "-100"])("rejects page=%s", (page) => {
    expect(() => parseCatalogPagination({ page }, BROWSE)).toThrow(
      ValidationError,
    );
  });

  it.each(["0", "-1", "-5"])("rejects limit=%s", (limit) => {
    expect(() => parseCatalogPagination({ limit }, BROWSE)).toThrow(
      ValidationError,
    );
  });
});

describe("parseCatalogPagination — valid values", () => {
  it("computes skip from page and limit", () => {
    expect(parseCatalogPagination({ page: "3", limit: "10" }, BROWSE)).toEqual({
      page: 3,
      limit: 10,
      skip: 20,
    });
  });

  it("accepts numeric (not string) query values", () => {
    expect(parseCatalogPagination({ page: 2, limit: 5 }, BROWSE)).toEqual({
      page: 2,
      limit: 5,
      skip: 5,
    });
  });

  it("accepts the boundary values page=1 and limit=1", () => {
    expect(parseCatalogPagination({ page: "1", limit: "1" }, BROWSE)).toEqual({
      page: 1,
      limit: 1,
      skip: 0,
    });
  });
});

describe("parseCatalogPagination — clamping above the maximum", () => {
  it("clamps a browse limit above 20 to 20 (documented, not rejected)", () => {
    expect(parseCatalogPagination({ limit: "500" }, BROWSE)).toEqual({
      page: 1,
      limit: 20,
      skip: 0,
    });
  });

  it("clamps a rail limit above 50 to 50", () => {
    expect(parseCatalogPagination({ limit: "999" }, RAIL)).toEqual({
      page: 1,
      limit: 50,
      skip: 0,
    });
  });

  it("clamps to exactly the maximum", () => {
    expect(parseCatalogPagination({ limit: "20" }, BROWSE).limit).toBe(20);
    expect(parseCatalogPagination({ limit: "50" }, RAIL).limit).toBe(50);
  });
});

describe("parseCatalogPagination — invalid values", () => {
  it.each([
    ["abc"],
    ["1.5"],
    ["10abc"],
    ["0"],
    ["-1"],
    ["-5"],
    ["Infinity"],
    ["NaN"],
    ["1,2"],
  ])("rejects page=%s", (page) => {
    expect(() => parseCatalogPagination({ page }, BROWSE)).toThrow(ValidationError);
  });

  it.each([
    ["abc"],
    ["2.5"],
    ["0"],
    ["-5"],
    ["Infinity"],
    ["NaN"],
    ["1,2"],
  ])("rejects limit=%s", (limit) => {
    expect(() => parseCatalogPagination({ limit }, BROWSE)).toThrow(ValidationError);
  });

  it("rejects a repeated query parameter", () => {
    expect(() =>
      parseCatalogPagination({ page: ["1", "2"] as unknown as string }, BROWSE),
    ).toThrow(ValidationError);
  });

  it("reports the standard 400 / VALIDATION_ERROR shape", () => {
    try {
      parseCatalogPagination({ page: "abc" }, BROWSE);
      throw new Error("expected a ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const validation = err as ValidationError;
      expect(validation.statusCode).toBe(400);
      expect(validation.code).toBe("VALIDATION_ERROR");
      expect(validation.message).toMatch(/page must be a positive integer/i);
    }
  });

  it("names the offending field", () => {
    expect(() => parseCatalogPagination({ limit: "0" }, BROWSE)).toThrow(
      /limit must be a positive integer/i,
    );
  });

  it("never produces NaN for any accepted input", () => {
    for (const page of ["1", "2", "100", 1, 7]) {
      for (const limit of ["1", "20", "50", 3]) {
        const parsed = parseCatalogPagination({ page, limit }, BROWSE);
        expect(Number.isFinite(parsed.page)).toBe(true);
        expect(Number.isFinite(parsed.limit)).toBe(true);
        expect(Number.isFinite(parsed.skip)).toBe(true);
        expect(parsed.skip).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

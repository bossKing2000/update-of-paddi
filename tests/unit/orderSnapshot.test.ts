import {
  DEFAULT_COMMISSION_RATE,
  buildOrderMoneySnapshot,
  resolveCommissionRate,
} from "../../src/services/orderSnapshot.service";
import { ValidationError } from "../../src/errors/AppError";

describe("orderSnapshot.service — buildOrderMoneySnapshot (integer kobo)", () => {
  it("computes normal positive values (base 500000 kobo, discount 50000 kobo, rate 0.15)", () => {
    const s = buildOrderMoneySnapshot({
      basePriceKobo: 500000,
      discountKobo: 50000,
      commissionRate: 0.15,
    });
    // commissionKobo = round(500000 * 0.15) = 75000 kobo
    expect(s.commissionRateSnapshot).toBe(0.15);
    expect(s.commissionKobo).toBe(75000n);
    expect(s.discountKobo).toBe(50000n);
    expect(s.vendorPayoutKobo).toBe(500000n - 75000n);
  });

  it("handles zero discount", () => {
    const s = buildOrderMoneySnapshot({
      basePriceKobo: 250000,
      discountKobo: 0,
      commissionRate: 0.15,
    });
    expect(s.discountKobo).toBe(0n);
    expect(s.commissionKobo).toBe(37500n);
    expect(s.vendorPayoutKobo).toBe(250000n - 37500n);
  });

  it("handles zero commission rate (payout equals gross)", () => {
    const s = buildOrderMoneySnapshot({
      basePriceKobo: 100000,
      discountKobo: 0,
      commissionRate: 0,
    });
    expect(s.commissionKobo).toBe(0n);
    expect(s.vendorPayoutKobo).toBe(100000n);
  });

  it("rounds commission to nearest kobo (199999 kobo * 0.15 = 29999.85 -> 30000)", () => {
    const s = buildOrderMoneySnapshot({
      basePriceKobo: 199999,
      discountKobo: 0,
      commissionRate: 0.15,
    });
    expect(s.commissionKobo).toBe(30000n);
  });

  it("computes vendor payout in the integer domain (exact)", () => {
    const s = buildOrderMoneySnapshot({
      basePriceKobo: 123456,
      discountKobo: 10000,
      commissionRate: 0.13,
    });
    expect(s.vendorPayoutKobo).toBe(BigInt(123456) - s.commissionKobo);
  });

  it("snapshots the exact rate used for the commission", () => {
    const s = buildOrderMoneySnapshot({
      basePriceKobo: 200000,
      discountKobo: 0,
      commissionRate: 0.175,
    });
    expect(s.commissionRateSnapshot).toBe(0.175);
  });

  it.each(["basePriceKobo", "discountKobo", "commissionRate"] as const)(
    "rejects NaN %s loudly",
    (field) => {
      expect(() =>
        buildOrderMoneySnapshot({
          basePriceKobo: 10000,
          discountKobo: 0,
          commissionRate: 0.15,
          [field]: NaN,
        }),
      ).toThrow(ValidationError);
    },
  );

  it.each(["basePriceKobo", "discountKobo", "commissionRate"] as const)(
    "rejects Infinity %s loudly",
    (field) => {
      expect(() =>
        buildOrderMoneySnapshot({
          basePriceKobo: 10000,
          discountKobo: 0,
          commissionRate: 0.15,
          [field]: Infinity,
        }),
      ).toThrow(ValidationError);
    },
  );
});

describe("orderSnapshot.service — resolveCommissionRate", () => {
  it("applies the existing 0.15 fallback for missing rates", () => {
    expect(resolveCommissionRate(undefined)).toBe(DEFAULT_COMMISSION_RATE);
    expect(resolveCommissionRate(null)).toBe(DEFAULT_COMMISSION_RATE);
    expect(DEFAULT_COMMISSION_RATE).toBe(0.15);
  });

  it("passes through explicit rates untouched (including 0)", () => {
    expect(resolveCommissionRate(0.2)).toBe(0.2);
    expect(resolveCommissionRate(0)).toBe(0);
  });

  it("rejects non-finite rates", () => {
    expect(() => resolveCommissionRate(NaN)).toThrow(ValidationError);
    expect(() => resolveCommissionRate(Infinity)).toThrow(ValidationError);
  });
});

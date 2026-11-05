import { bigIntToNumber, sendSuccess, toJsonSafe } from "../../src/utils/apiResponse";

describe("apiResponse BigInt boundary safety (Phase 3.2b kobo snapshots)", () => {
  it("converts bigints to Numbers, including nested", () => {
    expect(
      toJsonSafe({
        commissionKobo: 75000n,
        nested: { vendorPayoutKobo: 425000n },
        list: [1n, 2n],
      }),
    ).toEqual({
      commissionKobo: 75000,
      nested: { vendorPayoutKobo: 425000 },
      list: [1, 2],
    });
  });

  it("leaves non-bigint payloads byte-identical (nulls included)", () => {
    const payload = {
      commissionKobo: null,
      name: "Jollof",
      price: 2500.5,
      active: true,
      when: "2026-01-01T00:00:00.000Z",
    };
    expect(toJsonSafe(payload)).toEqual(payload);
    expect(JSON.stringify(toJsonSafe(payload))).toBe(JSON.stringify(payload));
  });

  it("sendSuccess serializes a BigInt-bearing payload without throwing", () => {
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json } as never;
    expect(() =>
      sendSuccess(res as never, { commissionKobo: 75000n } as never, "ok"),
    ).not.toThrow();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { commissionKobo: 75000 } }),
    );
  });

  it("bigIntToNumber passes everything else through untouched", () => {
    expect(bigIntToNumber("k", 5)).toBe(5);
    expect(bigIntToNumber("k", "x")).toBe("x");
    expect(bigIntToNumber("k", null)).toBe(null);
    expect(bigIntToNumber("k", 7n)).toBe(7);
  });
});

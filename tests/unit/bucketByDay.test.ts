import { bucketByDay } from "../../src/controllers/orderController";

describe("bucketByDay", () => {
  it("groups multiple orders on the same calendar day into one bucket", () => {
    const days = ["2026-01-01", "2026-01-02"];
    const rows = [
      { createdAt: new Date("2026-01-01T08:00:00Z"), totalPrice: 1000 },
      { createdAt: new Date("2026-01-01T20:59:59Z"), totalPrice: 500 },
      { createdAt: new Date("2026-01-02T03:00:00Z"), totalPrice: 250 },
    ];

    const result = bucketByDay(rows, days);

    expect(result).toEqual([
      { date: "2026-01-01", count: 2, revenue: 1500 },
      { date: "2026-01-02", count: 1, revenue: 250 },
    ]);
  });

  it("returns zeroed buckets for days with no orders", () => {
    const days = ["2026-01-01", "2026-01-02", "2026-01-03"];
    const result = bucketByDay([], days);

    expect(result).toEqual([
      { date: "2026-01-01", count: 0, revenue: 0 },
      { date: "2026-01-02", count: 0, revenue: 0 },
      { date: "2026-01-03", count: 0, revenue: 0 },
    ]);
  });

  it("ignores rows that fall outside the given day range", () => {
    const days = ["2026-01-01"];
    const rows = [
      { createdAt: new Date("2026-01-01T12:00:00Z"), totalPrice: 100 },
      { createdAt: new Date("2025-12-31T12:00:00Z"), totalPrice: 999 }, // out of range
    ];

    const result = bucketByDay(rows, days);
    expect(result).toEqual([{ date: "2026-01-01", count: 1, revenue: 100 }]);
  });

  it("defaults revenue to 0 when totalPrice is not provided", () => {
    const days = ["2026-01-01"];
    const rows = [{ createdAt: new Date("2026-01-01T12:00:00Z") }];

    const result = bucketByDay(rows, days);
    expect(result[0].revenue).toBe(0);
    expect(result[0].count).toBe(1);
  });
});

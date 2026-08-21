import { getRatingLabel, ratingBreakdown } from "../../src/controllers/reviewController";

describe("getRatingLabel", () => {
  it.each([
    [5, "Excellent"],
    [4.5, "Excellent"],
    [4, "Very Good"],
    [3.5, "Good"],
    [3, "Good"],
    [2, "Fair"],
    [1, "Poor"],
  ])("labels %f as %s", (rating, label) => {
    expect(getRatingLabel(rating)).toBe(label);
  });
});

describe("ratingBreakdown", () => {
  it("fills in zero counts for stars with no reviews", () => {
    const result = ratingBreakdown([{ rating: 5, _count: { rating: 3 } }]);
    expect(result).toEqual([
      { stars: 5, count: 3, label: "Excellent" },
      { stars: 4, count: 0, label: "Very Good" },
      { stars: 3, count: 0, label: "Good" },
      { stars: 2, count: 0, label: "Fair" },
      { stars: 1, count: 0, label: "Poor" },
    ]);
  });

  it("always returns exactly 5 buckets in descending star order", () => {
    const result = ratingBreakdown([]);
    expect(result.map((r) => r.stars)).toEqual([5, 4, 3, 2, 1]);
  });
});

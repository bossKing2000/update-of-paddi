import { computeIsLive } from "../../src/controllers/productController";

describe("computeIsLive", () => {
  it("returns the default when there is no schedule at all", () => {
    expect(computeIsLive(null, true)).toBe(true);
    expect(computeIsLive(undefined, false)).toBe(false);
  });

  it("returns the default when the schedule is missing goLiveAt or takeDownAt", () => {
    expect(computeIsLive({ goLiveAt: null, takeDownAt: new Date() }, true)).toBe(true);
    expect(computeIsLive({ goLiveAt: new Date(), takeDownAt: null }, false)).toBe(false);
  });

  it("is live when now is between goLiveAt and takeDownAt", () => {
    const goLiveAt = new Date(Date.now() - 60_000);
    const takeDownAt = new Date(Date.now() + 60_000);
    expect(computeIsLive({ goLiveAt, takeDownAt }, false)).toBe(true);
  });

  it("is not live before goLiveAt", () => {
    const goLiveAt = new Date(Date.now() + 60_000);
    const takeDownAt = new Date(Date.now() + 120_000);
    expect(computeIsLive({ goLiveAt, takeDownAt }, true)).toBe(false);
  });

  it("is not live after takeDownAt with no grace period", () => {
    const goLiveAt = new Date(Date.now() - 120_000);
    const takeDownAt = new Date(Date.now() - 60_000);
    expect(computeIsLive({ goLiveAt, takeDownAt, graceMinutes: 0 }, true)).toBe(false);
  });

  it("is still live within the grace period after takeDownAt", () => {
    const goLiveAt = new Date(Date.now() - 120_000);
    const takeDownAt = new Date(Date.now() - 60_000); // took down 1 minute ago
    expect(computeIsLive({ goLiveAt, takeDownAt, graceMinutes: 5 }, false)).toBe(true); // 5 min grace covers it
  });

  it("is not live once the grace period itself has also elapsed", () => {
    const goLiveAt = new Date(Date.now() - 600_000);
    const takeDownAt = new Date(Date.now() - 500_000); // took down ~8 minutes ago
    expect(computeIsLive({ goLiveAt, takeDownAt, graceMinutes: 5 }, true)).toBe(false); // 5 min grace already passed
  });
});

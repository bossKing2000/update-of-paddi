import {
  isVendorAcceptingOrders,
  isVendorOperating,
  isProductCurrentlyAvailable,
  isProductMarketplaceAvailable,
} from "../../src/services/vendorAvailability.service";

const minutesFrom = (base: Date, n: number) => new Date(base.getTime() + n * 60_000);

describe("vendor operating state", () => {
  it("is operating when live and not explicitly paused", () => {
    expect(isVendorOperating({ isLive: true })).toBe(true);
    expect(isVendorOperating({ isLive: true, deliveryPreferences: { acceptingOrders: true } })).toBe(true);
    expect(isVendorOperating({ isLive: true, deliveryPreferences: null })).toBe(true);
  });

  it("is NOT operating when the flag is false or orders are paused", () => {
    expect(isVendorOperating({ isLive: false })).toBe(false);
    expect(isVendorOperating({ isLive: true, deliveryPreferences: { acceptingOrders: false } })).toBe(false);
    // default when JSON absent = accepting (matches computeVendorIsOpen)
    expect(isVendorAcceptingOrders(undefined)).toBe(true);
  });
});

describe("product availability (schedule window)", () => {
  const now = new Date();

  const during = {
    archived: false,
    isLive: false, // stored mirror stale — window is the source of truth
    productSchedule: { goLiveAt: minutesFrom(now, -30), takeDownAt: minutesFrom(now, 30), graceMinutes: 0 },
  };
  const before = {
    archived: false,
    isLive: true,
    productSchedule: { goLiveAt: minutesFrom(now, 30), takeDownAt: minutesFrom(now, 90), graceMinutes: 0 },
  };
  const afterNoGrace = {
    archived: false,
    isLive: true,
    productSchedule: { goLiveAt: minutesFrom(now, -120), takeDownAt: minutesFrom(now, -60), graceMinutes: 0 },
  };

  it("is available during the active window even with a stale stored flag", () => {
    expect(isProductCurrentlyAvailable(during, now)).toBe(true);
  });

  it("is NOT available before goLiveAt", () => {
    expect(isProductCurrentlyAvailable(before, now)).toBe(false);
  });

  it("is NOT available after takeDownAt without grace", () => {
    expect(isProductCurrentlyAvailable(afterNoGrace, now)).toBe(false);
  });

  it("honors the grace period past takeDownAt", () => {
    const withGrace = {
      archived: false,
      isLive: false,
      productSchedule: { goLiveAt: minutesFrom(now, -120), takeDownAt: minutesFrom(now, -60), graceMinutes: 90 },
    };
    expect(isProductCurrentlyAvailable(withGrace, now)).toBe(true);
  });

  it("falls back to the stored mirror when there is no usable schedule", () => {
    expect(isProductCurrentlyAvailable({ archived: false, isLive: true }, now)).toBe(true);
    expect(isProductCurrentlyAvailable({ archived: false, isLive: false }, now)).toBe(false);
    expect(
      isProductCurrentlyAvailable(
        { archived: false, isLive: true, productSchedule: { goLiveAt: null, takeDownAt: null } },
        now,
      ),
    ).toBe(true);
  });

  it("archived products are never available", () => {
    expect(isProductCurrentlyAvailable({ ...during, archived: true }, now)).toBe(false);
  });
});

describe("marketplace availability (vendor AND product)", () => {
  const now = new Date();
  const liveVendor = { id: "v1", isLive: true, deliveryPreferences: { acceptingOrders: true } };
  const offlineVendor = { id: "v1", isLive: false, deliveryPreferences: {} as unknown };
  const pausedVendor = { id: "v1", isLive: true, deliveryPreferences: { acceptingOrders: false } };
  const availableProduct = {
    archived: false,
    isLive: false,
    productSchedule: { goLiveAt: minutesFrom(now, -10), takeDownAt: minutesFrom(now, 60), graceMinutes: 0 },
  };

  it("available when vendor online + product in window + not archived", () => {
    expect(isProductMarketplaceAvailable(availableProduct, liveVendor, now)).toBe(true);
  });

  it("NOT available when vendor went offline — even for a previously-live product", () => {
    expect(isProductMarketplaceAvailable(availableProduct, offlineVendor, now)).toBe(false);
  });

  it("NOT available when vendor paused orders", () => {
    expect(isProductMarketplaceAvailable(availableProduct, pausedVendor, now)).toBe(false);
  });

  it("NOT available when the product is archived even if the vendor is live", () => {
    expect(isProductMarketplaceAvailable({ ...availableProduct, archived: true }, liveVendor, now)).toBe(false);
  });

  it("NOT available outside the schedule window even if the vendor is live", () => {
    expect(
      isProductMarketplaceAvailable(
        { ...availableProduct, productSchedule: { ...availableProduct.productSchedule!, goLiveAt: minutesFrom(now, 30) } },
        liveVendor,
        now,
      ),
    ).toBe(false);
  });
});

describe("Vendor Live × weekly schedule separation", () => {
  // Fixed Wednesday noon UTC so dayOfWeek/window assertions are deterministic
  const now = new Date("2026-08-26T12:00:00Z");
  // Wednesday 10:00–20:00 UTC; `now` is Wed 12:00 UTC → window ACTIVE
  const weeklyProduct = {
    archived: false,
    isLive: false, // mirror irrelevant for WEEKLY — windows are authoritative
    productSchedule: {
      type: "WEEKLY",
      enabled: true,
      startDate: null,
      endDate: null,
      windows: [{ dayOfWeek: 3, startMinute: 600, endMinute: 1200 }],
    },
  };
  const online = { id: "v1", isLive: true, deliveryPreferences: { acceptingOrders: true } };
  const offline = { id: "v1", isLive: false, deliveryPreferences: {} as unknown };

  it("vendor offline during an active schedule → unavailable", () => {
    expect(isProductMarketplaceAvailable(weeklyProduct, offline, now)).toBe(false);
  });

  it("vendor comes back online during the same active schedule → available again (no schedule mutation)", () => {
    expect(weeklyProduct.productSchedule.windows).toHaveLength(1); // untouched
    expect(isProductMarketplaceAvailable(weeklyProduct, online, now)).toBe(true);
  });

  it("schedule inactive (outside window) + vendor online → unavailable", () => {
    const later = new Date(now.getTime() + 9 * 60 * 60_000); // Wed 21:00 UTC
    expect(isProductMarketplaceAvailable(weeklyProduct, online, later)).toBe(false);
  });

  it("weekly evaluation happens in the vendor timezone passed through", () => {
    const lagosVendor = { ...online, timezone: "Africa/Lagos" };
    // Window Wed 10:00–20:00 evaluated in LAGOS time. At 09:30 UTC it's
    // 10:30 in Lagos → active; in UTC it would be inactive.
    expect(
      isProductMarketplaceAvailable(
        {
          ...weeklyProduct,
          productSchedule: { ...weeklyProduct.productSchedule, windows: [{ dayOfWeek: 3, startMinute: 600, endMinute: 1200 }] },
        },
        lagosVendor,
        new Date("2026-08-26T09:30:00Z"),
      ),
    ).toBe(true);
    expect(
      isProductMarketplaceAvailable(weeklyProduct, { ...online }, new Date("2026-08-26T09:30:00Z")),
    ).toBe(false);
  });
});

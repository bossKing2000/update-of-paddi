import {
  isVendorAcceptingOrders,
  isVendorOperating,
  isProductCurrentlyAvailable,
  isProductMarketplaceAvailable,
} from "../../src/services/vendorAvailability.service";

describe("vendor operating state (Stage 1: no scheduling)", () => {
  it("is operating when live and not explicitly paused", () => {
    expect(isVendorOperating({ isLive: true })).toBe(true);
    expect(isVendorOperating({ isLive: true, deliveryPreferences: { acceptingOrders: true } })).toBe(true);
    expect(isVendorOperating({ isLive: true, deliveryPreferences: null })).toBe(true);
  });

  it("is NOT operating when the flag is false or orders are paused", () => {
    expect(isVendorOperating({ isLive: false })).toBe(false);
    expect(isVendorOperating({ isLive: true, deliveryPreferences: { acceptingOrders: false } })).toBe(false);
    // default when JSON absent = accepting
    expect(isVendorAcceptingOrders(undefined)).toBe(true);
  });
});

describe("product availability (Stage 1: archived check only)", () => {
  it("is available when not archived", () => {
    expect(isProductCurrentlyAvailable({ archived: false })).toBe(true);
  });

  it("is NOT available when archived", () => {
    expect(isProductCurrentlyAvailable({ archived: true })).toBe(false);
  });
});

describe("marketplace availability (vendor AND product)", () => {
  const liveVendor = { id: "v1", isLive: true, deliveryPreferences: { acceptingOrders: true } };
  const offlineVendor = { id: "v1", isLive: false, deliveryPreferences: {} as unknown };
  const pausedVendor = { id: "v1", isLive: true, deliveryPreferences: { acceptingOrders: false } };
  const availableProduct = { archived: false };

  it("available when vendor online + product not archived", () => {
    expect(isProductMarketplaceAvailable(availableProduct, liveVendor)).toBe(true);
  });

  it("NOT available when vendor went offline", () => {
    expect(isProductMarketplaceAvailable(availableProduct, offlineVendor)).toBe(false);
  });

  it("NOT available when vendor paused orders", () => {
    expect(isProductMarketplaceAvailable(availableProduct, pausedVendor)).toBe(false);
  });

  it("NOT available when the product is archived even if the vendor is live", () => {
    expect(isProductMarketplaceAvailable({ archived: true }, liveVendor)).toBe(false);
  });
});

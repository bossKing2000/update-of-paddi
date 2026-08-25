import { cartSummaryService } from "../../src/services/cartSummary.service";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    cart: { findFirst: jest.fn() },
  },
}));

jest.mock("../../src/services/deliveryFee.service", () => ({
  calculateDeliveryFee: jest.fn(),
}));

import prisma from "../../src/lib/prisma";
import { calculateDeliveryFee } from "../../src/services/deliveryFee.service";

const mockedFindFirst = (prisma as any).cart.findFirst as jest.Mock;
const mockedDeliveryFee = calculateDeliveryFee as jest.Mock;

function makeCartItem(overrides: any = {}) {
  return {
    id: "item-1",
    productId: "prod-1",
    quantity: 2,
    unitPrice: 1000,
    ...overrides,
    product: {
      id: "prod-1",
      name: "Jollof Rice",
      images: ["img.png"],
      archived: false,
      isLive: true,
      vendorId: "vendor-1",
      // Vendor Live migration: fixtures default to an operating vendor so
      // the marketplace-availability gate passes unless a test opts out.
      vendor: { name: "Mama Put", isLive: true, deliveryPreferences: { acceptingOrders: true } },
      productSchedule: null,
      ...(overrides.product || {}),
    },
  };
}

describe("cartSummaryService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns an empty summary when there is no cart", async () => {
    mockedFindFirst.mockResolvedValue(null);
    const result = await cartSummaryService({ userId: "user-1" });
    expect(result.vendorBreakdown).toEqual([]);
    expect(result.finalTotal).toBe(0);
  });

  it("excludes offline (not isLive) items and reports the count", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({ id: "a" }),
        makeCartItem({ id: "b", product: { isLive: false } }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });
    expect(result.excludedOfflineItemCount).toBe(1);
    expect(result.vendorBreakdown[0].items).toHaveLength(1);
  });

  it("Vendor Live: excludes items whose vendor went offline or paused orders, keeping the item count honest", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({ id: "a" }),
        makeCartItem({ id: "b", product: { vendorId: "vendor-2", vendor: { name: "Closed Kitchen", isLive: false } } }),
        makeCartItem({ id: "c", product: { vendorId: "vendor-3", vendor: { name: "Paused Kitchen", deliveryPreferences: { acceptingOrders: false } } } }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });
    expect(result.excludedOfflineItemCount).toBe(2);
    expect(result.vendorBreakdown).toHaveLength(1);
    expect(result.vendorBreakdown[0].items).toHaveLength(1);
  });

  it("groups items by vendor and sums subtotals correctly", async () => {
    mockedFindFirst.mockResolvedValue({
      items: [
        makeCartItem({ id: "a", quantity: 2, unitPrice: 1000 }), // vendor-1, 2000
        makeCartItem({
          id: "b",
          quantity: 1,
          unitPrice: 500,
          product: { vendorId: "vendor-2", vendor: { name: "Suya Spot", isLive: true, deliveryPreferences: { acceptingOrders: true } } },
        }),
      ],
    });

    const result = await cartSummaryService({ userId: "user-1" });
    expect(result.vendorBreakdown).toHaveLength(2);
    expect(result.subtotal).toBe(2500);

    const vendor1 = result.vendorBreakdown.find((v) => v.vendorId === "vendor-1")!;
    expect(vendor1.subtotal).toBe(2000);
  });

  it("computes delivery fee per vendor only when addressId is provided", async () => {
    mockedFindFirst.mockResolvedValue({ items: [makeCartItem()] });
    mockedDeliveryFee.mockResolvedValue({ fee: 450, distanceKm: 3.2, withinRange: true, freeDelivery: false });

    const result = await cartSummaryService({ userId: "user-1", addressId: "addr-1" });
    expect(mockedDeliveryFee).toHaveBeenCalledWith("vendor-1", "addr-1", 2000);
    expect(result.deliveryFee).toBe(450);
    expect(result.finalTotal).toBe(2450);
  });

  it("skips delivery fee calculation entirely when no addressId is given", async () => {
    mockedFindFirst.mockResolvedValue({ items: [makeCartItem()] });

    const result = await cartSummaryService({ userId: "user-1" });
    expect(mockedDeliveryFee).not.toHaveBeenCalled();
    expect(result.deliveryFee).toBe(0);
  });

  it("surfaces a warning when a vendor is out of delivery range", async () => {
    mockedFindFirst.mockResolvedValue({ items: [makeCartItem()] });
    mockedDeliveryFee.mockResolvedValue({ fee: 3000, distanceKm: 45, withinRange: false, freeDelivery: false });

    const result = await cartSummaryService({ userId: "user-1", addressId: "addr-1" });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Mama Put");
  });
});

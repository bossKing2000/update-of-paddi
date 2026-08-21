import {
  deliveryPreferencesSchema,
  operatingHoursSchema,
  serviceAreasSchema,
} from "../../src/validations/vendorSettingsSchema";

const hours = {
  timezone: "Africa/Lagos",
  monday: { enabled: true, open: "10:00", close: "22:00" },
  tuesday: { enabled: true, open: "10:00", close: "22:00" },
  wednesday: { enabled: true, open: "10:00", close: "22:00" },
  thursday: { enabled: true, open: "10:00", close: "22:00" },
  friday: { enabled: true, open: "10:00", close: "22:00" },
  saturday: { enabled: true, open: "10:00", close: "22:00" },
  sunday: { enabled: false, open: null, close: null },
};

describe("vendor settings validation", () => {
  it("accepts a complete weekly schedule", () => {
    expect(operatingHoursSchema.safeParse(hours).success).toBe(true);
  });

  it("rejects invalid 24-hour time values", () => {
    expect(operatingHoursSchema.safeParse({ ...hours, monday: { enabled: true, open: "25:00", close: "22:00" } }).success).toBe(false);
  });

  it("accepts bounded delivery preferences", () => {
    expect(deliveryPreferencesSchema.safeParse({ acceptingOrders: true, deliveryEnabled: true, deliveryRadiusKm: 20, baseDeliveryFee: 300, preparationTimeMinutes: 30 }).success).toBe(true);
  });

  it("rejects an excessive delivery radius", () => {
    expect(deliveryPreferencesSchema.safeParse({ acceptingOrders: true, deliveryEnabled: true, deliveryRadiusKm: 101 }).success).toBe(false);
  });

  it("accepts service areas with stable ids", () => {
    expect(serviceAreasSchema.safeParse({ areas: [{ id: "lekki-1", label: "Lekki Phase 1", city: "Lagos", state: "Lagos", radiusKm: 20, enabled: true }] }).success).toBe(true);
  });

  it("rejects incomplete service areas", () => {
    expect(serviceAreasSchema.safeParse({ areas: [{ id: "lekki-1", label: "Lekki" }] }).success).toBe(false);
  });
});

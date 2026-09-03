import {
  deliveryPreferencesSchema,
  serviceAreasSchema,
} from "../../src/validations/vendorSettingsSchema";

describe("vendor settings validation (Stage 1: no operating hours)", () => {
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

import { isValidDeliveryTransition } from "../../src/services/deliveryAssignment";
import { DeliveryStatus } from "@prisma/client";

describe("isValidDeliveryTransition", () => {
  it("allows the normal happy path: ACCEPTED -> PICKED_UP -> EN_ROUTE -> DELIVERED", () => {
    expect(isValidDeliveryTransition(DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP)).toBe(true);
    expect(isValidDeliveryTransition(DeliveryStatus.PICKED_UP, DeliveryStatus.EN_ROUTE)).toBe(true);
    expect(isValidDeliveryTransition(DeliveryStatus.EN_ROUTE, DeliveryStatus.DELIVERED)).toBe(true);
  });

  it("allows DELIVERED directly from PICKED_UP (EN_ROUTE is not mandatory)", () => {
    expect(isValidDeliveryTransition(DeliveryStatus.PICKED_UP, DeliveryStatus.DELIVERED)).toBe(true);
  });

  it("rejects skipping straight from ASSIGNED to DELIVERED", () => {
    expect(isValidDeliveryTransition(DeliveryStatus.ASSIGNED, DeliveryStatus.DELIVERED)).toBe(false);
  });

  it("rejects skipping straight from ASSIGNED to PICKED_UP (must be ACCEPTED first)", () => {
    expect(isValidDeliveryTransition(DeliveryStatus.ASSIGNED, DeliveryStatus.PICKED_UP)).toBe(false);
  });

  it("allows CANCELLED from any active state", () => {
    expect(isValidDeliveryTransition(DeliveryStatus.ASSIGNED, DeliveryStatus.CANCELLED)).toBe(true);
    expect(isValidDeliveryTransition(DeliveryStatus.ACCEPTED, DeliveryStatus.CANCELLED)).toBe(true);
    expect(isValidDeliveryTransition(DeliveryStatus.PICKED_UP, DeliveryStatus.CANCELLED)).toBe(true);
    expect(isValidDeliveryTransition(DeliveryStatus.EN_ROUTE, DeliveryStatus.CANCELLED)).toBe(true);
  });

  it("rejects CANCELLED once already DELIVERED", () => {
    expect(isValidDeliveryTransition(DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED)).toBe(false);
  });

  it("rejects RETURNED unless coming from FAILED", () => {
    expect(isValidDeliveryTransition(DeliveryStatus.FAILED, DeliveryStatus.RETURNED)).toBe(true);
    expect(isValidDeliveryTransition(DeliveryStatus.EN_ROUTE, DeliveryStatus.RETURNED)).toBe(false);
  });

  it("rejects transitions into ASSIGNED/ACCEPTED/DECLINED — those go through their own dedicated methods", () => {
    expect(isValidDeliveryTransition(DeliveryStatus.ACCEPTED, DeliveryStatus.ASSIGNED)).toBe(false);
    expect(isValidDeliveryTransition(DeliveryStatus.ASSIGNED, DeliveryStatus.ACCEPTED)).toBe(false);
  });
});

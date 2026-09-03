import { z } from "zod";

export const deliveryPreferencesSchema = z.object({
  acceptingOrders: z.boolean(),
  deliveryEnabled: z.boolean(),
  deliveryRadiusKm: z.number().positive().max(100).nullable().optional(),
  baseDeliveryFee: z.number().nonnegative().max(100000).nullable().optional(),
  preparationTimeMinutes: z.number().int().positive().max(240).nullable().optional(),
});

export const serviceAreaSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(2).max(100),
  city: z.string().min(2).max(100),
  state: z.string().min(2).max(100),
  radiusKm: z.number().positive().max(100).nullable().optional(),
  enabled: z.boolean().default(true),
});

export const serviceAreasSchema = z.object({
  areas: z.array(serviceAreaSchema).max(50),
});

export const vendorSettingsSchema = z.object({
  deliveryPreferences: deliveryPreferencesSchema,
  serviceAreas: serviceAreasSchema,
});

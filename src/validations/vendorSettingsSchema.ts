import { z } from "zod";

const dayHoursSchema = z.object({
  enabled: z.boolean(),
  open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
});

export const operatingHoursSchema = z.object({
  timezone: z.string().min(1).default("Africa/Lagos"),
  monday: dayHoursSchema,
  tuesday: dayHoursSchema,
  wednesday: dayHoursSchema,
  thursday: dayHoursSchema,
  friday: dayHoursSchema,
  saturday: dayHoursSchema,
  sunday: dayHoursSchema,
});

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
  operatingHours: operatingHoursSchema,
  deliveryPreferences: deliveryPreferencesSchema,
  serviceAreas: serviceAreasSchema,
});

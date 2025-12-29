// src/services/vendorAvailabilityService.ts
import prisma from '../config/prismaClient';

export const suggestAvailability = async (vendorId: string) => {
  // Example: analyze past orders to suggest Go-Live time
  const orders = await prisma.order.findMany({ where: { vendorId } });

  // Placeholder logic: suggest next 2 hours
  const now = new Date();
  const startTime = now;
  const endTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  return { startTime, endTime };
};

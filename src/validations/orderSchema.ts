// src/validations/order.schema.ts
import { z } from "zod";
import { OrderStatus } from "@prisma/client";

export const orderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().min(1),
  options: z.array(
    z.object({
      optionId: z.string()
    })
  ).optional()
});

export const createOrderSchema = z.object({
  items: z.array(orderItemSchema).min(1),
  addressId: z.string(),
  specialRequest: z.string().optional()
});

export const updateOrderStatusSchema = z.object({
  status: z.nativeEnum(OrderStatus)
});

export const vendorResponseSchema = z.object({
  vendorNote: z.string().optional(),
  extraCharge: z.coerce.number().min(0).optional()  
});

export const approveOrderSchema = z.object({
  confirm: z.literal(true).optional()
});

export const orderIdParamsSchema = z.object({
  orderId: z.string()
});

export const notificationIdParamsSchema = z.object({
  notificationId: z.string()
});
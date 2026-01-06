"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationIdParamsSchema = exports.orderIdParamsSchema = exports.approveOrderSchema = exports.vendorResponseSchema = exports.updateOrderStatusSchema = exports.createOrderSchema = exports.orderItemSchema = void 0;
// src/validations/order.schema.ts
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
exports.orderItemSchema = zod_1.z.object({
    productId: zod_1.z.string(),
    quantity: zod_1.z.number().int().min(1),
    options: zod_1.z.array(zod_1.z.object({
        optionId: zod_1.z.string()
    })).optional()
});
exports.createOrderSchema = zod_1.z.object({
    items: zod_1.z.array(exports.orderItemSchema).min(1),
    addressId: zod_1.z.string(),
    specialRequest: zod_1.z.string().optional()
});
exports.updateOrderStatusSchema = zod_1.z.object({
    status: zod_1.z.nativeEnum(client_1.OrderStatus)
});
exports.vendorResponseSchema = zod_1.z.object({
    vendorNote: zod_1.z.string().optional(),
    extraCharge: zod_1.z.coerce.number().min(0).optional()
});
exports.approveOrderSchema = zod_1.z.object({
    confirm: zod_1.z.literal(true).optional()
});
exports.orderIdParamsSchema = zod_1.z.object({
    orderId: zod_1.z.string()
});
exports.notificationIdParamsSchema = zod_1.z.object({
    notificationId: zod_1.z.string()
});

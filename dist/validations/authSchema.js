"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAddressSchema = exports.secureResetSchema = exports.resetSchema = exports.loginSchema = exports.updateUserSchema = exports.registerSchema = void 0;
const zod_1 = require("zod");
exports.registerSchema = zod_1.z.object({
    username: zod_1.z.string().min(2).optional(), // ✅ Optional
    name: zod_1.z.string().min(2), // ✅ Required
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    phoneNumber: zod_1.z.string().min(10).optional(),
    role: zod_1.z.enum(['CUSTOMER', 'VENDOR', 'ADMIN', 'DELIVERY']),
    brandName: zod_1.z.string().nullable().optional(),
});
exports.updateUserSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).optional(),
    phoneNumber: zod_1.z.string().min(10).optional(),
    avatarUrl: zod_1.z.string().nullable().optional(), // allow null
    bio: zod_1.z.string().max(300).nullable().optional(),
    address: zod_1.z.string().nullable().optional(),
    // customer only
    preferences: zod_1.z.array(zod_1.z.string()).nullable().optional(),
    // vendor only
    brandName: zod_1.z.string().nullable().optional(),
    brandLogo: zod_1.z.string().nullable().optional(),
    // delivery only
    vehicleType: zod_1.z.string().max(50).optional(),
    licensePlate: zod_1.z.string().max(20).optional(),
    status: zod_1.z.enum(["AVAILABLE", "BUSY", "OFFLINE"]).optional(),
});
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.email(),
    password: zod_1.z.string().min(6),
});
exports.resetSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    code: zod_1.z.string().length(6),
    newPassword: zod_1.z.string().min(6),
});
exports.secureResetSchema = zod_1.z.object({
    resetToken: zod_1.z.string(),
    newPassword: zod_1.z.string().min(6),
});
// validation
exports.createAddressSchema = zod_1.z.object({
    label: zod_1.z.string(),
    street: zod_1.z.string(),
    city: zod_1.z.string(),
    state: zod_1.z.string().optional(),
    country: zod_1.z.string(),
    zipCode: zod_1.z.string().optional(),
    latitude: zod_1.z.number().optional(),
    longitude: zod_1.z.number().optional(),
    isDefault: zod_1.z.boolean().optional(),
});

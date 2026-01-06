"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unfollowVendorSchema = exports.followVendorSchema = void 0;
// src/validations/vendorFollowSchema.ts
const zod_1 = require("zod");
exports.followVendorSchema = zod_1.z.object({
    vendorId: zod_1.z.string().uuid({ message: "invalid vendorId" }),
});
exports.unfollowVendorSchema = zod_1.z.object({
    vendorId: zod_1.z.string().uuid({ message: "invalid vendorId" }),
});

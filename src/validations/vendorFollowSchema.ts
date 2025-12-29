// src/validations/vendorFollowSchema.ts
import { z } from "zod";

export const followVendorSchema = z.object({
  vendorId: z.string().uuid({ message: "invalid vendorId" }),
});

export const unfollowVendorSchema = z.object({
  vendorId: z.string().uuid({ message: "invalid vendorId" }),
});

import { z } from 'zod';


export const registerSchema = z.object({
  username: z.string().min(2).optional(), // ✅ Optional
  name: z.string().min(2),                // ✅ Required
  email: z.string().email(),
  password: z.string().min(6),
  phoneNumber: z.string().min(10).optional(),
  role: z.enum(['CUSTOMER', 'VENDOR', 'ADMIN', 'DELIVERY']),
  brandName: z.string().nullable().optional(),
});



export const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  phoneNumber: z.string().min(10).optional(),
  avatarUrl: z.string().nullable().optional(), // allow null
  bio: z.string().max(300).nullable().optional(),
  address: z.string().nullable().optional(),

  // customer only
  preferences: z.array(z.string()).nullable().optional(),

  // vendor only
  brandName: z.string().nullable().optional(),
  brandLogo: z.string().nullable().optional(),
  
  // delivery only
  vehicleType: z.string().max(50).optional(),
  licensePlate: z.string().max(20).optional(),
  status: z.enum(["AVAILABLE", "BUSY", "OFFLINE"]).optional(),
});

 
export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
});


export const resetSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  newPassword: z.string().min(6),
});


export const secureResetSchema = z.object({
  resetToken: z.string(),
  newPassword: z.string().min(6),
});




// validation
export const createAddressSchema = z.object({
  label: z.string(),
  street: z.string(),
  city: z.string(),
  state: z.string().optional(),
  country: z.string(),
  zipCode: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  isDefault: z.boolean().optional(),
});


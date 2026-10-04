import { z } from 'zod';


export const registerSchema = z.object({
  username: z.string().min(2).optional(), // ✅ Optional
  name: z.string().min(2),                // ✅ Required
  email: z.string().email(),
  password: z
    .string()
    .min(8, { message: "Password must be at least 8 characters" })
    .max(128)
    .refine((value) => /[A-Z]/.test(value), { message: "Password must contain at least one uppercase letter" })
    .refine((value) => /[a-z]/.test(value), { message: "Password must contain at least one lowercase letter" })
    .refine((value) => /[0-9]/.test(value), { message: "Password must contain at least one number" })
    .refine((value) => /[@$!%*?&#^()_+\-=/]/.test(value), { message: "Password must contain at least one special character" })
  ,
  phoneNumber: z.string().min(10).optional(),
  // Public registration must never mint a privileged role. ADMIN accounts
  // are created only via the create-admin CLI job or by an existing admin
  // through PATCH /api/admin/users/:id/role.
  role: z.enum(['CUSTOMER', 'VENDOR', 'DELIVERY']),
  brandName: z.string().nullable().optional(),
});



export const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().transform((v) => v.toLowerCase().trim()).optional(),
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
  // NOTE: rider moderation status (DeliveryPersonStatus ACTIVE/SUSPENDED/
  // INACTIVE) is admin-only via PATCH /api/admin/delivery/:userId/status and
  // deliberately absent here — riders toggle availability via isOnline.
});

 
export const loginSchema = z.object({
  email: z.email(),
  password: z
    .string()
    .min(8, { message: "Password must be at least 8 characters" })
    ,
});


export const resetSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  newPassword: z
    .string()
    .min(8, { message: "Password must be at least 8 characters" })
    .max(128)
    .refine((value) => /[A-Z]/.test(value), { message: "Password must contain at least one uppercase letter" })
    .refine((value) => /[a-z]/.test(value), { message: "Password must contain at least one lowercase letter" })
    .refine((value) => /[0-9]/.test(value), { message: "Password must contain at least one number" })
    .refine((value) => /[@$!%*?&#^()_+\-=/]/.test(value), { message: "Password must contain at least one special character" })
  ,
});


export const secureResetSchema = z.object({
  resetToken: z.string(),
  newPassword: z
    .string()
    .min(8, { message: "Password must be at least 8 characters" })
    .max(128)
    .refine((value) => /[A-Z]/.test(value), { message: "Password must contain at least one uppercase letter" })
    .refine((value) => /[a-z]/.test(value), { message: "Password must contain at least one lowercase letter" })
    .refine((value) => /[0-9]/.test(value), { message: "Password must contain at least one number" })
    .refine((value) => /[@$!%*?&#^()_+\-=/]/.test(value), { message: "Password must contain at least one special character" })
  ,
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

// Phase 1B multi-role: CUSTOMER adds VENDOR without changing active role.
export const becomeVendorSchema = z.object({
  brandName: z.string().min(2),
  phoneNumber: z.string().min(10).optional(),
  brandLogo: z.string().min(1).nullable().optional(),
});

// Phase 1B multi-role: switch active role between held CUSTOMER/VENDOR roles.
export const switchRoleSchema = z.object({
  role: z.enum(["CUSTOMER", "VENDOR"]),
});


import { z } from 'zod';


export const registerSchema = z.object({
  username: z.string().min(2).optional(), // ✅ Optional
  name: z.string().min(2),                // ✅ Required
  email: z.string().email().toLowerCase().trim(),
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
  role: z.enum(["CUSTOMER", "VENDOR", "DELIVERY", "ADMIN"]),
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
  // Login must accept any non-empty password: strength rules apply only at
  // registration / password-(re)set time. Legacy and weak stored passwords
  // (e.g. "abc123") must still be able to log in.
  password: z.string().min(1, { message: "Password is required" }),
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


export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, { message: "Current password is required" }),
  // Same policy as registration/reset: do not invent a second standard.
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
  role: z.enum(["CUSTOMER", "VENDOR", "DELIVERY", "ADMIN"]),
});

// Phase 1D.3: phone OTP. Only verification/change are exposed on the
// authenticated /phone/* endpoints. PHONE_LOGIN is deliberately NOT
// accepted there — it is issued and consumed by the dedicated public
// phone-login endpoints below, so the authenticated surface can never be
// used to start a login for somebody else's number.
export const phoneOtpPurposeSchema = z.enum(["PHONE_VERIFICATION", "PHONE_CHANGE"]);

export const requestPhoneOtpSchema = z.object({
  phoneNumber: z.string().min(1),
  purpose: phoneOtpPurposeSchema.optional().default("PHONE_VERIFICATION"),
  // Phase 1D.4 step-up: required when replacing an already-verified phone
  // on a password account (see requestPhoneOtp).
  currentPassword: z.string().min(1).optional(),
});

export const verifyPhoneOtpSchema = z.object({
  phoneNumber: z.string().min(1),
  otp: z.string().length(6),
  purpose: phoneOtpPurposeSchema.optional().default("PHONE_VERIFICATION"),
});

// Phase 1D.38 phone login. Public by necessity — the caller has no session
// yet — so neither schema carries a purpose: the purpose is fixed server-side
// to PHONE_LOGIN and a client cannot select another one.
export const requestPhoneLoginOtpSchema = z.object({
  phoneNumber: z.string().min(1),
});

export const verifyPhoneLoginOtpSchema = z.object({
  phoneNumber: z.string().min(1),
  otp: z.string().length(6),
});

// ─────────────────────────────────────────────────────────────────────────────
// Email OTP passwordless login (Phase 1E replacement for the SMS login flow).
//
// Deliberately a strict z.string().email() rather than min(1): the address is
// the account identifier, and it is also the HMAC key for the stored code, so
// a malformed value must be rejected before any Redis or database work rather
// than silently canonicalised into something unexpected.
// ─────────────────────────────────────────────────────────────────────────────
export const requestEmailLoginOtpSchema = z.object({
  email: z.string().transform(v => v.trim().toLowerCase()).pipe(z.string().email()),
});

export const verifyEmailLoginOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/, {
    message: "OTP must be exactly six digits",
  }),
});

// Phase 1D.38 phone removal. The step-up password mirrors the verified-phone
// change rule: required when the account has a password, absent for
// passwordless (Google-only) accounts which have nothing to re-check.
export const removePhoneSchema = z.object({
  currentPassword: z.string().min(1).optional(),
});


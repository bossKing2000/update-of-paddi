import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

// Default country for national-format input. The current market is Nigeria
// (NIN/KYC via Dojah, Paystack, Africa/Lagos timezone), but the utility
// accepts any valid international E.164 number.
export const DEFAULT_PHONE_COUNTRY: CountryCode = 'NG';

export class InvalidPhoneNumberError extends Error {
  constructor(message = 'Invalid phone number') {
    super(message);
    this.name = 'InvalidPhoneNumberError';
  }
}

function toInputString(input: unknown): string {
  if (typeof input !== 'string') {
    throw new InvalidPhoneNumberError('Phone number must be a string');
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidPhoneNumberError('Phone number is required');
  }
  return trimmed;
}

export function normalizePhoneNumber(
  input: unknown,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): string {
  const raw = toInputString(input);
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed || !parsed.isValid()) {
    throw new InvalidPhoneNumberError('Invalid phone number');
  }
  return parsed.number;
}

export function tryNormalizePhoneNumber(
  input: unknown,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): string | null {
  try {
    return normalizePhoneNumber(input, defaultCountry);
  } catch {
    return null;
  }
}

export function isValidPhoneNumber(
  input: unknown,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): boolean {
  return tryNormalizePhoneNumber(input, defaultCountry) !== null;
}

export function areSamePhoneNumber(
  a: unknown,
  b: unknown,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): boolean {
  const na = tryNormalizePhoneNumber(a, defaultCountry);
  const nb = tryNormalizePhoneNumber(b, defaultCountry);
  if (!na || !nb) return false;
  return na === nb;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone identity coherence (Batch 1D.40)
//
// A user's phone is three columns that must agree:
//   phoneNumber      — the display form the client renders
//   phoneNumberE164  — the canonical identity, and the UNIQUE one
//   isPhoneVerified  — whether that canonical identity was proven
//
// Only the OTP flow (`/auth/phone/request-otp` + `/auth/phone/verify-otp`)
// may change the canonical pair, and it sets all four columns together.
// Anywhere else, `isPhoneVerified` is only truthful when the number being
// displayed is the very number that was verified.
// ─────────────────────────────────────────────────────────────────────────────

export interface PhoneIdentityState {
  phoneNumber: string | null | undefined;
  phoneNumberE164: string | null | undefined;
  isPhoneVerified: boolean | null | undefined;
}

/**
 * True only when the stored verification flag actually describes the number
 * being displayed.
 *
 * Defensive in both directions: a row can claim to be verified with no
 * canonical number, and (from before this batch) a row can carry a display
 * number that was never verified while `isPhoneVerified` stays true.
 */
export function isPhoneIdentityVerified(
  user: PhoneIdentityState,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): boolean {
  if (!user.isPhoneVerified) return false;
  if (!user.phoneNumberE164) return false;
  if (!user.phoneNumber) return false;
  return areSamePhoneNumber(user.phoneNumber, user.phoneNumberE164, defaultCountry);
}

export type ProfilePhoneWriteDecision =
  | { kind: 'skip' }
  | { kind: 'accept'; phoneNumber: string }
  | { kind: 'reject'; status: 400 | 409; code: string; message: string };

/**
 * Decide what a profile-style write of `phoneNumber` may do.
 *
 * These endpoints are not the verification flow, so they must never be able
 * to produce a display number that inherits another number's verified status:
 *
 *  - unparseable input -> 400, nothing is stored
 *  - user holds a verified number and this is a DIFFERENT number -> 409,
 *    pointing at /auth/phone/*, which is the only way to change it
 *  - user holds a verified number and this is the SAME number -> no write at
 *    all; the verified display value is already correct
 *  - user holds no verified number -> accept, because `phoneNumberE164` and
 *    `isPhoneVerified` are left untouched, so nothing claims verification
 *
 * The caller writes only `phoneNumber`. It never writes the canonical column,
 * so verified-phone uniqueness and the concurrent-conflict handling stay
 * entirely owned by the OTP flow.
 */
export function resolveProfilePhoneWrite(
  requested: unknown,
  current: PhoneIdentityState,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): ProfilePhoneWriteDecision {
  const normalized = tryNormalizePhoneNumber(requested, defaultCountry);
  if (!normalized) {
    return {
      kind: 'reject',
      status: 400,
      code: 'PROFILE_PHONE_INVALID',
      message: 'Invalid phone number',
    };
  }

  if (!isPhoneIdentityVerified(current, defaultCountry)) {
    // No verification is being claimed or retained; storing a validated
    // display number is safe and keeps vendor onboarding workable.
    if (typeof requested === 'string' && requested.trim()) {
      return { kind: 'accept', phoneNumber: requested.trim() };
    }
    return { kind: 'skip' };
  }

  if (normalized === tryNormalizePhoneNumber(current.phoneNumberE164, defaultCountry)) {
    // Exactly the verified number: the existing display value already
    // represents it, so there is nothing to change.
    return { kind: 'skip' };
  }

  return {
    kind: 'reject',
    status: 409,
    code: 'PROFILE_PHONE_REQUIRES_VERIFICATION',
    message:
      'Changing a verified phone number requires phone verification. Use the phone verification endpoints instead.',
  };
}

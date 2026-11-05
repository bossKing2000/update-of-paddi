/**
 * Batch 1D.40 — phone profile identity consistency.
 *
 * A user's phone is three columns that must agree: the display
 * `phoneNumber`, the canonical+unique `phoneNumberE164`, and
 * `isPhoneVerified`. Only the OTP flow may change the canonical pair, and it
 * sets them together. These tests pin that the profile-style endpoints cannot
 * produce a display number that inherits another number's verified status,
 * that unrelated updates never clear a valid verification, and that the
 * auth response never reports a number as verified unless that exact number
 * was the one verified.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisPayments: { get: jest.fn(async () => null), set: jest.fn(async () => "OK"), del: jest.fn(async () => 1) },
  redisUsersSessions: {
    get: jest.fn(async () => null), set: jest.fn(async () => "OK"), del: jest.fn(async () => 1),
    sAdd: jest.fn(async () => 1), sRem: jest.fn(async () => 1), sMembers: jest.fn(async () => []),
  },
}));

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  createUserSession: jest.fn(async () => {}),
  getUserSession: jest.fn(async () => ({ ip: "1.2.3.4" })),
  deleteUserSession: jest.fn(async () => {}),
  deleteAllUserSessions: jest.fn(async () => {}),
  listUserSessions: jest.fn(async () => []),
  setRefreshJti: jest.fn(async () => {}),
  getRefreshJti: jest.fn(async () => null),
  rotateRefreshJti: jest.fn(async () => {}),
  isRefreshJtiReplay: jest.fn(async () => false),
  deleteRefreshJti: jest.fn(async () => {}),
}));

jest.mock("../../src/services/mail/emailProvider", () => ({
  __esModule: true,
  getEmailProvider: jest.fn(() => ({
    name: "memory",
    sendEmail: jest.fn(async () => {}),
  })),
  EmailProviderError: class EmailProviderError extends Error {},
  LogEmailProvider: class {},
  InMemoryEmailProvider: class {},
  FailingEmailProvider: class {},
  SmtpEmailProvider: class {},
  maskEmail: (e: string) => e,
  __setEmailProviderForTests: jest.fn(),
}));

jest.mock("../../src/services/vendorStatus.service", () => ({
  ensureVendorStatusNew: jest.fn(async () => {}),
  evaluateVendorStatus: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { updateProfile, becomeVendor } from "../../src/controllers/auth.controller";
import { buildAuthResponse } from "../../src/utils/buildResponse";
import {
  isPhoneIdentityVerified,
  resolveProfilePhoneWrite,
} from "../../src/utils/phone";

const db = prisma as unknown as {
  user: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
};

const VERIFIED_E164 = "+2348012345678";
const VERIFIED_RAW = "08012345678";
const OTHER_E164 = "+2348099999999";

interface Row {
  id: string;
  email: string;
  name: string;
  username: string | null;
  password: string | null;
  googleId: string | null;
  role: string | null;
  roles: string[];
  phoneNumber: string | null;
  phoneNumberE164: string | null;
  isPhoneVerified: boolean;
  phoneVerifiedAt: Date | null;
  isEmailVerified: boolean;
  isBlocked: boolean;
  tokenVersion: number;
  avatarUrl: string | null;
  preferences: string[] | null;
  bio: string | null;
  brandLogo: string | null;
  brandName: string | null;
  kycStatus: string | null;
  vendorStatus: string | null;
  authProviders: string[];
  loginMethod: string | null;
  lastLoginAt: Date | null;
  emailVerificationToken: string | null;
  emailVerificationExpiresAt: Date | null;
  updatedAt: Date;
  deliveryPerson: null;
}

const users = new Map<string, Row>();

function seed(row: Partial<Row> & { id: string }): Row {
  const full: Row = {
    email: `${row.id}@example.com`,
    name: "Test User",
    username: null,
    password: "hash",
    googleId: null,
    role: "CUSTOMER",
    roles: ["CUSTOMER"],
    phoneNumber: null,
    phoneNumberE164: null,
    isPhoneVerified: false,
    phoneVerifiedAt: null,
    isEmailVerified: true,
    isBlocked: false,
    tokenVersion: 0,
    avatarUrl: null,
    preferences: [],
    bio: null,
    brandLogo: null,
    brandName: null,
    kycStatus: null,
    vendorStatus: null,
    authProviders: [],
    loginMethod: null,
    lastLoginAt: null,
    emailVerificationToken: null,
    emailVerificationExpiresAt: null,
    updatedAt: new Date(),
    deliveryPerson: null,
    ...row,
  };
  users.set(full.id, full);
  return full;
}

/** A user who has genuinely completed OTP verification. */
function seedVerified(id: string) {
  return seed({
    id,
    phoneNumber: VERIFIED_RAW,
    phoneNumberE164: VERIFIED_E164,
    isPhoneVerified: true,
    phoneVerifiedAt: new Date(),
  });
}

function mockRes() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

const authed = (id: string, body: unknown) =>
  ({ user: { id, role: "CUSTOMER", sessionId: "s1" }, body, headers: {} }) as never;

const statusOf = (r: any): number => r.status.mock.calls[0][0];
const bodyOf = (r: any): any => r.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  users.clear();
  db.user.findUnique.mockImplementation(async (args: any) => {
    if (args?.where?.id) return users.get(args.where.id) ?? null;
    if (args?.where?.email) {
      for (const u of users.values()) if (u.email === args.where.email) return u;
    }
    return null;
  });
  db.user.update.mockImplementation(async (args: any) => {
    const existing = users.get(args.where.id);
    if (!existing) throw new Error("User not found");
    const { loginHistory, ...data } = args.data ?? {};
    const updated = { ...existing, ...data };
    users.set(existing.id, updated);
    return updated;
  });
  db.user.updateMany.mockImplementation(async (args: any) => {
    const existing = users.get(args.where.id);
    if (!existing) return { count: 0 };
    users.set(existing.id, { ...existing, ...(args.data ?? {}) });
    return { count: 1 };
  });
});

describe("resolveProfilePhoneWrite", () => {
  it("rejects an unparseable number with 400", () => {
    const d = resolveProfilePhoneWrite("not-a-phone", {
      phoneNumber: null, phoneNumberE164: null, isPhoneVerified: false,
    });
    expect(d).toMatchObject({ kind: "reject", status: 400, code: "PROFILE_PHONE_INVALID" });
  });

  it("rejects a number that only passes the old zod length check", () => {
    // updateUserSchema allows any 10+ character string; this is exactly the
    // input that used to be written straight into the display field.
    const d = resolveProfilePhoneWrite("0000000000", {
      phoneNumber: null, phoneNumberE164: null, isPhoneVerified: false,
    });
    expect(d).toMatchObject({ kind: "reject", status: 400 });
  });

  it("accepts a valid number when the user has no verified phone", () => {
    const d = resolveProfilePhoneWrite(" 08031234567 ", {
      phoneNumber: null, phoneNumberE164: null, isPhoneVerified: false,
    });
    expect(d).toEqual({ kind: "accept", phoneNumber: "08031234567" });
  });

  it("rejects replacing a verified number with a different one", () => {
    const d = resolveProfilePhoneWrite(OTHER_E164, {
      phoneNumber: VERIFIED_RAW, phoneNumberE164: VERIFIED_E164, isPhoneVerified: true,
    });
    expect(d).toMatchObject({
      kind: "reject", status: 409, code: "PROFILE_PHONE_REQUIRES_VERIFICATION",
    });
    expect((d as { message: string }).message).toMatch(/phone verification/i);
  });

  it("treats the same verified number in another format as no change", () => {
    for (const same of ["+2348012345678", "08012345678", "2348012345678"]) {
      expect(resolveProfilePhoneWrite(same, {
        phoneNumber: VERIFIED_RAW, phoneNumberE164: VERIFIED_E164, isPhoneVerified: true,
      })).toEqual({ kind: "skip" });
    }
  });
});

describe("isPhoneIdentityVerified", () => {
  it("is true only when the displayed number IS the verified canonical number", () => {
    expect(isPhoneIdentityVerified({
      phoneNumber: VERIFIED_RAW, phoneNumberE164: VERIFIED_E164, isPhoneVerified: true,
    })).toBe(true);
  });

  it("is false for a display number that was never verified", () => {
    expect(isPhoneIdentityVerified({
      phoneNumber: OTHER_E164, phoneNumberE164: VERIFIED_E164, isPhoneVerified: true,
    })).toBe(false);
  });

  it("is false when the flag is set but no number is stored at all", () => {
    expect(isPhoneIdentityVerified({
      phoneNumber: null, phoneNumberE164: null, isPhoneVerified: true,
    })).toBe(false);
    expect(isPhoneIdentityVerified({
      phoneNumber: VERIFIED_RAW, phoneNumberE164: null, isPhoneVerified: true,
    })).toBe(false);
  });

  it("is false for a display value that cannot be parsed", () => {
    expect(isPhoneIdentityVerified({
      phoneNumber: "garbage", phoneNumberE164: VERIFIED_E164, isPhoneVerified: true,
    })).toBe(false);
  });
});

describe("updateProfile phone identity", () => {
  it("refuses to replace a verified number with a different one", async () => {
    seedVerified("u1");
    const r = mockRes();
    await updateProfile(authed("u1", { phoneNumber: OTHER_E164 }), r);
    expect(statusOf(r)).toBe(409);
    expect(bodyOf(r)).toEqual({
      success: false,
      code: "PROFILE_PHONE_REQUIRES_VERIFICATION",
      message: expect.stringMatching(/phone verification/i),
    });
    // Nothing was written at all.
    expect(db.user.update).not.toHaveBeenCalled();
    expect(users.get("u1")!.phoneNumber).toBe(VERIFIED_RAW);
    expect(users.get("u1")!.phoneNumberE164).toBe(VERIFIED_E164);
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
  });

  it("leaves verification untouched when the same verified number is resubmitted", async () => {
    seedVerified("u1");
    const r = mockRes();
    await updateProfile(authed("u1", { phoneNumber: VERIFIED_E164, bio: "New bio" }), r);
    expect(statusOf(r)).toBe(200);
    const row = users.get("u1")!;
    expect(row.phoneNumber).toBe(VERIFIED_RAW);
    expect(row.phoneNumberE164).toBe(VERIFIED_E164);
    expect(row.isPhoneVerified).toBe(true);
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
    // The unrelated field did update.
    expect(row.bio).toBe("New bio");
  });

  it("keeps a valid verification across an unrelated profile update", async () => {
    seedVerified("u1");
    const r = mockRes();
    await updateProfile(authed("u1", { name: "Renamed", avatarUrl: "/uploads/a.png" }), r);
    expect(statusOf(r)).toBe(200);
    const row = users.get("u1")!;
    expect(row.name).toBe("Renamed");
    expect(row.avatarUrl).toBe("/uploads/a.png");
    expect(row.isPhoneVerified).toBe(true);
    expect(row.phoneNumberE164).toBe(VERIFIED_E164);
    // And no phone column was written at all.
    const written = db.user.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(written).not.toHaveProperty("phoneNumber");
    expect(written).not.toHaveProperty("isPhoneVerified");
    expect(written).not.toHaveProperty("phoneNumberE164");
  });

  it("accepts an unverified number when the user has no verified phone", async () => {
    seed({ id: "u1" });
    const r = mockRes();
    await updateProfile(authed("u1", { phoneNumber: "08031234567" }), r);
    expect(statusOf(r)).toBe(200);
    const row = users.get("u1")!;
    expect(row.phoneNumber).toBe("08031234567");
    // Recording an unverified number claims nothing.
    expect(row.phoneNumberE164).toBeNull();
    expect(row.isPhoneVerified).toBe(false);
  });

  it("rejects an invalid phone value without touching the profile", async () => {
    seed({ id: "u1" });
    const r = mockRes();
    await updateProfile(authed("u1", { phoneNumber: "0000000000", bio: "New bio" }), r);
    expect(statusOf(r)).toBe(400);
    expect(bodyOf(r)).toEqual({
      success: false,
      code: "PROFILE_PHONE_INVALID",
      message: "Invalid phone number",
    });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(users.get("u1")!.bio).toBeNull();
  });

  it("does not let a profile write claim a canonical number or a verified flag", async () => {
    seed({ id: "u1" });
    await updateProfile(authed("u1", { phoneNumber: "08031234567" }), mockRes());
    const written = db.user.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["phoneNumber"]);
    expect(written).not.toHaveProperty("phoneNumberE164");
    expect(written).not.toHaveProperty("isPhoneVerified");
    expect(written).not.toHaveProperty("phoneVerifiedAt");
  });

  it("still refuses unauthenticated updates", async () => {
    seedVerified("u1");
    const r = mockRes();
    await updateProfile({ body: { phoneNumber: OTHER_E164 } } as never, r);
    expect(statusOf(r)).toBe(401);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe("becomeVendor phone identity", () => {
  it("refuses to displace a verified number during vendor onboarding", async () => {
    seedVerified("u1");
    const r = mockRes();
    await becomeVendor(
      { user: { id: "u1", role: "CUSTOMER", sessionId: "s1" },
        body: { brandName: "Test Kitchen", phoneNumber: OTHER_E164 } } as never,
      r,
    );
    expect(statusOf(r)).toBe(409);
    expect(bodyOf(r).code).toBe("PROFILE_PHONE_REQUIRES_VERIFICATION");
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(users.get("u1")!.phoneNumberE164).toBe(VERIFIED_E164);
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
  });

  it("still collects an unverified number for the vendor profile step", async () => {
    seed({ id: "u1" });
    const r = mockRes();
    await becomeVendor(
      { user: { id: "u1", role: "CUSTOMER", sessionId: "s1" },
        body: { brandName: "Test Kitchen", phoneNumber: "08031234567" } } as never,
      r,
    );
    expect(statusOf(r)).toBe(200);
    expect(users.get("u1")!.phoneNumber).toBe("08031234567");
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
    expect(db.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not reject an onboarding call that omits the phone entirely", async () => {
    seedVerified("u1");
    const r = mockRes();
    await becomeVendor(
      { user: { id: "u1", role: "CUSTOMER", sessionId: "s1" },
        body: { brandName: "Test Kitchen" } } as never,
      r,
    );
    expect(statusOf(r)).toBe(200);
    expect(users.get("u1")!.phoneNumber).toBe(VERIFIED_RAW);
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
  });
});

describe("response serialization", () => {
  const authUser = (over: Partial<Row> = {}) =>
    ({ id: "u1", name: "n", username: null, email: "u1@example.com", role: "CUSTOMER",
       roles: ["CUSTOMER"], phoneNumber: null, phoneNumberE164: null, isPhoneVerified: false,
       avatarUrl: null, preferences: [], bio: null, brandLogo: null, brandName: null,
       kycStatus: null, vendorStatus: null, ...over }) as never;

  it("reports a coherent verified phone as verified", () => {
    const body = buildAuthResponse(authUser({
      phoneNumber: VERIFIED_RAW, phoneNumberE164: VERIFIED_E164, isPhoneVerified: true,
    }), "token");
    expect(body.user.isPhoneVerified).toBe(true);
    expect(body.user.phoneNumber).toBe(VERIFIED_RAW);
  });

  it("never reports a swapped display number as verified", () => {
    // The exact corruption this batch prevents, as it would look in a row
    // written before the guard existed.
    const body = buildAuthResponse(authUser({
      phoneNumber: OTHER_E164, phoneNumberE164: VERIFIED_E164, isPhoneVerified: true,
    }), "token");
    expect(body.user.isPhoneVerified).toBe(false);
    expect(body.user.phoneNumber).toBe(OTHER_E164);
  });

  it("never reports a verified flag when no number is stored", () => {
    const body = buildAuthResponse(authUser({ isPhoneVerified: true }), "token");
    expect(body.user.isPhoneVerified).toBe(false);
  });

  it("leaves an unverified number unverified", () => {
    const body = buildAuthResponse(authUser({
      phoneNumber: "08031234567", phoneNumberE164: null, isPhoneVerified: false,
    }), "token");
    expect(body.user.isPhoneVerified).toBe(false);
  });
});
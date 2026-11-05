/**
 * Phase 1D.38 — the "only usable login method" guard on email change.
 *
 * Changing the address resets isEmailVerified, so LOCAL sign-in stops
 * working until the new address is confirmed. These tests pin that the
 * change is refused when that would leave the account with no way in, and
 * that it is still allowed whenever another method survives.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn() },
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
import { updateProfile } from "../../src/controllers/auth.controller";

const db = prisma as unknown as { user: { findUnique: jest.Mock; update: jest.Mock } };

interface Row {
  id: string;
  email: string;
  name: string;
  password: string | null;
  googleId: string | null;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  phoneNumber: string | null;
  phoneNumberE164: string | null;
  role: string | null;
  roles: string[];
  kycStatus: string | null;
  brandName: string | null;
  brandLogo: string | null;
  vendorStatus: string | null;
  username: string | null;
  avatarUrl: string | null;
  bio: string | null;
  preferences: string[] | null;
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
    password: "hash",
    googleId: null,
    isEmailVerified: true,
    isPhoneVerified: false,
    phoneNumber: null,
    phoneNumberE164: null,
    role: "CUSTOMER",
    roles: ["CUSTOMER"],
    kycStatus: null,
    brandName: null,
    brandLogo: null,
    vendorStatus: null,
    username: null,
    avatarUrl: null,
    bio: null,
    preferences: null,
    emailVerificationToken: null,
    emailVerificationExpiresAt: null,
    updatedAt: new Date(),
    deliveryPerson: null,
    ...row,
  };
  users.set(full.id, full);
  return full;
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
    const updated = { ...existing, ...args.data };
    users.set(existing.id, updated);
    return updated;
  });
});

describe("email change and the only-usable-login-method guard", () => {
  it("refuses a change that would leave no verified phone, no Google and an unverifiable email", async () => {
    // LOCAL is the only method, and the change is about to switch it off.
    seed({ id: "u1" });
    const r = mockRes();
    await updateProfile(authed("u1", { email: "new@example.com" }), r);
    expect(statusOf(r)).toBe(409);
    expect(bodyOf(r)).toEqual({
      success: false,
      code: "PROFILE_EMAIL_CHANGE_NO_LOGIN_METHOD",
      message: "Add and verify another login method before changing your email address",
    });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(users.get("u1")!.email).toBe("u1@example.com");
  });

  it("allows the change when a verified phone survives it", async () => {
    seed({ id: "u1", isPhoneVerified: true, phoneNumberE164: "+2348031234560" });
    const r = mockRes();
    await updateProfile(authed("u1", { email: "new@example.com" }), r);
    expect(statusOf(r)).toBe(200);
    const data = db.user.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.email).toBe("new@example.com");
    // Verification is reset on the new address, as before.
    expect(data.isEmailVerified).toBe(false);
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
    expect(users.get("u1")!.phoneNumberE164).toBe("+2348031234560");
  });

  it("allows the change when a Google identity survives it", async () => {
    seed({ id: "u1", password: null, googleId: "g-1" });
    const r = mockRes();
    await updateProfile(authed("u1", { email: "new@example.com" }), r);
    expect(statusOf(r)).toBe(200);
    expect(users.get("u1")!.email).toBe("new@example.com");
  });

  it("allows the change when the email was already unverified and nothing else works", async () => {
    // There was no usable method to lose, so the guard must not turn this
    // into a dead end.
    seed({ id: "u1", isEmailVerified: false, password: null });
    const r = mockRes();
    await updateProfile(authed("u1", { email: "new@example.com" }), r);
    expect(statusOf(r)).toBe(200);
    expect(users.get("u1")!.email).toBe("new@example.com");
  });

  it("still refuses an address already used by another account", async () => {
    seed({ id: "u1", isPhoneVerified: true, phoneNumberE164: "+2348" });
    seed({ id: "u2" });
    const r = mockRes();
    await updateProfile(authed("u1", { email: "u2@example.com" }), r);
    expect(statusOf(r)).toBe(409);
    expect(bodyOf(r)).toEqual({
      success: false,
      code: "PROFILE_EMAIL_TAKEN",
      message: "Email already in use",
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("treats a no-op email as no change at all", async () => {
    seed({ id: "u1" });
    const r = mockRes();
    await updateProfile(authed("u1", { email: "U1@Example.com" }), r);
    expect(statusOf(r)).toBe(200);
    const data = db.user.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("email");
    expect(data).not.toHaveProperty("isEmailVerified");
  });

  it("rejects unauthenticated profile updates", async () => {
    seed({ id: "u1" });
    const r = mockRes();
    await updateProfile({ body: { email: "new@example.com" } } as never, r);
    expect(statusOf(r)).toBe(401);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
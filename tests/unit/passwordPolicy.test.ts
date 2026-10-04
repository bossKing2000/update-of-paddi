/**
 * Password policy: strength rules live only on register / reset / secure-reset.
 * Login accepts any non-empty password so legacy weak stored passwords
 * (e.g. "abc123") can still authenticate.
 */
import bcrypt from "bcryptjs";

import { loginSchema, registerSchema } from "../../src/validations/authSchema";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisPayments: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
  redisUsersSessions: { get: jest.fn(async () => null), set: jest.fn(async () => {}) },
  ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
}));

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  createUserSession: jest.fn(async () => {}),
  setRefreshJti: jest.fn(async () => {}),
  deleteAllUserSessions: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { login } from "../../src/controllers/auth.controller";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  return r;
};

describe("loginSchema password policy", () => {
  it("accepts a weak password like abc123", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "abc123" }).success).toBe(true);
  });

  it("rejects an empty password", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });

  it("register still enforces strength", () => {
    const weak = registerSchema.safeParse({
      name: "Weak",
      email: "w@b.co",
      password: "abc123",
      role: "CUSTOMER",
    });
    expect(weak.success).toBe(false);
  });
});

describe("login with legacy weak stored password", () => {
  beforeEach(() => jest.clearAllMocks());

  it("a user whose stored password is abc123 can still log in", async () => {
    const stored = await bcrypt.hash("abc123", 4);
    const user = {
      id: "legacy-1",
      name: "Legacy",
      email: "legacy@example.com",
      password: stored,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
      tokenVersion: 0,
      kycStatus: "PENDING",
      phoneNumber: null,
      brandName: null,
      brandLogo: null,
      avatarUrl: null,
      username: null,
      bio: null,
      preferences: [],
      isEmailVerified: true,
      isBlocked: false,
      authProviders: ["LOCAL"],
    };
    db.user.findUnique.mockResolvedValue(user);
    db.user.update.mockImplementation(async (args: any) => ({ ...user, ...args.data }));

    const r = res();
    await login(
      {
        body: { email: "legacy@example.com", password: "abc123" },
        headers: {},
        ip: "127.0.0.1",
      } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Login successful" }));
  });
});

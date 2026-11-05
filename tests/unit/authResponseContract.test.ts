/**
 * Mobile auth response contract: routing fields present, no secrets leaked.
 */
import bcrypt from "bcryptjs";

const mockVerifyIdToken = jest.fn();

jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

jest.mock("../../src/lib/prisma", () => {
  // `register` writes the account and (for a rider) the linked rider profile
  // inside one prisma.$transaction so the pair cannot half-apply. Handing the
  // callback the SAME client keeps every existing assertion on
  // prisma.user.create / .update valid without rewriting them.
  const client: any = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    userSession: {
      upsert: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
      // Phase 1E: a role switch now writes the session's active role.
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    deliveryPerson: { create: jest.fn(async () => ({})) },
  };
  client.$transaction = jest.fn(async (fn: (tx: any) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisPayments: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
  },
  redisUsersSessions: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    sAdd: jest.fn(async () => 1),
    sRem: jest.fn(async () => 1),
    sMembers: jest.fn(async () => []),
  },
  ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => "OK") },
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
  // Phase 1E: a role switch writes the session's own active role.
  setSessionActiveRole: jest.fn(async () => {}),
  resolveSessionRole: jest.fn((session: any, accountRole: any) => {
    const sessionRole = session?.activeRole;
    return typeof sessionRole === "string" && sessionRole.length > 0 ? sessionRole : accountRole ?? null;
  }),
}));

import prisma from "../../src/lib/prisma";
import {
  register,
  login,
  googleLogin,
  switchRole,
  becomeVendor,
} from "../../src/controllers/auth.controller";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
};

const bodyOf = (r: any) => r.json.mock.calls[0][0];
const dumped = (r: any) => JSON.stringify(bodyOf(r));

function baseUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    name: "Test User",
    username: "testuser",
    email: "test@example.com",
    password: null as unknown as string | null,
    role: "CUSTOMER",
    roles: ["CUSTOMER"],
    phoneNumber: null,
    phoneNumberE164: null,
    isPhoneVerified: false,
    avatarUrl: null,
    preferences: [],
    bio: null,
    brandLogo: null,
    brandName: null,
    kycStatus: "PENDING",
    tokenVersion: 0,
    vendorStatus: null,
    isEmailVerified: true,
    isBlocked: false,
    authProviders: ["LOCAL"],
    ...overrides,
  };
}

function assertNoSecrets(r: any) {
  const body = bodyOf(r);
  expect(body.user).toBeDefined();
  for (const forbidden of ["password", "passwordHash", "refreshJti", "jti", "otp", "resetToken"]) {
    expect(body.user).not.toHaveProperty(forbidden);
  }
  expect(dumped(r).toLowerCase()).not.toContain("password");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyIdToken.mockReset();
});

describe("email login contract", () => {
  it("exposes routing fields for a dual-role account", async () => {
    const stored = await bcrypt.hash("Strong123!", 4);
    const user = baseUser({
      password: stored,
      role: "CUSTOMER",
      roles: ["CUSTOMER", "VENDOR"],
      vendorStatus: "ACTIVE",
      // Batch 1D.40: the flag is now DERIVED from the stored columns, so a
      // fixture claiming "verified" must actually carry a coherent pair.
      phoneNumber: "+2348012345678",
      phoneNumberE164: "+2348012345678",
      isPhoneVerified: true,
    });
    db.user.findUnique.mockResolvedValue(user);
    db.user.update.mockImplementation(async (args: any) => ({ ...user, ...args.data }));

    const r = res();
    await login({ body: { email: "test@example.com", password: "Strong123!" }, headers: {}, ip: "127.0.0.1" } as never, r);

    expect(r.status).toHaveBeenCalledWith(200);
    const body = bodyOf(r);
    expect(body.user.role).toBe("CUSTOMER");
    expect(body.user.roles).toEqual(["CUSTOMER", "VENDOR"]);
    expect(body.user.vendorStatus).toBe("ACTIVE");
    expect(body.user.isPhoneVerified).toBe(true);
    expect(body.onboarding).toBeDefined();
    expect(body.pendingRole).toBe(false);
    expect(typeof body.accessToken).toBe("string");
    assertNoSecrets(r);
  });
});

describe("register contract", () => {
  it("returns the canonical routing fields", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const created = baseUser({ id: "new-1", roles: ["CUSTOMER"], role: "CUSTOMER" });
    db.user.create.mockResolvedValue(created);

    const r = res();
    await register(
      { body: { name: "New", email: "new@example.com", password: "Strong123!", role: "CUSTOMER" }, headers: {}, ip: "127.0.0.1" } as never,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(201);
    const body = bodyOf(r);
    expect(body.user.role).toBe("CUSTOMER");
    expect(body.user.roles).toEqual(["CUSTOMER"]);
    expect(body.user.vendorStatus).toBeNull();
    expect(body.user.isPhoneVerified).toBe(false);
    expect(body.onboarding).toBeDefined();
    expect(body.pendingRole).toBe(false);
    expect(typeof body.accessToken).toBe("string");
    assertNoSecrets(r);
  });

  it("never writes the request body or the password to stdout", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const created = baseUser({ id: "new-2", roles: ["CUSTOMER"], role: "CUSTOMER" });
    db.user.create.mockResolvedValue(created);

    const PASSWORD = "Str0ngPass!";
    const EMAIL = "stdout-leak-check@example.com";

    // The registration body carries the plaintext password. `console.*` writes
    // straight to stdout and bypasses pino entirely — including the redaction
    // in src/lib/logger.ts — so that channel is the one that could leak it.
    // (pino itself writes to fd 1 through its own destination, so it is not
    // captured here; this asserts on the NON-redacting channel only.)
    const written: string[] = [];
    const capture = (args: unknown[]): void => {
      written.push(
        args
          .map((a) => {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a) ?? String(a);
            } catch {
              return String(a);
            }
          })
          .join(" "),
      );
    };
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        capture(args);
      }),
    );
    const stdoutSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: unknown) => {
        capture([chunk]);
        return true;
      }) as never);

    try {
      const r = res();
      await register(
        {
          body: {
            name: "Stdout Check",
            email: EMAIL,
            password: PASSWORD,
            role: "CUSTOMER",
          },
          headers: {},
          ip: "127.0.0.1",
        } as never,
        r,
      );
      expect(r.status).toHaveBeenCalledWith(201);
    } finally {
      consoleSpies.forEach((s) => s.mockRestore());
      stdoutSpy.mockRestore();
    }

    const captured = written.join("\n");
    expect(captured).not.toContain(PASSWORD);
    expect(captured).not.toContain(EMAIL);
  });
});

describe("Google login contract", () => {
  function googleTicket(email = "g@example.com") {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email, name: "Google User", picture: null, sub: "google-sub-1" }),
    });
  }

  it("matches the email-login routing contract (no extra /profile needed)", async () => {
    googleTicket();
    const created = baseUser({
      id: "g1",
      email: "g@example.com",
      role: "CUSTOMER",
      roles: ["CUSTOMER", "VENDOR"],
      vendorStatus: "PENDING_REVIEW",
      phoneNumber: "+2348012345678",
      phoneNumberE164: "+2348012345678",
      isPhoneVerified: true,
      authProviders: ["GOOGLE"],
    });
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue(created);
    db.user.update.mockImplementation(async (args: any) => ({ ...created, ...args.data }));

    const r = res();
    await googleLogin({ body: { idToken: "fake-id-token" }, headers: {}, ip: "127.0.0.1" } as never, r);

    expect(r.status).toHaveBeenCalledWith(200);
    const body = bodyOf(r);
    expect(body.user.role).toBe("CUSTOMER");
    expect(body.user.roles).toEqual(["CUSTOMER", "VENDOR"]);
    expect(body.user.vendorStatus).toBe("PENDING_REVIEW");
    expect(body.user.isPhoneVerified).toBe(true);
    expect(body.onboarding).toBeDefined();
    expect(body.pendingRole).toBe(false);
    expect(body.isProfileComplete).toBe(true);
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    assertNoSecrets(r);
  });
});

describe("role endpoints contract", () => {
  it("switch-role keeps roles and returns a fresh token", async () => {
    const user = baseUser({ roles: ["CUSTOMER", "VENDOR"], role: "CUSTOMER" });
    db.user.findUnique.mockResolvedValue(user);
    db.user.update.mockImplementation(async (args: any) => ({ ...user, ...args.data }));

    const r = res();
    await switchRole(
      { user: { id: "u1", role: "CUSTOMER", sessionId: "s1" }, body: { role: "VENDOR" } } as never,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    const body = bodyOf(r);
    expect(body.role).toBe("VENDOR");
    expect(body.roles).toEqual(["CUSTOMER", "VENDOR"]);
    expect(typeof body.accessToken).toBe("string");
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("become-vendor preserves the active role and held roles", async () => {
    const user = baseUser({
      roles: ["CUSTOMER"],
      role: "CUSTOMER",
      isEmailVerified: true,
      brandName: "Test Kitchen",
      phoneNumber: "08031234560",
    });
    db.user.findUnique.mockResolvedValue(user);
    db.user.updateMany.mockResolvedValueOnce({ count: 1 });
    db.user.findUnique
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ id: "u1", role: "CUSTOMER", roles: ["CUSTOMER", "VENDOR"] });

    const r = res();
    await becomeVendor(
      {
        user: { id: "u1", role: "CUSTOMER", sessionId: "s1" },
        body: { brandName: "Test Kitchen", phoneNumber: "08031234560" },
      } as never,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    const body = bodyOf(r);
    expect(body.role).toBe("CUSTOMER");
    expect(body.roles).toEqual(["CUSTOMER", "VENDOR"]);
  });
});

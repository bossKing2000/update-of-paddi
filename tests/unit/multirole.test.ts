/**
 * Phase 1B multi-role — core unit tests.
 *
 * Covers:
 * - roles helper (hasRole / assertRoleCombination)
 * - onboarding derived from HELD roles (not just active role)
 * - migration backfill SQL + schema field presence
 * - register / selectRole write roles=[role]
 */
import fs from "fs";
import path from "path";

import { Role } from "@prisma/client";
import { hasRole, assertRoleCombination } from "../../src/utils/roles";
import {
  resolveOnboardingState,
  OnboardingUser,
} from "../../src/controllers/auth.controller";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    deliveryPerson: { create: jest.fn(), upsert: jest.fn() },
  },
}));

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  createUserSession: jest.fn(async () => {}),
  setRefreshJti: jest.fn(async () => {}),
  getRefreshJti: jest.fn(async () => null),
  rotateRefreshJti: jest.fn(async () => {}),
  isRefreshJtiReplay: jest.fn(async () => false),
  deleteRefreshJti: jest.fn(async () => {}),
  deleteUserSession: jest.fn(async () => {}),
  deleteAllUserSessions: jest.fn(async () => {}),
  listUserSessions: jest.fn(async () => []),
  getUserSession: jest.fn(async () => null),
}));

import prisma from "../../src/lib/prisma";
import { register, selectRole } from "../../src/controllers/auth.controller";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
};

const PASSWORD = "Strong1!pass";

describe("roles helper", () => {
  it("hasRole is true only for held roles", () => {
    expect(hasRole({ roles: [Role.CUSTOMER, Role.VENDOR] }, Role.VENDOR)).toBe(true);
    expect(hasRole({ roles: [Role.CUSTOMER, Role.VENDOR] }, Role.ADMIN)).toBe(false);
    expect(hasRole({ roles: [] }, Role.CUSTOMER)).toBe(false);
    expect(hasRole(null, Role.CUSTOMER)).toBe(false);
    expect(hasRole(undefined, Role.CUSTOMER)).toBe(false);
  });

  it("assertRoleCombination allows solo ADMIN / solo DELIVERY / CUSTOMER+VENDOR", () => {
    expect(() => assertRoleCombination([Role.ADMIN])).not.toThrow();
    expect(() => assertRoleCombination([Role.DELIVERY])).not.toThrow();
    expect(() => assertRoleCombination([Role.CUSTOMER])).not.toThrow();
    expect(() => assertRoleCombination([Role.CUSTOMER, Role.VENDOR])).not.toThrow();
    expect(() => assertRoleCombination([])).not.toThrow();
  });

  it("assertRoleCombination rejects ADMIN or DELIVERY combined with another role", () => {
    expect(() => assertRoleCombination([Role.ADMIN, Role.CUSTOMER])).toThrow();
    expect(() => assertRoleCombination([Role.ADMIN, Role.VENDOR])).toThrow();
    expect(() => assertRoleCombination([Role.DELIVERY, Role.CUSTOMER])).toThrow();
    expect(() => assertRoleCombination([Role.DELIVERY, Role.VENDOR])).toThrow();
  });
});

describe("onboarding derived from held roles", () => {
  const base: OnboardingUser = {
    role: "CUSTOMER",
    roles: [Role.CUSTOMER, Role.VENDOR],
    kycStatus: "PENDING",
    phoneNumber: "08012345678",
    brandName: "Dual Foods",
    brandLogo: "https://example.com/logo.png",
  };

  it("dual-role user in CUSTOMER mode still requires KYC (held VENDOR)", () => {
    const state = resolveOnboardingState(base);
    const kyc = state.steps.find((s) => s.key === "KYC")!;
    expect(kyc.done).toBe(false);
    expect(state.nextStep).toBe("KYC");
  });

  it("dual-role user passes KYC step once VERIFIED", () => {
    const state = resolveOnboardingState({ ...base, kycStatus: "VERIFIED" });
    expect(state.steps.find((s) => s.key === "KYC")!.done).toBe(true);
    expect(state.isComplete).toBe(true);
  });

  it("single CUSTOMER still skips KYC (backwards compatible, no roles passed)", () => {
    const state = resolveOnboardingState({
      role: "CUSTOMER",
      kycStatus: "PENDING",
      phoneNumber: null,
      brandName: null,
      brandLogo: null,
    });
    expect(state.steps.find((s) => s.key === "KYC")!.done).toBe(true);
    expect(state.isComplete).toBe(true);
  });
});

describe("migration backfill + schema", () => {
  it("migration backfills roles from role", () => {
    const sql = fs.readFileSync(
      path.join(
        __dirname,
        "../../prisma/migrations/20261004000000_user_roles_multirole/migration.sql",
      ),
      "utf8",
    );
    expect(sql).toMatch(/ADD COLUMN "roles"/);
    expect(sql).toMatch(/UPDATE "User" SET "roles" = ARRAY\["role"\] WHERE "role" IS NOT NULL/);
  });

  it("User model has roles Role[] with default", () => {
    const schema = fs.readFileSync(
      path.join(__dirname, "../../prisma/schema.prisma"),
      "utf8",
    );
    expect(schema).toMatch(/roles\s+Role\[\] @default\(\[\]\)/);
    // existing active-role column untouched
    expect(schema).toMatch(/role\s+Role\?/);
  });
});

describe("register writes roles", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sets role AND roles=[role] when role provided", async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockImplementation(async (args: any) => ({
      id: "u-1",
      tokenVersion: 0,
      kycStatus: "PENDING",
      phoneNumber: null,
      brandName: null,
      brandLogo: null,
      ...args.data,
    }));

    const r = res();
    await register(
      {
        body: { name: "Test User", email: "t1@example.com", password: PASSWORD, role: "CUSTOMER" },
        headers: {},
      } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(201);
    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "CUSTOMER", roles: ["CUSTOMER"] }),
      }),
    );
  });

  it("still rejects ADMIN registration outright", async () => {
    const r = res();
    await register(
      { body: { name: "Root", email: "root@example.com", password: PASSWORD, role: "ADMIN" } } as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(403);
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

describe("selectRole writes roles and honours held roles", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sets role and roles=[role] for a fresh user", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-2", role: null, roles: [] });
    db.user.update.mockImplementation(async (args: any) => ({
      id: "u-2",
      kycStatus: "PENDING",
      phoneNumber: null,
      brandName: null,
      brandLogo: null,
      ...args.data,
    }));

    const r = res();
    await selectRole(
      { user: { id: "u-2", role: "", sessionId: "s" }, body: { role: "VENDOR" } } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "VENDOR", roles: ["VENDOR"] } }),
    );
  });

  it("rejects when the account already holds a role (roles non-empty)", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-3", role: "CUSTOMER", roles: ["CUSTOMER"] });

    const r = res();
    await selectRole(
      { user: { id: "u-3", role: "CUSTOMER", sessionId: "s" }, body: { role: "VENDOR" } } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

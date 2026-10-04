/**
 * Phase 1C TASK7 — vendor onboarding lifecycle tests.
 */
import fs from "fs";
import path from "path";

import { VendorStatus } from "@prisma/client";
import { ValidationError, NotFoundError, ForbiddenError } from "../../src/errors/AppError";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    order: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(async () => []), updateMany: jest.fn() },
    vendorPayout: { create: jest.fn(), findUnique: jest.fn() },
  },
}));

jest.mock("../../src/utils/activityUtils/notify", () => ({
  __esModule: true,
  sendNotification: jest.fn(async () => ({})),
  sendNotificationToMany: jest.fn(async () => []),
  notifyRole: jest.fn(async () => []),
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
  ShopCartRedis: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
  redisPayments: { get: jest.fn(async () => null), set: jest.fn(async () => {}), del: jest.fn(async () => {}) },
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(async () => []),
}));

import prisma from "../../src/lib/prisma";
import {
  allowedVendorTransitions,
  evaluateVendorStatus,
  ensureVendorStatusNew,
  changeVendorStatus,
} from "../../src/services/vendorStatus.service";
import { requireVendorNotSuspended } from "../../src/middlewares/vendorStatus.middleware";
import { updateVendorLive } from "../../src/controllers/vendorSettingsController";
import { getVendorOnboarding } from "../../src/controllers/vendorOnboardingController";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

beforeEach(() => jest.clearAllMocks());

describe("transition table", () => {
  it("allows every legal transition", () => {
    expect(allowedVendorTransitions(null)).toEqual(["NEW"]);
    expect(allowedVendorTransitions("NEW")).toEqual(["ACTIVE", "PENDING_REVIEW"]);
    expect(allowedVendorTransitions("PENDING_REVIEW")).toEqual(["ACTIVE", "NEW"]);
    expect(allowedVendorTransitions("ACTIVE")).toEqual(["SUSPENDED"]);
    expect(allowedVendorTransitions("SUSPENDED")).toEqual(["ACTIVE"]);
  });

  it("changeVendorStatus enforces the table", async () => {
    db.user.findUnique.mockResolvedValue({ id: "v-1", vendorStatus: "ACTIVE", roles: ["VENDOR"] });
    db.user.update.mockImplementation(async (a: any) => ({ id: "v-1", ...a.data }));

    // ACTIVE -> SUSPENDED with reason: allowed
    const r = res();
    const { setVendorStatus } = require("../../src/controllers/admin.controller");
    await setVendorStatus(
      { user: { id: "admin-1", role: "ADMIN", sessionId: "s" }, params: { id: "v-1" }, body: { status: "SUSPENDED", reason: "fraud" } } as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(200);

    // NEW -> SUSPENDED directly: rejected (must go through ACTIVE first)
    db.user.findUnique.mockResolvedValue({ id: "v-2", vendorStatus: "NEW", roles: ["VENDOR"] });
    await expect(
      changeVendorStatus("v-2", VendorStatus.SUSPENDED, "x", "admin-1"),
    ).rejects.toThrow(ValidationError);

    // SUSPENDED -> NEW: rejected
    db.user.findUnique.mockResolvedValue({ id: "v-3", vendorStatus: "SUSPENDED", roles: ["VENDOR"] });
    await expect(
      changeVendorStatus("v-3", VendorStatus.NEW, "x", "admin-1"),
    ).rejects.toThrow(ValidationError);

    // ACTIVE -> ACTIVE: rejected (no self transition)
    db.user.findUnique.mockResolvedValue({ id: "v-4", vendorStatus: "ACTIVE", roles: ["VENDOR"] });
    await expect(
      changeVendorStatus("v-4", VendorStatus.ACTIVE, undefined, "admin-1"),
    ).rejects.toThrow(ValidationError);

    // SUSPENDED requires a reason
    db.user.findUnique.mockResolvedValue({ id: "v-5", vendorStatus: "ACTIVE", roles: ["VENDOR"] });
    await expect(
      changeVendorStatus("v-5", VendorStatus.SUSPENDED, undefined, "admin-1"),
    ).rejects.toThrow(ValidationError);

    // unknown user
    db.user.findUnique.mockResolvedValue(null);
    await expect(
      changeVendorStatus("nope", VendorStatus.ACTIVE, undefined, "admin-1"),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("backfill migration", () => {
  it("activates complete vendors, NEWS the rest, ignores non-vendors", () => {
    const dir = path.join(__dirname, "../../prisma/migrations");
    const mig = fs
      .readdirSync(dir)
      .filter((d) => d.includes("vendor_status"))
      .sort()
      .pop();
    expect(mig).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, mig!, "migration.sql"), "utf8");
    expect(sql).toMatch(/CREATE TYPE "VendorStatus"/);
    expect(sql).toMatch(/"vendorStatus"/);
    expect(sql).toMatch(/'ACTIVE'/);
    expect(sql).toMatch(/ELSE 'NEW'/);
    expect(sql).toMatch(/"kycStatus" = 'VERIFIED'/);
    expect(sql).toMatch(/"brandName" IS NOT NULL/);
    expect(sql).toMatch(/"phoneNumber" IS NOT NULL/);
    expect(sql).toMatch(/"vendorStatus" IS NULL/);
  });
});

describe("evaluateVendorStatus", () => {
  const completeNew = {
    roles: ["CUSTOMER", "VENDOR"],
    vendorStatus: "NEW",
    kycStatus: "VERIFIED",
    brandName: "B",
    phoneNumber: "0801",
  };

  it("is idempotent and promotes NEW -> ACTIVE when complete", async () => {
    db.user.findUnique.mockResolvedValue({ ...completeNew });
    db.user.updateMany.mockResolvedValue({ count: 1 });
    expect(await evaluateVendorStatus("v-1")).toBe("ACTIVE");

    // second run: already ACTIVE, requirements met — stays, no write race
    db.user.findUnique.mockResolvedValue({ ...completeNew, vendorStatus: "ACTIVE" });
    db.user.updateMany.mockResolvedValue({ count: 1 });
    expect(await evaluateVendorStatus("v-1")).toBe("ACTIVE");
  });

  it("never overrides SUSPENDED or PENDING_REVIEW", async () => {
    for (const s of ["SUSPENDED", "PENDING_REVIEW"]) {
      db.user.findUnique.mockResolvedValue({ ...completeNew, vendorStatus: s });
      expect(await evaluateVendorStatus("v-1")).toBe(s);
    }
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("leaves incomplete NEW vendors alone", async () => {
    db.user.findUnique.mockResolvedValue({ ...completeNew, kycStatus: "PENDING" });
    expect(await evaluateVendorStatus("v-1")).toBe("NEW");
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("queues PENDING_REVIEW when auto-approve is off", async () => {
    process.env.VENDOR_AUTO_APPROVE = "false";
    try {
      db.user.findUnique.mockResolvedValue({ ...completeNew });
      db.user.updateMany.mockResolvedValue({ count: 1 });
      expect(await evaluateVendorStatus("v-1")).toBe("PENDING_REVIEW");
    } finally {
      delete process.env.VENDOR_AUTO_APPROVE;
    }
  });

  it("ensureVendorStatusNew only fills null statuses", async () => {
    await ensureVendorStatusNew("v-1");
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "v-1", vendorStatus: null }),
      }),
    );
  });
});

describe("suspended vendor enforcement", () => {
  it("write middleware blocks SUSPENDED, passes others", async () => {
    const next = jest.fn();
    db.user.findUnique.mockResolvedValue({ vendorStatus: "SUSPENDED" });
    await expect(
      requireVendorNotSuspended({ user: { id: "v-1", role: "VENDOR", sessionId: "s" } } as any, res(), next),
    ).rejects.toThrow(ForbiddenError);
    expect(next).not.toHaveBeenCalled();

    for (const s of ["NEW", "PENDING_REVIEW", "ACTIVE", null]) {
      jest.clearAllMocks();
      db.user.findUnique.mockResolvedValue({ vendorStatus: s });
      const n2 = jest.fn();
      await requireVendorNotSuspended({ user: { id: "v-1", role: "VENDOR", sessionId: "s" } } as any, res(), n2);
      expect(n2).toHaveBeenCalled();
    }
  });

  it("NEW vendors cannot go live; SUSPENDED vendors cannot go live", async () => {
    for (const s of ["NEW", "PENDING_REVIEW", "SUSPENDED", null]) {
      db.user.findUnique.mockResolvedValue({ kycStatus: "VERIFIED", vendorStatus: s });
      await expect(
        updateVendorLive(
          { user: { id: "v-1", role: "VENDOR", sessionId: "s" }, body: { isLive: true } } as any,
          res(),
        ),
      ).rejects.toThrow(/onboarding|suspended/i);
    }
  });

  it("ACTIVE + VERIFIED vendors can go live", async () => {
    const { updateVendorLive: live } = require("../../src/controllers/vendorSettingsController");
    db.user.findUnique.mockResolvedValue({ kycStatus: "VERIFIED", vendorStatus: "ACTIVE" });
    db.user.update.mockImplementation(async (a: any) => ({ isLive: a.data.isLive }));
    const r = res();
    await live(
      { user: { id: "v-1", role: "VENDOR", sessionId: "s" }, body: { isLive: true } } as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

describe("vendor onboarding endpoint", () => {
  it("returns status, canGoLive and steps", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "v-1",
      roles: ["VENDOR"],
      brandName: "B",
      phoneNumber: null,
      kycStatus: "VERIFIED",
      bankName: null,
      bankAccountNumber: null,
      paystackRecipientCode: null,
      vendorStatus: "NEW",
      vendorStatusReason: null,
      vendorStatusChangedAt: new Date(),
      isLive: false,
    });
    const r = res();
    await getVendorOnboarding({ user: { id: "v-1", role: "VENDOR", sessionId: "s" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(200);
    const body = r.json.mock.calls[0][0];
    expect(body.data.status).toBe("NEW");
    expect(body.data.canGoLive).toBe(false);
    expect(body.data.steps).toEqual([
      { key: "profile", done: false },
      { key: "kyc", done: true },
      { key: "bank", done: false, required: false },
    ]);
  });
});

describe("payout holds", () => {
  const { getPendingPayouts, processPayout } = require("../../src/controllers/admin.controller");

  const banked = {
    id: "v-ok",
    name: "Ok",
    brandName: "Ok Foods",
    commissionRate: 0.15,
    bankName: "GTB",
    bankCode: "058",
    bankAccountNumber: "enc:1234",
    paystackRecipientCode: "RCP_1",
    vendorStatus: "ACTIVE",
  };

  it("pending list flags suspended and no-bank vendors as held", async () => {
    db.order.groupBy.mockResolvedValue([
      { vendorId: "v-ok", _sum: { totalPrice: 10000, deliveryFee: 1000 }, _count: { id: 2 } },
      { vendorId: "v-sus", _sum: { totalPrice: 5000, deliveryFee: 500 }, _count: { id: 1 } },
      { vendorId: "v-nobank", _sum: { totalPrice: 3000, deliveryFee: 0 }, _count: { id: 1 } },
    ]);
    db.user.findMany.mockResolvedValue([
      banked,
      { ...banked, id: "v-sus", vendorStatus: "SUSPENDED" },
      { ...banked, id: "v-nobank", bankName: null, bankCode: null, bankAccountNumber: null, paystackRecipientCode: null },
    ]);

    const r = res();
    await getPendingPayouts({} as any, r);
    const pending = r.json.mock.calls[0][0].data.pending;
    const byId = Object.fromEntries(pending.map((p: any) => [p.vendorId, p]));
    expect(byId["v-ok"].held).toBe(false);
    expect(byId["v-ok"].transferVerified).toBe(true);
    expect(byId["v-sus"].held).toBe(true);
    expect(byId["v-sus"].heldReason).toMatch(/suspended/i);
    expect(byId["v-nobank"].held).toBe(true);
    expect(byId["v-nobank"].heldReason).toMatch(/bank/i);
  });

  it("processPayout skips held vendors without creating records", async () => {
    db.user.findUnique.mockResolvedValue({ ...banked, id: "v-sus", vendorStatus: "SUSPENDED", roles: ["VENDOR"] });

    const r = res();
    await processPayout(
      { user: { id: "admin-1", role: "ADMIN", sessionId: "s" }, body: { vendorId: "v-sus" } } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ skipped: expect.objectContaining({ vendorId: "v-sus" }) }) }),
    );
    expect(db.vendorPayout.create).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * Phase 1C TASK7 — vendor onboarding lifecycle tests.
 */
import fs from "fs";
import path from "path";

import { VendorStatus } from "@prisma/client";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  UnauthorizedError,
} from "../../src/errors/AppError";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
    order: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(async () => []), updateMany: jest.fn() },
    // F8: payout selectors now read refund state before paying anything.
    payment: { findMany: jest.fn(async () => []) },
    refundRequest: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
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

describe("migration baseline", () => {
  it("represents the vendor lifecycle in the current schema and migrations", () => {
    // The historical vendor_status migration was intentionally replaced
    // by the clean 1B.3 baseline; assert the current intended state.
    const schema = fs.readFileSync(
      path.join(__dirname, "../../prisma/schema.prisma"),
      "utf8",
    );
    expect(schema).toMatch(/enum VendorStatus/);
    for (const s of ["NEW", "PENDING_REVIEW", "ACTIVE", "SUSPENDED"]) {
      expect(schema).toContain(s);
    }
    expect(schema).toMatch(/vendorStatus\s+VendorStatus\?/);
    expect(schema).toMatch(/vendorStatusReason/);
    expect(schema).toMatch(/vendorStatusChangedAt/);
    // Phase 1D: activation identity is the canonical verified phone.
    expect(schema).toMatch(/phoneNumberE164/);
    expect(schema).toMatch(/isPhoneVerified/);
    expect(schema).toMatch(/phoneVerifiedAt/);

    const dir = path.join(__dirname, "../../prisma/migrations");
    const migs = fs
      .readdirSync(dir)
      .filter((d) => !d.startsWith(".") && d !== "migration_lock.toml");
    expect(migs.length).toBeGreaterThan(0);
    expect(migs.some((d) => d.endsWith("_init"))).toBe(true);
  });
});

describe("evaluateVendorStatus", () => {
  const completeNew = {
    roles: ["CUSTOMER", "VENDOR"],
    vendorStatus: "NEW",
    kycStatus: "VERIFIED",
    brandName: "B",
    phoneNumber: "08031234560",
    phoneNumberE164: "+2348031234560",
    isPhoneVerified: true,
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

  it("requires a canonical phone number (raw phoneNumber is not enough)", async () => {
    db.user.findUnique.mockResolvedValue({
      ...completeNew,
      phoneNumber: "08031234560",
      phoneNumberE164: null,
      isPhoneVerified: false,
    });
    expect(await evaluateVendorStatus("v-1")).toBe("NEW");
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("requires the phone to be verified, not merely present", async () => {
    db.user.findUnique.mockResolvedValue({
      ...completeNew,
      phoneNumberE164: "+2348031234560",
      isPhoneVerified: false,
    });
    expect(await evaluateVendorStatus("v-1")).toBe("NEW");
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("still requires brand and KYC alongside a verified phone", async () => {
    db.user.findUnique.mockResolvedValue({ ...completeNew, brandName: null });
    expect(await evaluateVendorStatus("v-1")).toBe("NEW");
    db.user.findUnique.mockResolvedValue({ ...completeNew, kycStatus: "REJECTED" });
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

  // Phase 1C hardening: the compare-and-swap fallback. The conditional write
  // pins the status it read, so a concurrent writer that already moved the
  // row makes the UPDATE match nothing (count === 0). The service must then
  // report the CONCURRENT status, not the one it attempted.
  it("returns the concurrent status when the conditional update matches nothing", async () => {
    // Read 1 sees NEW with requirements met, so it targets ACTIVE.
    db.user.findUnique
      .mockResolvedValueOnce({ ...completeNew, vendorStatus: "NEW" })
      // Read 2 observes what the concurrent writer actually committed.
      .mockResolvedValueOnce({ vendorStatus: "SUSPENDED" });
    // The conditional UPDATE is refused: an admin suspended the row first.
    db.user.updateMany.mockResolvedValue({ count: 0 });

    const result = await evaluateVendorStatus("v-1");

    // The externally meaningful result is the REAL persisted status.
    expect(result).toBe("SUSPENDED");
    // It must NOT report the attempted status as if it had been saved.
    expect(result).not.toBe("ACTIVE");

    // Exactly one conditional write, and it was conditional — no unconditional
    // retry that could overwrite the concurrent change.
    expect(db.user.updateMany).toHaveBeenCalledTimes(1);
    const [call] = db.user.updateMany.mock.calls;
    expect(call[0].where).toEqual(expect.objectContaining({ id: "v-1", vendorStatus: "NEW" }));
    expect(call[0].data).toEqual(expect.objectContaining({ vendorStatus: "ACTIVE" }));

    // Read 1 (requirements + status) then read 2 (fresh status) — in order.
    expect(db.user.findUnique).toHaveBeenCalledTimes(2);
    expect(db.user.findUnique.mock.calls[1][0].select).toEqual(expect.objectContaining({ vendorStatus: true }));
  });

  it("falls back to the attempted status when the row disappears after a lost race", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ ...completeNew, vendorStatus: "NEW" })
      .mockResolvedValueOnce(null);
    db.user.updateMany.mockResolvedValue({ count: 0 });

    // Documented contract: `fresh?.vendorStatus ?? target`. With no row to read
    // there is nothing better to report, and the caller still learns the
    // outcome it attempted rather than an exception.
    expect(await evaluateVendorStatus("v-1")).toBe("ACTIVE");
    expect(db.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not retry the write after losing the race", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ ...completeNew, vendorStatus: "NEW" })
      .mockResolvedValueOnce({ vendorStatus: "PENDING_REVIEW" });
    db.user.updateMany.mockResolvedValue({ count: 0 });

    await evaluateVendorStatus("v-1");

    // One attempt only. A retry loop here would defeat the whole purpose of
    // the conditional write.
    expect(db.user.updateMany).toHaveBeenCalledTimes(1);
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

  // Phase 1C hardening: the middleware must not turn "I could not read the
  // status" into "this vendor is allowed to write". Each row below is a state
  // the middleware can actually distinguish, and each is asserted separately so
  // a regression in one cannot hide behind another.
  describe("fails closed when the vendor status cannot be established", () => {
    const req = () => ({ user: { id: "v-1", role: "VENDOR", sessionId: "s" } }) as any;

    it("blocks a SUSPENDED vendor and never reaches the protected handler", async () => {
      db.user.findUnique.mockResolvedValue({ vendorStatus: "SUSPENDED" });
      const next = jest.fn();
      await expect(requireVendorNotSuspended(req(), res(), next)).rejects.toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });

    it.each(["NEW", "PENDING_REVIEW", "ACTIVE"])(
      "still allows a %s vendor to write (onboarding must not be blocked)",
      async (status) => {
        db.user.findUnique.mockResolvedValue({ vendorStatus: status });
        const next = jest.fn();
        await requireVendorNotSuspended(req(), res(), next);
        expect(next).toHaveBeenCalledTimes(1);
      },
    );

    it("still allows a genuinely null status through", async () => {
      // `null` is the schema's modelled "holds VENDOR, status system has not
      // run yet" state. It is a REAL status, not an unknown one, so the
      // fail-closed rule must not swallow it — otherwise a brand-new vendor
      // could never create their first product.
      db.user.findUnique.mockResolvedValue({ vendorStatus: null });
      const next = jest.fn();
      await requireVendorNotSuspended(req(), res(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("refuses a MISSING vendor row instead of assuming a valid status", async () => {
      // The regression: `vendor?.vendorStatus ?? null` turned a missing row
      // into the permissive `null` above and let the write through.
      db.user.findUnique.mockResolvedValue(null);
      const next = jest.fn();
      await expect(requireVendorNotSuspended(req(), res(), next)).rejects.toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });

    it("refuses an UNREADABLE vendorStatus field instead of assuming null", async () => {
      // undefined means "the field was not read", which the schema documents
      // as different from a genuine null.
      db.user.findUnique.mockResolvedValue({});
      const next = jest.fn();
      await expect(requireVendorNotSuspended(req(), res(), next)).rejects.toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });

    it("refuses an out-of-enum status value", async () => {
      db.user.findUnique.mockResolvedValue({ vendorStatus: "SOMETHING_ELSE" });
      const next = jest.fn();
      await expect(requireVendorNotSuspended(req(), res(), next)).rejects.toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });

    it("uses the same unresolved-status message as the order-lifecycle guard", async () => {
      // One policy, one message: the middleware and orderController must not
      // drift into telling the client two different things.
      db.user.findUnique.mockResolvedValue(null);
      const next = jest.fn();
      await expect(requireVendorNotSuspended(req(), res(), next)).rejects.toThrow(
        /could not confirm your vendor account status/i,
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("propagates a database read failure rather than reporting a status", async () => {
      // An infrastructure failure must NOT be laundered into a vendor status.
      // It propagates to the error handler, which renders it as a 500 and
      // never calls next().
      const boom = new Error("database unavailable");
      db.user.findUnique.mockRejectedValue(boom);
      const next = jest.fn();
      await expect(requireVendorNotSuspended(req(), res(), next)).rejects.toThrow(boom);
      expect(next).not.toHaveBeenCalled();
    });

    it("still rejects an unauthenticated request before reading the database", async () => {
      const next = jest.fn();
      await expect(
        requireVendorNotSuspended({ user: undefined } as any, res(), next),
      ).rejects.toThrow(UnauthorizedError);
      expect(next).not.toHaveBeenCalled();
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });
  });
});

describe("vendor onboarding endpoint", () => {
  it("returns status, canGoLive and steps", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "v-1",
      roles: ["VENDOR"],
      brandName: "B",
      phoneNumber: null,
      phoneNumberE164: null,
      isPhoneVerified: false,
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
    expect(body.data.phoneVerified).toBe(false);
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
    // F8: getPendingPayouts now filters at order grain before aggregating, so
    // the mock returns per-order rows whose sums match the previous groupBy.
    db.order.findMany.mockResolvedValue([
      { id: "ok1", vendorId: "v-ok", totalPrice: 5000, deliveryFee: 500, idempotencyKey: "k1" },
      { id: "ok2", vendorId: "v-ok", totalPrice: 5000, deliveryFee: 500, idempotencyKey: "k2" },
      { id: "sus1", vendorId: "v-sus", totalPrice: 5000, deliveryFee: 500, idempotencyKey: "k3" },
      { id: "nob1", vendorId: "v-nobank", totalPrice: 3000, deliveryFee: 0, idempotencyKey: "k4" },
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

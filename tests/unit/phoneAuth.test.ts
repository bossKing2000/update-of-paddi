/**
 * Phase 1D.3 — phone OTP API tests.
 *
 * Full controller path with the REAL OTP service against FakeRedis and an
 * in-memory SMS provider; only Prisma (PostgreSQL) is mocked.
 */
process.env.PHONE_OTP_SECRET = "test-only-phone-otp-secret-do-not-use-in-prod";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  get redisUsersSessions() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../helpers/fakeRedis").testRedis.current;
  },
  redisPayments: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
  },
}));

import { Prisma } from "@prisma/client";
import prisma from "../../src/lib/prisma";
import { FakeRedis, testRedis } from "../helpers/fakeRedis";
import { requestPhoneOtp, verifyPhoneOtp, removePhone } from "../../src/controllers/auth.controller";
import { OtpPurpose, otpKeyFor, otpIpRateLimitKeyFor, otpRateLimitKeyFor, OTP_MAX_ATTEMPTS, requestOtp } from "../../src/services/phoneOtp.service";
import {
  InMemorySmsProvider,
  FailingSmsProvider,
  __setSmsProviderForTests,
} from "../../src/services/sms/smsProvider";

const db = prisma as unknown as {
  user: { findUnique: jest.Mock; update: jest.Mock };
};

interface UserRow {
  id: string;
  phoneNumber: string | null;
  phoneNumberE164: string | null;
  isPhoneVerified: boolean;
  phoneVerifiedAt: Date | null;
  password?: string | null;
  isEmailVerified?: boolean;
  googleId?: string | null;
}

const users = new Map<string, UserRow>();

function seedUser(row: Partial<UserRow> & { id: string }): UserRow {
  const full: UserRow = {
    phoneNumber: null,
    phoneNumberE164: null,
    isPhoneVerified: false,
    phoneVerifiedAt: null,
    isEmailVerified: true,
    googleId: null,
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

// `ip` is what Express resolved under the app's `trust proxy` setting; the
// controller must key its per-IP budget on this, never on a raw header.
const authed = (id: string, body: unknown, ip = "198.51.100.20") =>
  ({
    user: { id, role: "CUSTOMER", sessionId: "s1" },
    body,
    ip,
    headers: {},
    socket: {},
  }) as never;

let redis: FakeRedis;
let sms: InMemorySmsProvider;

beforeEach(() => {
  jest.clearAllMocks();
  users.clear();
  redis = new FakeRedis();
  testRedis.current = redis;
  sms = new InMemorySmsProvider();
  __setSmsProviderForTests(sms);

  db.user.findUnique.mockImplementation(async (args: any) => {
    if (args?.where?.id) return users.get(args.where.id) ?? null;
    if (args?.where && "phoneNumberE164" in args.where) {
      for (const u of users.values()) {
        if (u.phoneNumberE164 === args.where.phoneNumberE164) {
          return { id: u.id };
        }
      }
      return null;
    }
    return null;
  });
  db.user.update.mockImplementation(async (args: any) => {
    const existing = users.get(args.where.id);
    if (!existing) throw new Error("User not found");
    // Emulate the real User_phoneNumberE164_key unique index. The
    // controller's ownership pre-check is inherently racy, so the database
    // constraint is what actually guarantees one verified owner.
    if (
      typeof args.data?.phoneNumberE164 === "string" &&
      args.data.phoneNumberE164 !== null
    ) {
      const clash = [...users.values()].find(
        (u) => u.id !== existing.id && u.phoneNumberE164 === args.data.phoneNumberE164,
      );
      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["phoneNumberE164"] },
        });
      }
    }
    const updated = { ...existing, ...args.data };
    users.set(existing.id, updated);
    return updated;
  });
});

afterEach(() => {
  __setSmsProviderForTests(null);
  testRedis.current = null;
});

function bodyOf(r: any): any {
  return r.json.mock.calls[0][0];
}

function statusOf(r: any): number {
  return r.status.mock.calls[0][0];
}

describe("POST /phone/request-otp", () => {
  it("sends an OTP for a valid Nigerian number without exposing it", async () => {
    seedUser({ id: "u1" });
    const r = mockRes();
    await requestPhoneOtp(
      authed("u1", { phoneNumber: "08031234560", purpose: "PHONE_VERIFICATION" }),
      r,
    );
    expect(r.status).toHaveBeenCalledWith(200);
    expect(bodyOf(r)).toEqual({ message: "Verification code sent" });
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].to).toBe("+2348031234560");
    expect(sms.sent[0].otp).toMatch(/^\d{6}$/);
    expect(sms.sent[0].purpose).toBe(OtpPurpose.PHONE_VERIFICATION);
    expect(JSON.stringify(bodyOf(r))).not.toMatch(/\d{6}/);
    // Requesting a code must not, by itself, change the caller's identity.
    // These read the write-through user store (db.user.update writes back into
    // `users`), so a regression that granted verification at request time
    // would flip these rather than pass them vacuously. Verification is only
    // ever granted by POST /phone/verify-otp after a valid code.
    expect(users.get("u1")!.phoneNumberE164).toBeNull();
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
  });

  it("accepts valid international numbers and normalizes equivalents", async () => {
    seedUser({ id: "u1" });
    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "+14155552670" }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(sms.sent[0].to).toBe("+14155552670");
  });

  it("rejects invalid numbers without touching OTP state or SMS", async () => {
    seedUser({ id: "u1" });
    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "not-a-number" }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(sms.sent).toHaveLength(0);
    expect(redis.store.size).toBe(0);
  });

  it("rejects unauthenticated requests", async () => {
    const r = mockRes();
    await requestPhoneOtp({ body: { phoneNumber: "08031234560" } } as never, r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(sms.sent).toHaveLength(0);
  });

  it("rejects undisclosed purposes on the authenticated endpoint", async () => {
    seedUser({ id: "u1" });
    // PHONE_LOGIN is deliberately NOT accepted here: the authenticated
    // endpoints attach a number to the caller's own account, and letting
    // them mint a PHONE_LOGIN code would start a login for a number the
    // caller may not own. It has its own public pair instead.
    for (const purpose of ["PHONE_LOGIN", "PHONE_PASSWORD_RESET", "ADMIN"]) {
      const r = mockRes();
      await requestPhoneOtp(authed("u1", { phoneNumber: "08031234561", purpose }), r);
      expect(r.status).toHaveBeenCalledWith(422);
    }
    expect(sms.sent).toHaveLength(0);
  });

  it("is idempotent for an already-verified number", async () => {
    seedUser({ id: "u1", phoneNumber: "08031234562", phoneNumberE164: "+2348031234562", isPhoneVerified: true });
    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "+2348031234562" }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(bodyOf(r)).toEqual({ message: "Phone number already verified" });
    expect(sms.sent).toHaveLength(0);
  });

  // Phase 1D.4: these two used to be 409 "This phone number is unavailable"
  // versus 200 "Verification code sent", which answered "is this number
  // registered to somebody?" for free. Ownership now gates delivery only.
  it("answers a number owned by another account exactly like an unclaimed one", async () => {
    seedUser({ id: "u1" });
    seedUser({ id: "u2", phoneNumberE164: "+2348031234563", isPhoneVerified: true });

    const taken = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234563" }), taken);

    const unclaimed = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234564" }), unclaimed);

    // Byte-identical, so the probe is unanswerable.
    expect(statusOf(taken)).toBe(200);
    expect(statusOf(taken)).toBe(statusOf(unclaimed));
    expect(JSON.stringify(bodyOf(taken))).toBe(JSON.stringify(bodyOf(unclaimed)));
    expect(bodyOf(taken)).toEqual({ message: "Verification code sent" });
    expect(JSON.stringify(bodyOf(taken))).not.toContain("u2");
    expect(JSON.stringify(bodyOf(taken))).not.toMatch(/unavailable|409/);
  });

  it("sends no SMS for a number owned by another account and still spends the budgets", async () => {
    seedUser({ id: "u1" });
    const target = "+2348031234565";
    seedUser({ id: "u2", phoneNumberE164: target, isPhoneVerified: true });
    const ip = "203.0.113.9";

    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234565" }, ip), r);
    expect(statusOf(r)).toBe(200);

    // Nothing was delivered, so no usable code ever leaves Redis for a number
    // the caller does not control, and none is disclosed in the body.
    expect(sms.sent).toHaveLength(0);
    expect(JSON.stringify(bodyOf(r))).not.toMatch(/\d{6}/);

    // ...but the probe is not free: the per-phone request budget, the per-IP
    // budget and the resend cooldown are all charged, so enumerating this
    // endpoint is bounded by the same cross-instance limits as any other OTP
    // request. Skipping them would have turned the generic body back into an
    // unlimited oracle.
    expect(await redis.get(otpRateLimitKeyFor(target))).toBe("1");
    expect(await redis.get(otpIpRateLimitKeyFor(ip))).toBe("1");

    const again = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234565" }, ip), again);
    expect(statusOf(again)).toBe(429);
    expect(bodyOf(again)).toEqual({ message: "Please wait before requesting another code" });
  });

  it("enforces resend cooldown without sending again", async () => {
    seedUser({ id: "u1" });
    const first = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234564" }), first);
    expect(first.status).toHaveBeenCalledWith(200);
    const second = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234564" }), second);
    expect(second.status).toHaveBeenCalledWith(429);
    expect(sms.sent).toHaveLength(1);
  });

  it("returns 404 for unknown users", async () => {
    const r = mockRes();
    await requestPhoneOtp(authed("ghost", { phoneNumber: "08031234565" }), r);
    expect(r.status).toHaveBeenCalledWith(404);
    expect(sms.sent).toHaveLength(0);
  });

  it("fails safely when SMS delivery fails and leaves no misleading OTP", async () => {
    seedUser({ id: "u1" });
    __setSmsProviderForTests(new FailingSmsProvider());
    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234566" }), r);
    expect(r.status).toHaveBeenCalledWith(502);
    expect(bodyOf(r)).toEqual({ message: "Failed to send verification code, please try again" });
    // The orphaned OTP was invalidated: a retry is not cooldown-blocked.
    const retry = mockRes();
    __setSmsProviderForTests(sms);
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234566" }), retry);
    expect(retry.status).toHaveBeenCalledWith(200);
  });

  it("returns 503 when Redis is unavailable", async () => {
    seedUser({ id: "u1" });
    redis.fail = true;
    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234567" }), r);
    expect(r.status).toHaveBeenCalledWith(503);
    expect(sms.sent).toHaveLength(0);
  });

  it("applies the per-IP budget on the authenticated path too", async () => {
    seedUser({ id: "u1" });
    const ip = "203.0.113.42";
    // Distinct numbers so only the shared IP budget can be what refuses.
    for (let i = 0; i < 20; i++) {
      const r = mockRes();
      await requestPhoneOtp(
        authed("u1", { phoneNumber: `0${String(8031234567 + 200 + i)}` }, ip),
        r,
      );
      expect(r.status).toHaveBeenCalledWith(200);
    }
    const limited = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234998" }, ip), limited);
    expect(limited.status).toHaveBeenCalledWith(429);
    expect(bodyOf(limited)).toEqual({
      message: "Too many OTP requests, please try again later",
    });
    expect(sms.sent).toHaveLength(20);
  });

  it("keys the IP budget on the address Express resolved, not a forged header", async () => {
    seedUser({ id: "u1" });
    const realIp = "203.0.113.77";
    // Exhaust this caller's whole 20-request IP budget using the address
    // Express resolved for them.
    for (let i = 0; i < 20; i++) {
      const r = mockRes();
      await requestPhoneOtp(
        authed("u1", { phoneNumber: `0${String(8031234567 + 300 + i)}` }, realIp),
        r,
      );
      expect(r.status).toHaveBeenCalledWith(200);
    }
    // A caller who forges X-Forwarded-For still lands in the same bucket:
    // the controller reads req.ip, which the header cannot influence.
    const forged = mockRes();
    await requestPhoneOtp(
      {
        user: { id: "u1", role: "CUSTOMER", sessionId: "s1" },
        body: { phoneNumber: "08031234997" },
        ip: realIp,
        headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" },
        socket: {},
      } as never,
      forged,
    );
    expect(forged.status).toHaveBeenCalledWith(429);
    // No budget was minted for the address the header claimed.
    expect(await redis.get(otpIpRateLimitKeyFor("9.9.9.9"))).toBeNull();
    expect(await redis.get(otpIpRateLimitKeyFor("8.8.8.8"))).toBeNull();
  });
});

describe("POST /phone/verify-otp", () => {
  async function requestFor(userId: string, phone: string, purpose = "PHONE_VERIFICATION") {
    const r = mockRes();
    await requestPhoneOtp(authed(userId, { phoneNumber: phone, purpose }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    return sms.sent[sms.sent.length - 1].otp;
  }

  it("verifies a correct OTP and updates the user record", async () => {
    seedUser({ id: "u1", phoneNumber: "08031234568" });
    const otp = await requestFor("u1", "08031234568");
    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234568", otp }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(bodyOf(r)).toEqual({
      message: "Phone number verified successfully",
      phoneNumberE164: "+2348031234568",
    });
    expect(JSON.stringify(bodyOf(r))).not.toContain(otp);
    const user = users.get("u1")!;
    expect(user.phoneNumberE164).toBe("+2348031234568");
    expect(user.isPhoneVerified).toBe(true);
    expect(user.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it("accepts equivalent representations of the same number", async () => {
    seedUser({ id: "u1" });
    const otp = await requestFor("u1", "08031234569");
    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "+2348031234569", otp }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
  });

  it("rejects an incorrect OTP without updating the user", async () => {
    seedUser({ id: "u1" });
    await requestFor("u1", "08031234570");
    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234570", otp: "000000" }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects expired OTPs and exhausted attempts", async () => {
    seedUser({ id: "u1" });
    await requestFor("u1", "+14155552670");
    redis.expireNow(otpKeyFor(OtpPurpose.PHONE_VERIFICATION, "+14155552670"));
    const expired = mockRes();
    await verifyPhoneOtp(
      authed("u1", { phoneNumber: "+14155552670", otp: "123456" }),
      expired,
    );
    expect(expired.status).toHaveBeenCalledWith(400);

    seedUser({ id: "u2" });
    const otp = await requestFor("u2", "+14155552672");
    const wrong = otp === "000000" ? "000001" : "000000";
    // Phase 1D.38: five wrong codes are each answered 400 INVALID...
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      const r = mockRes();
      await verifyPhoneOtp(authed("u2", { phoneNumber: "+14155552672", otp: wrong }), r);
      expect(r.status).toHaveBeenCalledWith(400);
      expect(bodyOf(r)).toEqual({ message: "Invalid verification code" });
    }
    // ...and the one after that is refused outright.
    const locked = mockRes();
    await verifyPhoneOtp(authed("u2", { phoneNumber: "+14155552672", otp: wrong }), locked);
    expect(locked.status).toHaveBeenCalledWith(429);
    // The OTP is gone afterwards: the real code no longer authenticates.
    const gone = mockRes();
    await verifyPhoneOtp(authed("u2", { phoneNumber: "+14155552672", otp }), gone);
    expect(gone.status).toHaveBeenCalledWith(400);
    expect(users.get("u2")!.isPhoneVerified).toBe(false);
  });

  it("is idempotent for an already-verified number", async () => {
    seedUser({
      id: "u1",
      phoneNumber: "+2348031234561",
      phoneNumberE164: "+2348031234561",
      isPhoneVerified: true,
    });
    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234561", otp: "123456" }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("blocks claiming a number taken since the request", async () => {
    seedUser({ id: "u1" });
    seedUser({ id: "u2" });
    const otp = await requestFor("u1", "08031234562");
    // Another account claims the number before u1 verifies.
    users.get("u2")!.phoneNumberE164 = "+2348031234562";
    users.get("u2")!.isPhoneVerified = true;
    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234562", otp }), r);
    // The ownership check now runs only after the code is accepted, so the
    // answer is the ordinary failed-verification one rather than a 409 that
    // names the situation.
    expect(statusOf(r)).toBe(400);
    expect(bodyOf(r)).toEqual({ message: "Invalid verification code" });
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
    expect(users.get("u1")!.phoneNumberE164).toBeNull();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("maps a unique-constraint race to the same safe failure", async () => {
    seedUser({ id: "u1" });
    const otp = await requestFor("u1", "08031234563");
    db.user.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234563", otp }), r);
    expect(statusOf(r)).toBe(400);
    expect(bodyOf(r)).toEqual({ message: "Invalid verification code" });
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
  });

  it("never reports success when the database update fails", async () => {
    seedUser({ id: "u1" });
    const otp = await requestFor("u1", "08031234564");
    db.user.update.mockRejectedValueOnce(new Error("db down"));
    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234564", otp }), r);
    expect(r.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(bodyOf(r))).not.toContain("verified successfully");
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
  });

  it("returns 503 when Redis is unavailable", async () => {
    seedUser({ id: "u1", phoneNumberE164: "+2348031234565", isPhoneVerified: false });
    redis.fail = true;
    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234565", otp: "123456" }), r);
    expect(r.status).toHaveBeenCalledWith(503);
  });

  it("rejects unauthenticated, malformed and invalid input", async () => {
    const anon = mockRes();
    await verifyPhoneOtp({ body: { phoneNumber: "08031234566", otp: "123456" } } as never, anon);
    expect(anon.status).toHaveBeenCalledWith(401);

    seedUser({ id: "u1" });
    const badOtp = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234566", otp: "12" }), badOtp);
    expect(badOtp.status).toHaveBeenCalledWith(422);

    const badPhone = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "xyz", otp: "123456" }), badPhone);
    expect(badPhone.status).toHaveBeenCalledWith(400);
  });
});

// Phase 1D.4: the authenticated add/verify pair must not answer "is this
  // number registered to somebody?". Both endpoints are private, so the
  // attacker here is a signed-in user, and the guarantee they need is that
  // every observable outcome is identical across ownership.
describe("authenticated phone-number enumeration (Phase 1D.4)", () => {
  const TAKEN = "+2348031234571";
  const FREE = "+2348031234572";

  /** u1 probes both numbers; u2 already owns TAKEN. */
  function seedProbe() {
    seedUser({ id: "u1" });
    seedUser({ id: "u2", phoneNumberE164: TAKEN, isPhoneVerified: true });
  }

  async function requestBoth() {
    const taken = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234571" }), taken);
    const free = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234572" }), free);
    expect(statusOf(taken)).toBe(200);
    expect(statusOf(free)).toBe(200);
    return { taken, free };
  }

  it("answers an invalid code identically whether or not the number is taken", async () => {
    seedProbe();
    await requestBoth();

    const taken = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234571", otp: "000000" }), taken);
    const free = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234572", otp: "000000" }), free);

    expect(statusOf(taken)).toBe(400);
    expect(statusOf(taken)).toBe(statusOf(free));
    expect(JSON.stringify(bodyOf(taken))).toBe(JSON.stringify(bodyOf(free)));
    expect(bodyOf(taken)).toEqual({ message: "Invalid verification code" });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("runs the same attempt accounting for a taken number as for a free one", async () => {
    // The old pre-check short-circuited before verifyOtp, so a taken number
    // answered 400 forever while a free one reached MAX_ATTEMPTS. That was a
    // stronger oracle than the status code it replaced.
    seedProbe();
    await requestBoth();

    const wrong = "000000";
    for (const number of ["08031234571", "08031234572"]) {
      for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
        const r = mockRes();
        await verifyPhoneOtp(authed("u1", { phoneNumber: number, otp: wrong }), r);
        expect(statusOf(r)).toBe(400);
        expect(bodyOf(r)).toEqual({ message: "Invalid verification code" });
      }
      const locked = mockRes();
      await verifyPhoneOtp(authed("u1", { phoneNumber: number, otp: wrong }), locked);
      expect(statusOf(locked)).toBe(429);
      expect(bodyOf(locked)).toEqual({ message: "Too many attempts, please request a new code" });
    }
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
  });

  it("consumes a correct code for a taken number without ever attaching it", async () => {
    seedProbe();
    // A code for a number the caller cannot receive still exists when one was
    // issued through the service directly (a probe stores the record and
    // suppresses only the delivery), which is exactly the case that reaches
    // the post-verification ownership check.
    const issued = await requestOtp(
      { phoneNumber: TAKEN, purpose: OtpPurpose.PHONE_VERIFICATION, ip: "198.51.100.20" },
      { exposeOtp: true },
    );
    const otp = issued.otp!;
    expect(otp).toMatch(/^\d{6}$/);

    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234571", otp }), r);
    expect(statusOf(r)).toBe(400);
    expect(bodyOf(r)).toEqual({ message: "Invalid verification code" });

    // Never verified, never written, and the owner is untouched.
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
    expect(users.get("u1")!.phoneNumberE164).toBeNull();
    expect(users.get("u2")!.phoneNumberE164).toBe(TAKEN);
    expect(db.user.update).not.toHaveBeenCalled();

    // Single-use is preserved: the code cannot be replayed into a second
    // answer that might differ.
    const replay = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234571", otp }), replay);
    expect(statusOf(replay)).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("does not mark a free number verified when the ownership re-check fails", async () => {
    // The ownership re-check is the only thing standing between a consumed
    // code and a verified write, so it must still refuse the write.
    seedUser({ id: "u1" });
    const otp = (await requestOtp(
      { phoneNumber: FREE, purpose: OtpPurpose.PHONE_VERIFICATION, ip: "198.51.100.20" },
      { exposeOtp: true },
    )).otp!;

    // The number is claimed by somebody else between issuing and verifying.
    seedUser({ id: "u2", phoneNumberE164: FREE, isPhoneVerified: true });

    const r = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234572", otp }), r);
    expect(statusOf(r)).toBe(400);
    expect(bodyOf(r)).toEqual({ message: "Invalid verification code" });
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

// Shared step-up credential for the phone-change and phone-removal flows.
const PASSWORD = "Correct123!";
let passwordHash: string;

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bcrypt = require("bcryptjs") as typeof import("bcryptjs");
  passwordHash = bcrypt.hashSync(PASSWORD, 4);
});

describe("verified-phone change (step-up)", () => {
  function verifiedUser(id: string, e164: string, password?: string | null) {
    return seedUser({
      id,
      phoneNumber: e164,
      phoneNumberE164: e164,
      isPhoneVerified: true,
      phoneVerifiedAt: new Date(),
      password: password === undefined ? passwordHash : password,
    });
  }

  it("requires the current password to change a verified phone", async () => {
    verifiedUser("u1", "+2348031234560");
    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234561" }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(bodyOf(r)).toEqual({
      message: "Current password is required to change your phone number",
    });
    expect(sms.sent).toHaveLength(0);
    expect(users.get("u1")!.phoneNumberE164).toBe("+2348031234560");
  });

  it("rejects a wrong step-up password and keeps the old phone", async () => {
    verifiedUser("u1", "+2348031234560");
    const r = mockRes();
    await requestPhoneOtp(
      authed("u1", { phoneNumber: "08031234561", currentPassword: "Wrong123!" }),
      r,
    );
    expect(r.status).toHaveBeenCalledWith(401);
    expect(sms.sent).toHaveLength(0);
    expect(users.get("u1")!.phoneNumberE164).toBe("+2348031234560");
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
  });

  it("changes the phone with correct step-up plus new-number OTP", async () => {
    verifiedUser("u1", "+2348031234560");
    const req = mockRes();
    await requestPhoneOtp(
      authed("u1", { phoneNumber: "08031234561", currentPassword: PASSWORD }),
      req,
    );
    expect(req.status).toHaveBeenCalledWith(200);
    const otp = sms.sent[sms.sent.length - 1].otp;
    const ver = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234561", otp }), ver);
    expect(ver.status).toHaveBeenCalledWith(200);
    const user = users.get("u1")!;
    expect(user.phoneNumberE164).toBe("+2348031234561");
    expect(user.isPhoneVerified).toBe(true);
    expect(user.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it("leaves the old phone when the new-number OTP fails", async () => {
    verifiedUser("u1", "+2348031234560");
    const req = mockRes();
    await requestPhoneOtp(
      authed("u1", { phoneNumber: "08031234561", currentPassword: PASSWORD }),
      req,
    );
    expect(req.status).toHaveBeenCalledWith(200);
    const ver = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234561", otp: "000000" }), ver);
    expect(ver.status).toHaveBeenCalledWith(400);
    const user = users.get("u1")!;
    expect(user.phoneNumberE164).toBe("+2348031234560");
    expect(user.isPhoneVerified).toBe(true);
  });

  it("lets passwordless (Google-only) accounts proceed with new-number OTP", async () => {
    verifiedUser("u1", "+2348031234560", null);
    const req = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234561" }), req);
    expect(req.status).toHaveBeenCalledWith(200);
    const otp = sms.sent[sms.sent.length - 1].otp;
    const ver = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234561", otp }), ver);
    expect(ver.status).toHaveBeenCalledWith(200);
    expect(users.get("u1")!.phoneNumberE164).toBe("+2348031234561");
  });

  it("does not treat the same number as a change", async () => {
    verifiedUser("u1", "+2348031234560");
    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234560" }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(bodyOf(r)).toEqual({ message: "Phone number already verified" });
    expect(sms.sent).toHaveLength(0);
  });
});

describe("SMS abstraction", () => {
  it("hands the canonical number and purpose to the provider", async () => {
    seedUser({ id: "u1" });
    const r = mockRes();
    await requestPhoneOtp(
      authed("u1", { phoneNumber: "2348031234567", purpose: "PHONE_CHANGE" }),
      r,
    );
    expect(r.status).toHaveBeenCalledWith(200);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toEqual({
      to: "+2348031234567",
      otp: expect.stringMatching(/^\d{6}$/),
      purpose: OtpPurpose.PHONE_CHANGE,
    });
  });

  it("needs no production provider for the test path", async () => {
    delete process.env.SMS_PROVIDER;
    seedUser({ id: "u1" });
    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234568" }), r);
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

describe("DELETE /phone (phone management)", () => {
  function verified(id: string, e164: string, extra: Partial<UserRow> = {}) {
    return seedUser({
      id,
      phoneNumber: e164,
      phoneNumberE164: e164,
      isPhoneVerified: true,
      phoneVerifiedAt: new Date(),
      password: passwordHash,
      isEmailVerified: true,
      ...extra,
    });
  }

  it("removes the caller's own phone and clears every verification field", async () => {
    verified("u1", "+2348031234560");
    const r = mockRes();
    await removePhone(authed("u1", { currentPassword: PASSWORD }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(bodyOf(r)).toEqual({ message: "Phone number removed successfully" });
    const user = users.get("u1")!;
    expect(user.phoneNumberE164).toBeNull();
    expect(user.phoneNumber).toBeNull();
    expect(user.isPhoneVerified).toBe(false);
    expect(user.phoneVerifiedAt).toBeNull();
  });

  it("requires the current password as step-up", async () => {
    verified("u1", "+2348031234560");
    const missing = mockRes();
    await removePhone(authed("u1", {}), missing);
    expect(missing.status).toHaveBeenCalledWith(400);
    expect(bodyOf(missing)).toEqual({
      message: "Current password is required to remove your phone number",
    });
    expect(users.get("u1")!.isPhoneVerified).toBe(true);

    const wrong = mockRes();
    await removePhone(authed("u1", { currentPassword: "Nope123!" }), wrong);
    expect(wrong.status).toHaveBeenCalledWith(401);
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("refuses to remove the account's only usable login method", async () => {
    // No password, no Google, email never verified: the verified phone is
    // the one thing that can sign this account in.
    verified("u1", "+2348031234560", { password: null, isEmailVerified: false, googleId: null });
    const r = mockRes();
    await removePhone(authed("u1", {}), r);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(bodyOf(r)).toEqual({
      message: "Add and verify another login method before removing your phone number",
    });
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("allows removal when a verified email login still works", async () => {
    verified("u1", "+2348031234560", { isEmailVerified: true });
    const r = mockRes();
    await removePhone(authed("u1", { currentPassword: PASSWORD }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
  });

  it("allows removal when a Google login still works", async () => {
    // Passwordless Google account: there is no password to re-check, and
    // the OAuth identity survives the removal.
    verified("u1", "+2348031234560", {
      password: null,
      isEmailVerified: false,
      googleId: "google-sub-1",
    });
    const r = mockRes();
    await removePhone(authed("u1", {}), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
  });

  it("can only ever target the calling account", async () => {
    verified("u1", "+2348031234560");
    verified("u2", "+2348031234561");
    // The request names no user id at all: there is nothing a caller can
    // put in the body to point this at somebody else's row.
    const r = mockRes();
    await removePhone(
      { user: { id: "u1", role: "CUSTOMER", sessionId: "s1" }, body: {
        userId: "u2",
        phoneNumberE164: "+2348031234561",
        currentPassword: PASSWORD,
      } } as never,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(200);
    expect(users.get("u1")!.isPhoneVerified).toBe(false);
    expect(users.get("u2")!.isPhoneVerified).toBe(true);
    expect(users.get("u2")!.phoneNumberE164).toBe("+2348031234561");
  });

  it("rejects unauthenticated removal", async () => {
    verified("u1", "+2348031234560");
    const r = mockRes();
    await removePhone({ body: { currentPassword: PASSWORD } } as never, r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
  });

  it("is idempotent when there is no phone to remove", async () => {
    seedUser({ id: "u1", isEmailVerified: true, password: passwordHash });
    const r = mockRes();
    await removePhone(authed("u1", {}), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(bodyOf(r)).toEqual({ message: "No phone number to remove" });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("invalidates outstanding OTPs for the removed number", async () => {
    verified("u1", "+2348031234560");
    const removedNumber = "+2348031234560";
    for (const purpose of [OtpPurpose.PHONE_VERIFICATION, OtpPurpose.PHONE_CHANGE]) {
      redis.set(
        otpKeyFor(purpose, removedNumber),
        JSON.stringify({ d: "x", a: 0, c: Date.now(), s: Date.now() }),
        { EX: 300 },
      );
    }
    const r = mockRes();
    await removePhone(authed("u1", { currentPassword: PASSWORD }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    // No code issued while the number was attached survives its removal.
    expect(redis.raw(otpKeyFor(OtpPurpose.PHONE_VERIFICATION, removedNumber))).toBeNull();
    expect(redis.raw(otpKeyFor(OtpPurpose.PHONE_CHANGE, removedNumber))).toBeNull();
  });

  it("lets a removed number be re-added and verified by the normal rules", async () => {
    verified("u1", "+2348031234560");
    await removePhone(authed("u1", { currentPassword: PASSWORD }), mockRes());
    expect(users.get("u1")!.phoneNumberE164).toBeNull();

    // The canonical column is free again, so the same number verifies afresh.
    const req = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: "08031234560" }), req);
    expect(req.status).toHaveBeenCalledWith(200);
    const otp = sms.sent[sms.sent.length - 1].otp;
    const ver = mockRes();
    await verifyPhoneOtp(authed("u1", { phoneNumber: "08031234560", otp }), ver);
    expect(ver.status).toHaveBeenCalledWith(200);
    expect(users.get("u1")!.phoneNumberE164).toBe("+2348031234560");
    expect(users.get("u1")!.isPhoneVerified).toBe(true);
    expect(users.get("u1")!.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it("frees the number for another account to claim", async () => {
    verified("u1", "+2348031234560");
    seedUser({ id: "u2" });
    const claim = mockRes();
    // While u1 holds it, u2 gets the ordinary unclaimed answer and no SMS.
    // The probe still spends the per-phone budget, but the removal clears the
    // record, so the cooldown does not survive it.
    await requestPhoneOtp(authed("u2", { phoneNumber: "08031234560" }), claim);
    expect(statusOf(claim)).toBe(200);
    expect(bodyOf(claim)).toEqual({ message: "Verification code sent" });
    expect(sms.sent).toHaveLength(0);

    await removePhone(authed("u1", { currentPassword: PASSWORD }), mockRes());

    const after = mockRes();
    await requestPhoneOtp(authed("u2", { phoneNumber: "08031234560" }), after);
    expect(after.status).toHaveBeenCalledWith(200);
    const otp = sms.sent[sms.sent.length - 1].otp;
    const ver = mockRes();
    await verifyPhoneOtp(authed("u2", { phoneNumber: "08031234560", otp }), ver);
    expect(ver.status).toHaveBeenCalledWith(200);
    expect(users.get("u2")!.phoneNumberE164).toBe("+2348031234560");
    expect(users.get("u2")!.isPhoneVerified).toBe(true);
  });
});

describe("verified-phone uniqueness under concurrency", () => {
  const target = "08031234563";
  const targetE164 = "+2348031234563";

  /** Give u1 the number as a first-time addition. */
  async function u1Requests(): Promise<string> {
    seedUser({ id: "u1" });
    const r = mockRes();
    await requestPhoneOtp(authed("u1", { phoneNumber: target }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    return sms.sent[sms.sent.length - 1].otp;
  }

  /**
   * Give u2 a code for the same number by moving its own verified number
   * there. The two flows use different OTP purposes, so both accounts can
   * hold a valid code for the same number simultaneously.
   */
  async function u2Requests(): Promise<string> {
    seedUser({
      id: "u2",
      phoneNumber: "+2348031234599",
      phoneNumberE164: "+2348031234599",
      isPhoneVerified: true,
      phoneVerifiedAt: new Date(),
      password: passwordHash,
      isEmailVerified: true,
    });
    const r = mockRes();
    await requestPhoneOtp(
      authed("u2", { phoneNumber: target, purpose: "PHONE_CHANGE", currentPassword: PASSWORD }),
      r,
    );
    expect(r.status).toHaveBeenCalledWith(200);
    return sms.sent[sms.sent.length - 1].otp;
  }

  const ownersOfTarget = () =>
    [...users.values()].filter((u) => u.phoneNumberE164 === targetE164);

  it("never lets both accounts end up owning the same number", async () => {
    const otpA = await u1Requests();
    const otpB = await u2Requests();
    expect(otpB).not.toBe(otpA);

    const first = mockRes();
    const second = mockRes();
    await Promise.all([
      verifyPhoneOtp(authed("u1", { phoneNumber: target, otp: otpA }), first),
      verifyPhoneOtp(authed("u2", { phoneNumber: target, otp: otpB, purpose: "PHONE_CHANGE" }), second),
    ]);

    expect(ownersOfTarget()).toHaveLength(1);
    expect(ownersOfTarget()[0].isPhoneVerified).toBe(true);
    expect([first, second].map(statusOf).sort()).toEqual([200, 400]);
    // The loser's body never claims success, never carries the number, and
    // never says who holds it.
    const loser = statusOf(first) === 400 ? first : second;
    expect(bodyOf(loser)).toEqual({ message: "Invalid verification code" });
    expect(JSON.stringify(bodyOf(loser))).not.toContain(targetE164);
    // The loser keeps whatever number it legitimately owned before.
    expect(users.get("u2")!.phoneNumberE164).toBe("+2348031234599");
  });

  it("lets the unique index break the tie when both ownership re-checks miss", async () => {
    const otpA = await u1Requests();
    const otpB = await u2Requests();

    // Worst case for the application-level guard: both accounts' post-OTP
    // ownership re-check finds no owner, so neither controller steps aside.
    // Only the database constraint can still stop a double owner.
    const realFindUnique = db.user.findUnique.getMockImplementation()!;
    db.user.findUnique.mockImplementation(async (args: any) => {
      if (args?.where && "phoneNumberE164" in args.where) return null;
      return realFindUnique(args);
    });
    const realUpdate = db.user.update.getMockImplementation()!;
    const writeAttempts: string[] = [];
    db.user.update.mockImplementation(async (args: any) => {
      if (typeof args.data?.phoneNumberE164 === "string") {
        writeAttempts.push(args.data.phoneNumberE164);
      }
      return realUpdate(args);
    });

    const first = mockRes();
    const second = mockRes();
    await Promise.all([
      verifyPhoneOtp(authed("u1", { phoneNumber: target, otp: otpA }), first),
      verifyPhoneOtp(authed("u2", { phoneNumber: target, otp: otpB, purpose: "PHONE_CHANGE" }), second),
    ]);

    // Both controllers really did reach the write with the same value...
    expect(writeAttempts).toEqual([targetE164, targetE164]);
    // ...and the unique index still left exactly one owner.
    expect(ownersOfTarget()).toHaveLength(1);
    expect(ownersOfTarget()[0].isPhoneVerified).toBe(true);
    expect([first, second].map(statusOf).sort()).toEqual([200, 400]);
    const loser = statusOf(first) === 400 ? first : second;
    expect(bodyOf(loser)).toEqual({ message: "Invalid verification code" });
    expect(users.get("u2")!.phoneNumberE164).not.toBe(targetE164);
  });

  it("keeps the unique constraint as the real enforcement point", () => {
    // The application pre-check alone cannot close the race above; this
    // database-level constraint is what makes exactly-one-owner true.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/phoneNumberE164\s+String\?\s+@unique/);
  });
});

/**
 * Batch 1D.39 (F1) — client identity for rate limiting.
 *
 * An IPv6 client is handed a whole prefix and may use any address inside
 * it, so keying a limit on the raw address hands it a fresh budget per
 * rotation. These tests pin the normalisation, that IPv4 behaviour is
 * unchanged, that the OTP service's Redis key and the express-rate-limit
 * key agree, and that unusable input is bounded rather than unlimited.
 */
// The OTP service imports the real Redis client module, which refuses to
// load without REDIS_URL. Every call in this file passes an explicit
// `client`, so the module-level client is never used.
jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisUsersSessions: {},
}));

import type { RedisClientType } from "redis";
import {
  clientRateLimitIdentity,
  isSameClientIdentity,
  UNKNOWN_CLIENT_IDENTITY,
  IPV6_RATE_LIMIT_SUBNET,
} from "../../src/utils/clientIp";
import { phoneOtpRateLimiter } from "../../src/middlewares/rateLimiter.middleware";
import { FakeRedis } from "../helpers/fakeRedis";
import {
  requestOtp,
  OtpPurpose,
  OTP_MAX_REQUESTS_PER_IP,
  OTP_MAX_REQUESTS_PER_PHONE,
  OTP_RESEND_COOLDOWN_SECONDS,
  otpIpRateLimitKeyFor,
  otpKeyFor,
} from "../../src/services/phoneOtp.service";

process.env.PHONE_OTP_SECRET = "test-only-phone-otp-secret-do-not-use-in-prod";

describe("clientRateLimitIdentity — IPv6", () => {
  it("folds addresses in the same /56 onto one identity", () => {
    const base = clientRateLimitIdentity("2001:db8:1234:5600::1");
    for (const host of [
      "2001:db8:1234:5600::1",
      "2001:db8:1234:5600::2",
      "2001:db8:1234:5600:ffff:ffff:ffff:ffff",
      "2001:db8:1234:5601::abcd",
    ]) {
      expect(clientRateLimitIdentity(host)).toBe(base);
    }
    expect(base).toContain(`/${IPV6_RATE_LIMIT_SUBNET}`);
  });

  it("keeps different /56 networks distinct", () => {
    const a = clientRateLimitIdentity("2001:db8:1234:5600::1");
    const b = clientRateLimitIdentity("2001:db8:1234:5700::1");
    const c = clientRateLimitIdentity("2001:db8:1234:4900::1");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("keeps different /48 allocations distinct", () => {
    expect(clientRateLimitIdentity("2001:db8:1111::1")).not.toBe(
      clientRateLimitIdentity("2001:db8:2222::1"),
    );
  });

  it("treats every textual spelling of one address as the same client", () => {
    const canonical = clientRateLimitIdentity("2001:db8:1234:5600::1");
    for (const spelling of [
      "2001:0db8:1234:5600:0000:0000:0000:0001",
      "2001:DB8:1234:5600::1",
      "2001:db8:1234:5600:0:0:0:1",
    ]) {
      expect(clientRateLimitIdentity(spelling)).toBe(canonical);
    }
  });

  it("uses the express-rate-limit prefix convention", () => {
    expect(IPV6_RATE_LIMIT_SUBNET).toBe(56);
  });
});

describe("clientRateLimitIdentity — IPv4", () => {
  it("leaves IPv4 addresses untouched", () => {
    for (const ip of ["203.0.113.7", "198.51.100.1", "10.0.0.1", "192.0.2.255"]) {
      expect(clientRateLimitIdentity(ip)).toBe(ip);
    }
  });

  it("never groups unrelated IPv4 addresses together", () => {
    const ips = ["203.0.113.7", "203.0.113.8", "198.51.100.1", "10.0.0.1"];
    expect(new Set(ips.map(clientRateLimitIdentity)).size).toBe(ips.length);
  });
});

describe("clientRateLimitIdentity — unusable input", () => {
  it("maps missing and blank addresses to one bounded identity", () => {
    for (const bad of [undefined, null, "", "   ", "\t"]) {
      expect(clientRateLimitIdentity(bad)).toBe(UNKNOWN_CLIENT_IDENTITY);
    }
  });

  it("buckets a malformed address deterministically without collapsing others", () => {
    expect(clientRateLimitIdentity("not-an-ip")).toBe("not-an-ip");
    expect(clientRateLimitIdentity("also-not-an-ip")).toBe("also-not-an-ip");
    expect(clientRateLimitIdentity("not-an-ip")).not.toBe(UNKNOWN_CLIENT_IDENTITY);
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(clientRateLimitIdentity("  203.0.113.7  ")).toBe("203.0.113.7");
  });
});

describe("isSameClientIdentity", () => {
  it("sees two addresses in one IPv6 allocation as the same client", () => {
    expect(isSameClientIdentity("2001:db8:1234:5600::1", "2001:db8:1234:5600::99")).toBe(true);
  });

  it("sees different allocations and IPv4 hosts as different clients", () => {
    expect(isSameClientIdentity("2001:db8:1234:5600::1", "2001:db8:1234:5700::1")).toBe(false);
    expect(isSameClientIdentity("203.0.113.7", "203.0.113.8")).toBe(false);
  });
});

describe("express-rate-limit middleware and the OTP service agree on the client", () => {
  /**
   * Drive the real middleware and read back the key it actually used.
   * express-rate-limit publishes it on `request.rateLimit.key`, so this
   * observes behaviour rather than reading the source.
   */
  function middlewareKey(ip?: string, userId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req: any = {
        ip,
        headers: {},
        socket: {},
        method: "POST",
        originalUrl: "/api/auth/phone/login/request-otp",
      };
      if (userId) req.user = { id: userId, role: "CUSTOMER", sessionId: "s" };
      const res: any = {
        statusCode: 200,
        status() { return res; },
        json() { resolve((req.rateLimit && req.rateLimit.key) ?? ""); return res; },
        setHeader() { return res; },
        getHeader() { return undefined; },
        end() { resolve((req.rateLimit && req.rateLimit.key) ?? ""); return res; },
      };
      try {
        const fn = phoneOtpRateLimiter as unknown as (r: any, s: any, n: any) => void;
        fn(req, res, () => resolve((req.rateLimit && req.rateLimit.key) ?? ""));
      } catch (err) {
        reject(err);
      }
    });
  }

  it("keys two addresses in one IPv6 allocation identically", async () => {
    const a = await middlewareKey("2001:db8:1234:5600::1");
    const b = await middlewareKey("2001:db8:1234:5600::beef");
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it("keys different IPv6 allocations differently", async () => {
    expect(await middlewareKey("2001:db8:1234:5600::1"))
      .not.toBe(await middlewareKey("2001:db8:1234:5700::1"));
  });

  it("keeps IPv4 hosts on distinct keys", async () => {
    expect(await middlewareKey("203.0.113.7")).not.toBe(await middlewareKey("203.0.113.8"));
  });

  it("matches the identity the OTP service charges for the same address", async () => {
    // If these ever diverge, a caller gets one budget in each layer and the
    // effective limit is the sum rather than the configured value.
    for (const ip of [
      "2001:db8:1234:5600::7",
      "2001:db8:1234:5700::7",
      "203.0.113.7",
      "junk",
      undefined,
    ]) {
      expect(await middlewareKey(ip)).toBe(clientRateLimitIdentity(ip));
    }
  });

  it("still prefers the account id when there is a session", async () => {
    const byAccount = await middlewareKey("2001:db8:1234:5600::1", "user-42");
    expect(byAccount).toBe("user-42");
  });
});

describe("OTP service rate limiting under IPv6", () => {
  let redis: FakeRedis;
  const client = (): RedisClientType => redis as unknown as RedisClientType;
  const ng = (n: number) => `0${String(8031234567 + n)}`;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it("charges an IPv6 rotator one budget, not one per address", async () => {
    const prefix = "2001:db8:1234:5600::";
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_IP; i++) {
      const res = await requestOtp(
        {
          phoneNumber: ng(400 + i),
          purpose: OtpPurpose.PHONE_LOGIN,
          ip: `${prefix}${i + 1}`,
        },
        { client: client() },
      );
      expect(res.status).toBe("SUCCESS");
    }
    // Still inside the same /56, brand-new host bits: no fresh budget.
    const rotated = await requestOtp(
      { phoneNumber: ng(460), purpose: OtpPurpose.PHONE_LOGIN, ip: `${prefix}dead:beef` },
      { client: client() },
    );
    expect(rotated.status).toBe("RATE_LIMITED");
    expect(await redis.get(otpIpRateLimitKeyFor(clientRateLimitIdentity(`${prefix}1`))))
      .toBe(String(OTP_MAX_REQUESTS_PER_IP + 1));
  });

  it("still separates genuinely different IPv6 allocations", async () => {
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_IP; i++) {
      expect((await requestOtp(
        { phoneNumber: ng(500 + i), purpose: OtpPurpose.PHONE_LOGIN, ip: "2001:db8:aaaa::1" },
        { client: client() },
      )).status).toBe("SUCCESS");
    }
    // A different allocation is unaffected...
    expect((await requestOtp(
      { phoneNumber: ng(560), purpose: OtpPurpose.PHONE_LOGIN, ip: "2001:db8:bbbb::1" },
      { client: client() },
    )).status).toBe("SUCCESS");
    // ...but rotation inside the exhausted one is not.
    expect((await requestOtp(
      { phoneNumber: ng(561), purpose: OtpPurpose.PHONE_LOGIN, ip: "2001:db8:aaaa::999" },
      { client: client() },
    )).status).toBe("RATE_LIMITED");
  });

  it("does not let IPv6 rotation widen the per-phone limit or dodge the cooldown", async () => {
    const phone = "08031234567";
    const key = otpKeyFor(OtpPurpose.PHONE_LOGIN, "+2348031234567");
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_PHONE; i++) {
      const res = await requestOtp(
        { phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, ip: "2001:db8:cccc::1" },
        { client: client() },
      );
      expect(res.status).toBe("SUCCESS");
      redis.backdateSent(key, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    }
    // Sixth generation for the same number is refused even from a fresh
    // address inside the same allocation.
    expect((await requestOtp(
      { phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, ip: "2001:db8:cccc::2" },
      { client: client() },
    )).status).toBe("RATE_LIMITED");
  });

  it("fails closed when Redis is down", async () => {
    redis.fail = true;
    await expect(requestOtp(
      { phoneNumber: "08031234568", purpose: OtpPurpose.PHONE_LOGIN, ip: "2001:db8:dddd::1" },
      { client: client() },
    )).rejects.toThrow(/unavailable/i);
  });
});
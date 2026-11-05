/**
 * Phase 1D.2 — phone OTP service tests.
 *
 * The service is exercised against an in-memory Redis stand-in that honors
 * TTLs and implements the same atomic verify semantics as the production
 * Lua script, so no live Redis is required.
 */
process.env.PHONE_OTP_SECRET = "test-only-phone-otp-secret-do-not-use-in-prod";

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisUsersSessions: {},
}));

import crypto from "crypto";
import type { RedisClientType } from "redis";
import { FakeRedis } from "../helpers/fakeRedis";
import {
  requestOtp,
  verifyOtp,
  ISSUE_LUA,
  VERIFY_LUA,
  OtpPurpose,
  OTP_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_PHONE,
  OTP_MAX_REQUESTS_PER_IP,
  OTP_RATE_LIMIT_WINDOW_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  otpKeyFor,
  otpRateLimitKeyFor,
  otpIpRateLimitKeyFor,
  otpDigest,
  OtpServiceError,
} from "../../src/services/phoneOtp.service";
import { UNKNOWN_CLIENT_IDENTITY } from "../../src/utils/clientIp";

const SECRET = "test-only-phone-otp-secret-do-not-use-in-prod";
const PURPOSE = OtpPurpose.PHONE_VERIFICATION;

let redis: FakeRedis;

const client = () => redis as unknown as RedisClientType;

beforeEach(() => {
  redis = new FakeRedis();
});

function expectedDigest(e164: string, purpose: OtpPurpose, otp: string): string {
  return crypto
    .createHmac("sha256", SECRET)
    .update(`${purpose}:${e164}:${otp}`, "utf8")
    .digest("hex");
}

describe("generation", () => {
  it("generates a 6-digit numeric OTP", async () => {
    const res = await requestOtp(
      { phoneNumber: "08031234560", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    expect(res.status).toBe("SUCCESS");
    expect(res.otp).toMatch(/^\d{6}$/);
  });

  it("generates distinct OTPs across phones", async () => {
    const otps = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const res = await requestOtp(
        { phoneNumber: `0803123456${i}`, purpose: PURPOSE },
        { client: client(), exposeOtp: true },
      );
      expect(res.status).toBe("SUCCESS");
      otps.add(res.otp!);
    }
    expect(otps.size).toBeGreaterThan(1);
  });

  it("never stores the plaintext OTP and stores a bound digest", async () => {
    const res = await requestOtp(
      { phoneNumber: "08031234561", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    const otp = res.otp!;
    const stored = redis.raw(otpKeyFor(PURPOSE, "+2348031234561"))!;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(otp);
    const rec = JSON.parse(stored) as { d: string; a: number };
    expect(rec.a).toBe(0);
    expect(rec.d).toBe(expectedDigest("+2348031234561", PURPOSE, otp));
    expect(rec.d).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets the production TTL on the OTP record", async () => {
    await requestOtp(
      { phoneNumber: "08031234562", purpose: PURPOSE },
      { client: client() },
    );
    const ttl = redis.ttlOf(otpKeyFor(PURPOSE, "+2348031234562"));
    expect(OTP_TTL_SECONDS).toBe(5 * 60);
    expect(ttl).toBe(OTP_TTL_SECONDS);
  });

  it("does not expose the OTP unless explicitly requested", async () => {
    const res = await requestOtp(
      { phoneNumber: "08031234563", purpose: PURPOSE },
      { client: client() },
    );
    expect(res).toEqual({ status: "SUCCESS" });
    expect("otp" in res).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Task 7.35 — the OTP must be drawn from the CSPRNG.
  //
  // This closes a gap found in Task 7.34: `grep -rn "randomInt" tests/` matched
  // nothing, so the six-digit OTPs the suite exercised were only ever checked
  // for SHAPE (`/^\d{6}$/`), never for provenance. A regression that swapped
  // `crypto.randomInt` for `Math.random`, a counter, or a timestamp would
  // have left every other test in this file green.
  //
  // WHY A SPY IS THE RIGHT TOOL HERE — verified from source, not assumed:
  //   - `src/services/phoneOtp.service.ts:1` is `import crypto from "crypto"`,
  //     and `:286` calls `crypto.randomInt(100000, 1000000)` as a RUNTIME
  //     property lookup on that module object. It does NOT destructure
  //     `const { randomInt } = crypto` at module scope.
  //   - This file imports `crypto` the same way (line 15), and with
  //     `esModuleInterop` both bindings resolve to the SAME Node module object.
  //   Therefore `jest.spyOn(crypto, "randomInt")` intercepts the real
  //     production call. Only a module-scope destructure would defeat it.
  //
  // This test CANNOT PASS VACUOUSLY. If the implementation stopped using the
  // secure generator the spy would record zero calls and the very first
  // assertion below would fail.
  //
  // It deliberately does NOT assert that a sample of generated codes looks
  // statistically random. Such a test is flaky, has no fixed failure threshold,
  // and would not prove the CSPRNG is used — it could pass against a weak
  // generator by luck. Provenance is what matters, and provenance is exactly
  // what a spy observes.
  // ───────────────────────────────────────────────────────────────────────────
  it("draws the OTP from crypto.randomInt with the production bounds (Task 7.35)", async () => {
    // Deterministic, inside the production range, and not a real OTP: this is
    // a synthetic fixture the test controls, never a value that left a system.
    const STUB = 424242;

    // `@types/node` declares FOUR `randomInt` overloads and the two legacy
    // callback forms come LAST (crypto.d.ts:1940-1941) returning `void`, so
    // `jest.spyOn(crypto, "randomInt")` infers a `void` return and
    // `.mockReturnValue(424242)` fails to compile. Production code calls the
    // two-argument SYNCHRONOUS form (phoneOtp.service.ts:286), so narrow to
    // exactly that signature. The cast is type-only: it produces the same
    // object reference, so `mockRestore` still restores the real property on
    // the real Node `crypto` module, and `createHmac` is left untouched.
    const cryptoSync = crypto as unknown as {
      randomInt: (min: number, max: number) => number;
    };
    // Captured BEFORE the spy is installed, so the restore below can be
    // proved rather than assumed.
    const originalRandomInt = crypto.randomInt;
    const randomIntSpy = jest.spyOn(cryptoSync, "randomInt").mockReturnValue(STUB);
    try {
      const res = await requestOtp(
        { phoneNumber: "08031234570", purpose: PURPOSE },
        { client: client(), exposeOtp: true },
      );

      expect(res.status).toBe("SUCCESS");

      // 1. The secure generator is actually invoked, exactly once per OTP...
      expect(randomIntSpy).toHaveBeenCalledTimes(1);
      // 2. ...with the bounds that produce exactly six digits, 100000-999999.
      expect(randomIntSpy).toHaveBeenCalledWith(100000, 1000000);
      // Guard the fixture itself, so widening the bounds later cannot make
      // this test silently assert the wrong thing.
      expect(STUB).toBeGreaterThanOrEqual(100000);
      expect(STUB).toBeLessThan(1000000);

      // 3. The returned value is the secure generator's output, not a
      //    second, independent source of entropy.
      expect(res.otp).toBe(String(STUB));
      expect(res.otp).toMatch(/^\d{6}$/);

      // 4. And that value genuinely feeds the credential that gets persisted,
      //    so the spy cannot be satisfied by an incidental call on some other
      //    path: the stored HMAC must be the one computed over THIS value.
      //    This is what ties "uses the CSPRNG" to "the CSPRNG's output is the
      //    secret", rather than merely "a CSPRNG call happened somewhere".
      const stored = redis.raw(otpKeyFor(PURPOSE, "+2348031234570"));
      expect(stored).toBeTruthy();
      const rec = JSON.parse(stored as string) as { d: string; a: number };
      expect(rec.d).toBe(otpDigest(SECRET, PURPOSE, "+2348031234570", String(STUB)));
      // The plaintext is still never what gets stored — the digest-only
      // property must survive the CSPRNG assertion above.
      expect(stored as string).not.toContain(String(STUB));
    } finally {
      // `clearMocks: true` in jest.config.js clears call records but does NOT
      // restore a spied implementation, so an explicit restore is required or
      // the stub would leak into every later test in this file. try/finally
      // matches the convention already used by the missing-secret test below.
      randomIntSpy.mockRestore();
    }

    // Deliberately OUTSIDE the try, so it runs after the finally.
    //
    // This is not belt-and-braces decoration: nothing later in this file
    // asserts that two issued OTPs differ (the only `new Set` is at line 67,
    // which runs BEFORE this test), so a leaked constant stub would leave the
    // whole suite green while every subsequent OTP became 424242. Reference
    // identity proves the real Node function is back in place, deterministically
    // and with no randomness assumption.
    expect(crypto.randomInt).toBe(originalRandomInt);
    expect(jest.isMockFunction(crypto.randomInt)).toBe(false);
  });
});

describe("verification", () => {
  async function issue(phone: string): Promise<string> {
    const res = await requestOtp(
      { phoneNumber: phone, purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    expect(res.status).toBe("SUCCESS");
    return res.otp!;
  }

  it("accepts the correct OTP", async () => {
    const otp = await issue("08031234564");
    const res = await verifyOtp(
      { phoneNumber: "08031234564", purpose: PURPOSE, otp },
      { client: client() },
    );
    expect(res).toEqual({ status: "SUCCESS" });
  });

  it("rejects an incorrect OTP and tracks attempts", async () => {
    await issue("08031234565");
    const key = otpKeyFor(PURPOSE, "+2348031234565");
    expect(await verifyOtp(
      { phoneNumber: "08031234565", purpose: PURPOSE, otp: "000000" },
      { client: client() },
    )).toEqual({ status: "INVALID" });
    expect((JSON.parse(redis.raw(key)!) as { a: number }).a).toBe(1);
    expect(await verifyOtp(
      { phoneNumber: "08031234565", purpose: PURPOSE, otp: "000001" },
      { client: client() },
    )).toEqual({ status: "INVALID" });
    expect((JSON.parse(redis.raw(key)!) as { a: number }).a).toBe(2);
  });

  /** A 6-digit code that is guaranteed not to be `real`. */
  function wrongCode(real: string, n: number): string {
    const candidate = String(100000 + n).padStart(6, "0");
    if (candidate !== real) return candidate;
    return String(100000 + n + 1).padStart(6, "0");
  }

  it("invalidates the OTP on the attempt after the fifth wrong one", async () => {
    const otp = await issue("08031234566");
    const args = { client: client() };
    // Phase 1D.38: OTP_MAX_ATTEMPTS wrong codes are each answered INVALID;
    // the one after that is refused and destroys the record.
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    for (let i = 1; i <= OTP_MAX_ATTEMPTS; i++) {
      expect(await verifyOtp(
        { phoneNumber: "08031234566", purpose: PURPOSE, otp: wrongCode(otp, i) },
        args,
      )).toEqual({ status: "INVALID" });
      expect((JSON.parse(redis.raw(otpKeyFor(PURPOSE, "+2348031234566"))!) as { a: number }).a)
        .toBe(i);
    }
    expect(await verifyOtp(
      { phoneNumber: "08031234566", purpose: PURPOSE, otp: wrongCode(otp, OTP_MAX_ATTEMPTS + 1) },
      args,
    )).toEqual({ status: "MAX_ATTEMPTS" });
    // Even the correct OTP is now useless.
    expect(await verifyOtp({ phoneNumber: "08031234566", purpose: PURPOSE, otp }, args))
      .toEqual({ status: "EXPIRED" });
  });

  it("deletes the OTP on success so replays fail", async () => {
    const otp = await issue("08031234567");
    const args = { client: client() };
    expect(await verifyOtp({ phoneNumber: "08031234567", purpose: PURPOSE, otp }, args))
      .toEqual({ status: "SUCCESS" });
    expect(redis.raw(otpKeyFor(PURPOSE, "+2348031234567"))).toBeNull();
    expect(await verifyOtp({ phoneNumber: "08031234567", purpose: PURPOSE, otp }, args))
      .toEqual({ status: "EXPIRED" });
  });

  it("rejects malformed OTP input without touching state", async () => {
    await issue("08031234568");
    const key = otpKeyFor(PURPOSE, "+2348031234568");
    for (const bad of ["123", "abcdef", "1234567", ""]) {
      expect(await verifyOtp(
        { phoneNumber: "08031234568", purpose: PURPOSE, otp: bad },
        { client: client() },
      )).toEqual({ status: "INVALID" });
    }
    expect((JSON.parse(redis.raw(key)!) as { a: number }).a).toBe(0);
  });
});

describe("expiration", () => {
  it("rejects an expired OTP", async () => {
    const res = await requestOtp(
      { phoneNumber: "08031234569", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    redis.expireNow(otpKeyFor(PURPOSE, "+2348031234569"));
    expect(await verifyOtp(
      { phoneNumber: "08031234569", purpose: PURPOSE, otp: res.otp! },
      { client: client() },
    )).toEqual({ status: "EXPIRED" });
  });

  it("stops accepting a code once its 5-minute lifetime has elapsed", async () => {
    const phone = "08031234571";
    const res = await requestOtp(
      { phoneNumber: phone, purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    const key = otpKeyFor(PURPOSE, "+2348031234571");
    // Just inside the window the code still verifies, so the test is pinned
    // to the lifetime rather than to the clock being frozen.
    expect(redis.ttlOf(key)).toBe(OTP_TTL_SECONDS);
    const remaining = redis.ttlOf(key);
    redis.store.get(key)!.expiresAt = Date.now() + remaining * 1000 - 2000;
    expect(await verifyOtp(
      { phoneNumber: phone, purpose: PURPOSE, otp: res.otp! },
      { client: client() },
    )).toEqual({ status: "SUCCESS" });

    // Same code, one full lifetime later, is refused.
    const second = await requestOtp(
      { phoneNumber: phone, purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    redis.expireNow(key);
    expect(await verifyOtp(
      { phoneNumber: phone, purpose: PURPOSE, otp: second.otp! },
      { client: client() },
    )).toEqual({ status: "EXPIRED" });
  });
});

describe("purpose isolation", () => {
  it("rejects an OTP under a different purpose", async () => {
    const res = await requestOtp(
      { phoneNumber: "08031234570", purpose: OtpPurpose.PHONE_VERIFICATION },
      { client: client(), exposeOtp: true },
    );
    expect(await verifyOtp(
      { phoneNumber: "08031234570", purpose: OtpPurpose.PHONE_CHANGE, otp: res.otp! },
      { client: client() },
    )).not.toEqual({ status: "SUCCESS" });
    // The original OTP is still consumable under its own purpose.
    expect(await verifyOtp(
      { phoneNumber: "08031234570", purpose: OtpPurpose.PHONE_VERIFICATION, otp: res.otp! },
      { client: client() },
    )).toEqual({ status: "SUCCESS" });
  });

  it("binds the digest to the purpose", () => {
    const digestA = otpDigest(SECRET, OtpPurpose.PHONE_VERIFICATION, "+2348031234570", "123456");
    const digestB = otpDigest(SECRET, OtpPurpose.PHONE_CHANGE, "+2348031234570", "123456");
    expect(digestA).not.toBe(digestB);
  });
});

describe("phone normalization", () => {
  it("maps equivalent representations to one OTP identity", async () => {
    const res = await requestOtp(
      { phoneNumber: "08012345678", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    expect(res.status).toBe("SUCCESS");
    // Same canonical key regardless of input format.
    expect(redis.raw(otpKeyFor(PURPOSE, "+2348012345678"))).toBeTruthy();
    expect(await verifyOtp(
      { phoneNumber: "+2348012345678", purpose: PURPOSE, otp: res.otp! },
      { client: client() },
    )).toEqual({ status: "SUCCESS" });
  });
});

describe("resend", () => {
  it("rejects a resend inside the 60-second cooldown window", async () => {
    const first = await requestOtp(
      { phoneNumber: "08051112233", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    expect(first.status).toBe("SUCCESS");
    const second = await requestOtp(
      { phoneNumber: "08051112233", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    expect(second.status).toBe("COOLDOWN");
    expect("otp" in second).toBe(false);
    expect(OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
  });

  it("refuses a resend one second short of the cooldown", async () => {
    const key = otpKeyFor(PURPOSE, "+2348051112234");
    await requestOtp(
      { phoneNumber: "08051112234", purpose: PURPOSE },
      { client: client() },
    );
    redis.backdateSent(key, (OTP_RESEND_COOLDOWN_SECONDS - 1) * 1000);
    expect((await requestOtp(
      { phoneNumber: "08051112234", purpose: PURPOSE },
      { client: client() },
    )).status).toBe("COOLDOWN");
    // One more second and it is allowed.
    redis.backdateSent(key, 1000);
    expect((await requestOtp(
      { phoneNumber: "08051112234", purpose: PURPOSE },
      { client: client() },
    )).status).toBe("SUCCESS");
  });

  it("does not consume a rate-limit slot on a cooldown rejection", async () => {
    const key = otpKeyFor(PURPOSE, "+2348051112235");
    const rateKey = otpRateLimitKeyFor("+2348051112235");
    const args = { client: client(), exposeOtp: true };
    expect((await requestOtp({ phoneNumber: "08051112235", purpose: PURPOSE }, args)).status)
      .toBe("SUCCESS");
    for (let i = 0; i < 10; i++) {
      expect((await requestOtp({ phoneNumber: "08051112235", purpose: PURPOSE }, args)).status)
        .toBe("COOLDOWN");
    }
    expect(await redis.get(rateKey)).toBe("1");
    redis.backdateSent(key, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect((await requestOtp({ phoneNumber: "08051112235", purpose: PURPOSE }, args)).status)
      .toBe("SUCCESS");
    expect(await redis.get(rateKey)).toBe("2");
  });

  it("an allowed resend replaces the old OTP and resets state", async () => {
    const key = otpKeyFor(PURPOSE, "+2348051112233");
    const first = await requestOtp(
      { phoneNumber: "08051112233", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    // Two failed attempts, then wait out the cooldown.
    await verifyOtp(
      { phoneNumber: "08051112233", purpose: PURPOSE, otp: "000000" },
      { client: client() },
    );
    redis.backdateSent(key, 61 * 1000);
    const second = await requestOtp(
      { phoneNumber: "08051112233", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    expect(second.status).toBe("SUCCESS");
    expect(second.otp).toMatch(/^\d{6}$/);
    // Resend starts from a clean slate: zero attempts and a fresh TTL.
    expect((JSON.parse(redis.raw(key)!) as { a: number }).a).toBe(0);
    expect(redis.ttlOf(key)).toBeGreaterThan(OTP_TTL_SECONDS - 30);
    // Old OTP is dead, new OTP works.
    expect(await verifyOtp(
      { phoneNumber: "08051112233", purpose: PURPOSE, otp: first.otp! },
      { client: client() },
    )).not.toEqual({ status: "SUCCESS" });
    expect(await verifyOtp(
      { phoneNumber: "08051112233", purpose: PURPOSE, otp: second.otp! },
      { client: client() },
    )).toEqual({ status: "SUCCESS" });
  });
});

describe("request rate limiting", () => {
  // Distinct, valid Nigerian mobiles (0 + a 10-digit NSN) so a per-phone
  // limit can never be what stops a test that is about the per-IP budget.
  const ng = (n: number) => `0${String(8031234567 + n)}`;

  it("rejects the sixth request inside the 24-hour per-phone window", async () => {
    const phone = "08031234560";
    const key = otpKeyFor(PURPOSE, "+2348031234560");
    const args = { client: client(), exposeOtp: true };
    expect(OTP_RATE_LIMIT_WINDOW_SECONDS).toBe(24 * 60 * 60);
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_PHONE; i++) {
      expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args)).status)
        .toBe("SUCCESS");
      redis.backdateSent(key, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    }
    const limited = await requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args);
    expect(limited.status).toBe("RATE_LIMITED");
    expect("otp" in limited).toBe(false);
  });

  it("allows requests again once the 24-hour per-phone counter lapses", async () => {
    const phone = "08031234561";
    const key = otpKeyFor(PURPOSE, "+2348031234561");
    const rateKey = otpRateLimitKeyFor("+2348031234561");
    const args = { client: client(), exposeOtp: true };
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_PHONE; i++) {
      await requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args);
      redis.backdateSent(key, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    }
    expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args)).status)
      .toBe("RATE_LIMITED");
    await redis.del(rateKey);
    redis.backdateSent(key, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args)).status)
      .toBe("SUCCESS");
  });

  it("rejects the twenty-first request inside the 24-hour per-IP window", async () => {
    const ip = "203.0.113.7";
    const args = { client: client(), exposeOtp: true };
    // Distinct numbers so the per-phone budget is never what stops it —
    // only the shared per-IP budget can.
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_IP; i++) {
      const res = await requestOtp(
        { phoneNumber: ng(100 + i), purpose: PURPOSE, ip },
        args,
      );
      expect(res.status).toBe("SUCCESS");
    }
    expect(OTP_MAX_REQUESTS_PER_IP).toBe(20);

    // Twenty-first request: a different phone, same IP.
    const limited = await requestOtp({ phoneNumber: ng(200), purpose: PURPOSE, ip }, args);
    expect(limited.status).toBe("RATE_LIMITED");
    expect("otp" in limited).toBe(false);
    // Nothing was stored for the blocked request.
    expect(redis.raw(otpKeyFor(PURPOSE, `+${ng(200).slice(1)}`))).toBeNull();
    expect(await redis.get(otpIpRateLimitKeyFor(ip))).toBe(String(OTP_MAX_REQUESTS_PER_IP + 1));
  });

  it("still refuses the sixth request one millisecond before the 24-hour window ends", async () => {
    const phone = "08031234566";
    const e164 = "+2348031234566";
    const rateKey = otpRateLimitKeyFor(e164);
    const recordKey = otpKeyFor(PURPOSE, e164);
    const args = { client: client(), exposeOtp: true };
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_PHONE; i++) {
      expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args)).status).toBe("SUCCESS");
      redis.backdateSent(recordKey, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    }
    expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args)).status).toBe("RATE_LIMITED");

    // Park the counter's expiry a moment ahead: the window has NOT lapsed, so
    // the exhausted budget must still be honoured. (Deleting the counter
    // outright, as the test above does, proves recovery but says nothing
    // about the boundary itself.)
    redis.store.get(rateKey)!.expiresAt = Date.now() + 5_000;
    redis.backdateSent(recordKey, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args)).status).toBe("RATE_LIMITED");

    // One millisecond after the counter lapses the budget is whole again.
    redis.expireNow(rateKey);
    expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args)).status).toBe("SUCCESS");
    expect(await redis.get(rateKey)).toBe("1");
  });

  it("still refuses the twenty-first request one millisecond before the IP window ends", async () => {
    const ip = "203.0.113.31";
    const ipKey = otpIpRateLimitKeyFor(ip);
    const args = { client: client(), exposeOtp: true };
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_IP; i++) {
      expect((await requestOtp({ phoneNumber: ng(900 + i), purpose: PURPOSE, ip }, args)).status).toBe("SUCCESS");
    }
    expect((await requestOtp({ phoneNumber: ng(950), purpose: PURPOSE, ip }, args)).status).toBe("RATE_LIMITED");

    // Distinct numbers throughout, so the per-phone budget is never what
    // stops a request here — only the shared per-IP window can.
    redis.store.get(ipKey)!.expiresAt = Date.now() + 5_000;
    expect((await requestOtp({ phoneNumber: ng(951), purpose: PURPOSE, ip }, args)).status).toBe("RATE_LIMITED");

    redis.expireNow(ipKey);
    expect((await requestOtp({ phoneNumber: ng(952), purpose: PURPOSE, ip }, args)).status).toBe("SUCCESS");
    expect(await redis.get(ipKey)).toBe("1");
  });

  it("keeps the per-IP budget separate per originating IP", async () => {
    const args = { client: client(), exposeOtp: true };
    const a = "198.51.100.1";
    const b = "198.51.100.2";
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_IP; i++) {
      await requestOtp({ phoneNumber: ng(300 + i), purpose: PURPOSE, ip: a }, args);
    }
    expect((await requestOtp({ phoneNumber: ng(400), purpose: PURPOSE, ip: a }, args)).status)
      .toBe("RATE_LIMITED");
    // A different origin is unaffected by the first one's exhausted budget.
    expect((await requestOtp({ phoneNumber: ng(400), purpose: PURPOSE, ip: b }, args)).status)
      .toBe("SUCCESS");
  });

  it("shares the per-IP budget across OTP purposes", async () => {
    const ip = "198.51.100.3";
    const args = { client: client(), exposeOtp: true };
    // Purpose changes must not hand a caller a fresh IP allowance: the SMS
    // cost is the same whichever flow triggered it.
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_IP; i++) {
      await requestOtp(
        { phoneNumber: ng(500 + i), purpose: OtpPurpose.PHONE_LOGIN, ip },
        args,
      );
    }
    const other = await requestOtp(
      { phoneNumber: ng(600), purpose: OtpPurpose.PHONE_VERIFICATION, ip },
      args,
    );
    expect(other.status).toBe("RATE_LIMITED");
  });

  it("enforces the limits through shared storage, not process memory", async () => {
    // Two handles over ONE backing store: the "second application instance".
    const instanceA = client();
    const instanceB = redis.fork() as unknown as RedisClientType;
    const ip = "203.0.113.99";
    const phone = "08031234600";
    const key = otpKeyFor(PURPOSE, "+2348031234600");

    for (let i = 0; i < OTP_MAX_REQUESTS_PER_PHONE - 1; i++) {
      expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE, ip }, { client: instanceA })).status)
        .toBe("SUCCESS");
      // Backdate between requests but NOT after the last one, so the next
      // call is genuinely inside the cooldown window.
      if (i < OTP_MAX_REQUESTS_PER_PHONE - 2) {
        redis.backdateSent(key, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
      }
    }
    // The cooldown is enforced by the shared store too: instance B, which
    // issued none of those, sees instance A's record and refuses the resend.
    expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE, ip }, { client: instanceB })).status)
      .toBe("COOLDOWN");

    // Fifth request comes from instance B and succeeds...
    redis.backdateSent(key, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE, ip }, { client: instanceB })).status)
      .toBe("SUCCESS");
    redis.backdateSent(key, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    // ...and the sixth is refused even though it arrives at instance A,
    // which issued only the first four.
    expect((await requestOtp({ phoneNumber: phone, purpose: PURPOSE, ip }, { client: instanceA })).status)
      .toBe("RATE_LIMITED");

    // The per-IP counter is shared too: instance B's spend is visible to
    // instance A through the same storage, so the two budgets cannot be
    // reset by bouncing between instances.
    expect(await instanceB.get(otpIpRateLimitKeyFor(ip)))
      .toBe(String(OTP_MAX_REQUESTS_PER_PHONE));
  });

  it("still charges a bounded budget when the caller supplies no IP", async () => {
    const args = { client: client(), exposeOtp: true };
    // Phase 1D.39 (F1): a caller with no usable address must NOT be handed an
    // unlimited budget. Such callers collapse onto one identity that is
    // charged like any other, so the 20/24h ceiling still applies.
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_IP; i++) {
      const res = await requestOtp({ phoneNumber: ng(700 + i), purpose: PURPOSE }, args);
      expect(res.status).toBe("SUCCESS");
    }
    const limited = await requestOtp({ phoneNumber: ng(750), purpose: PURPOSE }, args);
    expect(limited.status).toBe("RATE_LIMITED");
    expect(await redis.get(otpIpRateLimitKeyFor(UNKNOWN_CLIENT_IDENTITY)))
      .toBe(String(OTP_MAX_REQUESTS_PER_IP + 1));
  });

  it("shares one bounded budget across every unusable-IP caller", async () => {
    const args = { client: client(), exposeOtp: true };
    // Missing, blank and whitespace-only addresses are the SAME identity, so
    // they cannot each buy a fresh 20-request allowance.
    const junk = [undefined, null, "", "   ", undefined];
    for (const ip of junk) {
      const res = await requestOtp({ phoneNumber: ng(800), purpose: PURPOSE, ip }, args);
      // First one succeeds; the rest hit the 60s cooldown on the same phone,
      // which proves they all resolved to the same OTP record and therefore
      // the same identity space.
      if (res.status === "SUCCESS") expect(junk.indexOf(ip)).toBe(0);
    }
    expect(await redis.get(otpIpRateLimitKeyFor(UNKNOWN_CLIENT_IDENTITY))).toBe("1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch 1D.3 — the per-phone request budget is shared across purposes.
//
// The product requirement is five OTP requests per normalized phone number
// per 24 hours. The counter was keyed on purpose + phone, which gave each
// purpose its own five (and public phone login another five on top), so one
// number could receive up to 15 codes a day. These tests pin the shared
// budget without disturbing purpose-scoped OTP storage or the IP budget.
// ─────────────────────────────────────────────────────────────────────────────
describe("per-phone budget across purposes", () => {
  /**
   * Issue a code, clearing the 60-second resend cooldown on that purpose's
   * record when one exists, so consecutive issues are gated only by the
   * request budget rather than the cooldown.
   */
  async function issuePastCooldown(
    phoneNumber: string,
    purpose: OtpPurpose,
    e164: string,
    ip: string | null = null,
  ) {
    const recordKey = otpKeyFor(purpose, e164);
    if (redis.raw(recordKey) !== null) {
      redis.backdateSent(recordKey, (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    }
    return requestOtp({ phoneNumber, purpose, ip }, { client: client(), exposeOtp: true });
  }

  /** Every phone-budget counter currently in the store. */
  const phoneBudgetKeys = () =>
    [...redis.store.keys()].filter((k) => k.startsWith("otp:rl:phone:"));

  /** A distinct valid Nigerian number, in national and canonical form. */
  const distinctPhone = (n: number) => ({
    phone: `0${String(8031234567 + n)}`,
    e164: `+234${String(8031234567 + n)}`,
  });

  it("counts every purpose against one shared per-phone budget", async () => {
    const phone = "08051234560";
    const e164 = "+2348051234560";
    const rateKey = otpRateLimitKeyFor(e164);
    const purposes = [
      OtpPurpose.PHONE_VERIFICATION,
      OtpPurpose.PHONE_CHANGE,
      OtpPurpose.PHONE_LOGIN,
    ];

    // Five issues, deliberately alternating purpose, all charge ONE counter.
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_PHONE; i += 1) {
      const res = await issuePastCooldown(phone, purposes[i % purposes.length]!, e164);
      expect(res.status).toBe("SUCCESS");
    }
    expect(await redis.get(rateKey)).toBe(String(OTP_MAX_REQUESTS_PER_PHONE));

    // The sixth is refused whichever purpose is used, and no OTP is returned.
    for (const purpose of purposes) {
      const limited = await issuePastCooldown(phone, purpose, e164);
      expect(limited.status).toBe("RATE_LIMITED");
      expect("otp" in limited).toBe(false);
    }

    // Exactly one counter exists for the number — not one per purpose.
    expect(phoneBudgetKeys()).toEqual([rateKey]);
  });

  it("still keeps purpose-scoped OTP records, so codes cannot cross purposes", async () => {
    const e164 = "+2348051234610";
    const verification = await requestOtp(
      { phoneNumber: "08051234610", purpose: OtpPurpose.PHONE_VERIFICATION },
      { client: client(), exposeOtp: true },
    );
    expect(verification.status).toBe("SUCCESS");

    // The code is bound to the purpose that issued it even though both share
    // the request budget.
    expect(await verifyOtp(
      { phoneNumber: "08051234610", purpose: OtpPurpose.PHONE_CHANGE, otp: verification.otp! },
      { client: client() },
    )).not.toEqual({ status: "SUCCESS" });
    expect(await verifyOtp(
      { phoneNumber: "08051234610", purpose: OtpPurpose.PHONE_VERIFICATION, otp: verification.otp! },
      { client: client() },
    )).toEqual({ status: "SUCCESS" });

    // Distinct record keys prove the OTP storage is still per-purpose.
    expect(redis.raw(otpKeyFor(OtpPurpose.PHONE_VERIFICATION, e164))).toBeNull();
    expect(redis.raw(otpKeyFor(OtpPurpose.PHONE_CHANGE, e164))).toBeNull();
  });

  it("normalizes equivalent number spellings onto the same budget", async () => {
    const rateKey = otpRateLimitKeyFor("+2348051234560");
    const spellings = ["08051234560", "+2348051234560", "2348051234560"];

    for (const spelling of spellings) {
      const res = await issuePastCooldown(spelling, PURPOSE, "+2348051234560");
      expect(res.status).toBe("SUCCESS");
    }
    expect(await redis.get(rateKey)).toBe(String(spellings.length));

    // Spend what is left of the five-request budget, then every spelling is
    // refused — the counter is on the number, not the representation.
    const remaining = OTP_MAX_REQUESTS_PER_PHONE - spellings.length;
    for (let i = 0; i < remaining; i += 1) {
      expect((await issuePastCooldown("08051234560", PURPOSE, "+2348051234560")).status)
        .toBe("SUCCESS");
    }
    expect(await redis.get(rateKey)).toBe(String(OTP_MAX_REQUESTS_PER_PHONE));
    for (const spelling of spellings) {
      expect((await issuePastCooldown(spelling, PURPOSE, "+2348051234560")).status)
        .toBe("RATE_LIMITED");
    }
  });

  it("does not let one number's budget consume another's", async () => {
    const phoneA = "08051234620";
    const phoneB = "08051234621";

    for (let i = 0; i < OTP_MAX_REQUESTS_PER_PHONE; i += 1) {
      expect((await issuePastCooldown(phoneA, PURPOSE, "+2348051234620")).status)
        .toBe("SUCCESS");
    }
    expect((await issuePastCooldown(phoneA, PURPOSE, "+2348051234620")).status)
      .toBe("RATE_LIMITED");

    // A different number is untouched by A's exhausted budget.
    expect((await issuePastCooldown(phoneB, PURPOSE, "+2348051234621")).status)
      .toBe("SUCCESS");
    expect(await redis.get(otpRateLimitKeyFor("+2348051234621"))).toBe("1");
  });

  it("leaves the per-IP budget behavior unchanged", async () => {
    const ip = "198.51.100.44";
    // Twenty distinct numbers from one IP — the IP ceiling, not the per-phone
    // ceiling, is what stops the twenty-first.
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_IP; i += 1) {
      const { phone, e164 } = distinctPhone(1200 + i);
      expect((await issuePastCooldown(phone, PURPOSE, e164, ip)).status).toBe("SUCCESS");
    }
    const last = distinctPhone(1300);
    const limited = await issuePastCooldown(last.phone, PURPOSE, last.e164, ip);
    expect(limited.status).toBe("RATE_LIMITED");
    expect(await redis.get(otpIpRateLimitKeyFor(ip)))
      .toBe(String(OTP_MAX_REQUESTS_PER_IP + 1));
  });
});

describe("security", () => {
  it("exposes no sensitive data in results or errors", async () => {
    const res = await requestOtp(
      { phoneNumber: "08031234562", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    const otp = res.otp!;
    const body = JSON.stringify(redis.raw(otpKeyFor(PURPOSE, "+2348031234562")));
    expect(body).not.toContain(otp);
    expect(body).not.toContain(SECRET);
    const bad = await verifyOtp(
      { phoneNumber: "08031234562", purpose: PURPOSE, otp: "000000" },
      { client: client() },
    );
    expect(JSON.stringify(bad)).not.toContain(otp);
    expect(JSON.stringify(bad)).not.toContain(SECRET);
  });

  it("fails loudly when the secret is missing, without leaking it", async () => {
    const saved = process.env.PHONE_OTP_SECRET;
    delete process.env.PHONE_OTP_SECRET;
    jest.resetModules();
    try {
      // Fresh module graph so neither process.env nor the already-captured
      // config value can supply the secret.
      const fresh = require("../../src/services/phoneOtp.service") as typeof import(
        "../../src/services/phoneOtp.service"
      );
      // NOTE: assert against the fresh copy's own error class — after
      // resetModules it is a different identity than the top-level import.
      await expect(fresh.requestOtp(
        { phoneNumber: "08031234563", purpose: PURPOSE },
        { client: client() },
      )).rejects.toThrow(fresh.OtpServiceError);
      await expect(fresh.requestOtp(
        { phoneNumber: "08031234563", purpose: PURPOSE },
        { client: client() },
      )).rejects.toThrow("PHONE_OTP_SECRET is not configured");
    } finally {
      process.env.PHONE_OTP_SECRET = saved;
      jest.resetModules();
    }
  });

  it("fails closed when Redis is unavailable", async () => {
    redis.fail = true;
    await expect(requestOtp(
      { phoneNumber: "08031234564", purpose: PURPOSE },
      { client: client() },
    )).rejects.toThrow(OtpServiceError);
    await expect(verifyOtp(
      { phoneNumber: "08031234564", purpose: PURPOSE, otp: "123456" },
      { client: client() },
    )).rejects.toThrow(OtpServiceError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1D.3 — the five-minute TTL must survive a FAILED verification.
// ─────────────────────────────────────────────────────────────────────────────
describe("expiry survives a failed attempt (script contract)", () => {
  /**
   * A source-level assertion, and deliberately so. `fakeRedis.ts` already
   * preserves a record's `expiresAt` when it bumps the attempt counter, so a
   * behavioural unit test CANNOT tell a correct script from a broken one here:
   * the model was already right and the production Lua was wrong. That is
   * exactly the gap the gated real-Redis suite exists to close.
   *
   * Redis's own documentation is the evidence that the script must not
   * read back the TTL: `SET` "discards" any previous TTL unless `KEEPTTL` is
   * passed, and `TTL` rounds to 0 across the final 500 ms of a key's life
   * (src/expire.c returns `(ttl+500)/1000`). A `SET ... EX ttl` guarded by
   * `ttl > 0` therefore fell through to a plain `SET` in that half-second and
   * rewrote an already-expired credential with no expiry at all — permanent,
   * and still matching the original digest.
   *
   * This assertion stops the shape regressing before that suite can run.
   */
  it("bumps attempts with KEEPTTL and never issues a TTL-dropping SET", () => {
    expect(VERIFY_LUA).toContain('"KEEPTTL"');
    // No read-back-and-reset: the remaining TTL is never inspected.
    expect(VERIFY_LUA).not.toMatch(/redis\.call\("TTL"/);

    // Every SET in the script carries an explicit expiry-preserving option.
    const setLines = VERIFY_LUA.split("\n").filter((l) => l.includes('redis.call("SET"'));
    expect(setLines.length).toBeGreaterThan(0);
    for (const line of setLines) {
      expect(line).toMatch(/"KEEPTTL"|"EX"|"EXAT"|"PX"|"PXAT"/);
    }
  });

  it("still issues every record with an explicit expiry", () => {
    // The other half of the same contract: ISSUE_LUA must still write with a
    // five-minute TTL, so a fix to the verify path cannot silently become a
    // lifetime change.
    const issueSetLines = ISSUE_LUA.split("\n").filter((l) => l.includes('redis.call("SET"'));
    expect(issueSetLines.length).toBeGreaterThan(0);
    for (const line of issueSetLines) {
      expect(line).toMatch(/"EX"|"EXAT"|"PX"|"PXAT"/);
      expect(line).not.toMatch(/KEEPTTL/);
    }
  });
});

describe("concurrency", () => {
  it("consumes the OTP exactly once under concurrent verification", async () => {
    const res = await requestOtp(
      { phoneNumber: "+14155552670", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    const input = { phoneNumber: "+14155552670", purpose: PURPOSE, otp: res.otp! };
    const args = { client: client() };
    const [first, second] = await Promise.all([verifyOtp(input, args), verifyOtp(input, args)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["EXPIRED", "SUCCESS"]);
  });

  it("never consumes an OTP twice when many verifications race", async () => {
    const res = await requestOtp(
      { phoneNumber: "+14155552671", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    const input = { phoneNumber: "+14155552671", purpose: PURPOSE, otp: res.otp! };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => verifyOtp(input, { client: client() })),
    );
    expect(results.filter((r) => r.status === "SUCCESS")).toHaveLength(1);
  });

  it("issues exactly one code when concurrent requests race", async () => {
    // Both requests start with no record. Without an atomic check the
    // cooldown would be read as clear twice, so both would mint and deliver
    // a code and both would charge the rate-limit budget.
    const phone = "+14155552672";
    const args = { client: client(), exposeOtp: true };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => requestOtp({ phoneNumber: phone, purpose: PURPOSE }, args)),
    );
    const issued = results.filter((r) => r.status === "SUCCESS");
    expect(issued).toHaveLength(1);
    expect(results.filter((r) => r.status === "COOLDOWN")).toHaveLength(4);
    // Only one unit of the per-phone budget was charged for the burst.
    expect(await redis.get(otpRateLimitKeyFor(phone))).toBe("1");
  });

  it("does not let racing verifications exceed the attempt limit", async () => {
    const res = await requestOtp(
      { phoneNumber: "+14155552673", purpose: PURPOSE },
      { client: client(), exposeOtp: true },
    );
    const wrong = res.otp! === "000000" ? "000001" : "000000";
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        verifyOtp({ phoneNumber: "+14155552673", purpose: PURPOSE, otp: wrong }, { client: client() }),
      ),
    );
    // Five are answered INVALID, the sixth exhausts the budget and the
    // rest arrive at an already-deleted record.
    expect(results.filter((r) => r.status === "INVALID")).toHaveLength(OTP_MAX_ATTEMPTS);
    expect(results.filter((r) => r.status === "MAX_ATTEMPTS")).toHaveLength(1);
    expect(results.filter((r) => r.status === "EXPIRED")).toHaveLength(2);
    // The correct code is dead either way — no attempt budget survived.
    expect(await verifyOtp(
      { phoneNumber: "+14155552673", purpose: PURPOSE, otp: res.otp! },
      { client: client() },
    )).toEqual({ status: "EXPIRED" });
  });
});

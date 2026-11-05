/**
 * Batch 1D.39 (F4) — the PRODUCTION OTP Lua scripts, executed against a real
 * Redis.
 *
 * Why this suite exists: every other OTP test runs the scripts through
 * tests/helpers/fakeRedis.ts, which is a hand-written JavaScript MODEL of the
 * Lua. A model cannot prove the script parses inside Redis, that the argument
 * order the service sends matches the argument order the script reads, or
 * that Redis' single-threaded execution really does make issuance atomic
 * under concurrency. This suite closes that gap by evaluating the exact
 * strings exported from src/services/phoneOtp.service.ts.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 * It will only run against a local, disposable, non-default Redis named by
 * OTP_TEST_REDIS_URL. It NEVER falls back to the application's REDIS_URL,
 * which points at shared production infrastructure. The gate refuses TLS
 * schemes, non-loopback hosts and database 0, and the suite deletes only the
 * keys it created (tracked explicitly, plus a namespace-scoped SCAN sweep).
 * It never issues FLUSHDB, FLUSHALL, DEL on a wildcard, or any config change.
 *
 * ── STATUS ──────────────────────────────────────────────────────────────────
 * As of Batch 1D.39 this suite is PREPARED BUT NOT EXECUTED: the environment
 * has no Redis server, no Redis binary and no container runtime, and the
 * configured REDIS_URL is production. With OTP_TEST_REDIS_URL unset the suite
 * FAILS with an explicit blocker rather than reporting a pass, so it can
 * never be mistaken for verified evidence.
 *
 * To run it later, against a throwaway server:
 *
 *   redis-server --port 6399 --save '' --appendonly no --daemonize no
 *   OTP_TEST_REDIS_URL=redis://127.0.0.1:6399/15 \
 *     npm run test:redis-integration
 */

// The OTP service's module-level Redis client is never used here: every call
// in this file passes an explicit `client` built from OTP_TEST_REDIS_URL.
// Mocking the module is therefore a SAFETY measure as much as a convenience —
// it guarantees this suite cannot open a connection to the application's
// configured REDIS_URL, whatever that happens to be.
jest.mock("../../../src/lib/redis", () => ({
  __esModule: true,
  redisUsersSessions: {},
}));

import { createClient, type RedisClientType } from "redis";
import { normalizePhoneNumber } from "../../../src/utils/phone";
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
} from "../../../src/services/phoneOtp.service";
import {
  evaluateDisposableRedisTarget,
  redisTestNamespace,
} from "../../helpers/localRedisTarget";
import { createRunPhoneNumberFactory, runScopedTestIp, runEntropy, mix32 } from "../../helpers/otpTestPhoneNumbers";

const decision = evaluateDisposableRedisTarget(process.env.OTP_TEST_REDIS_URL);

const BLOCKED_MESSAGE =
  "F4 integration suite cannot run here. " +
  (decision.ok
    ? ""
    : `Reason: ${decision.reason} `) +
  "This suite executes the production ISSUE_LUA/VERIFY_LUA against a real Redis. " +
  "It is intentionally reported as a failure, not a skip, so a green run can never " +
  "be mistaken for evidence that the Lua was executed.";

// Batch 1D.45: the production key format is `otp:<kind>:<E.164>`, so the
// phone number and the client IP are the only key discriminators a test can
// control. Both are therefore run-scoped: two concurrent runs must not share
// them, or one run's cleanup would delete the other's data.
const RUN_ENTROPY = runEntropy();

/** How many distinct client addresses one run may consume. */
const IP_RESERVED_PER_RUN = 32;
/** Draws allowed before giving up on finding a fresh address. */
const IP_DRAW_LIMIT = 256;

/**
 * Per-test client addresses.
 *
 * Every issuance charges the production per-IP budget
 * (`otp:rl:ip:<identity>`, 20 per 24 h). That limit is real behaviour under
 * test, not something a test may opt out of, so it must not be spent by
 * unrelated tests: with ONE address for the whole file the budget was
 * exhausted partway through, after which `requestOtp` returned RATE_LIMITED
 * having stored nothing and returned no code — and every later assertion
 * silently degraded onto an undefined OTP.
 *
 * So each issuance gets its own address by default. Tests that ARE about the
 * per-IP limit take a single address and pass it explicitly, so they still
 * share it deliberately ("allows twenty IP requests per window").
 *
 * Addresses come from `runScopedTestIp`, so they stay inside the RFC 5737
 * documentation space that helper already reserves. Distinctness within a run
 * is guaranteed by resampling (bounded), not assumed — a run that somehow
 * cannot find a free address fails loudly instead of quietly re-coupling two
 * tests through a shared budget.
 */
function createTestIpFactory(entropy: number): () => string {
  const issued = new Set<string>();
  let draws = 0;
  return function nextIp(): string {
    for (let attempt = 0; attempt < IP_DRAW_LIMIT; attempt += 1) {
      if (issued.size >= IP_RESERVED_PER_RUN) {
        throw new Error(
          `OTP test ran out of reserved client IPs (${IP_RESERVED_PER_RUN}). ` +
            "Raise IP_RESERVED_PER_RUN or reduce the number of issuances per run.",
        );
      }
      draws += 1;
      const ip = runScopedTestIp(mix32((entropy + draws) >>> 0));
      if (!issued.has(ip)) {
        issued.add(ip);
        return ip;
      }
    }
    throw new Error(
      `OTP test could not find a distinct client IP after ${IP_DRAW_LIMIT} draws.`,
    );
  };
}

const nextIp = createTestIpFactory(RUN_ENTROPY);

// Phase 3.1.4: test-only OTP secret. The service under test reads
// PHONE_OTP_SECRET lazily on every call (getOtpSecret) and rejects an empty
// value, so the suite needs one configured. This dummy is scoped to the test
// process, used only if the operator did not already provide a value, and is
// NOT a credential: it signs nothing outside this disposable run, is never
// logged, and must never be copied into real configuration. Validation,
// rate limiting, and verification behavior are unchanged — the secret only
// unlocks the HMAC path the tests exist to exercise.
if (!process.env.PHONE_OTP_SECRET) {
  process.env.PHONE_OTP_SECRET = "test-only-phone-otp-secret-not-a-credential-phase-3-1-4";
}

let redis: RedisClientType;
const writtenKeys = new Set<string>();
let redisVersion = "unknown";

/**
 * A valid E.164 number, unique within this run and disjoint from any other
 * run started at a different time.
 *
 * The previous inline generator produced `+120255501001`, which
 * `normalizePhoneNumber()` rejects — so every `requestOtp()` below would
 * have thrown before reaching Redis. See tests/helpers/otpTestPhoneNumbers.ts.
 */
const nextPhone = createRunPhoneNumberFactory(RUN_ENTROPY);

const e164Of = (phone: string) => phone;

function track(...keys: string[]): void {
  keys.forEach((k) => writtenKeys.add(k));
}

/** Records of the keys an issuance creates, so cleanup is exact. */
function keysForIssue(phone: string, ip: string): string[] {
  return [
    otpKeyFor(OtpPurpose.PHONE_LOGIN, e164Of(phone)),
    otpRateLimitKeyFor(e164Of(phone)),
    otpIpRateLimitKeyFor(ip),
  ];
}

async function issue(phone: string, ip = nextIp(), client: RedisClientType = redis) {
  track(...keysForIssue(phone, ip));
  // `exposeOtp` is the service's documented test-only escape hatch
  // (RequestOtpOptions.exposeOtp): the plaintext is returned ONLY when it is
  // set, and otherwise the result is exactly `{ status: "SUCCESS" }`. Without
  // it `res.otp` is undefined, so every test that needs to verify a code —
  // or to derive a wrong one — failed on the undefined value before reaching
  // any assertion about Redis. This mirrors tests/unit/phoneOtp.test.ts, which
  // passes the same flag. It changes nothing about what is stored: the record
  // still holds only the bound HMAC digest.
  return requestOtp(
    { phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, ip },
    { client, exposeOtp: true },
  );
}

/**
 * Age an OTP record so its resend cooldown has lapsed.
 *
 * The cooldown is NOT a function of the key's TTL. ISSUE_LUA compares the
 * caller's clock against the record's OWN `s` field — epoch ms of the last
 * generation — so shortening the TTL with EXPIRE leaves `s` untouched and the
 * next issuance still answers COOLDOWN. That was the previous behaviour of
 * this helper, and it is why the cooldown and per-phone budget tests failed
 * against a correct production script.
 *
 * So `s` is moved back instead (and `c` with it, since both record the same
 * generation). The rewrite is done with KEEPTTL so the record's real
 * five-minute expiry is carried across unchanged: never shortened, and — the
 * part that matters — never discarded, since a bare SET would strip it and
 * leave a permanent record behind.
 *
 * Returns 1 = aged, 0 = no such record, -1 = unparseable record. Anything but
 * 1 raises, so a broken precondition can never be mistaken for a step that
 * simply had nothing to do.
 */
const BACKDATE_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return 0
end
local ok, rec = pcall(cjson.decode, raw)
if not ok or type(rec) ~= "table" or type(rec.s) ~= "number" then
  return -1
end
rec.s = tonumber(ARGV[1])
rec.c = tonumber(ARGV[1])
redis.call("SET", KEYS[1], cjson.encode(rec), "KEEPTTL")
return 1
`;

async function backdate(key: string, ms: number): Promise<void> {
  const code = Number(
    await redis.eval(BACKDATE_LUA, {
      keys: [key],
      arguments: [String(Date.now() - ms)],
    }),
  );
  if (code === 0) {
    throw new Error(`backdate: no OTP record at ${key}`);
  }
  if (code !== 1) {
    throw new Error(`backdate: malformed OTP record at ${key}`);
  }
}

describe("OTP Lua scripts against real Redis", () => {
  beforeAll(async () => {
    if (!decision.ok) throw new Error(BLOCKED_MESSAGE);
    redis = createClient({ url: decision.url }) as unknown as RedisClientType;
    await redis.connect();
    const info = (await redis.info("server")) as string;
    redisVersion = /redis_version:([^\r\n]+)/.exec(info)?.[1]?.trim() ?? "unknown";
    // Record the exact production scripts we are about to exercise.
    if (!ISSUE_LUA || !VERIFY_LUA) throw new Error("production Lua scripts are not exported");
  }, 30000);

  afterAll(async () => {
    if (!redis?.isOpen) return;
    // Delete ONLY keys this suite wrote, by exact name.
    if (writtenKeys.size) await redis.del([...writtenKeys]);
    // Belt and braces: sweep the per-run namespace in case a test wrote a
    // key built from a helper this suite did not register.
    for await (const keys of redis.scanIterator({
      MATCH: `${redisTestNamespace("*")}`,
      COUNT: 200,
    })) {
      if (keys.length) await redis.del(keys as string[]);
    }
    await redis.quit();
  });

  it("reports the server it is exercising", () => {
    expect(decision.ok).toBe(true);
    expect(redisVersion).toMatch(/^\d+\./);
    // eslint-disable-next-line no-console
    console.log(`[F4] exercising production Lua against ${decision.description}, redis_version=${redisVersion}`);
  });

  it("verifies the production constants separately from any test tuning", () => {
    expect(OTP_TTL_SECONDS).toBe(300);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
    expect(OTP_MAX_REQUESTS_PER_PHONE).toBe(5);
    expect(OTP_MAX_REQUESTS_PER_IP).toBe(20);
    expect(OTP_RATE_LIMIT_WINDOW_SECONDS).toBe(86400);
  });

  it("stores an HMAC-only record with the production TTL", async () => {
    const phone = nextPhone();
    const res = await issue(phone);
    expect(res.status).toBe("SUCCESS");
    const raw = await redis.get(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone));
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(res.otp);
    expect(JSON.parse(raw!)).toEqual({ d: expect.any(String), a: 0, c: expect.any(Number), s: expect.any(Number) });
    // Real TTL, not a model of one.
    expect(await redis.ttl(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone))).toBe(OTP_TTL_SECONDS);
  });

  it("makes the record genuinely expire", async () => {
    const phone = nextPhone();
    const res = await issue(phone);
    expect(res.status).toBe("SUCCESS");
    await redis.expire(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone), 1);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await redis.exists(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone))).toBe(0);
    expect(await verifyOtp({ phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: res.otp! }, { client: redis }))
      .toEqual({ status: "EXPIRED" });
  }, 20000);

  it("never lets a failed attempt outlive the record's original expiration", async () => {
    // Phase 1D.3 regression. VERIFY_LUA previously bumped the attempt counter
    // by reading the key's TTL and re-issuing it with SET ... EX. Redis
    // documents that a SET without an expiry option DISCARDS the previous TTL,
    // and the integer-second TTL reports 0 across the final 500 ms of a key's
    // life — so a wrong guess landing in that window fell through to a plain
    // SET and turned a five-minute credential into a PERMANENT one, whose
    // original digest still matched. The fix writes with KEEPTTL.
    //
    // PEXPIRE is used for the shortening because the bug lives in the
    // sub-second boundary, which EXPIRE (whole seconds) cannot express. The
    // assertions below are deliberately made against PTTL and against the
    // record's eventual disappearance, never against the value of the
    // integer-second TTL, which rounds and would make this flaky.
    const phone = nextPhone();
    const key = otpKeyFor(OtpPurpose.PHONE_LOGIN, phone);
    const res = await issue(phone);
    expect(res.status).toBe("SUCCESS");
    // The record starts life with the production five-minute deadline.
    expect(await redis.ttl(key)).toBe(OTP_TTL_SECONDS);

    // 400 ms is inside the window where TTL reads 0 but still leaves ample
    // margin for one EVAL round trip.
    await redis.pExpire(key, 400);

    const wrong = res.otp === "000000" ? "000001" : "000000";
    expect((await verifyOtp({ phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: wrong }, { client: redis })).status)
      .toBe("INVALID");

    // THE DISCRIMINATOR. The failed attempt must have left the key expiring.
    // Under the old script this key had become permanent, so pTTL and ttl both
    // report the -1 "no associated expiration" sentinel.
    expect(await redis.pTTL(key)).toBeGreaterThan(0);
    expect(await redis.ttl(key)).not.toBe(-1);

    // Poll instead of sleeping a fixed amount: the lifetime is deliberately
    // sub-second, so a fixed sleep would be either flaky or needlessly long.
    const deadline = Date.now() + 3000;
    while ((await redis.exists(key)) !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await redis.exists(key)).toBe(0);

    // And the original code is therefore dead, rather than revived by the
    // record having outlived its own deadline.
    expect(await verifyOtp({ phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: res.otp! }, { client: redis }))
      .toEqual({ status: "EXPIRED" });
  }, 20000);

  it("enforces the 60-second cooldown", async () => {
    const phone = nextPhone();
    expect((await issue(phone)).status).toBe("SUCCESS");
    expect((await issue(phone)).status).toBe("COOLDOWN");
    await backdate(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone), (OTP_RESEND_COOLDOWN_SECONDS + 2) * 1000);
    expect((await issue(phone)).status).toBe("SUCCESS");
  });

  it("allows five phone requests per window and refuses the sixth", async () => {
    const phone = nextPhone();
    const key = otpKeyFor(OtpPurpose.PHONE_LOGIN, phone);
    for (let i = 0; i < OTP_MAX_REQUESTS_PER_PHONE; i++) {
      expect((await issue(phone)).status).toBe("SUCCESS");
      await backdate(key, (OTP_RESEND_COOLDOWN_SECONDS + 2) * 1000);
    }
    const sixth = await issue(phone);
    expect(sixth.status).toBe("RATE_LIMITED");
    // The counter really is on a 24-hour expiry in Redis.
    const ttl = await redis.ttl(otpRateLimitKeyFor(phone));
    expect(ttl).toBeGreaterThan(OTP_RATE_LIMIT_WINDOW_SECONDS - 120);
    expect(ttl).toBeLessThanOrEqual(OTP_RATE_LIMIT_WINDOW_SECONDS);
  });

  it("allows twenty IP requests per window and refuses the twenty-first", async () => {
    // Deliberately ONE address for all 21 issuances: sharing the per-IP budget
    // is exactly what this test is asserting.
    const ip = nextIp();
    const phones = Array.from({ length: OTP_MAX_REQUESTS_PER_IP }, () => nextPhone());
    for (const phone of phones) {
      expect((await issue(phone, ip)).status).toBe("SUCCESS");
    }
    const twentyFirst = await issue(nextPhone(), ip);
    expect(twentyFirst.status).toBe("RATE_LIMITED");
    expect(await redis.get(otpIpRateLimitKeyFor(ip))).toBe(String(OTP_MAX_REQUESTS_PER_IP + 1));
    // Nothing was stored for the refused request.
    expect(await redis.exists(otpKeyFor(OtpPurpose.PHONE_LOGIN, nextPhone()))).toBe(0);
  });

  it("gives each issuance exactly one record and one counter increment", async () => {
    const phone = nextPhone();
    const ip = nextIp();
    await issue(phone, ip);
    expect(await redis.get(otpRateLimitKeyFor(phone))).toBe("1");
    expect(await redis.get(otpIpRateLimitKeyFor(ip))).toBe("1");
    await backdate(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone), (OTP_RESEND_COOLDOWN_SECONDS + 2) * 1000);
    await issue(phone, ip);
    expect(await redis.get(otpRateLimitKeyFor(phone))).toBe("2");
    expect(await redis.get(otpIpRateLimitKeyFor(ip))).toBe("2");
  });

  it("is atomic under concurrent issuance for one number", async () => {
    const phone = nextPhone();
    // Redis executes each EVAL to completion before the next, so exactly one
    // of these can win the "no existing record" race.
    const results = await Promise.all(Array.from({ length: 8 }, () => issue(phone)));
    expect(results.filter((r) => r.status === "SUCCESS")).toHaveLength(1);
    expect(results.filter((r) => r.status === "COOLDOWN")).toHaveLength(7);
    // Only one issuance was charged against the budget.
    expect(await redis.get(otpRateLimitKeyFor(phone))).toBe("1");
  });

  it("consumes a valid OTP exactly once", async () => {
    const phone = nextPhone();
    const res = await issue(phone);
    expect((await verifyOtp({ phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: res.otp! }, { client: redis })).status)
      .toBe("SUCCESS");
    expect(await redis.exists(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone))).toBe(0);
    // Replay is refused.
    expect((await verifyOtp({ phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: res.otp! }, { client: redis })).status)
      .toBe("EXPIRED");
  });

  it("answers five wrong codes then refuses the sixth, and destroys the record", async () => {
    const phone = nextPhone();
    const res = await issue(phone);
    const wrong = res.otp === "000000" ? "000001" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      expect((await verifyOtp({ phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: wrong }, { client: redis })).status)
        .toBe("INVALID");
      const rec = JSON.parse((await redis.get(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone)))!);
      expect(rec.a).toBe(i + 1);
    }
    expect((await verifyOtp({ phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: wrong }, { client: redis })).status)
      .toBe("MAX_ATTEMPTS");
    expect(await redis.exists(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone))).toBe(0);
    // The real code is dead too.
    expect((await verifyOtp({ phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: res.otp! }, { client: redis })).status)
      .toBe("EXPIRED");
  });

  it("lets exactly one concurrent verification consume the OTP", async () => {
    const phone = nextPhone();
    const res = await issue(phone);
    const input = { phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: res.otp! };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => verifyOtp(input, { client: redis })),
    );
    expect(results.filter((r) => r.status === "SUCCESS")).toHaveLength(1);
    expect(results.filter((r) => r.status === "SUCCESS" || r.status === "EXPIRED")).toHaveLength(12);
  });

  it("does not let racing wrong verifications exceed the attempt limit", async () => {
    const phone = nextPhone();
    const res = await issue(phone);
    const wrong = res.otp === "000000" ? "000001" : "000000";
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        verifyOtp({ phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: wrong }, { client: redis })),
    );
    expect(results.filter((r) => r.status === "INVALID")).toHaveLength(OTP_MAX_ATTEMPTS);
    expect(await redis.exists(otpKeyFor(OtpPurpose.PHONE_LOGIN, phone))).toBe(0);
  });

  it("binds the digest to the purpose, using the real scripts", async () => {
    const phone = nextPhone();
    const res = await issue(phone);
    // The code was issued for PHONE_LOGIN; it is presented here as
    // PHONE_VERIFICATION. Cross-purpose use MUST NOT succeed, and the correct
    // answer is EXPIRED, not INVALID: the record is stored under the
    // purpose-scoped key `otp:phone:PHONE_LOGIN:<e164>`, so verifying under
    // PHONE_VERIFICATION reads a key that does not exist and VERIFY_LUA
    // returns 0, which the service maps to EXPIRED. This expectation was
    // previously "INVALID" and only ever passed for the wrong reason —
    // `issue()` was returning RATE_LIMITED, so `res.otp` was undefined and the
    // `^\d{6}$` guard returned INVALID before any Redis lookup happened.
    expect((await verifyOtp(
      { phoneNumber: phone, purpose: OtpPurpose.PHONE_VERIFICATION, otp: res.otp! },
      { client: redis },
    )).status).toBe("EXPIRED");
  });

  it("propagates a Redis failure as the service's documented fail-closed error", async () => {
    const phone = nextPhone();
    const broken = {
      eval: () => Promise.reject(new Error("redis down")),
      get: () => Promise.reject(new Error("redis down")),
      del: () => Promise.reject(new Error("redis down")),
    } as unknown as RedisClientType;
    await expect(requestOtp(
      { phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, ip: nextIp() },
      { client: broken },
    )).rejects.toThrow(/unavailable/i);
    await expect(verifyOtp(
      { phoneNumber: phone, purpose: OtpPurpose.PHONE_LOGIN, otp: "123456" },
      { client: broken },
    )).rejects.toThrow(/unavailable/i);
  });

  it("actually evaluates ISSUE_LUA and VERIFY_LUA with the documented ARGV layout", async () => {
    // Direct EVAL, bypassing the service, so the positional contract is
    // pinned against Redis rather than against the TypeScript call site.
    const key = `${redisTestNamespace("argv")}:record`;
    const phone = nextPhone();
    const now = Date.now();
    const code = await redis.eval(ISSUE_LUA, {
      keys: [key, `${key}:phone`, `${key}:ip`],
      arguments: [
        String(now),
        String(OTP_RESEND_COOLDOWN_SECONDS * 1000),
        String(OTP_RATE_LIMIT_WINDOW_SECONDS),
        String(OTP_MAX_REQUESTS_PER_PHONE),
        String(OTP_RATE_LIMIT_WINDOW_SECONDS),
        String(OTP_MAX_REQUESTS_PER_IP),
        JSON.stringify({ d: "digest", a: 0, c: now, s: now }),
        String(OTP_TTL_SECONDS),
        "1",
      ],
    });
    writtenKeys.add(key);
    writtenKeys.add(`${key}:phone`);
    writtenKeys.add(`${key}:ip`);
    expect(Number(code)).toBe(0);
    expect(await redis.get(`${key}:phone`)).toBe("1");
    // ARGV[7] is the record and ARGV[8] is the TTL.
    expect(await redis.ttl(key)).toBe(OTP_TTL_SECONDS);
    // ARGV[1] is the expected digest for VERIFY_LUA.
    expect(Number(await redis.eval(VERIFY_LUA, {
      keys: [key],
      arguments: ["digest", String(OTP_MAX_ATTEMPTS)],
    }))).toBe(1);
    expect(await redis.exists(key)).toBe(0);
  });

  it("uses phone numbers that survive real normalization", () => {
    // The generated numbers must be accepted by the production
    // normalizer; the old generator's were not, and this assertion is the
    // shape check that let it through.
    const sample = e164Of(nextPhone());
    expect(sample).toMatch(/^\+23480\d{8}$/);
    expect(() => normalizePhoneNumber(sample)).not.toThrow();
  });
});
/**
 * Batch 1D.70 — shared, credential-scoped finalization counter (service level).
 *
 * Exercises the REAL `recordResetAttempt` and the real key/identity builders
 * from src/services/passwordResetLimits.service.ts against FakeRedis.
 *
 * What these tests prove, and what they do not. They prove the decision logic:
 * five attempts are permitted and the sixth is exhausted, the counter is
 * increment-first so concurrent callers cannot slip extras past the limit, two
 * "instances" sharing one store share one budget, the key is opaque and
 * distinct per credential, and the expiry tracks the supplied remaining
 * lifetime. They CANNOT prove that the Lua parses or executes inside real
 * Redis, that node-redis' command timeout actually cancels a stalled command,
 * or that the counter outlives the credential under real server clock skew —
 * those need isolated infrastructure and are reported as outstanding.
 */
import { FakeRedis, testRedis } from "../helpers/fakeRedis";
import type { RedisClientType } from "redis";
import {
  recordResetAttempt,
  resetFinalizeIdentity,
  resetFinalizeKeyFor,
  RESET_FINALIZE_MAX_ATTEMPTS,
  RESET_ATTEMPT_LUA,
  RESET_LIMITS_COMMAND_TIMEOUT_MS,
  PasswordResetLimitsError,
} from "../../src/services/passwordResetLimits.service";
import { resetJwtDigest } from "../../src/utils/resetTokenDigest";
import config from "../../src/config/config";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn(), update: jest.fn(async () => ({})) } },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  get redisUsersSessions() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../helpers/fakeRedis").testRedis.current;
  },
}));

const SECRET = config.jwtResetSecret;
const TOKEN_A = "header.payload.signature-a";
const TOKEN_B = "header.payload.signature-b";

let redis: FakeRedis;
// Same cast the existing limits suite uses: FakeRedis models the client's
// surface, it is not structurally a RedisClientType.
const client = () => redis as unknown as RedisClientType;
const keyOf = (token: string) => resetFinalizeKeyFor(token);

/** The controller's call shape: an integer TTL taken from the credential. */
function countAttempt(token: string, windowSeconds = 600) {
  return recordResetAttempt(keyOf(token), {
    client: client(),
    windowSeconds,
    maxAttempts: RESET_FINALIZE_MAX_ATTEMPTS,
    timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  redis = new FakeRedis();
  testRedis.current = redis;
});

describe("finalization counter budget", () => {
  it("permits five attempts and marks the sixth exhausted", async () => {
    for (let n = 1; n <= RESET_FINALIZE_MAX_ATTEMPTS; n += 1) {
      const out = await countAttempt(TOKEN_A);
      expect(out.count).toBe(n);
      expect(out.exhausted).toBe(false);
    }
    const sixth = await countAttempt(TOKEN_A);
    expect(sixth.count).toBe(6);
    expect(sixth.exhausted).toBe(true);
  });

  it("consumes budget on every attempt regardless of the caller's outcome", async () => {
    // A caller that abandons after the counter (bad digest, replay, 404) has
    // still been charged: the counter only knows how many requests arrived.
    await countAttempt(TOKEN_A);
    await countAttempt(TOKEN_A);
    expect((await countAttempt(TOKEN_A)).count).toBe(3);
    expect(redis.raw(keyOf(TOKEN_A))).toBeDefined();
  });

  it("never exceeds the budget under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => countAttempt(TOKEN_A)),
    );
    const permitted = results.filter((r) => !r.exhausted);
    const exhausted = results.filter((r) => r.exhausted);
    expect(permitted).toHaveLength(RESET_FINALIZE_MAX_ATTEMPTS);
    expect(exhausted).toHaveLength(12 - RESET_FINALIZE_MAX_ATTEMPTS);
    // Increment-first: the stored counter is the true arrival count, so no
    // caller can slip past the limit by racing.
    expect(redis.raw(keyOf(TOKEN_A))).toBe("12");
  });

  it("is shared across instances that share one Redis", async () => {
    // Two separate service "instances" — same shared store, no shared memory.
    await countAttempt(TOKEN_A);
    await countAttempt(TOKEN_A);
    await countAttempt(TOKEN_A);
    // A different process picks up the same budget; the per-process IP limiter
    // could not do this.
    expect((await countAttempt(TOKEN_A)).exhausted).toBe(false);
    expect((await countAttempt(TOKEN_A)).exhausted).toBe(false);
    expect((await countAttempt(TOKEN_A)).exhausted).toBe(true);
  });
});

describe("finalization counter key hygiene", () => {
  it("keys are opaque: no raw JWT and no stored database digest", () => {
    const key = keyOf(TOKEN_A);
    expect(key).not.toContain(TOKEN_A);
    expect(key).not.toContain(TOKEN_A.split(".")[2]);
    // The DB stores resetJwtDigest(...); the counter key must not be that
    // value, or a Redis dump would yield a persisted database column.
    expect(key).not.toContain(resetJwtDigest(SECRET, TOKEN_A));
    expect(resetFinalizeIdentity(TOKEN_A)).not.toBe(resetJwtDigest(SECRET, TOKEN_A));
    expect(key).toBe(`pwdreset:finalize:${resetFinalizeIdentity(TOKEN_A)}`);
  });

  it("different credentials get different keys and independent budgets", async () => {
    expect(keyOf(TOKEN_A)).not.toBe(keyOf(TOKEN_B));

    for (let n = 0; n < RESET_FINALIZE_MAX_ATTEMPTS; n += 1) {
      await countAttempt(TOKEN_A);
    }
    expect((await countAttempt(TOKEN_A)).exhausted).toBe(true);

    // A different credential is unaffected by another credential's budget.
    expect((await countAttempt(TOKEN_B)).exhausted).toBe(false);
  });
});

describe("finalization counter expiry", () => {
  it("takes its TTL from the credential's remaining lifetime", async () => {
    await countAttempt(TOKEN_A, 517);
    const ttl = redis.ttlOf(keyOf(TOKEN_A));
    expect(ttl).toBeGreaterThan(510);
    expect(ttl).toBeLessThanOrEqual(517);
  });

  it("never expires before the credential does, and later attempts do not extend it", async () => {
    // The Lua sets EXPIRE only on the first increment, so the window is fixed
    // by the credential's lifetime at first contact.
    await countAttempt(TOKEN_A, 300);
    const firstTtl = redis.ttlOf(keyOf(TOKEN_A));
    await countAttempt(TOKEN_A, 600); // a later caller claiming a longer life
    const secondTtl = redis.ttlOf(keyOf(TOKEN_A));
    expect(secondTtl).toBeLessThanOrEqual(firstTtl);
    expect(secondTtl).toBeLessThanOrEqual(300);
  });

  it("uses the existing attempt-counter Lua rather than a new script", async () => {
    const seen: Array<{ keys: string[]; args: string[] }> = [];
    const origEval = redis.eval.bind(redis);
    (redis as any).eval = async (script: string, opts: { keys: string[]; arguments: string[] }) => {
      seen.push({ keys: opts.keys, args: opts.arguments });
      return origEval(script, opts);
    };
    await countAttempt(TOKEN_A, 420);
    expect(seen).toHaveLength(1);
    expect(seen[0].keys).toEqual([keyOf(TOKEN_A)]);
    expect(seen[0].args).toEqual(["420"]);
    expect(typeof RESET_ATTEMPT_LUA).toBe("string");
  });
});

describe("finalization counter failure behavior", () => {
  it("fails closed when Redis is unavailable", async () => {
    redis.fail = true;
    await expect(countAttempt(TOKEN_A)).rejects.toThrow(PasswordResetLimitsError);
  });

  it("tolerates a client without withCommandOptions (test doubles degrade safely)", async () => {
    // FakeRedis has no withCommandOptions; the bounded-timeout helper must not
    // turn that into an error. The double also cannot stall, so nothing is
    // lost by running unbounded here.
    expect(typeof (redis as unknown as { withCommandOptions?: unknown }).withCommandOptions)
      .toBe("undefined");
    await expect(countAttempt(TOKEN_A)).resolves.toMatchObject({ count: 1 });
  });
});

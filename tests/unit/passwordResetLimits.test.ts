/**
 * Batch 1D.53 — password-reset abuse controls.
 *
 * Two controls, both enforced in Redis so they hold across concurrent
 * requests and application instances:
 *
 *   1. Attempt limiting: at most 5 incorrect verifications per challenge.
 *      Counting is increment-first inside one Lua round trip, so concurrent
 *      guesses cannot slip extras past the limit.
 *   2. Resend cooldown: one reset email per account per 60 seconds, acquired
 *      atomically with SET NX EX.
 *
 * What these tests do and do not prove. Service-level tests run against
 * FakeRedis, which executes each script body synchronously — the same
 * serialization real Redis gives a Lua script — so "exactly N increments
 * from N concurrent calls" is meaningful here. But FakeRedis is still a
 * model: it cannot prove the Lua parses inside Redis. That gap belongs to
 * the real-Redis integration suite (which remains blocked on infrastructure),
 * and every concurrency claim below is labeled accordingly.
 */
import type { RedisClientType } from "redis";

const mockSendResetEmail: jest.Mock = jest.fn(async () => {});

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn() },
    passwordResetToken: {
      upsert: jest.fn(async () => ({})),
      findUnique: jest.fn(),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  },
}));

jest.mock("../../src/services/mail/sendResetEmail", () => ({
  __esModule: true,
  sendResetEmail: (...args: unknown[]) => mockSendResetEmail(...(args as [])),
}));

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  deleteAllUserSessions: jest.fn(async () => {}),
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  // Served lazily from the per-test FakeRedis, so the limits run against
  // shared state with real TTLs rather than stubs.
  get redisUsersSessions() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../helpers/fakeRedis").testRedis.current;
  },
}));

import prisma from "../../src/lib/prisma";
import config from "../../src/config/config";
import { FakeRedis, testRedis } from "../helpers/fakeRedis";
import {
  forgotPassword,
  verifyResetCode,
} from "../../src/controllers/auth.controller";
import {
  RESET_MAX_ATTEMPTS,
  RESET_ATTEMPT_WINDOW_SECONDS,
  RESET_COOLDOWN_SECONDS,
  PasswordResetLimitsError,
  acquireResetCooldown,
  clearResetAttempts,
  recordResetAttempt,
  resetAttemptsKeyFor,
  resetCooldownKeyFor,
  resetUnknownAttemptsKeyFor,
  resetUnknownCooldownKeyFor,
} from "../../src/services/passwordResetLimits.service";
import { resetCodeDigest } from "../../src/utils/resetTokenDigest";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const SECRET = config.jwtResetSecret;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};
const statusOf = (r: any): number => r.status.mock.calls[0][0];
const bodyOf = (r: any): any => r.json.mock.calls[0][0];

const KNOWN = { id: "u-known", email: "known@example.com", authProviders: [] as string[] };
const CODE = "ABC123";
const WRONG = "ZZZZZZ";

const clientOf = () => testRedis.current as unknown as RedisClientType;

function seedChallenge(code: string = CODE, expiresInMs = 60_000) {
  db.passwordResetToken.findUnique.mockResolvedValue({
    userId: KNOWN.id,
    token: resetCodeDigest(SECRET, KNOWN.email, code),
    expiresAt: new Date(Date.now() + expiresInMs),
  });
}

/** The code the mailer was asked to deliver on the most recent issuance. */
function emailedCode(): string {
  return mockSendResetEmail.mock.calls[mockSendResetEmail.mock.calls.length - 1][2] as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  testRedis.current = new FakeRedis();
  mockSendResetEmail.mockResolvedValue(undefined);
  db.user.findUnique.mockResolvedValue(null);
  db.passwordResetToken.findUnique.mockResolvedValue(null);
  db.passwordResetToken.findFirst.mockResolvedValue(null);
  db.user.update.mockImplementation(async (args: any) => ({ ...KNOWN, ...args.data }));
});

describe("service: recordResetAttempt", () => {
  it("1. permits five attempts and reports exhaustion from the sixth", async () => {
    const key = resetAttemptsKeyFor(KNOWN.id);
    for (let i = 1; i <= RESET_MAX_ATTEMPTS; i++) {
      const r = await recordResetAttempt(key, { client: clientOf() });
      expect(r).toEqual({ count: i, exhausted: false });
    }
    expect(RESET_MAX_ATTEMPTS).toBe(5);
    const sixth = await recordResetAttempt(key, { client: clientOf() });
    expect(sixth).toEqual({ count: 6, exhausted: true });
    // Stays exhausted; the counter keeps counting so the state is observable.
    expect(await recordResetAttempt(key, { client: clientOf() })).toEqual({
      count: 7,
      exhausted: true,
    });
  });

  it("2. concurrent increments are all counted (model-level atomicity)", async () => {
    // FakeRedis runs each script body synchronously, the way Redis
    // single-threads a Lua script — so "no lost increments" here models the
    // production guarantee rather than proving it (see file header).
    const key = resetAttemptsKeyFor("concurrent-user");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordResetAttempt(key, { client: clientOf() })),
    );
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(results.filter((r) => r.exhausted)).toHaveLength(3);
  });

  it("sets a bounded TTL so counters cannot linger", async () => {
    const key = resetAttemptsKeyFor(KNOWN.id);
    await recordResetAttempt(key, { client: clientOf() });
    const ttl = (testRedis.current as FakeRedis).ttlOf(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(RESET_ATTEMPT_WINDOW_SECONDS);
    expect(RESET_ATTEMPT_WINDOW_SECONDS).toBe(600);
  });

  it("4. clearResetAttempts re-arms the challenge from zero", async () => {
    const key = resetAttemptsKeyFor(KNOWN.id);
    await recordResetAttempt(key, { client: clientOf() });
    await recordResetAttempt(key, { client: clientOf() });
    await clearResetAttempts(key, { client: clientOf() });
    expect(await recordResetAttempt(key, { client: clientOf() })).toEqual({
      count: 1,
      exhausted: false,
    });
  });

  it("7. Redis failure throws instead of succeeding unlimited", async () => {
    (testRedis.current as unknown as FakeRedis).fail = true;
    await expect(recordResetAttempt(resetAttemptsKeyFor(KNOWN.id), { client: clientOf() }))
      .rejects.toBeInstanceOf(PasswordResetLimitsError);
    await expect(clearResetAttempts(resetAttemptsKeyFor(KNOWN.id), { client: clientOf() }))
      .rejects.toBeInstanceOf(PasswordResetLimitsError);
    await expect(acquireResetCooldown(resetCooldownKeyFor(KNOWN.id), { client: clientOf() }))
      .rejects.toBeInstanceOf(PasswordResetLimitsError);
  });
});

describe("service: acquireResetCooldown", () => {
  it("5. the first caller wins; the second sees the active cooldown", async () => {
    const key = resetCooldownKeyFor(KNOWN.id);
    expect(await acquireResetCooldown(key, { client: clientOf() })).toBe(true);
    expect(await acquireResetCooldown(key, { client: clientOf() })).toBe(false);
    expect(RESET_COOLDOWN_SECONDS).toBe(60);
  });

  it("6. concurrent acquisition has exactly one winner (model-level atomicity)", async () => {
    const key = resetCooldownKeyFor("race-user");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => acquireResetCooldown(key, { client: clientOf() })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("cooldowns are per account", async () => {
    expect(await acquireResetCooldown(resetCooldownKeyFor("a"), { client: clientOf() })).toBe(true);
    expect(await acquireResetCooldown(resetCooldownKeyFor("b"), { client: clientOf() })).toBe(true);
  });

  it("carries a 60-second TTL", async () => {
    const key = resetCooldownKeyFor(KNOWN.id);
    await acquireResetCooldown(key, { client: clientOf() });
    const ttl = (testRedis.current as FakeRedis).ttlOf(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(RESET_COOLDOWN_SECONDS);
  });
});

describe("service: unknown-address identities carry no PII", () => {
  it("9. decoy keys and values contain no raw email, code, or JWT", async () => {
    const email = "somebody@example.com";
    const cooldownKey = resetUnknownCooldownKeyFor(email);
    const attemptsKey = resetUnknownAttemptsKeyFor(email);
    expect(cooldownKey).not.toContain(email);
    expect(attemptsKey).not.toContain(email);
    expect(cooldownKey).not.toBe(attemptsKey);

    await acquireResetCooldown(cooldownKey, { client: clientOf() });
    await recordResetAttempt(attemptsKey, { client: clientOf() });
    const store = (testRedis.current as FakeRedis).store;
    for (const [k, v] of store) {
      expect(k).not.toContain(email);
      expect(v.value).not.toContain(email);
      expect(v.value).not.toContain(CODE);
    }
  });
});

describe("controller: verifyResetCode attempt limiting", () => {
  function knownUser() {
    db.user.findUnique.mockResolvedValue(KNOWN);
  }

  it("1. five incorrect attempts are answered 406", async () => {
    knownUser();
    seedChallenge();
    for (let i = 0; i < RESET_MAX_ATTEMPTS; i++) {
      const r = res();
      await verifyResetCode({ body: { email: KNOWN.email, code: WRONG } } as never, r);
      expect(statusOf(r)).toBe(406);
      expect(bodyOf(r)).toEqual({ message: "Invalid or expired reset code" });
    }
  });

  it("3. a correct code is rejected once the challenge limit is exhausted", async () => {
    knownUser();
    seedChallenge();
    for (let i = 0; i < RESET_MAX_ATTEMPTS; i++) {
      await verifyResetCode({ body: { email: KNOWN.email, code: WRONG } } as never, res());
    }
    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: CODE } } as never, r);
    expect(statusOf(r)).toBe(406);
  });

  it("2. concurrent wrong guesses all count; the challenge stays exhausted after", async () => {
    knownUser();
    seedChallenge();
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const r = res();
        await verifyResetCode({ body: { email: KNOWN.email, code: WRONG } } as never, r);
        return statusOf(r);
      }),
    );
    // Every guess is answered, none bypasses: all 406 with the same body.
    expect(results).toEqual(new Array(8).fill(406));
    // And the budget is spent — a correct code afterwards is refused.
    const after = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: CODE } } as never, after);
    expect(statusOf(after)).toBe(406);
  });

  it("a correct code still verifies within budget and consumes the challenge", async () => {
    knownUser();
    seedChallenge();
    await verifyResetCode({ body: { email: KNOWN.email, code: WRONG } } as never, res());
    await verifyResetCode({ body: { email: KNOWN.email, code: WRONG } } as never, res());
    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: CODE } } as never, r);
    expect(statusOf(r)).toBe(200);
    expect(typeof bodyOf(r).resetToken).toBe("string");
  });
});

describe("controller: forgotPassword resend cooldown", () => {
  function knownUser() {
    db.user.findUnique.mockResolvedValue(KNOWN);
  }

  it("5. a second resend within 60 seconds issues nothing and emails nothing", async () => {
    knownUser();
    const first = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, first);
    expect(statusOf(first)).toBe(200);
    expect(db.passwordResetToken.upsert).toHaveBeenCalledTimes(1);
    expect(mockSendResetEmail).toHaveBeenCalledTimes(1);

    const second = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, second);
    expect(statusOf(second)).toBe(200);
    expect(bodyOf(second)).toEqual(bodyOf(first));
    expect(db.passwordResetToken.upsert).toHaveBeenCalledTimes(1);
    expect(mockSendResetEmail).toHaveBeenCalledTimes(1);
  });

  it("6. concurrent resends issue exactly one credential and one email", async () => {
    knownUser();
    const responses = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const r = res();
        await forgotPassword({ body: { email: KNOWN.email } } as never, r);
        return statusOf(r);
      }),
    );
    expect(responses).toEqual([200, 200, 200, 200]);
    expect(db.passwordResetToken.upsert).toHaveBeenCalledTimes(1);
    expect(mockSendResetEmail).toHaveBeenCalledTimes(1);
  });

  it("4. a new challenge after the cooldown resets attempt state", async () => {
    knownUser();
    seedChallenge();
    // Burn the whole budget on the first challenge.
    for (let i = 0; i < RESET_MAX_ATTEMPTS; i++) {
      await verifyResetCode({ body: { email: KNOWN.email, code: WRONG } } as never, res());
    }
    const dead = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: CODE } } as never, dead);
    expect(statusOf(dead)).toBe(406);

    // Simulate the cooldown lapsing (the key would have expired in Redis).
    await (testRedis.current as FakeRedis).del(resetCooldownKeyFor(KNOWN.id));

    // A fresh challenge re-arms verification...
    const req2 = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, req2);
    expect(statusOf(req2)).toBe(200);
    const freshCode = emailedCode();
    // ...against the NEW digest the controller just stored.
    const stored = db.passwordResetToken.upsert.mock.calls[
      db.passwordResetToken.upsert.mock.calls.length - 1
    ][0];
    expect(stored.create.token).toBe(resetCodeDigest(SECRET, KNOWN.email, freshCode));

    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: stored.create.token,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const ok = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: freshCode } } as never, ok);
    expect(statusOf(ok)).toBe(200);
  });

  it("4b. a cooldown-skipped resend does not clear attempt state", async () => {
    knownUser();
    seedChallenge();

    // First issuance wins the cooldown and (re)arms the challenge...
    const first = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, first);
    expect(statusOf(first)).toBe(200);
    // ...so point the mock at the newly issued digest from here on.
    const issued = db.passwordResetToken.upsert.mock.calls[0][0];
    const freshCode = emailedCode();
    const wrong = freshCode === WRONG ? "YYYYYY" : WRONG;
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: issued.create.token,
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Two wrong guesses against the fresh challenge...
    await verifyResetCode({ body: { email: KNOWN.email, code: wrong } } as never, res());
    await verifyResetCode({ body: { email: KNOWN.email, code: wrong } } as never, res());

    // ...then an immediate resend, which the cooldown skips entirely...
    const skipped = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, skipped);
    expect(statusOf(skipped)).toBe(200);
    expect(db.passwordResetToken.upsert).toHaveBeenCalledTimes(1);
    expect(mockSendResetEmail).toHaveBeenCalledTimes(1);

    // ...so the two earlier guesses still count: three more wrongs exhaust,
    // and the correct code is then refused.
    for (let i = 0; i < 3; i++) {
      await verifyResetCode({ body: { email: KNOWN.email, code: wrong } } as never, res());
    }
    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: freshCode } } as never, r);
    expect(statusOf(r)).toBe(406);
  });
});

describe("controller: Redis outage fails closed on both branches", () => {
  function redisDown() {
    (testRedis.current as unknown as FakeRedis).fail = true;
  }

  it("7+8. forgotPassword returns the same 500 for known and unknown accounts and sends nothing", async () => {
    redisDown();

    db.user.findUnique.mockResolvedValue(KNOWN);
    const known = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, known);

    db.user.findUnique.mockResolvedValue(null);
    const unknown = res();
    await forgotPassword({ body: { email: "nobody@example.com" } } as never, unknown);

    expect(statusOf(known)).toBe(500);
    expect(statusOf(unknown)).toBe(statusOf(known));
    expect(bodyOf(unknown)).toEqual(bodyOf(known));
    expect(db.passwordResetToken.upsert).not.toHaveBeenCalled();
    expect(mockSendResetEmail).not.toHaveBeenCalled();
  });

  it("7+8. verifyResetCode returns the same 500 for known and unknown accounts", async () => {
    redisDown();

    db.user.findUnique.mockResolvedValue(KNOWN);
    seedChallenge();
    const known = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: WRONG } } as never, known);

    db.user.findUnique.mockResolvedValue(null);
    const unknown = res();
    await verifyResetCode({ body: { email: "nobody@example.com", code: WRONG } } as never, unknown);

    expect(statusOf(known)).toBe(500);
    expect(statusOf(unknown)).toBe(statusOf(known));
    expect(bodyOf(unknown)).toEqual(bodyOf(known));
  });
});

describe("controller: unknown-account decoy work", () => {
  it("8. unknown verify performs Redis work without creating challenge state", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const r = res();
    await verifyResetCode({ body: { email: "ghost@example.com", code: WRONG } } as never, r);
    expect(statusOf(r)).toBe(406);
    // The decoy increment ran (same class of work as the known branch)...
    const store = (testRedis.current as FakeRedis).store;
    expect(store.size).toBe(1);
    // ...under a one-way identity, with no challenge row created.
    expect(db.passwordResetToken.update).not.toHaveBeenCalled();
    expect(db.passwordResetToken.upsert).not.toHaveBeenCalled();
  });

  it("8. unknown forgot performs Redis work without creating challenge state", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const r = res();
    await forgotPassword({ body: { email: "ghost@example.com" } } as never, r);
    expect(statusOf(r)).toBe(200);
    expect((testRedis.current as FakeRedis).store.size).toBe(1);
    expect(db.passwordResetToken.upsert).not.toHaveBeenCalled();
    expect(mockSendResetEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Batch 1D.74 — bounded Redis commands for issuance and verification.
//
// Every Redis command in forgotPassword / verifyResetCode now carries the
// shared RESET_LIMITS_COMMAND_TIMEOUT_MS bound. These tests use an
// instrumented client that actually exposes `withCommandOptions` (FakeRedis
// does not), so the bound is observed end-to-end: controller -> service ->
// withCommandOptions. That proves the ARGUMENT is forwarded; it does not
// prove node-redis fires the timeout on a real stalled socket, which needs
// isolated Redis.
// ---------------------------------------------------------------------------

const RESET_LIMITS_COMMAND_TIMEOUT_MS = 750;

/**
 * Wraps the current FakeRedis in a client that records the timeout applied by
 * `withCommandOptions`, and can inject a timeout-style failure for one method.
 */
function instrumented(over: { failOn?: "set" | "del" | "eval" } = {}) {
  const base = testRedis.current as FakeRedis;
  const seen: number[] = [];
  const boom = () => {
    const err = new Error("Command timed out");
    (err as unknown as { name: string }).name = "TimeoutError";
    throw err;
  };
  const raw = base as unknown as Record<string, (...a: unknown[]) => unknown>;
  const client: Record<string, unknown> = {
    set: async (k: string, v: string, o: unknown) =>
      over.failOn === "set" ? boom() : raw.set(k, v, o),
    del: async (k: string) => (over.failOn === "del" ? boom() : raw.del(k)),
    eval: async (s: unknown, o: unknown) =>
      over.failOn === "eval" ? boom() : raw.eval(s, o),
    withCommandOptions: (o: { timeout: number }) => {
      seen.push(o.timeout);
      return client;
    },
  };
  testRedis.current = client as unknown as FakeRedis;
  return { seen, base };
}

describe("service: timeoutMs is forwarded (1D.74)", () => {
  it("acquireResetCooldown applies the bound and issues the same SET NX EX", async () => {
    const { seen, base } = instrumented();
    const key = resetCooldownKeyFor(KNOWN.id);
    expect(await acquireResetCooldown(key, {
      client: clientOf(),
      timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
    })).toBe(true);
    expect(seen).toEqual([RESET_LIMITS_COMMAND_TIMEOUT_MS]);
    // The command itself is unchanged: same key, NX, and 60s cooldown TTL.
    expect(base.raw(key)).toBe("1");
    expect(base.ttlOf(key)).toBeLessThanOrEqual(RESET_COOLDOWN_SECONDS);
  });

  it("clearResetAttempts applies the bound and issues the same DEL", async () => {
    const { seen, base } = instrumented();
    const key = resetAttemptsKeyFor(KNOWN.id);
    base.store.set(key, { value: "3", expiresAt: null });
    await clearResetAttempts(key, {
      client: clientOf(),
      timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
    });
    expect(seen).toEqual([RESET_LIMITS_COMMAND_TIMEOUT_MS]);
    expect(base.raw(key)).toBeNull();
  });

  it("omitting timeoutMs leaves the previous unbounded behaviour untouched", async () => {
    const { seen } = instrumented();
    await acquireResetCooldown(resetCooldownKeyFor(KNOWN.id), { client: clientOf() });
    await clearResetAttempts(resetAttemptsKeyFor(KNOWN.id), { client: clientOf() });
    expect(seen).toEqual([]);
  });

  it("a client without withCommandOptions still works (degrade path)", async () => {
    // testRedis.current is a plain FakeRedis here: no withCommandOptions.
    expect(await acquireResetCooldown(resetCooldownKeyFor(KNOWN.id), {
      client: clientOf(),
      timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
    })).toBe(true);
  });

  it("a timed-out command still fails closed with PasswordResetLimitsError", async () => {
    instrumented({ failOn: "set" });
    await expect(acquireResetCooldown(resetCooldownKeyFor(KNOWN.id), {
      client: clientOf(),
      timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
    })).rejects.toThrow(PasswordResetLimitsError);

    instrumented({ failOn: "del" });
    await expect(clearResetAttempts(resetAttemptsKeyFor(KNOWN.id), {
      client: clientOf(),
      timeoutMs: RESET_LIMITS_COMMAND_TIMEOUT_MS,
    })).rejects.toThrow(PasswordResetLimitsError);
  });
});

describe("controller: all six call sites are bounded (1D.74)", () => {
  it("forgotPassword bounds both the known-account cooldown and the cleanup", async () => {
    const { seen } = instrumented();
    db.user.findUnique.mockResolvedValue(KNOWN);

    const r = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, r);

    expect(statusOf(r)).toBe(200);
    // acquireResetCooldown + clearResetAttempts
    expect(seen).toEqual([
      RESET_LIMITS_COMMAND_TIMEOUT_MS,
      RESET_LIMITS_COMMAND_TIMEOUT_MS,
    ]);
  });

  it("forgotPassword bounds the decoy cooldown for an unknown address", async () => {
    const { seen } = instrumented();
    db.user.findUnique.mockResolvedValue(null);

    const r = res();
    await forgotPassword({ body: { email: "nobody@example.com" } } as never, r);

    expect(statusOf(r)).toBe(200);
    expect(seen).toEqual([RESET_LIMITS_COMMAND_TIMEOUT_MS]);
  });

  it("verifyResetCode bounds the known-account attempt counter and the cleanup", async () => {
    const { seen } = instrumented();
    db.user.findUnique.mockResolvedValue(KNOWN);
    seedChallenge();

    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: CODE } } as never, r);

    expect(statusOf(r)).toBe(200);
    // recordResetAttempt + clearResetAttempts
    expect(seen).toEqual([
      RESET_LIMITS_COMMAND_TIMEOUT_MS,
      RESET_LIMITS_COMMAND_TIMEOUT_MS,
    ]);
  });

  it("verifyResetCode bounds the decoy attempt counter for an unknown address", async () => {
    const { seen } = instrumented();
    db.user.findUnique.mockResolvedValue(null);

    const r = res();
    await verifyResetCode({ body: { email: "nobody@example.com", code: WRONG } } as never, r);

    expect(statusOf(r)).toBe(406);
    expect(seen).toEqual([RESET_LIMITS_COMMAND_TIMEOUT_MS]);
  });

  it("a timed-out cooldown still fails issuance closed, with no row and no email", async () => {
    instrumented({ failOn: "set" });
    db.user.findUnique.mockResolvedValue(KNOWN);

    const r = res();
    await forgotPassword({ body: { email: KNOWN.email } } as never, r);

    expect(statusOf(r)).toBe(500);
    expect(db.passwordResetToken.upsert).not.toHaveBeenCalled();
    expect(mockSendResetEmail).not.toHaveBeenCalled();
  });

  it("a timed-out attempt counter fails verification closed identically for both branches", async () => {
    instrumented({ failOn: "eval" });

    db.user.findUnique.mockResolvedValue(KNOWN);
    seedChallenge();
    const known = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: WRONG } } as never, known);

    db.user.findUnique.mockResolvedValue(null);
    const unknown = res();
    await verifyResetCode({ body: { email: "nobody@example.com", code: WRONG } } as never, unknown);

    expect(statusOf(known)).toBe(500);
    expect(statusOf(unknown)).toBe(statusOf(known));
    expect(bodyOf(unknown)).toEqual(bodyOf(known));
  });

  it("a timed-out best-effort cleanup does NOT fail an otherwise successful verification", async () => {
    // Only DEL fails, so the issuance path is untouched and the cleanup after a
    // successful verify is the only thing that times out.
    instrumented({ failOn: "del" });
    db.user.findUnique.mockResolvedValue(KNOWN);
    seedChallenge();

    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: CODE } } as never, r);

    expect(statusOf(r)).toBe(200);
    expect(bodyOf(r).resetToken).toEqual(expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Batch 1D.75 — the known-account-without-challenge branch must be
// indistinguishable from the other two account states when Redis is down.
// ---------------------------------------------------------------------------

/** Drives all three account states through verifyResetCode and reports each. */
async function threeStates(
  configure: () => void,
  code: string = WRONG,
): Promise<Record<string, { status: number; body: unknown }>> {
  const out: Record<string, { status: number; body: unknown }> = {};

  // (1) known account, WITH an active challenge
  configure();
  db.user.findUnique.mockResolvedValue(KNOWN);
  seedChallenge();
  const withChallenge = res();
  await verifyResetCode({ body: { email: KNOWN.email, code } } as never, withChallenge);
  out.knownWithChallenge = { status: statusOf(withChallenge), body: bodyOf(withChallenge) };

  // (2) known account, NO challenge row
  configure();
  db.user.findUnique.mockResolvedValue(KNOWN);
  db.passwordResetToken.findUnique.mockResolvedValue(null);
  const noChallenge = res();
  await verifyResetCode({ body: { email: KNOWN.email, code } } as never, noChallenge);
  out.knownNoChallenge = { status: statusOf(noChallenge), body: bodyOf(noChallenge) };

  // (3) unknown account
  configure();
  db.user.findUnique.mockResolvedValue(null);
  const unknown = res();
  await verifyResetCode({ body: { email: "nobody@example.com", code } } as never, unknown);
  out.unknown = { status: statusOf(unknown), body: bodyOf(unknown) };

  return out;
}

describe("verifyResetCode: no enumeration divergence across account states (1D.75)", () => {
  it("with Redis DOWN, all three account states fail identically", async () => {
    const states = await threeStates(() => {
      testRedis.current = new FakeRedis();
      (testRedis.current as FakeRedis).fail = true;
    });

    // Before 1D.75 the middle state answered 406 here, separating
    // "registered, no challenge" from the two states that fail to 500.
    expect(states.knownNoChallenge.status).toBe(states.unknown.status);
    expect(states.knownNoChallenge.status).toBe(states.knownWithChallenge.status);
    expect(states.knownNoChallenge.status).toBe(500);

    expect(states.knownNoChallenge.body).toEqual(states.unknown.body);
    expect(states.knownNoChallenge.body).toEqual(states.knownWithChallenge.body);
  });

  it("with a Redis command TIMING OUT, all three states fail identically", async () => {
    const states = await threeStates(() => instrumented({ failOn: "eval" }));

    expect(states.knownNoChallenge.status).toBe(states.unknown.status);
    expect(states.knownNoChallenge.status).toBe(states.knownWithChallenge.status);
    expect(states.knownNoChallenge.status).toBe(500);
    expect(states.knownNoChallenge.body).toEqual(states.unknown.body);
  });

  it("with Redis HEALTHY, all three states still answer the same 406", async () => {
    const states = await threeStates(() => {
      testRedis.current = new FakeRedis();
    });

    expect(states.knownNoChallenge.status).toBe(406);
    expect(states.knownNoChallenge.status).toBe(states.unknown.status);
    expect(states.knownNoChallenge.status).toBe(states.knownWithChallenge.status);
    expect(states.knownNoChallenge.body).toEqual(states.unknown.body);
    expect(states.knownNoChallenge.body).toEqual({
      message: "Invalid or expired reset code",
    });
  });

  it("issues no reset credential on any outage path", async () => {
    await threeStates(() => {
      testRedis.current = new FakeRedis();
      (testRedis.current as FakeRedis).fail = true;
    });

    // No JWT was minted and no digest written on any branch.
    expect(db.passwordResetToken.update).not.toHaveBeenCalled();
    expect(db.passwordResetToken.upsert).not.toHaveBeenCalled();
  });

  it("the extra increment cannot pre-exhaust a real challenge", async () => {
    // Burn the account counter on the no-challenge path...
    testRedis.current = new FakeRedis();
    db.user.findUnique.mockResolvedValue(KNOWN);
    db.passwordResetToken.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 5; i += 1) {
      const r = res();
      await verifyResetCode({ body: { email: KNOWN.email, code: WRONG } } as never, r);
    }

    // ...then issue a real challenge. Issuance clears the counter fail-closed,
    // so the new code is verifiable rather than stranded.
    db.passwordResetToken.findUnique.mockResolvedValue({
      userId: KNOWN.id,
      token: resetCodeDigest(SECRET, KNOWN.email, CODE),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await clearResetAttempts(resetAttemptsKeyFor(KNOWN.id), { client: clientOf() });

    const r = res();
    await verifyResetCode({ body: { email: KNOWN.email, code: CODE } } as never, r);
    expect(statusOf(r)).toBe(200);
  });
});

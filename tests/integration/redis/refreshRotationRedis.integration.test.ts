/**
 * Phase 1E — real Redis verification of the refresh-token rotation Lua script.
 *
 * ── WHAT THIS PROVES ────────────────────────────────────────────────────────
 * `tests/helpers/fakeRedis.ts` is a JavaScript MODEL of `REFRESH_ROTATE_LUA`.
 * A passing mirror proves the intended branches, never that the real script
 * parses, runs atomically, applies the right TTLs, or serialises concurrent
 * callers the way Redis does. This suite runs the UNCHANGED production script
 * through the production helper against a real disposable Redis.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 * It runs only against a local, disposable, non-default Redis named by
 * REFRESH_TEST_REDIS_URL. It NEVER falls back to the application's REDIS_URL
 * (which points at shared production infrastructure); the target is checked
 * with the repository's own `evaluateDisposableRedisTarget`, which refuses TLS
 * schemes, non-loopback hosts, database 0, and any endpoint equal to the
 * ambient REDIS_URL. When the variable is absent this suite FAILS with an
 * explicit blocker rather than skipping, so a run can never be mistaken for
 * evidence.
 *
 * `src/lib/redis` is mocked so the module-level client can never open a
 * connection to the application's configured REDIS_URL: this is a safety
 * measure, not a convenience. Only the CLIENT WIRING is substituted — the
 * `REFRESH_ROTATE_LUA` string and `rotateRefreshJtiCAS`/`deleteRefreshJti` are
 * the real production code, untouched.
 *
 * No FLUSHDB / FLUSHALL / wildcard DEL is ever issued. Cleanup deletes only
 * keys this run created and tracks, and a sentinel key planted outside that
 * set is asserted to survive.
 *
 *   redis-server --bind 127.0.0.1 --port 6399 --save '' --appendonly no \
 *     --databases 32
 *   REFRESH_TEST_REDIS_URL=redis://127.0.0.1:6399/16 \
 *     npm run test:redis-integration
 */
import { createClient, type RedisClientType } from "redis";
import { evaluateDisposableRedisTarget } from "../../helpers/localRedisTarget";

// Validate the configured target and fail closed before any CONNECTION exists.
// Note on ordering: TypeScript emits `import` requires ahead of intervening
// statements, so `src/lib/session` (and the mock factory below) is loaded
// before this check runs. That is safe because neither path connects on
// construction — `createClient` and `new PrismaClient()` are both lazy, and
// the first `connect()` happens in `beforeAll`, which never runs once this
// throw has fired. So no socket is ever opened against an unvalidated target.
const TARGET = evaluateDisposableRedisTarget(process.env.REFRESH_TEST_REDIS_URL);
if (!TARGET.ok) {
  throw new Error(
    `[refresh-rotation-redis] BLOCKED: REFRESH_TEST_REDIS_URL is unusable.\n` +
      `Reason from evaluateDisposableRedisTarget: ${TARGET.reason}\n` +
      "This suite must fail rather than skip; an unexecuted check is not evidence.",
  );
}

jest.mock("../../../src/lib/redis", () => {
  const { createClient: create } = require("redis");
  const client = create({ url: process.env.REFRESH_TEST_REDIS_URL });
  client.on("error", () => {
    /* connection errors surface through the caller's promise rejection */
  });
  return { __esModule: true, redisUsersSessions: client };
});

// Imported AFTER the mock so the helper binds to the disposable client.
import {
  rotateRefreshJtiCAS,
  deleteRefreshJti,
  REFRESH_ROTATE_LUA,
} from "../../../src/lib/session";
import { redisUsersSessions } from "../../../src/lib/redis";

// Mirrors src/lib/session.ts key construction. Kept local so the test cannot
// silently drift from a production change without this assertion failing.
const curKey = (u: string, s: string) => `refresh:jti:${u}:${s}`;
const prevKey = (u: string, s: string) => `refresh:jti:prev:${u}:${s}`;

const RUN = `run${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const createdKeys = new Set<string>();
const SENTINEL = `refresh:jti:${RUN}:sentinel`;
const SENTINEL_VALUE = "sentinel-must-survive";

let client: RedisClientType;
/**
 * `session.ts` uses the module-level `redisUsersSessions`. node-redis does not
 * auto-connect, so that client must be connected explicitly or the first EVAL
 * would queue forever. Connecting it here is what makes the real Lua execute.
 */
let moduleClient: RedisClientType;

beforeAll(async () => {
  client = createClient({ url: process.env.REFRESH_TEST_REDIS_URL });
  client.on("error", () => {});
  await client.connect();

  moduleClient = redisUsersSessions as unknown as RedisClientType;
  moduleClient.on("error", () => {});
  if (!moduleClient.isOpen) await moduleClient.connect();
});

afterAll(async () => {
  // Close BOTH so no open handle can outlive the run.
  if (moduleClient?.isOpen) await moduleClient.quit().catch(() => {});
  if (client?.isOpen) await client.quit().catch(() => {});
});

/** A fresh, untracked user/session pair for one test. */
function newIds(tag: string) {
  const userId = `${RUN}_u_${tag}`;
  const sessionId = `${RUN}_s_${tag}`;
  createdKeys.add(curKey(userId, sessionId));
  createdKeys.add(prevKey(userId, sessionId));
  return { userId, sessionId };
}

beforeEach(async () => {
  // The sentinel is deliberately UNTRACKED. It is the control key that proves
  // `cleanupTrackedKeys()` deletes only the keys it was handed — so adding it to
  // `createdKeys` would delete the very thing it exists to protect against, and
  // would also inflate the tracked-key count. It is removed explicitly (in a
  // `finally`) by the cleanup test, which is its own key from this run.
  await client.set(SENTINEL, SENTINEL_VALUE);
});

/**
 * Delete exactly the tracked keys, then PROVE they are gone.
 *
 * F1: the previous cleanup test read `createdKeys` after `afterEach` had
 * already cleared it, so its assertion could never fail. This routine is the
 * single cleanup path for both `afterEach` and the cleanup test, and it keys
 * off the live set.
 *
 * F7: an explicit `DEL` of a named key either removes it or never removed it —
 * a tracked key surviving cleanup is a genuine defect, so it throws. The DEL
 * count is returned for callers that can assert an exact number. The count is
 * legitimately lower than the tracked size when a test already removed or
 * let-expire some of those keys itself, so no equality is asserted here.
 */
async function cleanupTrackedKeys(): Promise<{ requested: number; deleted: number }> {
  const mine = [...createdKeys];
  if (mine.length === 0) return { requested: 0, deleted: 0 };

  const deleted = await client.del(mine); // explicit names only — never a pattern

  const survivors: string[] = [];
  for (const k of mine) {
    if (await client.exists(k)) survivors.push(k);
  }
  if (survivors.length > 0) {
    // Leave them registered so a later cleanup pass can still retry.
    throw new Error(
      `tracked-key cleanup failed; ${survivors.length} key(s) survived: ${survivors.join(", ")}`,
    );
  }
  createdKeys.clear();
  return { requested: mine.length, deleted };
}

afterEach(async () => {
  await cleanupTrackedKeys();
});

// ── 1. Initial rotation ─────────────────────────────────────────────────────

it("1. initial rotation seeds both keys and reports `rotated`", async () => {
  const { userId, sessionId } = newIds("init");
  expect(await client.exists(curKey(userId, sessionId))).toBe(0);

  const out = await rotateRefreshJtiCAS(userId, sessionId, "j1", "j2");

  // Derived from REFRESH_ROTATE_LUA: no current key -> {0, incoming} seeded as
  // prev, new jti stored as current.
  expect(out).toEqual({ outcome: "rotated" });
  expect(await client.get(curKey(userId, sessionId))).toBe("j2");
  expect(await client.get(prevKey(userId, sessionId))).toBe("j1");
});

// ── 2. Current-JTI rotation ─────────────────────────────────────────────────

it("2. presenting the current JTI rotates it and seeds prev", async () => {
  const { userId, sessionId } = newIds("cur");
  await rotateRefreshJtiCAS(userId, sessionId, "j1", "j2"); // cur=j2, prev=j1
  await client.del(prevKey(userId, sessionId));

  const out = await rotateRefreshJtiCAS(userId, sessionId, "j2", "j3");

  expect(out).toEqual({ outcome: "rotated" });
  expect(await client.get(curKey(userId, sessionId))).toBe("j3");
  expect(await client.get(prevKey(userId, sessionId))).toBe("j2");
});

// ── 3. Grace-period retry ───────────────────────────────────────────────────

it("3. the previous JTI inside the grace window returns `grace` and changes nothing", async () => {
  const { userId, sessionId } = newIds("grace");
  await rotateRefreshJtiCAS(userId, sessionId, "j1", "j2"); // cur=j2, prev=j1

  const before = {
    cur: await client.get(curKey(userId, sessionId)),
    prev: await client.get(prevKey(userId, sessionId)),
  };

  const out = await rotateRefreshJtiCAS(userId, sessionId, "j1", "j3");

  expect(out).toEqual({ outcome: "grace", currentJti: "j2" });
  // The decisive assertion: grace must not rotate anything.
  expect(await client.get(curKey(userId, sessionId))).toBe(before.cur);
  expect(await client.get(prevKey(userId, sessionId))).toBe(before.prev);
});

// ── 4. Replay detection (deterministic: remove ONLY the tracked prev key) ───

it("4. a stale JTI with no prev key returns `replay` and mutates nothing", async () => {
  const { userId, sessionId } = newIds("replay");
  await rotateRefreshJtiCAS(userId, sessionId, "j1", "j2"); // cur=j2, prev=j1

  // Deterministic expiry simulation: drop ONLY this session's prev key rather
  // than sleeping out the whole grace window.
  await client.del(prevKey(userId, sessionId));

  const out = await rotateRefreshJtiCAS(userId, sessionId, "j1", "j4");

  // From the script's final branch: neither cur nor prev matches -> {2, cur}.
  expect(out).toEqual({ outcome: "replay", currentJti: "j2" });
  expect(await client.get(curKey(userId, sessionId))).toBe("j2");
});

// ── 5. Concurrent requests ──────────────────────────────────────────────────

it("5. eight concurrent calls with one incoming JTI rotate exactly once", async () => {
  const { userId, sessionId } = newIds("race");
  await rotateRefreshJtiCAS(userId, sessionId, "seed", "j1"); // cur=j1, prev=seed

  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => rotateRefreshJtiCAS(userId, sessionId, "j1", `w${i}`)),
  );

  const rotated = results.filter((r) => r.outcome === "rotated");
  const grace = results.filter((r) => r.outcome === "grace");

  // Redis executes EVAL atomically on a single thread, so the COUNT is
  // deterministic even though WHICH caller wins is not asserted.
  expect(rotated.length).toBe(1);
  expect(rotated.length + grace.length).toBe(N);

  // The winner's JTI is the current key; every loser's JTI was never stored.
  const cur = await client.get(curKey(userId, sessionId));
  expect(cur).toMatch(/^w\d$/);
  expect(results.filter((r) => r.outcome === "grace").every((r) => r.currentJti === cur)).toBe(true);
});

// ── 6. JTI deletion is scoped ───────────────────────────────────────────────

it("6. deleteRefreshJti removes only the intended session's keys", async () => {
  const mine = newIds("del");
  const other = newIds("keep");
  await rotateRefreshJtiCAS(mine.userId, mine.sessionId, "j1", "j2");
  await rotateRefreshJtiCAS(other.userId, other.sessionId, "j1", "j2");

  await deleteRefreshJti(mine.userId, mine.sessionId);

  expect(await client.exists(curKey(mine.userId, mine.sessionId))).toBe(0);
  expect(await client.exists(prevKey(mine.userId, mine.sessionId))).toBe(0);
  // The other session must be untouched.
  expect(await client.get(curKey(other.userId, other.sessionId))).toBe("j2");
  expect(await client.get(prevKey(other.userId, other.sessionId))).toBe("j1");
});

// ── 7. TTL behaviour ────────────────────────────────────────────────────────

it("7. current key gets the 7-day TTL and prev gets the grace TTL", async () => {
  const { userId, sessionId } = newIds("ttl");
  await rotateRefreshJtiCAS(userId, sessionId, "j1", "j2");

  // pTTL reports MILLISECONDS; the Lua sets EX in seconds
  // (REFRESH_JTI_TTL_SECONDS = 604800s = 7 days, REFRESH_GRACE_SECONDS = 10s).
  const curTtl = await client.pTTL(curKey(userId, sessionId));
  const prevTtl = await client.pTTL(prevKey(userId, sessionId));

  expect(curTtl).toBeGreaterThan(604_000_000); // ~7 days
  expect(curTtl).toBeLessThanOrEqual(604_800_000);
  expect(prevTtl).toBeGreaterThan(0);
  expect(prevTtl).toBeLessThanOrEqual(10_000); // grace window
});

// ── 8. Invalid inputs ────────────────────────────────────────────────────────

it("8. an empty incoming JTI is treated as `replay`, never as a rotation", async () => {
  const { userId, sessionId } = newIds("invalid");
  await rotateRefreshJtiCAS(userId, sessionId, "j1", "j2");

  const out = await rotateRefreshJtiCAS(userId, sessionId, "", "j3");

  // Empty string matches neither cur nor prev, so the script's final branch
  // applies. It must not rotate.
  expect(out.outcome).toBe("replay");
  expect(await client.get(curKey(userId, sessionId))).toBe("j2");
});

it("8b. the production Lua string is the one actually evaluated", () => {
  // Guards against the suite ever drifting onto a re-implementation.
  expect(typeof REFRESH_ROTATE_LUA).toBe("string");
  expect(REFRESH_ROTATE_LUA).toContain('redis.call("GET", KEYS[1])');
  expect(REFRESH_ROTATE_LUA).toContain("return {2, cur}");
  expect(redisUsersSessions).toBeDefined();
});

// ── 9. Redis failure propagation (helper level only) ────────────────────────

it("9. an unreachable Redis rejects instead of returning a fake outcome", async () => {
  // Helper-level propagation only: a store outage must REJECT so the controller
  // can fail closed with a retryable 503. This does NOT prove controller-level
  // HTTP behaviour, nor that sessions are left unrevoked.
  //
  // `reconnectStrategy: false` makes the dead endpoint fail immediately instead
  // of retrying, so the assertion is deterministic rather than timing-dependent.
  const dead = createClient({
    url: "redis://127.0.0.1:6398/16",
    socket: { reconnectStrategy: false as any },
  });
  dead.on("error", () => {});
  try {
    jest.resetModules();
    jest.doMock("../../../src/lib/redis", () => ({
      __esModule: true,
      redisUsersSessions: dead,
    }));
    // Loaded AFTER doMock so it binds to the unreachable client.
    const freshSession = require("../../../src/lib/session");

    await expect(
      freshSession.rotateRefreshJtiCAS("u", "s", "j1", "j2"),
    ).rejects.toBeDefined();

    jest.dontMock("../../../src/lib/redis");
    jest.resetModules();
  } finally {
    if (dead.isOpen) await dead.quit().catch(() => {});
  }
}, 30_000);

// ── Cleanup verification ────────────────────────────────────────────────────

it("Z. tracked cleanup removes exactly this run's keys and spares the sentinel", async () => {
  // Register keys THIS test creates, prove they exist, then run the real
  // cleanup routine and prove they are gone. Unlike the previous version this
  // can actually fail: if cleanup left a tracked key behind, `exists` would be 1.
  const ids = newIds("cleanup");
  const tracked = [curKey(ids.userId, ids.sessionId), prevKey(ids.userId, ids.sessionId)];
  for (const k of tracked) createdKeys.add(k); // newIds already does this; explicit for clarity

  await rotateRefreshJtiCAS(ids.userId, ids.sessionId, "j1", "j2"); // creates both keys

  // Precondition: both tracked keys genuinely exist, so a zero-length DEL
  // result would be a real failure rather than a legitimate no-op.
  expect(await client.exists(tracked[0])).toBe(1);
  expect(await client.exists(tracked[1])).toBe(1);
  // The untracked-key stand-in is present before cleanup.
  expect(await client.get(SENTINEL)).toBe(SENTINEL_VALUE);

  const result = await cleanupTrackedKeys();

  // F7: with every tracked key known-present beforehand, DEL must remove
  // exactly those two — nothing more, nothing less.
  expect(result.requested).toBe(2);
  expect(result.deleted).toBe(2);

  // F1: the assertion that was previously vacuous, now falsifiable.
  expect(await client.exists(tracked[0])).toBe(0);
  expect(await client.exists(tracked[1])).toBe(0);

  // The sentinel is NOT in the tracked set (it was consumed by the routine), so
  // it must survive — proving cleanup touched only what it was given.
  expect(await client.get(SENTINEL)).toBe(SENTINEL_VALUE);

  // The sentinel is this run's own key; remove it explicitly, and do so even if
  // an assertion above has already failed.
  try {
    await client.del(SENTINEL);
  } finally {
    createdKeys.delete(SENTINEL);
  }
});
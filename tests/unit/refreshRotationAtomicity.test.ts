/**
 * Batch 1D.60 — atomic refresh-token JTI rotation, service level.
 *
 * Exercises the REAL `rotateRefreshJtiCAS` from src/lib/session.ts against
 * FakeRedis (shared store, synchronous script bodies — the same
 * serialization real Redis gives a Lua script). What this proves: the
 * decision logic (rotate exactly once, grace without writing, replay without
 * overwriting) and the outcome mapping. What it does NOT prove: that the Lua
 * parses inside real Redis or that two processes serialize — that needs an
 * approved isolated Redis and is reported as outstanding.
 */
import { FakeRedis, testRedis } from "../helpers/fakeRedis";
import {
  rotateRefreshJtiCAS,
  REFRESH_ROTATE_LUA,
} from "../../src/lib/session";

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

const CUR = (u = "u", s = "s") => `refresh:jti:${u}:${s}`;
const PREV = (u = "u", s = "s") => `refresh:jti:prev:${u}:${s}`;

beforeEach(() => {
  jest.clearAllMocks();
  testRedis.current = new FakeRedis();
});

function raw(key: string): string | null {
  return (testRedis.current as FakeRedis).raw(key);
}

describe("rotateRefreshJtiCAS outcomes", () => {
  it("rotates on the current JTI and persists prev + new with their TTLs", async () => {
    const redis = testRedis.current as FakeRedis;
    redis.store.set(CUR(), { value: "j0", expiresAt: null });
    const out = await rotateRefreshJtiCAS("u", "s", "j0", "j1");
    expect(out).toEqual({ outcome: "rotated" });
    expect(raw(CUR())).toBe("j1");
    expect(raw(PREV())).toBe("j0");
    expect(redis.ttlOf(CUR())).toBeGreaterThan(6 * 24 * 3600);
    expect(redis.ttlOf(CUR())).toBeLessThanOrEqual(7 * 24 * 3600);
    expect(redis.ttlOf(PREV())).toBeGreaterThan(0);
    expect(redis.ttlOf(PREV())).toBeLessThanOrEqual(10);
  });

  it("adopts on first refresh (no stored state) and rotates in the same step", async () => {
    const out = await rotateRefreshJtiCAS("u", "s", "j0", "j1");
    expect(out).toEqual({ outcome: "rotated" });
    expect(raw(CUR())).toBe("j1");
    expect(raw(PREV())).toBe("j0");
  });

  it("answers grace on the previous JTI and writes nothing", async () => {
    const redis = testRedis.current as FakeRedis;
    redis.store.set(CUR(), { value: "j1", expiresAt: null });
    redis.store.set(PREV(), { value: "j0", expiresAt: Date.now() + 10_000 });
    const before = JSON.stringify({ cur: raw(CUR()), prev: raw(PREV()) });

    const out = await rotateRefreshJtiCAS("u", "s", "j0", "j2");
    expect(out).toEqual({ outcome: "grace", currentJti: "j1" });
    // A grace classification must not move any state.
    expect(JSON.stringify({ cur: raw(CUR()), prev: raw(PREV()) })).toBe(before);
  });

  it("answers replay on an unknown JTI and writes nothing", async () => {
    const redis = testRedis.current as FakeRedis;
    redis.store.set(CUR(), { value: "j1", expiresAt: null });
    redis.store.set(PREV(), { value: "j0", expiresAt: Date.now() + 10_000 });

    const out = await rotateRefreshJtiCAS("u", "s", "attacker", "evil");
    expect(out.outcome).toBe("replay");
    // A mismatch must never overwrite the newer rotation.
    expect(raw(CUR())).toBe("j1");
    expect(raw(PREV())).toBe("j0");
  });

  it("a mismatch cannot overwrite a newer session state", async () => {
    const redis = testRedis.current as FakeRedis;
    redis.store.set(CUR(), { value: "j-winner", expiresAt: null });
    redis.store.set(PREV(), { value: "j1", expiresAt: Date.now() + 10_000 });

    const out = await rotateRefreshJtiCAS("u", "s", "j-stale", "j-evil");
    expect(out).toEqual({ outcome: "replay", currentJti: "j-winner" });
    expect(raw(CUR())).toBe("j-winner");
    expect(raw(PREV())).toBe("j1");
  });

  it("fails closed when Redis is unavailable", async () => {
    (testRedis.current as FakeRedis).fail = true;
    await expect(rotateRefreshJtiCAS("u", "s", "j0", "j1")).rejects.toThrow();
  });
});

describe("rotateRefreshJtiCAS under concurrency", () => {
  it("N concurrent rotations on one JTI yield exactly one winner; the rest see grace", async () => {
    const redis = testRedis.current as FakeRedis;
    redis.store.set(CUR(), { value: "j0", expiresAt: null });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => rotateRefreshJtiCAS("u", "s", "j0", `j-win-${i}`)),
    );
    const rotated = results.filter((r) => r.outcome === "rotated");
    const grace = results.filter((r) => r.outcome === "grace");
    expect(rotated).toHaveLength(1);
    expect(grace).toHaveLength(7);

    // Final state reflects exactly one rotation, and every loser converged
    // on the winner's jti rather than minting an independent pair.
    expect(raw(PREV())).toBe("j0");
    const winner = raw(CUR())!;
    expect(winner).toMatch(/^j-win-\d$/);
    for (const g of grace) {
      expect(g).toEqual({ outcome: "grace", currentJti: winner });
    }
  });

  it("a stale presenter gets grace while prev lives, then replay after a subsequent rotation — never a second rotation", async () => {
    await rotateRefreshJtiCAS("u", "s", "j0", "j1");
    expect(await rotateRefreshJtiCAS("u", "s", "j0", "j2")).toEqual({
      outcome: "grace",
      currentJti: "j1",
    });
    // A subsequent legitimate rotation rolls prev past j0 (deterministic —
    // no waiting on the 10s TTL): presenting the current jti is always live.
    expect(await rotateRefreshJtiCAS("u", "s", "j1", "j2b")).toEqual({ outcome: "rotated" });
    // The original jti now matches neither current nor prev: replay, and the
    // stale presenter still never wins a rotation of its own.
    expect(await rotateRefreshJtiCAS("u", "s", "j0", "j3")).toEqual({
      outcome: "replay",
      currentJti: "j2b",
    });
    expect(raw(CUR())).toBe("j2b");
    expect(raw(PREV())).toBe("j1");
  });
});

describe("REFRESH_ROTATE_LUA contract", () => {
  it("is dispatched by identity with 2 keys and 4 args", async () => {
    const redis = testRedis.current as FakeRedis;
    const seen: Array<{ keys: string[]; args: string[] }> = [];
    const origEval = redis.eval.bind(redis);
    (redis as any).eval = async (script: string, opts: { keys: string[]; arguments: string[] }) => {
      seen.push({ keys: opts.keys, args: opts.arguments });
      return origEval(script, opts);
    };
    await rotateRefreshJtiCAS("u", "s", "j0", "j1");
    expect(seen).toHaveLength(1);
    expect(seen[0].keys).toHaveLength(2);
    expect(seen[0].args).toHaveLength(4);
    expect(typeof REFRESH_ROTATE_LUA).toBe("string");
  });
});

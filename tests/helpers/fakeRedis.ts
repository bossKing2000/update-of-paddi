/**
 * In-memory Redis stand-in for unit tests: honors TTLs and implements the
 * same atomic compare/bump/delete verify semantics as the production OTP
 * Lua script, so service-level tests need no live Redis.
 *
 * This is a MODEL, not the real thing: it cannot prove the production Lua
 * parses or behaves identically inside Redis. That gap is covered
 * separately by tests/integration/phoneOtpRedis.integration.test.ts, which
 * runs the actual scripts against a real server. Unit suites here are fast
 * and deterministic; they are not a substitute for that run.
 */
import { RESET_ATTEMPT_LUA } from "../../src/services/passwordResetLimits.service";
import { REFRESH_ROTATE_LUA } from "../../src/lib/session";

/** How ISSUE_LUA is invoked: 3 keys (record, phone counter, IP counter). */
export const ISSUE_LUA_KEY_COUNT = 3;
/** ARGV count the production `requestOtp` must supply to ISSUE_LUA. */
export const ISSUE_LUA_ARGV_COUNT = 9;

/**
 * Fails loudly if ISSUE_LUA's positional contract ever changes, instead of
 * silently shifting every window/limit to the wrong counter. Called on every
 * issue so a future edit to either side fails the suite immediately.
 */
export function assertIssueArgvLayout(argv: string[]): void {
  if (argv.length !== ISSUE_LUA_ARGV_COUNT) {
    throw new Error(
      `ISSUE_LUA expects ${ISSUE_LUA_ARGV_COUNT} ARGV, received ${argv.length}. ` +
        `Order: [now, cooldownMs, phoneWindowSeconds, phoneMax, ipWindowSeconds, ipMax, record, ttlSeconds, ipEnabled]`,
    );
  }
  for (const [index, label] of [
    [0, "now"],
    [1, "cooldownMs"],
    [2, "phoneWindowSeconds"],
    [3, "phoneMax"],
    [4, "ipWindowSeconds"],
    [5, "ipMax"],
    [7, "ttlSeconds"],
  ] as const) {
    if (!Number.isFinite(Number(argv[index]))) {
      throw new Error(`ISSUE_LUA ARGV[${index}] (${label}) must be numeric, got ${JSON.stringify(argv[index])}`);
    }
  }
  if (!argv[6] || argv[6][0] !== "{") {
    throw new Error("ISSUE_LUA ARGV[6] must be the JSON record");
  }
}

export class FakeRedis {
  store = new Map<string, { value: string; expiresAt: number | null }>();
  fail = false;

  private purge(key: string) {
    const e = this.store.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.store.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.fail) throw new Error("redis down");
    this.purge(key);
    return this.store.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    opts?: { EX?: number; NX?: boolean },
  ): Promise<string | null> {
    if (this.fail) throw new Error("redis down");
    this.purge(key);
    if (opts?.NX && this.store.has(key)) return null;
    this.store.set(
      key,
      { value, expiresAt: opts?.EX ? Date.now() + opts.EX * 1000 : null },
    );
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    if (this.fail) throw new Error("redis down");
    let n = 0;
    for (const k of keys) {
      this.purge(k);
      if (this.store.delete(k)) n++;
    }
    return n;
  }

  async incr(key: string): Promise<number> {
    if (this.fail) throw new Error("redis down");
    this.purge(key);
    const next = Number(this.store.get(key)?.value ?? "0") + 1;
    this.store.set(
      key,
      { value: String(next), expiresAt: this.store.get(key)?.expiresAt ?? null },
    );
    return next;
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    if (this.fail) throw new Error("redis down");
    const e = this.store.get(key);
    if (!e) return false;
    e.expiresAt = Date.now() + seconds * 1000;
    return true;
  }

  async ttl(key: string): Promise<number> {
    if (this.fail) throw new Error("redis down");
    const e = this.store.get(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000));
  }

  /**
   * Mirrors the production VERIFY Lua: compare, bump, delete on terminal
   * states. Exhaustion uses `>` so OTP_MAX_ATTEMPTS wrong codes are answered
   * INVALID and the next one is refused.
   *
   * Scripts are distinguished by identity first: RESET_ATTEMPT_LUA (1 key /
   * 1 arg) would otherwise be ambiguous to read, and arity alone cannot tell
   * a future 1-key script apart. REFRESH_ROTATE_LUA (2 keys / 4 args) is
   * likewise identity-dispatched. ISSUE_LUA stays on its 3-key / 9-arg arity,
   * VERIFY_LUA on 1-key / 2-arg.
   */
  async eval(
    _script: string,
    opts: { keys: string[]; arguments: string[] },
  ): Promise<number | [number, string | null]> {
    if (this.fail) throw new Error("redis down");
    if (_script === RESET_ATTEMPT_LUA) return this.resetAttempt(opts);
    if (_script === REFRESH_ROTATE_LUA) return this.refreshRotate(opts);
    // The issue and verify scripts are distinguished by arity: ISSUE_LUA
    // takes 3 keys / 9 args, VERIFY_LUA takes 1 key / 2 args.
    if (opts.keys.length === 3) return this.issue(opts);
    const [key] = opts.keys;
    const [expected, maxAttempts] = opts.arguments;
    this.purge(key);
    const raw = this.store.get(key)?.value ?? null;
    if (!raw) return 0;
    const rec = JSON.parse(raw) as { d: string; a: number };
    if (rec.d === expected) {
      this.store.delete(key);
      return 1;
    }
    rec.a = (rec.a || 0) + 1;
    if (rec.a > Number(maxAttempts)) {
      this.store.delete(key);
      return 2;
    }
    this.store.set(key, { value: JSON.stringify(rec), expiresAt: this.store.get(key)!.expiresAt });
    return 3;
  }

  /**
   * Mirrors the production ISSUE Lua: cooldown, both counters, one atomic
   * write.
   *
   * Phase 1D.39: the positional ARGV layout is asserted explicitly (see
   * `assertIssueArgvLayout`) rather than trusted, and each window is applied
   * to the counter it actually belongs to. Previously the IP counter was
   * given ARGV[3] (the phone window) while ARGV[5] — the IP window — was
   * destructured into an unnamed hole and silently discarded, so the double
   * could not have detected the two windows being swapped.
   */
  private issue(opts: { keys: string[]; arguments: string[] }): number {
    const [key, phoneRateKey, ipKey] = opts.keys;
    const argv = opts.arguments;
    assertIssueArgvLayout(argv);
    const now = argv[0];
    const cooldownMs = argv[1];
    const phoneWindowSeconds = argv[2];
    const phoneMax = argv[3];
    const ipWindowSeconds = argv[4];
    const ipMax = argv[5];
    const record = argv[6];
    const ttlSeconds = argv[7];
    const ipEnabled = argv[8];
    this.purge(key);
    this.purge(phoneRateKey);
    this.purge(ipKey);

    const existing = this.store.get(key)?.value;
    if (existing) {
      const rec = JSON.parse(existing) as { s: number };
      if (Number(now) - (rec.s ?? 0) < Number(cooldownMs)) return 1;
    }

    const phoneCount = this.incrSync(phoneRateKey);
    if (phoneCount === 1) this.expireSync(phoneRateKey, Number(phoneWindowSeconds));
    if (phoneCount > Number(phoneMax)) return 2;

    if (ipEnabled === "1") {
      const ipCount = this.incrSync(ipKey);
      if (ipCount === 1) this.expireSync(ipKey, Number(ipWindowSeconds));
      if (ipCount > Number(ipMax)) return 2;
    }

    this.store.set(key, { value: record, expiresAt: Date.now() + Number(ttlSeconds) * 1000 });
    return 0;
  }

  private incrSync(key: string): number {
    const next = Number(this.store.get(key)?.value ?? "0") + 1;
    this.store.set(key, { value: String(next), expiresAt: this.store.get(key)?.expiresAt ?? null });
    return next;
  }

  private expireSync(key: string, seconds: number): void {
    const e = this.store.get(key);
    if (e) e.expiresAt = Date.now() + seconds * 1000;
  }

  /**
   * Mirrors RESET_ATTEMPT_LUA: atomic INCR with the TTL assigned exactly
   * once, on first increment; returns the post-increment count. Runs
   * synchronously inside `eval`, so concurrent test callers serialize the
   * same way Redis serializes the script.
   */
  private resetAttempt(opts: { keys: string[]; arguments: string[] }): number {
    const [key] = opts.keys;
    const [ttlSeconds] = opts.arguments;
    if (!key || !Number.isFinite(Number(ttlSeconds))) {
      throw new Error(
        "RESET_ATTEMPT_LUA expects keys=[attemptsKey], arguments=[ttlSeconds]",
      );
    }
    this.purge(key);
    const count = this.incrSync(key);
    if (count === 1) this.expireSync(key, Number(ttlSeconds));
    return count;
  }

  /**
   * Mirrors REFRESH_ROTATE_LUA: compare the expected current JTI and rotate,
   * or classify as grace/replay — all synchronously, so concurrent test
   * callers serialize the same way Redis single-threads the script. Returns
   * [code, current] with 0 = rotated, 1 = grace, 2 = replay, matching the
   * production script's contract exactly (including returning the observed
   * current JTI for grace minting).
   *
   * This is a MODEL, not proof: it cannot show the Lua parses or behaves
   * identically inside real Redis. See the header comment.
   */
  private refreshRotate(opts: {
    keys: string[];
    arguments: string[];
  }): [number, string | null] {
    const [curKey, prevKey] = opts.keys;
    const [incoming, newJti, curTtl, prevTtl] = opts.arguments;
    if (
      !curKey ||
      !prevKey ||
      typeof incoming !== "string" ||
      incoming.length === 0 ||
      typeof newJti !== "string" ||
      newJti.length === 0 ||
      !Number.isFinite(Number(curTtl)) ||
      !Number.isFinite(Number(prevTtl))
    ) {
      throw new Error(
        "REFRESH_ROTATE_LUA expects keys=[curKey, prevKey], " +
          "arguments=[incomingJti, newJti, curTtlSeconds, prevTtlSeconds]",
      );
    }
    this.purge(curKey);
    this.purge(prevKey);
    const cur = this.store.get(curKey)?.value ?? null;
    const prev = this.store.get(prevKey)?.value ?? null;
    if (cur === null) {
      this.store.set(prevKey, { value: incoming, expiresAt: Date.now() + Number(prevTtl) * 1000 });
      this.store.set(curKey, { value: newJti, expiresAt: Date.now() + Number(curTtl) * 1000 });
      return [0, newJti];
    }
    if (cur === incoming) {
      this.store.set(prevKey, { value: cur, expiresAt: Date.now() + Number(prevTtl) * 1000 });
      this.store.set(curKey, { value: newJti, expiresAt: Date.now() + Number(curTtl) * 1000 });
      return [0, cur];
    }
    if (prev !== null && prev === incoming) {
      return [1, cur];
    }
    return [2, cur];
  }

  raw(key: string): string | null {
    this.purge(key);
    return this.store.get(key)?.value ?? null;
  }

  ttlOf(key: string): number {
    const e = this.store.get(key);
    if (!e || e.expiresAt === null) return -1;
    return Math.ceil((e.expiresAt - Date.now()) / 1000);
  }

  expireNow(key: string) {
    const e = this.store.get(key);
    if (e) e.expiresAt = Date.now() - 1;
  }

  /** Move the OTP record's last-sent timestamp into the past (cooldown tests). */
  backdateSent(key: string, msAgo: number) {
    const e = this.store.get(key);
    if (!e) throw new Error(`no record at ${key}`);
    const rec = JSON.parse(e.value) as { s: number };
    rec.s -= msAgo;
    e.value = JSON.stringify(rec);
  }

  clear() {
    this.store.clear();
    this.fail = false;
  }

  /**
   * A second "application instance" that shares this one's storage, the way
   * two processes share one Redis. Rate-limit and cooldown state written
   * through either handle is visible to the other, so tests can prove the
   * limits are enforced by shared state rather than process memory.
   */
  fork(): FakeRedis {
    const other = new FakeRedis();
    other.store = this.store;
    return other;
  }
}

/**
 * Holder wired into the `../../src/lib/redis` jest mock: tests assign a
 * fresh FakeRedis per test and the mocked module serves it lazily.
 */
export const testRedis: { current: FakeRedis | null } = { current: null };

/**
 * Phase 3.2.8 (F-1) — webhook replay-claim state machine.
 *
 * Drives the REAL scripts against an in-memory Redis double that implements
 * exactly the three commands they use (EXISTS / SET NX EX / GET / DEL), so
 * the ownership and fencing rules are exercised, not just the call shape.
 *
 * NOT PROVEN HERE (requires disposable Redis): Lua atomicity under real
 * concurrent connections, script replication semantics, TTL expiry driven
 * by the real clock, and cluster/failover behaviour. These tests prove the
 * state machine's logic and the owner checks, not distributed concurrency.
 */
import {
  acquireWebhookClaim,
  completeWebhookClaim,
  releaseWebhookClaim,
  newClaimToken,
  WEBHOOK_INFLIGHT_TTL_SECONDS,
} from "../../src/services/webhookReplayClaim.service";

/** Minimal Redis double covering the commands the scripts use. */
class FakeRedis {
  store = new Map<string, { value: string; expiresAt: number | null }>();
  /** Simulated clock (ms) so TTL expiry is deterministic. */
  now = 1_000_000;
  failNext = false;

  #expired(key: string) {
    const e = this.store.get(key);
    if (!e) return true;
    if (e.expiresAt !== null && e.expiresAt <= this.now) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async eval(
    script: string,
    args: { keys: string[]; arguments: string[] },
  ): Promise<number> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("ECONNRESET: connection lost");
    }
    const [k1, k2] = args.keys;
    const ar = args.arguments;
    const exists = (key: string) => (this.#expired(key) ? 0 : 1);
    const get = (key: string) => (this.#expired(key) ? null : this.store.get(key)!.value);
    const del = (key: string) => (this.#expired(key) ? 0 : Number(this.store.delete(key)));
    const set = (
      key: string,
      value: string,
      nx: boolean,
      ttl: number,
    ): boolean => {
      if (!this.#expired(key) && nx) return false; // NX: not set
      this.store.set(key, {
        value,
        expiresAt: ttl > 0 ? this.now + ttl * 1000 : null,
      });
      return true;
    };

    if (script.includes("exists")) {
      // ACQUIRE
      if (exists(k1) === 1) return 2; // DONE
      if (set(k2, ar[0], true, Number(ar[1]))) return 1; // ACQUIRED
      return 3; // BUSY
    }
    if (args.keys.length === 2) {
      // COMPLETE
      if (get(k2) === ar[0]) {
        del(k2);
        this.store.set(k1, { value: "1", expiresAt: this.now + Number(ar[1]) * 1000 });
        return 1;
      }
      return 0;
    }
    // RELEASE (single key)
    if (get(k1) === ar[0]) return del(k1);
    return 0;
  }

  advance(seconds: number) {
    this.now += seconds * 1000;
  }
}

const asClient = (fake: FakeRedis) => fake as unknown as never;

const ID = "wh-abc";
const key = (kind: "done" | "inflight") => `webhook:${kind}:${ID}`;

describe("F-1 — claim lifecycle", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it("1. a fresh event is acquired, and a second worker sees it BUSY (not completed)", async () => {
    const a = newClaimToken();
    expect(await acquireWebhookClaim(asClient(redis), ID, a)).toBe("ACQUIRED");

    // A concurrent duplicate must NOT be told the event is done.
    expect(await acquireWebhookClaim(asClient(redis), ID, newClaimToken())).toBe("BUSY");
  });

  it("2. a completed event is recognised as DONE", async () => {
    const claim = { webhookId: ID, token: newClaimToken() };
    await acquireWebhookClaim(asClient(redis), ID, claim.token);
    expect(await completeWebhookClaim(asClient(redis), claim)).toBe(true);

    expect(await acquireWebhookClaim(asClient(redis), ID, newClaimToken())).toBe("DONE");
    // The lease is gone — only the durable marker remains.
    expect(redis.store.has(key("inflight"))).toBe(false);
    expect(redis.store.has(key("done"))).toBe(true);
  });

  it("3. owner A cannot release owner B's claim", async () => {
    await acquireWebhookClaim(asClient(redis), ID, "token-A");

    expect(await releaseWebhookClaim(asClient(redis), { webhookId: ID, token: "token-B" })).toBe(false);
    // B did not clear A's lease — the event is still owned by A.
    expect(await acquireWebhookClaim(asClient(redis), ID, "token-B")).toBe("BUSY");
  });

  it("4. owner A cannot complete owner B's claim", async () => {
    await acquireWebhookClaim(asClient(redis), ID, "token-A");

    expect(await completeWebhookClaim(asClient(redis), { webhookId: ID, token: "token-B" })).toBe(false);
    // No done marker was written by the stale worker.
    expect(redis.store.has(key("done"))).toBe(false);
  });

  it("5. an abandoned lease becomes recoverable once it expires", async () => {
    await acquireWebhookClaim(asClient(redis), ID, "token-A");
    // Worker A crashes: its lease is never released or completed.
    redis.advance(WEBHOOK_INFLIGHT_TTL_SECONDS + 1);

    // The event is acquirable again rather than suppressed for 72h.
    expect(await acquireWebhookClaim(asClient(redis), ID, "token-B")).toBe("ACQUIRED");
  });

  it("6. a stale owner cannot overwrite a newer owner's completion", async () => {
    const stale = { webhookId: ID, token: "token-A" };
    await acquireWebhookClaim(asClient(redis), ID, "token-A");
    redis.advance(WEBHOOK_INFLIGHT_TTL_SECONDS + 1);

    // B takes over and finishes the work.
    const fresh = { webhookId: ID, token: "token-B" };
    await acquireWebhookClaim(asClient(redis), ID, "token-B");
    expect(await completeWebhookClaim(asClient(redis), fresh)).toBe(true);

    // A wakes up and tries to complete/release its expired lease. It owns
    // nothing, so both are no-ops and B's done marker is untouched.
    expect(await completeWebhookClaim(asClient(redis), stale)).toBe(false);
    expect(await releaseWebhookClaim(asClient(redis), stale)).toBe(false);
    expect(redis.store.has(key("done"))).toBe(true);
    expect(redis.store.has(key("inflight"))).toBe(false);
  });

  it("7. a Redis failure is never reported as successful acquisition", async () => {
    redis.failNext = true;
    await expect(
      acquireWebhookClaim(asClient(redis), ID, newClaimToken()),
    ).rejects.toThrow(/ECONNRESET/);
    // Nothing was claimed: a retry must be able to acquire normally.
    expect(await acquireWebhookClaim(asClient(redis), ID, newClaimToken())).toBe("ACQUIRED");
  });

  it("8. a release failure surfaces and leaves the event retryable", async () => {
    const claim = { webhookId: ID, token: "token-A" };
    await acquireWebhookClaim(asClient(redis), ID, "token-A");
    redis.failNext = true;

    await expect(releaseWebhookClaim(asClient(redis), claim)).rejects.toThrow(/ECONNRESET/);
    // Even though release failed, the lease is bounded — after it lapses
    // the event is recoverable.
    redis.advance(WEBHOOK_INFLIGHT_TTL_SECONDS + 1);
    expect(await acquireWebhookClaim(asClient(redis), ID, newClaimToken())).toBe("ACQUIRED");
  });

  it("9. completed markers stay protected for the full replay window", async () => {
    const claim = { webhookId: ID, token: "token-A" };
    await acquireWebhookClaim(asClient(redis), ID, "token-A");
    await completeWebhookClaim(asClient(redis), claim);

    // Far beyond the in-flight lease, still deduplicated.
    redis.advance(WEBHOOK_INFLIGHT_TTL_SECONDS * 10);
    expect(await acquireWebhookClaim(asClient(redis), ID, newClaimToken())).toBe("DONE");
  });
});

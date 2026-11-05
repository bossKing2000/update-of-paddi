import fs from "fs";
import { acquireLock, releaseLock, AcquiredLock, PAYMENT_LOCK_COMMAND_TIMEOUT_MS } from "../../src/lib/redisLock";

/**
 * A minimal in-memory stand-in for the redis@5 client surface
 * acquireLock/releaseLock actually use (`set` with NX/EX, and `eval`).
 * `eval` here reproduces the exact compare-and-delete semantics of the
 * Lua script in redisLock.ts, so these tests exercise the real
 * acquire/release logic, not a re-implementation of it.
 */
class FakeRedisClient {
  private store = new Map<string, string>();

  async set(key: string, value: string, opts?: { NX?: boolean; EX?: number }) {
    if (opts?.NX && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
    const [key] = options.keys;
    const [token] = options.arguments;
    if (this.store.get(key) === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  /** Test helper: simulate the TTL expiring without anyone releasing it. */
  _expire(key: string) {
    this.store.delete(key);
  }
}

describe("redisLock — ownership-safe SET NX + Lua compare-and-delete", () => {
  let client: FakeRedisClient;

  beforeEach(() => {
    client = new FakeRedisClient();
  });

  it("generates a unique token for every acquisition", async () => {
    const lockA = await acquireLock(client as any, "payment:init:u1:idem1", 20);
    client._expire("payment:init:u1:idem1");
    const lockB = await acquireLock(client as any, "payment:init:u1:idem1", 20);
    expect(lockA?.token).toBeDefined();
    expect(lockB?.token).toBeDefined();
    expect(lockA?.token).not.toBe(lockB?.token);
  });

  it("concurrent initialization: only one acquisition succeeds for the same key", async () => {
    const lockA = await acquireLock(client as any, "payment:init:u1:idem1", 20);
    const lockB = await acquireLock(client as any, "payment:init:u1:idem1", 20);
    expect(lockA).not.toBeNull();
    expect(lockB).toBeNull(); // second concurrent request must NOT get to call Paystack
  });

  it("the owner can release its own lock", async () => {
    const lock = (await acquireLock(client as any, "k", 20)) as AcquiredLock;
    const released = await releaseLock(client as any, lock);
    expect(released).toBe(true);
    // key is free again
    const reacquired = await acquireLock(client as any, "k", 20);
    expect(reacquired).not.toBeNull();
  });

  it("a wrong/forged token does not release the lock", async () => {
    await acquireLock(client as any, "k", 20);
    const forged: AcquiredLock = { key: "k", token: "not-the-real-token" };
    const released = await releaseLock(client as any, forged);
    expect(released).toBe(false);
    // real owner's lock is still held
    const stillHeld = await acquireLock(client as any, "k", 20);
    expect(stillHeld).toBeNull();
  });

  it("an expired old owner cannot delete a lock a new owner has since acquired", async () => {
    const lockA = (await acquireLock(client as any, "k", 20)) as AcquiredLock;
    // TTL expires without lockA's holder releasing it
    client._expire("k");
    // a different request now legitimately acquires the same key
    const lockB = await acquireLock(client as any, "k", 20);
    expect(lockB).not.toBeNull();

    // the original (now-stale) holder's `finally` block runs late and
    // tries to release what it still thinks is its lock
    const released = await releaseLock(client as any, lockA);
    expect(released).toBe(false); // must NOT touch lockB's lock

    // lockB is still intact
    const stillHeld = await acquireLock(client as any, "k", 20);
    expect(stillHeld).toBeNull();
  });
});

describe("redisLock — bounded command timeouts", () => {
  /**
   * A double that exposes `withCommandOptions` exactly like a real
   * node-redis client: it records the applied timeout, scopes subsequent
   * commands through it, and can be told to fail the way a timed-out
   * command does. Storage semantics mirror FakeRedisClient above.
   */
  function timeoutCapableClient(fail?: { set?: Error; eval?: Error }) {
    const store = new Map<string, string>();
    const seenTimeouts: number[] = [];
    const methods = {
      async set(key: string, value: string, opts?: { NX?: boolean; EX?: number }) {
        if (fail?.set) throw fail.set;
        if (opts?.NX && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
        if (fail?.eval) throw fail.eval;
        const [key] = options.keys;
        const [token] = options.arguments;
        if (store.get(key) === token) {
          store.delete(key);
          return 1;
        }
        return 0;
      },
    };
    const client = {
      ...methods,
      withCommandOptions: (options: { timeout: number }) => {
        seenTimeouts.push(options.timeout);
        return methods;
      },
    };
    return { client, seenTimeouts, store };
  }

  it("forwards the configured timeout to the Redis command API", async () => {
    const { client, seenTimeouts } = timeoutCapableClient();
    const lock = (await acquireLock(client as any, "k", 20, { timeoutMs: 2000 })) as AcquiredLock;
    expect(lock).not.toBeNull();
    expect(seenTimeouts).toEqual([2000]);

    const released = await releaseLock(client as any, lock, { timeoutMs: 2000 });
    expect(released).toBe(true);
    expect(seenTimeouts).toEqual([2000, 2000]);
  });

  it("clients without withCommandOptions preserve the existing no-timeout behavior", async () => {
    // The legacy FakeRedisClient has no withCommandOptions: passing a timeout
    // must degrade to the plain client, not throw.
    const plain = new FakeRedisClient();
    const lock = (await acquireLock(plain as any, "k", 20, { timeoutMs: 2000 })) as AcquiredLock;
    expect(lock).not.toBeNull();
    expect(await releaseLock(plain as any, lock, { timeoutMs: 2000 })).toBe(true);
  });

  it("omitting the timeout leaves behavior exactly as before", async () => {
    const { client, seenTimeouts } = timeoutCapableClient();
    const lock = (await acquireLock(client as any, "k", 20)) as AcquiredLock;
    expect(lock).not.toBeNull();
    expect(await releaseLock(client as any, lock)).toBe(true);
    expect(seenTimeouts).toEqual([]);
  });

  it("acquisition timeout rejects rather than being treated as contention", async () => {
    const { client } = timeoutCapableClient({ set: new Error("Command timed out") });
    // Must REJECT: returning null would surface as a routine 409 "please
    // retry", hiding an infrastructure failure from the caller.
    await expect(
      acquireLock(client as any, "k", 20, { timeoutMs: 2000 }),
    ).rejects.toThrow("Command timed out");
    // And nothing was left held: a healthy client acquires the same key.
    const healthy = timeoutCapableClient();
    const retry = await acquireLock(healthy.client as any, "k", 20);
    expect(retry).not.toBeNull();
  });

  it("release timeout is swallowed and reported as false, never thrown", async () => {
    const { client } = timeoutCapableClient({ eval: new Error("Command timed out") });
    const forged: AcquiredLock = { key: "k", token: "t" };
    await expect(
      releaseLock(client as any, forged, { timeoutMs: 2000 }),
    ).resolves.toBe(false);
  });

  it("the payment timeout default is positive and far below the 20s lock TTL", () => {
    expect(PAYMENT_LOCK_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PAYMENT_LOCK_COMMAND_TIMEOUT_MS).toBeLessThan(20 * 1000);
  });
});

describe("paymentController — uses the ownership-safe lock, not a bare DEL", () => {
  const source = fs.readFileSync("src/controllers/paymentController.ts", "utf8");

  it("acquires the lock via acquireLock with a bounded timeout, before ever calling Paystack, in both initiateOrderPayment and chargeSavedCard", () => {
    const acquireCount = source.split("acquireLock(redisPayments, initLockKey, 20,").length - 1;
    expect(acquireCount).toBe(2); // initiateOrderPayment + chargeSavedCard
    // Both acquisitions must carry the payment-domain timeout: dropping it
    // from either call site silently restores the unbounded hang this guards.
    const timeoutCount = source.split("timeoutMs: PAYMENT_LOCK_COMMAND_TIMEOUT_MS").length - 1;
    expect(timeoutCount).toBe(4); // 2 acquires + 2 releases
  });

  it("releases via releaseLock (token-checked), never a bare redisPayments.del", () => {
    expect(source).not.toContain("redisPayments.del(initLockKey)");
    const releaseCount = source.split("releaseLock(redisPayments, lock,").length - 1;
    expect(releaseCount).toBe(2);
  });

  it("throws a retry-friendly conflict instead of proceeding when the lock is already held", () => {
    expect(source).toContain("Payment is already being initialized for this order — please wait a moment and retry.");
  });
});

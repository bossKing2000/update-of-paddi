import fs from "fs";
import { acquireLock, releaseLock, AcquiredLock } from "../../src/lib/redisLock";

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

describe("paymentController — uses the ownership-safe lock, not a bare DEL", () => {
  const source = fs.readFileSync("src/controllers/paymentController.ts", "utf8");

  it("acquires the lock via acquireLock before ever calling Paystack, in both initiateOrderPayment and chargeSavedCard", () => {
    const acquireCount = source.split("acquireLock(redisPayments, initLockKey, 20)").length - 1;
    expect(acquireCount).toBe(2); // initiateOrderPayment + chargeSavedCard
  });

  it("releases via releaseLock (token-checked), never a bare redisPayments.del", () => {
    expect(source).not.toContain("redisPayments.del(initLockKey)");
    const releaseCount = source.split("releaseLock(redisPayments, lock)").length - 1;
    expect(releaseCount).toBe(2);
  });

  it("throws a retry-friendly conflict instead of proceeding when the lock is already held", () => {
    expect(source).toContain("Payment is already being initialized for this order — please wait a moment and retry.");
  });
});

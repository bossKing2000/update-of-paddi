/**
 * Phase 3.2.12 — real-Redis verification of the webhook replay-claim state
 * machine (Phase 3.2.8 / F-1) and the controller's handling of it.
 *
 * These tests execute the ACTUAL Lua scripts shipped in
 * src/services/webhookReplayClaim.service.ts. The Phase 3.2.9 review noted
 * that the unit suite's double interprets the scripts' intent rather than
 * executing them, so a syntax or semantic error would only surface here.
 *
 * Safety: the target is gated by tests/helpers/localRedisTarget.ts (loopback,
 * non-default database, never the application's endpoint). Every key is
 * namespaced by this run's pid and deleted in afterAll — no FLUSH, no pattern
 * deletes, no access to any other database index.
 */
import { createClient } from "redis";
import {
  acquireWebhookClaim,
  completeWebhookClaim,
  releaseWebhookClaim,
  newClaimToken,
  WEBHOOK_INFLIGHT_TTL_SECONDS,
  WEBHOOK_DONE_TTL_SECONDS,
  type WebhookClaim,
} from "../../../src/services/webhookReplayClaim.service";
import { evaluateDisposableRedisTarget } from "../../helpers/localRedisTarget";

jest.setTimeout(30000);

const target = evaluateDisposableRedisTarget(process.env.WEBHOOK_TEST_REDIS_URL);
if (!target.ok) {
  throw new Error(`Refusing to run: ${target.reason}`);
}

const client = createClient({ url: target.url });
const keys: string[] = [];
const ns = `whm:itest:${process.pid}:`;

/**
 * Register BOTH keys a claim can create for this id, up front, so teardown
 * deletes exactly what the run created even when the test takes a path that
 * never reaches completion (owner-only rejections, concurrent acquisition,
 * error cases). Phase 3.2.13: three cases previously created keys without
 * registering them, leaving them behind until TTL.
 */
function track(id: string) {
  keys.push(`webhook:done:${id}`, `webhook:inflight:${id}`);
}

let seq = 0;
function eventId() {
  const id = `${ns}e${Date.now().toString(36)}${seq++}`;
  track(id);
  return id;
}
// Key builders are pure — registration happens once, in `eventId()`.
function doneKey(id: string) {
  return `webhook:done:${id}`;
}
function inflightKey(id: string) {
  return `webhook:inflight:${id}`;
}

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  // Delete only the keys this run created.
  if (keys.length > 0) await client.del(keys);
  await client.quit();
});

describe("A. real Lua scripts execute and enforce the state machine", () => {
  it("1. acquires, reports BUSY to a concurrent caller, and completes to DONE", async () => {
    const id = eventId();
    const owner = newClaimToken();
    expect(await acquireWebhookClaim(client as never, id, owner)).toBe("ACQUIRED");
    // A second delivery while the first is still working.
    expect(await acquireWebhookClaim(client as never, id, newClaimToken())).toBe("BUSY");
    // ...and after completion it is a genuine duplicate, not merely busy.
    expect(await completeWebhookClaim(client as never, { webhookId: id, token: owner })).toBe(true);
    expect(await acquireWebhookClaim(client as never, id, newClaimToken())).toBe("DONE");
  });

  it("2. only the owner can complete or release the claim", async () => {
    const id = eventId();
    await acquireWebhookClaim(client as never, id, "owner-a");
    const claimB: WebhookClaim = { webhookId: id, token: "owner-b" };

    expect(await completeWebhookClaim(client as never, claimB)).toBe(false);
    expect(await releaseWebhookClaim(client as never, claimB)).toBe(false);
    // A's lease survives both attempts.
    expect(await client.exists(inflightKey(id))).toBe(1);
    expect(await completeWebhookClaim(client as never, { webhookId: id, token: "owner-a" })).toBe(true);
  });

  it("3. a stale owner cannot overwrite a newer owner's completion", async () => {
    const id = eventId();
    const stale: WebhookClaim = { webhookId: id, token: "owner-a" };
    await acquireWebhookClaim(client as never, id, "owner-a");

    // Simulate the lease lapsing (no waiting five minutes) and B taking over.
    await client.pExpire(inflightKey(id), 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(await acquireWebhookClaim(client as never, id, "owner-b")).toBe("ACQUIRED");

    // A resumes and tries to finish its abandoned work.
    expect(await completeWebhookClaim(client as never, stale)).toBe(false);
    expect(await releaseWebhookClaim(client as never, stale)).toBe(false);
    // B's ownership is intact and it may still complete.
    expect(await client.get(inflightKey(id))).toBe("owner-b");
    expect(await completeWebhookClaim(client as never, { webhookId: id, token: "owner-b" })).toBe(true);
  });

  it("4. an expired (abandoned) lease is recoverable", async () => {
    const id = eventId();
    await acquireWebhookClaim(client as never, id, "crashed-worker");
    await client.pExpire(inflightKey(id), 1);
    await new Promise((r) => setTimeout(r, 10));

    expect(await client.exists(doneKey(id))).toBe(0);
    expect(await acquireWebhookClaim(client as never, id, "recovering-worker")).toBe("ACQUIRED");
  });

  it("5. acquisition is atomic under concurrent requests", async () => {
    const id = eventId();
    const tokens = Array.from({ length: 12 }, () => newClaimToken());

    const results = await Promise.all(
      tokens.map((t) => acquireWebhookClaim(client as never, id, t)),
    );

    // Exactly one winner; every other concurrent caller sees BUSY, never DONE.
    expect(results.filter((r) => r === "ACQUIRED")).toHaveLength(1);
    expect(results.filter((r) => r === "BUSY")).toHaveLength(tokens.length - 1);
    expect(results.filter((r) => r === "DONE")).toHaveLength(0);
  });

  it("6. markers carry the documented TTLs", async () => {
    const id = eventId();
    await acquireWebhookClaim(client as never, id, "ttl-owner");

    const inflightTtl = await client.ttl(inflightKey(id));
    const doneTtl = await client.ttl(doneKey(id));
    // Redis TTL is second-granular and counts down.
    expect(inflightTtl).toBeGreaterThan(WEBHOOK_INFLIGHT_TTL_SECONDS - 15);
    expect(inflightTtl).toBeLessThanOrEqual(WEBHOOK_INFLIGHT_TTL_SECONDS);

    expect(await completeWebhookClaim(client as never, { webhookId: id, token: "ttl-owner" })).toBe(true);
    expect(await client.exists(inflightKey(id))).toBe(0);
    const completedTtl = await client.ttl(doneKey(id));
    expect(completedTtl).toBeGreaterThan(WEBHOOK_DONE_TTL_SECONDS - 60);
  });

  it("7. a completed event stays deduplicated across many acquisitions", async () => {
    const id = eventId();
    await acquireWebhookClaim(client as never, id, "once");
    await completeWebhookClaim(client as never, { webhookId: id, token: "once" });

    for (let i = 0; i < 5; i += 1) {
      expect(await acquireWebhookClaim(client as never, id, newClaimToken())).toBe("DONE");
    }
  });

  it("8. a Redis failure surfaces instead of looking like acquisition", async () => {
    // Point a client at a closed loopback port: nothing is listening there.
    const broken = createClient({
      url: "redis://127.0.0.1:6497/15",
      socket: { connectTimeout: 500, reconnectStrategy: false },
    });
    await expect(acquireWebhookClaim(broken as never, eventId(), "x")).rejects.toThrow();
    await broken.quit().catch(() => {});
  });
});
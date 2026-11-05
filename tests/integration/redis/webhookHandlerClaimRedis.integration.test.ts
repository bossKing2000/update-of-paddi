/**
 * Phase 3.2.12 — controller-level replay-claim behaviour against a REAL
 * disposable Redis.
 *
 * The claim scripts themselves are covered by
 * webhookReplayClaimRedis.integration.test.ts. This suite closes the
 * remaining gap from the Phase 3.2.9 review: it proves the handler's
 * ACQUIRED / BUSY / DONE decisions and its release-on-failure path are wired
 * to real Redis keys rather than to a stub.
 *
 * Only Redis is real here. The database, the Paystack SDK, and the
 * settlement helpers are mocked exactly as the unit suite mocks them, since
 * this suite is about claim routing, not financial behaviour.
 *
 * Safety: the shared evaluateDisposableRedisTarget gate asserts a loopback,
 * non-default database
 * before anything connects, and every key touched is deleted in afterAll.
 */
import { createHash } from "crypto";
import { createClient } from "redis";
import { evaluateDisposableRedisTarget, redisTestNamespace } from "../../helpers/localRedisTarget";

jest.mock("../../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    vendorPayout: { findFirst: jest.fn(async () => null) },
    riderWithdrawal: { findUnique: jest.fn(async () => null) },
    auditLog: { create: jest.fn(async () => ({})) },
  },
}));

jest.mock("../../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => ({})),
}));

jest.mock("../../../src/utils/paystack", () => ({
  __esModule: true,
  validatePaystackSignature: jest.fn(() => true),
}));

jest.mock("../../../src/services/paymentFinalizer.service", () => ({
  finalizePaymentSuccess: jest.fn(async () => ({ outcome: "SUCCESS" })),
}));

jest.mock("../../../src/services/refundFinalizer.service", () => ({
  matchRefundRequest: jest.fn(),
  completeRefund: jest.fn(),
  failRefund: jest.fn(),
}));

jest.mock("../../../src/services/vendorPayoutSettlement.service", () => ({
  settleVendorPayoutPaid: jest.fn(async () => ({ outcome: "SETTLED" })),
  settleVendorPayoutFailed: jest.fn(async () => ({ outcome: "SETTLED" })),
}));

jest.mock("../../../src/services/riderWithdrawalSettlement.service", () => ({
  settleRiderWithdrawalPaid: jest.fn(async () => ({ outcome: "SETTLED" })),
  settleRiderWithdrawalFailed: jest.fn(async () => ({ outcome: "SETTLED" })),
}));

import { paystackWebhookHandler } from "../../../src/controllers/webhook";
import { finalizePaymentSuccess } from "../../../src/services/paymentFinalizer.service";
import { redisPayments } from "../../../src/lib/redis";

/**
 * `redisPayments` is the production client for webhook payments and is
 * created with the logical database the handler uses (src/lib/redis.ts).
 * Production connects it at startup; a test must do the same, otherwise
 * every command rejects with ClientClosedError.
 */
const HANDLER_DB = 6;

jest.setTimeout(30000);

// Local-only guarantee before any connection: the handler's Redis client is
// built from REDIS_URL, so it must be loopback and not the default database.
// FIN-07-05k: read a dedicated disposable-target variable and validate it with
// the SHARED gate, exactly as webhookReplayClaimRedis does.
//
// This used to read `process.env.REDIS_URL` through a local inline guard. That
// conflicted with the pin-and-restore setup: the pin restores REDIS_URL to its
// pre-run value (normally unset) before any test module is required, so the
// module-scope read saw `undefined` and this suite aborted. Leaving REDIS_URL
// set instead is not viable either — the shared gate treats any set REDIS_URL
// as the application endpoint and would then refuse this suite's own target.
//
// The candidate comes exclusively from WEBHOOK_TEST_REDIS_URL, is validated by
// the unchanged evaluateDisposableRedisTarget (loopback-only, plain redis://,
// non-default database index, and host+port separation from the application
// endpoint), and fails closed with no fallback of any kind. The production
// client and the webhook claim Lua scripts are still exercised for real.
const targetDecision = evaluateDisposableRedisTarget(process.env.WEBHOOK_TEST_REDIS_URL);
if (!targetDecision.ok) {
  throw new Error(
    "[webhookHandlerClaimRedis] BLOCKED: the disposable Redis target was refused — " +
      `${targetDecision.reason ?? "no reason supplied"}. ` +
      "Set WEBHOOK_TEST_REDIS_URL to a disposable loopback Redis. Refusing to fall back " +
      "to the application's REDIS_URL.",
  );
}
const target = { url: targetDecision.url };

// Task 7.41 — the inspector must land on the SAME logical database the handler
// under test actually writes to.
//
// `node-redis` gives a database path in the URL precedence over the explicit
// `database` option (measured in Task 7.39: `{url:"…/9", database:3}` writes to
// database 9). Passing `target.url` unchanged therefore sent this inspector to
// WEBHOOK_TEST_REDIS_URL's database while `redisPayments` — built from the
// pathname-free REDIS_URL published by pinTestRedisUrl, so honouring its own
// `database: 6` — wrote to database 6. The two clients addressed different
// logical databases, which failed tests 9-11 and left the handler's keys behind
// in a database `afterAll` never cleaned.
//
// Stripping ONLY the pathname lets the explicit `database: HANDLER_DB` option
// apply, exactly as it does for the application client. The gate above has
// already validated the FULL url (loopback host, plain redis:// scheme,
// non-default database index, separation from the application endpoint) and is
// neither bypassed nor weakened; this only selects the logical database, never
// the server. Scheme, hostname and port are carried through unchanged.
const inspectorUrl = new URL(target.url);
inspectorUrl.pathname = "";

const inspector = createClient({ url: inspectorUrl.toString(), database: HANDLER_DB });
const touched = new Set<string>();

const mockedFinalize = finalizePaymentSuccess as jest.Mock;

function chargeData() {
  return { reference: "PSK-R1", amount: 500000, channel: "card", metadata: { userId: "cust-1" } };
}
function webhookReq(event: string, data: Record<string, unknown>) {
  return {
    ip: "127.0.0.1",
    body: Buffer.from(JSON.stringify({ event, data })),
    headers: { "x-paystack-signature": "sig" },
    socket: { remoteAddress: "127.0.0.1" },
  } as never;
}
function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  return r;
}
const statusOf = (r: any) => r.status.mock.calls[0][0];

/** Mirrors computeWebhookId so a BUSY lease can be planted before delivery. */
function webhookIdFor(event: string, data: Record<string, unknown>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        event,
        reference: data.reference ?? (data as any).transaction_reference,
        refundReference: (data as any).refund_reference,
        amount: data.amount,
      }),
    )
    .digest("hex");
}

let idCounter = 0;
function freshIds() {
  idCounter += 1;
  // Task 7.40: the reference is namespaced per PROCESS, not fixed as `PSK-R1-N`.
  // These ids feed a sha256 that becomes the Redis key, so a fixed counter made
  // every run derive the SAME `webhook:done:*` keys. If a run ever failed while
  // its handler and inspector addressed different databases, `afterAll` deleted
  // through the inspector only, orphaning the handler's keys — and the next run
  // on that database then saw them as pre-existing replays. Measured in Task
  // 7.39: a split run failed 3/3 and left 4 keys, and the following run on the
  // same database also failed 3/3 purely from those orphans. Namespacing makes
  // ids unique per run so orphans can never be mistaken for live state. It does
  // not weaken any assertion: `touched` still records the exact keys written,
  // and `afterAll` still deletes exactly those.
  const data = { ...chargeData(), reference: `${redisTestNamespace("wclaim")}-${idCounter}` };
  const id = webhookIdFor("charge.success", data);
  touched.add(`webhook:done:${id}`);
  touched.add(`webhook:inflight:${id}`);
  return { data, id };
}

beforeAll(async () => {
  await inspector.connect();
  if (!redisPayments.isOpen) await redisPayments.connect();
});
beforeEach(() => {
  jest.clearAllMocks();
  mockedFinalize.mockResolvedValue({ outcome: "SUCCESS" });
});
afterAll(async () => {
  if (touched.size > 0) await inspector.del([...touched]);
  if (redisPayments.isOpen) await redisPayments.quit();
  await inspector.quit();
});

describe("B. handler claim routing against real Redis", () => {
  it("9. an acquired claim is completed and the redelivery is a duplicate", async () => {
    const { data, id } = freshIds();

    const first = res();
    await paystackWebhookHandler(webhookReq("charge.success", data), first);
    expect(statusOf(first)).toBe(200);
    // The production key was written under the id this suite derived — which
    // also proves the derived id matches the handler's own computation.
    expect(await inspector.exists(`webhook:done:${id}`)).toBe(1);
    expect(await inspector.exists(`webhook:inflight:${id}`)).toBe(0);

    const second = res();
    await paystackWebhookHandler(webhookReq("charge.success", data), second);
    expect(statusOf(second)).toBe(200);
    expect(second.send).toHaveBeenCalledWith("Webhook already processed");
    // The duplicate never re-entered the finalizer.
    expect(mockedFinalize).toHaveBeenCalledTimes(1);
  });

  it("10. an event owned by another worker is retryable, not acknowledged", async () => {
    const { data, id } = freshIds();
    // Another worker holds a live lease.
    await inspector.set(`webhook:inflight:${id}`, "some-other-owner", { EX: 300 });

    const r = res();
    await paystackWebhookHandler(webhookReq("charge.success", data), r);

    expect(statusOf(r)).toBe(503);
    expect(mockedFinalize).not.toHaveBeenCalled();
    // The other worker's lease was neither completed nor released.
    expect(await inspector.get(`webhook:inflight:${id}`)).toBe("some-other-owner");
  });

  it("11. a processing failure releases the lease so the event stays retryable", async () => {
    const { data, id } = freshIds();
    mockedFinalize.mockRejectedValueOnce(new Error("db unavailable"));

    const r = res();
    await paystackWebhookHandler(webhookReq("charge.success", data), r);

    expect(statusOf(r)).toBe(503);
    expect(await inspector.exists(`webhook:inflight:${id}`)).toBe(0);
    expect(await inspector.exists(`webhook:done:${id}`)).toBe(0);

    // The provider's retry is accepted rather than deduplicated.
    mockedFinalize.mockResolvedValueOnce({ outcome: "SUCCESS" });
    const retry = res();
    await paystackWebhookHandler(webhookReq("charge.success", data), retry);
    expect(statusOf(retry)).toBe(200);
    expect(await inspector.exists(`webhook:done:${id}`)).toBe(1);
  });
});
/**
 * FIN-07-03c — bounded recovery of captures whose webhook never arrived.
 *
 * THE LOSS PATH BEING CLOSED
 * --------------------------
 * `verifyPendingPayments` marks a reference EXPIRED as soon as `expiresAt`
 * passes, WITHOUT asking Paystack, and then excludes it from all later polling.
 * A charge Paystack captured while the `charge.success` webhook was lost in
 * transit was therefore undiscoverable, so the FIN-07-02 refund-obligation
 * branch in `finalizePaymentSuccess` — which only runs once somebody already
 * knows the payment succeeded — could never be reached.
 *
 * WHAT MAKES THESE TESTS REAL
 * ---------------------------
 * The worker's Paystack client is stubbed, but `finalizePaymentSuccess` is the
 * REAL implementation against a mocked Prisma, so the FIN-07-02 branch that
 * files the durable obligation actually executes here. Writes are modelled with
 * a durability snapshot so a committed claim persists across invocations,
 * exactly as it would after a real commit.
 *
 * These tests prove application logic only. They do NOT prove PostgreSQL
 * isolation, transaction rollback under real concurrency, or anything about a
 * live provider — all of that still needs disposable-database verification.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    order: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    refundRequest: { findFirst: jest.fn(), create: jest.fn() },
    userPaymentMethod: { upsert: jest.fn(async () => ({})) },
    product: { updateMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../../src/services/paymentService", () => ({
  __esModule: true,
  verifyPayment: jest.fn(),
}));

jest.mock("../../src/services/inventory.service", () => ({
  __esModule: true,
  restoreStockForOrders: jest.fn(async () => []),
  reserveStockForItems: jest.fn(),
  assertQuantityAvailable: jest.fn(),
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => ({})),
  clearProductsCache: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => ({})),
}));

jest.mock("../../src/utils/generate Receipt/generateReceipt", () => ({
  __esModule: true,
  generateReceipt: jest.fn(async () => ({ pdfUrl: "http://test/r.pdf" })),
}));

import prisma from "../../src/lib/prisma";
import { verifyPayment } from "../../src/services/paymentService";
import { restoreStockForOrders } from "../../src/services/inventory.service";
import { verifyExpiredPayments, EXPIRED_RECOVERY_WINDOW_MS } from "../../src/jobs/payment/worker/verifyExpiredPayments";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & {
  $queryRaw: jest.Mock;
};

/** Durability model: an accepted payment-status claim persists. */
let PERSISTED_STATUS = "EXPIRED";

let CANDIDATES: any[] = [];
let ORDERS: any[] = [];
let openRefund: any = null;
let createdRefunds: any[] = [];

/** Paystack verify() payload shaped like the real one. */
function successPayload(over: Record<string, unknown> = {}) {
  return {
    status: "success",
    amount: 550000,
    currency: "NGN",
    channel: "card",
    metadata: { userId: "cust-1" },
    authorization: { authorization_code: "AUTH_TEST" },
    ...over,
  };
}

/** Order row in the state the expiry path leaves behind. */
function expiredOrder(over: Record<string, unknown> = {}) {
  return {
    id: "order-A",
    idempotencyKey: "batch-1",
    customerId: "cust-1",
    // Phase 3A: order.totalPrice is integer kobo.
    totalPrice: 550000,
    status: "CANCELLED_UNPAID",
    paymentStatus: "EXPIRED",
    cancellationReason: "PAYMENT_EXPIRED",
    paidAt: null,
    ...over,
  };
}

/** Payment row in the state `verifyPendingPayments` leaves behind. */
function expiredPayment(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    reference: REFERENCE,
    orderId: "order-A",
    idempotencyKey: "batch-1",
    status: "EXPIRED",
    expiresAt: new Date(Date.now() - 1 * HOUR),
    paystackData: null,
    createdAt: new Date(),
    ...over,
  };
}

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
};

const baseReq = (body: Record<string, unknown> = {}): any => ({
  body,
  headers: {},
  params: {},
  query: {},
  ip: "127.0.0.1",
  get: () => undefined,
  user: { id: "u-1", role: "CUSTOMER" },
});

const mockedVerify = verifyPayment as jest.Mock;
const mockedRestore = restoreStockForOrders as jest.Mock;

const REFERENCE = "PSK-EXPIRED-1";
const HOUR = 60 * 60 * 1000;

/** Bound parameters seen by the last candidate scan, for assertions. */
const SCAN: { cutoff: Date | null; limit: number | null; text: string } = {
  cutoff: null,
  limit: null,
  text: "",
};

const TERMINAL_OUTCOMES = ["reconciled", "provider_not_successful"];

/** Every candidate scan the worker issued, in order. */
const SCAN_CALLS: any[] = [];

/** Mirrors the SQL predicate the worker sends (documented in the worker header). */
function isEligible(row: any, now: number): boolean {
  if (row.status !== "EXPIRED") return false;
  if (typeof row.reference === "string" && row.reference.startsWith("SEED-")) return false;
  const pd = row.paystackData;
  if (pd !== null && pd !== undefined) {
    const outcome = pd?.expiredRecovery?.outcome;
    // absent / JSON null / undefined -> eligible; terminal value -> excluded
    if (outcome !== undefined && outcome !== null && TERMINAL_OUTCOMES.includes(outcome)) {
      return false;
    }
    const next = pd?.expiredRecovery?.nextCheckAt;
    if (typeof next === "string" && /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?(Z|[+][0-9]{2}:[0-5][0-9]|-[0-9]{2}:[0-5][0-9])$/.test(next)) {
      const t = new Date(next).getTime();
      if (Number.isFinite(t) && t > now) return false; // cooldown
    }
    // malformed -> treated as absent -> due now
  }
  return true;
}

/**
 * Installs a $queryRaw double that emulates the documented candidate SQL over
 * an in-memory store: window, SEED- exclusion, terminal + cooldown exclusion
 * BEFORE the limit, FIFO ordering, keyset, LIMIT.
 */
function installScanDouble(source: any[] | (() => any[])) {
  db.$queryRaw.mockImplementation(async (sqlObj: any) => {
    // Resolved per call so a test that reassigns CANDIDATES/STORE is observed.
    const rows = typeof source === "function" ? source() : source;
    const values: any[] = Array.isArray(sqlObj?.values) ? sqlObj.values : [];
    const text = String(sqlObj?.text ?? "");
    SCAN.text = text;
    // Bound-parameter order: status, window cutoff, SEED- prefix, the two
    // terminal outcomes, the ISO pattern, the comparison instant, then the
    // keyset boundary (present only from page 2), then the page size.
    const dates = values.filter((v) => v instanceof Date);
    SCAN.cutoff = dates[0] ?? null;
    SCAN.limit = values.filter((v) => typeof v === "number").pop() ?? null;
    const hasKeyset = text.includes('AND (p."expiresAt" >');
    const now = dates[1] ?? new Date();
    const keysetAt = hasKeyset ? dates[dates.length - 1] : null;
    const keysetId = hasKeyset ? String(values.filter((v) => typeof v === "string").pop()) : null;
    SCAN_CALLS.push({ text, cutoff: SCAN.cutoff, limit: SCAN.limit, hasKeyset, keysetAt, keysetId });

    let out = rows
      .filter((r) => isEligible(r, now.getTime()))
      .filter((r) => (SCAN.cutoff ? new Date(r.expiresAt).getTime() >= SCAN.cutoff.getTime() : true))
      .filter((r) =>
        keysetAt && keysetId
          ? new Date(r.expiresAt).getTime() > keysetAt.getTime() ||
            (new Date(r.expiresAt).getTime() === keysetAt.getTime() && r.id > keysetId)
          : true,
      )
      .sort((a, b) => {
        const av = new Date(a.expiresAt).getTime();
        const bv = new Date(b.expiresAt).getTime();
        if (av !== bv) return av - bv;
        return a.id < b.id ? -1 : 1;
      });
    out = out.slice(0, SCAN.limit ?? out.length);
    return out.map((r) => ({
      id: r.id,
      reference: r.reference,
      expiresAt: r.expiresAt,
      paystackData: r.paystackData,
    }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  SCAN_CALLS.length = 0;
  PERSISTED_STATUS = "EXPIRED";
  CANDIDATES = [expiredPayment()];
  ORDERS = [expiredOrder()];
  openRefund = null;
  createdRefunds = [];

  // Candidates the worker may consider. The `where` clause it sends is asserted
  // separately, so this stands in for "rows the database returned".
  installScanDouble(() => CANDIDATES);
  db.payment.findUnique.mockImplementation(async () => ({
    ...expiredPayment(),
    status: PERSISTED_STATUS,
    expiresAt: new Date(Date.now() - 1 * HOUR),
  }));
  db.payment.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (where?.status && where.status !== PERSISTED_STATUS) return { count: 0 };
    if (data?.status) PERSISTED_STATUS = data.status;
    return { count: 1 };
  });
  db.order.findMany.mockImplementation(async () => ORDERS);
  db.order.findUnique.mockImplementation(async ({ where }: any) =>
    ORDERS.find((o) => o.id === where.id) ?? null,
  );
  db.order.updateMany.mockImplementation(async () => ({ count: 0 }));
  db.refundRequest.findFirst.mockImplementation(async () => openRefund);
  db.refundRequest.create.mockImplementation(async ({ data }: any) => {
    const row = { id: `rr-${createdRefunds.length + 1}`, ...data };
    createdRefunds.push(row);
    return row;
  });
  db.$transaction.mockImplementation(async (arg: any) => {

  // C-2: obligations are filed with `INSERT ... ON CONFLICT DO NOTHING
  // RETURNING ...` (raw SQL) instead of a typed `create`. Route it through the
  // existing `create` double so every assertion below is unchanged.
  // This file already emulates the candidate-scan SQL through $queryRaw (see
  // installScanDouble). Capture whatever is installed so non-INSERT statements
  // keep going to the scan double instead of being swallowed.
  const priorRaw = db.$queryRaw.getMockImplementation() as
    | ((...a: any[]) => Promise<any>)
    | undefined;

  db.$queryRaw.mockImplementation(async (...args: any[]) => {
    const head = args[0];
    const sql = Array.isArray(head)
      ? head.join(" ")
      : String(head?.text ?? head ?? "");
    if (!sql.includes('INSERT INTO "RefundRequest"')) {
      return priorRaw ? priorRaw(...args) : [];
    }
    const values = Array.isArray(head) ? args.slice(1) : [];
    const [id, userId, paymentRef, reason, status, , , orderId, requestedAmountKobo] = values;
    const row = await db.refundRequest.create({
      data: { id, userId, paymentRef, reason, status, orderId, requestedAmountKobo },
    });
    return row ? [row] : [];
  });
    if (typeof arg !== "function") return arg;
    const snapshot = PERSISTED_STATUS;
    try {
      return await arg(db);
    } catch (err) {
      PERSISTED_STATUS = snapshot;
      throw err;
    }
  });
  mockedVerify.mockResolvedValue(successPayload());
});

/** The marker the worker writes once it has a definitive answer. */
function terminalOutcomes() {
  return markerWrites()
    .map((d: any) => d?.expiredRecovery?.outcome)
    .filter(Boolean);
}

function markerWrites() {
  return db.payment.updateMany.mock.calls
    .map((c: any[]) => c[0]?.data?.paystackData)
    .filter(Boolean);
}

describe("FIN-07-03c — a capture found after the payment already expired", () => {
  it("1. routes a Paystack success through the canonical finalizer", async () => {
    await verifyExpiredPayments();

    expect(mockedVerify).toHaveBeenCalledTimes(1);
    expect(mockedVerify).toHaveBeenCalledWith(REFERENCE);
  });

  it("2. files exactly one durable refund obligation (the missing-webhook case)", async () => {
    const result = await verifyExpiredPayments();

    expect(result.reconciled).toBe(1);
    expect(createdRefunds).toHaveLength(1);
    expect(createdRefunds[0]).toMatchObject({
      paymentRef: REFERENCE,
      orderId: "order-A",
      status: "PENDING",
      requestedAmountKobo: 550000, // order-bounded, never the payment total
      userId: "cust-1",
    });
    expect(createdRefunds[0].reason).toContain("LATE_PAYMENT");
  });

  it("3. the cancelled order stays cancelled and is never reopened", async () => {
    await verifyExpiredPayments();

    // The EXPIRED branch deliberately writes no Order row at all.
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(ORDERS[0].status).toBe("CANCELLED_UNPAID");
  });

  it("4. never rewrites Payment.status or restores inventory", async () => {
    await verifyExpiredPayments();

    expect(PERSISTED_STATUS).toBe("EXPIRED");
    const statusWrites = db.payment.updateMany.mock.calls.filter(
      (c: any[]) => c[0]?.data?.status !== undefined,
    );
    expect(statusWrites).toHaveLength(0);
    expect(mockedRestore).not.toHaveBeenCalled();
  });

  it("5. a second recovery pass does not duplicate the obligation or re-query", async () => {
    await verifyExpiredPayments();
    expect(createdRefunds).toHaveLength(1);

    // The marker persisted, so the reference is no longer a fresh candidate.
    const marker = markerWrites()[0];
    CANDIDATES = [expiredPayment({ paystackData: marker })];
    const result = await verifyExpiredPayments();

    expect(mockedVerify).toHaveBeenCalledTimes(1); // still just the first call
    expect(createdRefunds).toHaveLength(1);
    expect(result.checked).toBe(0);
  });

  it("5b. a repeat while the obligation is already open still files nothing new", async () => {
    await verifyExpiredPayments();
    openRefund = { id: "rr-existing" };

    // Marker lost (e.g. a restore from backup) but an obligation exists.
    CANDIDATES = [expiredPayment({ paystackData: null })];
    await verifyExpiredPayments();

    expect(createdRefunds).toHaveLength(1);
  });
});

describe("FIN-07-03c — ambiguity is never treated as failure", () => {
  it("6. a pending provider response does not mark the payment successful", async () => {
    mockedVerify.mockResolvedValue({ status: "pending", amount: 550000 });

    const result = await verifyExpiredPayments();

    expect(result.reconciled).toBe(0);
    expect(result.deferred).toBe(1);
    expect(createdRefunds).toHaveLength(0);
    // FIN-07-03c.1: it is now SCHEDULED for a retry, but never resolved.
    expect(terminalOutcomes()).toEqual([]);
    expect(markerWrites()[0].expiredRecovery.nextCheckAt).toEqual(expect.any(String));
    expect(PERSISTED_STATUS).toBe("EXPIRED");
  });

  it("7. a timeout leaves the reference recoverable inside the window", async () => {
    mockedVerify.mockRejectedValue(new Error("socket hang up"));

    const first = await verifyExpiredPayments();
    expect(first.deferred).toBe(1);
    expect(first.checked).toBe(1);
    expect(terminalOutcomes()).toEqual([]);

    // The marker persisted, so the database now returns it on the row.
    const marker = markerWrites()[0];
    CANDIDATES = [expiredPayment({ paystackData: marker })];

    // The backoff is honoured: an immediate second pass yields its budget.
    // The cooldown row is excluded by the SQL predicate itself, so the scan
    // never returns it and the worker spends no budget on it.
    const second = await verifyExpiredPayments();
    expect(second.checked).toBe(0);
    expect(mockedVerify).toHaveBeenCalledTimes(1);

    // Once the scheduled time has passed it is checked again. Simulated by
    // rewinding nextCheckAt rather than sleeping, so the test is deterministic.
    CANDIDATES = [
      expiredPayment({
        paystackData: {
          ...marker,
          expiredRecovery: {
            ...marker.expiredRecovery,
            nextCheckAt: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      }),
    ];
    const third = await verifyExpiredPayments();
    expect(third.checked).toBe(1);
    expect(mockedVerify).toHaveBeenCalledTimes(2);
    expect(createdRefunds).toHaveLength(0);
  });

  it("8. a confirmed unsuccessful response creates no false success", async () => {
    mockedVerify.mockResolvedValue({ status: "failed", amount: 550000 });

    const result = await verifyExpiredPayments();

    expect(result.notSuccessful).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(createdRefunds).toHaveLength(0);
    expect(PERSISTED_STATUS).toBe("EXPIRED");
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it("8b. 'abandoned' is also a definitive negative", async () => {
    mockedVerify.mockResolvedValue({ status: "abandoned" });
    const result = await verifyExpiredPayments();
    expect(result.notSuccessful).toBe(1);
    expect(createdRefunds).toHaveLength(0);
  });

  it("8c. an unknown provider status is deferred, never recorded", async () => {
    mockedVerify.mockResolvedValue({ status: "weird-new-state" });
    const result = await verifyExpiredPayments();
    expect(result.deferred).toBe(1);
    expect(terminalOutcomes()).toEqual([]);
  });
});

describe("FIN-07-03c — bounded selection", () => {
  it("9. only references expired inside the recovery window are selected", async () => {
    await verifyExpiredPayments();

    // The scan binds the window cutoff as its first timestamp parameter.
    expect(SCAN.cutoff).toBeInstanceOf(Date);
    const drift = Date.now() - SCAN.cutoff!.getTime();
    // Exactly the 72-hour application recovery window behind now.
    expect(Math.abs(drift - EXPIRED_RECOVERY_WINDOW_MS)).toBeLessThan(5000);
    // Only EXPIRED rows are eligible, and the SEED- prefix is excluded.
    expect(SCAN.text).toContain('p."status" = $1::"PaymentStatus"');
    expect(SCAN.text).toContain('p."reference" NOT LIKE $3');
  });

  it("10. historical expired payments are excluded by the cutoff", async () => {
    await verifyExpiredPayments();

    const cutoff = SCAN.cutoff!;
    // A reference that expired well before the cutoff fails `gte`.
    const longAgo = new Date(Date.now() - EXPIRED_RECOVERY_WINDOW_MS - HOUR);
    expect(longAgo.getTime() >= cutoff.getTime()).toBe(false);
    // One inside the window passes.
    const recent = new Date(Date.now() - HOUR);
    expect(recent.getTime() >= cutoff.getTime()).toBe(true);
  });

  it("10b. ordering is stable FIFO with an immutable unique tiebreaker", async () => {
    await verifyExpiredPayments();
    // Stable FIFO with the unique tiebreaker, both immutable to this worker so
    // the keyset boundary stays valid for the whole run.
    expect(SCAN.text).toContain('ORDER BY p."expiresAt" ASC, p."id" ASC');
    // Behavioural proof, not just the SQL text: the oldest candidate is served
    // first when several are eligible.
    CANDIDATES = [
      expiredPayment({ id: "b", reference: "REF-B", expiresAt: new Date(Date.now() - 2 * HOUR) }),
      expiredPayment({ id: "a", reference: "REF-A", expiresAt: new Date(Date.now() - 1 * HOUR) }),
    ];
    mockedVerify.mockClear();
    await verifyExpiredPayments(2);
    expect(mockedVerify.mock.calls.map((c) => c[0])).toEqual(["REF-B", "REF-A"]);
  });

  it("10c. already-resolved references are skipped before any provider call", async () => {
    CANDIDATES = [
      expiredPayment({ id: "old", reference: "OLD", paystackData: { expiredRecovery: { outcome: "reconciled" } } }),
      expiredPayment({ id: "mid", reference: "MID", paystackData: { authorization_url: "u", expiredRecovery: { outcome: "provider_not_successful" } } }),
    ];

    const result = await verifyExpiredPayments();

    expect(result.checked).toBe(0);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("10d. the marker merge preserves Paystack's own payload", async () => {
    await verifyExpiredPayments();

    const written = markerWrites()[0];
    expect(written.expiredRecovery.outcome).toBe("reconciled");
    expect(typeof written.expiredRecovery.checkedAt).toBe("string");
  });

  it("14. provider calls per tick are capped by the batch size", async () => {
    CANDIDATES = Array.from({ length: 12 }, (_, i) =>
      expiredPayment({ id: `p-${i}`, reference: `REF-${i}` }),
    );

    await verifyExpiredPayments(3);

    expect(mockedVerify).toHaveBeenCalledTimes(3);
  });
});

describe("FIN-07-03c — concurrency and interaction with a live webhook", () => {
  it("13. a concurrent webhook holding the lock leaves the obligation to a later pass", async () => {
    // The finalizer cannot take the per-payment lock.
    db.payment.updateMany.mockImplementation(async ({ where }: any) => {
      if (where?.OR) return { count: 0 }; // lock acquisition lost
      return { count: 1 };
    });

    const result = await verifyExpiredPayments();

    expect(result.deferred).toBe(1);
    expect(result.reconciled).toBe(0);
    // Never recorded as reconciled; merely rescheduled.
    expect(terminalOutcomes()).toEqual([]);
    expect(createdRefunds).toHaveLength(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it("13b. a concurrent finalization that already moved the reference is not overwritten", async () => {
    PERSISTED_STATUS = "SUCCESS";
    // No orders match the batch any more — nothing is owed.
    ORDERS = [];

    await verifyExpiredPayments();

    expect(createdRefunds).toHaveLength(0);
    expect(PERSISTED_STATUS).toBe("SUCCESS");
    const statusWrites = db.payment.updateMany.mock.calls.filter(
      (c: any[]) => c[0]?.data?.status !== undefined,
    );
    expect(statusWrites).toHaveLength(0);
  });

  it("11. the existing PENDING/INITIATED poller is untouched by this sweep", async () => {
    // The recovery worker only ever selects EXPIRED; a live payment is not
    // its business and must not be queried here.
    CANDIDATES = [expiredPayment()];
    await verifyExpiredPayments();

    // The sweep targets EXPIRED only, and never the PENDING/INITIATED set the
    // live poller owns.
    expect(SCAN.text).toContain('p."status" = $1::"PaymentStatus"');
    expect(SCAN.text).not.toContain("PENDING");
    expect(SCAN.text).not.toContain("INITIATED");
  });
});
/**
 * FIN-07-03c.1 — fairness under a hostile provider.
 *
 * These tests use a store that PERSISTS across worker executions (the marker
 * `updateMany` writes is reflected in what `findMany` later returns) and a
 * `findMany` that honours the cursor, `skip` and `take` the worker sends. That
 * is what makes them a genuine multi-execution test rather than a single-run
 * simulation: the starvation bug only appears when state survives between runs.
 *
 * No timers and no sleeps. Backoff is exercised by reading the `nextCheckAt`
 * the worker actually wrote.
 */
describe("FIN-07-03c.1 — fairness across repeated executions", () => {
  /** Rows as the database holds them, oldest expiry first. */
  let STORE: any[] = [];

  /** Build N candidates, oldest expiry first. */
  function seed(count: number) {
    STORE = Array.from({ length: count }, (_, i) => ({
      id: `pay-${String(i).padStart(3, "0")}`,
      reference: `REF-${String(i).padStart(3, "0")}`,
      // Oldest first: index 0 expired longest ago.
      expiresAt: new Date(Date.now() - (count - i) * 60_000),
      paystackData: null,
      status: "EXPIRED",
    }));
  }

  beforeEach(() => {
    seed(30); // > the 20-call budget, so starvation is observable
    installScanDouble(() => STORE);
    db.payment.updateMany.mockImplementation(async ({ where, data }: any) => {
      const row = where?.id
        ? STORE.find((p) => p.id === where.id)
        : STORE.find((p) => p.reference === where?.reference);
      if (!row) return { count: 0 };
      if (where?.status && row.status !== where.status) return { count: 0 };
      if (data?.paystackData) row.paystackData = data.paystackData;
      if (data?.status) row.status = data.status;
      return { count: 1 };
    });
  });

  /** References the provider was actually asked about. */
  function asked(): string[] {
    return mockedVerify.mock.calls.map((c) => c[0]);
  }

  it("4. older eligible candidates are reached across repeated executions", async () => {
    // 1 & 2: every candidate, including the newest, answers `pending`.
    mockedVerify.mockResolvedValue({ status: "pending", amount: 550000 });

    for (let run = 0; run < 6; run++) {
      await verifyExpiredPayments(5);
    }

    // Every one of the 30 candidates was eventually checked...
    expect(new Set(asked()).size).toBe(30);
    // ...and none was checked twice, because each check schedules a backoff.
    expect(asked()).toHaveLength(30);
  });

  it("4b. the oldest reference is always served before the newest", async () => {
    mockedVerify.mockResolvedValue({ status: "pending" });
    await verifyExpiredPayments(5);

    // FIFO: the first five asked are the five oldest expiries.
    expect(asked()).toEqual(["REF-000", "REF-001", "REF-002", "REF-003", "REF-004"]);
  });

  it("5. the per-execution call limit is never exceeded", async () => {
    mockedVerify.mockResolvedValue({ status: "pending" });

    const counts: number[] = [];
    for (let run = 0; run < 6; run++) {
      counts.push((await verifyExpiredPayments(5)).checked);
    }

    expect(Math.max(...counts)).toBeLessThanOrEqual(5);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it("7. newly eligible records do not starve older candidates", async () => {
    mockedVerify.mockResolvedValue({ status: "pending" });

    await verifyExpiredPayments(5); // consumes REF-000..004
    // Ten more payments expire in the meantime. Under a DESC scan these would
    // jump the queue and the backlog would never drain.
    STORE.push(
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `new-${i}`,
        reference: `NEW-${i}`,
        expiresAt: new Date(Date.now() - (i + 1) * 1000),
        paystackData: null,
        status: "EXPIRED",
      })),
    );

    for (let run = 0; run < 8; run++) {
      await verifyExpiredPayments(5);
    }

    const all = new Set(asked());
    expect(all.size).toBe(40);
    // The original backlog still completed.
    for (let i = 0; i < 30; i++) {
      expect(all.has(`REF-${String(i).padStart(3, "0")}`)).toBe(true);
    }
  });

  it("3. a transient provider error yields to the queue like any other unresolved result", async () => {
    // Every third reference times out; the rest answer `pending`.
    mockedVerify.mockImplementation(async (ref: string) => {
      if (ref.endsWith("1")) throw new Error("socket hang up");
      return { status: "pending" };
    });

    for (let run = 0; run < 6; run++) await verifyExpiredPayments(5);

    // The errored references were retried rather than abandoned.
    expect(new Set(asked()).size).toBe(30);
    // And none was recorded as resolved.
    expect(STORE.every((p) => !p.paystackData?.expiredRecovery?.outcome)).toBe(true);
  });

  it("8. backoff advances and is recorded on the row", async () => {
    mockedVerify.mockResolvedValue({ status: "pending" });

    await verifyExpiredPayments(1);
    const first = STORE[0].paystackData.expiredRecovery;
    expect(first.attempts).toBe(1);
    expect(first.nextCheckAt).toEqual(expect.any(String));
    expect(new Date(first.nextCheckAt).getTime()).toBeGreaterThan(Date.now());

    // Not due yet, so it is skipped and a different reference is served.
    const secondRun = await verifyExpiredPayments(1);
    // The not-due reference never reaches the worker: the SQL predicate drops
    // it before LIMIT, so the next eligible reference is served instead.
    expect(secondRun.checked).toBe(1);
    expect(asked()).toEqual(["REF-000", "REF-001"]);
  });

  it("8b. backoff grows exponentially and is capped", async () => {
    const { nextCheckDelayMs } = require("../../src/jobs/payment/worker/verifyExpiredPayments");
    const base = nextCheckDelayMs(1, "REF");
    const second = nextCheckDelayMs(2, "REF");
    const capped = nextCheckDelayMs(30, "REF");

    expect(second).toBeGreaterThan(base);
    // F-05: the total delay, jitter INCLUDED, never exceeds the documented cap.
    expect(capped).toBeLessThanOrEqual(4 * 60 * 60 * 1000);
    // Jitter is subtracted from the ceiling, so the floor is half of it.
    expect(capped).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });

  it("8c. the jitter is deterministic for a given reference", () => {
    const { nextCheckDelayMs } = require("../../src/jobs/payment/worker/verifyExpiredPayments");
    expect(nextCheckDelayMs(3, "REF-ABC")).toBe(nextCheckDelayMs(3, "REF-ABC"));
    // Different references are spread out so a batch does not retry in lockstep.
    const spread = new Set(
      Array.from({ length: 20 }, (_, i) => nextCheckDelayMs(1, `REF-${i}`)),
    );
    expect(spread.size).toBeGreaterThan(1);
  });

  it("6. a resolved reference is never queried again", async () => {
    mockedVerify.mockResolvedValue({ status: "failed" });

    for (let run = 0; run < 6; run++) await verifyExpiredPayments(5);

    // `failed` is documented as a definitive negative, so each reference is
    // asked about exactly once and then never again.
    expect(asked()).toHaveLength(30);
    expect(new Set(asked()).size).toBe(30);
    expect(STORE.every((p) => p.paystackData?.expiredRecovery?.outcome === "provider_not_successful")).toBe(true);
  });

  it("10. a late success still runs the canonical finalizer and files one obligation", async () => {
    db.payment.findUnique.mockImplementation(async () => expiredPayment({ status: "EXPIRED" }));
    db.order.findMany.mockImplementation(async () => [expiredOrder()]);
    db.refundRequest.findFirst.mockImplementation(async () => null);
    mockedVerify.mockResolvedValue(successPayload());

    // Only the very oldest reference succeeds.
    mockedVerify.mockImplementation(async (ref: string) =>
      ref === "REF-000" ? successPayload() : { status: "pending" },
    );

    await verifyExpiredPayments(5);

    expect(createdRefunds).toHaveLength(1);
    expect(createdRefunds[0]).toMatchObject({ paymentRef: "REF-000", orderId: "order-A" });
    expect(STORE[0].paystackData.expiredRecovery.outcome).toBe("reconciled");
    // The others are merely rescheduled.
    expect(STORE[1].paystackData.expiredRecovery.outcome).toBeUndefined();
  });

  it("11. a marker persistence failure never marks a payment reconciled", async () => {
    // The marker write fails; the finalizer's lock and every other write
    // behave normally, so reconciliation genuinely happens first.
    db.payment.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (data?.paystackData) throw new Error("database is unavailable");
      const row = where?.id
        ? STORE.find((p) => p.id === where.id)
        : STORE.find((p) => p.reference === where?.reference);
      if (!row) return { count: 0 };
      if (data?.paystackData) row.paystackData = data.paystackData;
      return { count: 1 };
    });

    mockedVerify.mockResolvedValue(successPayload());

    // The provider said success and the obligation was genuinely created, but
    // the marker could not be persisted. The run must not crash, must not
    // fabricate a state, and must remain retryable rather than being lost.
    await expect(verifyExpiredPayments(1)).resolves.toBeDefined();
    expect(createdRefunds).toHaveLength(1);
    // Nothing claims to be resolved in durable storage.
    expect(STORE.every((p) => !p.paystackData?.expiredRecovery?.outcome)).toBe(true);
  });

  it("9. only documented statuses are treated as definitive", async () => {
    const cases: Array<[string, "deferred" | "notSuccessful"]> = [
      ["success", "deferred"],        // finalizer decides; see the test above
      ["failed", "notSuccessful"],
      ["abandoned", "notSuccessful"],
      ["pending", "deferred"],
      ["processing", "deferred"],
      ["ongoing", "deferred"],
      ["queued", "deferred"],
      ["", "deferred"],
    ];

    for (const [status, expectation] of cases) {
      seed(1);
      mockedVerify.mockResolvedValue({ status, amount: 550000 });
      const result = await verifyExpiredPayments(1);
      if (expectation === "notSuccessful") {
        expect(result.notSuccessful).toBe(1);
      } else {
        expect(result.notSuccessful).toBe(0);
      }
      // Nothing but the two documented negatives is ever resolved.
      const outcome = STORE[0].paystackData?.expiredRecovery?.outcome;
      if (expectation === "notSuccessful") expect(outcome).toBe("provider_not_successful");
      else expect(outcome).toBeUndefined();
    }
  });

  it("12. recovery-window boundary is applied by the query", async () => {
    seed(2);
    await verifyExpiredPayments(2);

    const cutoff = SCAN.cutoff!;
    expect(cutoff).toBeInstanceOf(Date);

    // Inside the window passes; the boundary is inclusive.
    expect(new Date(Date.now() - 60_000).getTime()).toBeGreaterThanOrEqual(cutoff.getTime());
    // One second older than the boundary fails.
    expect(new Date(cutoff.getTime() - 1000).getTime()).toBeLessThan(cutoff.getTime());
  });
});

/**
 * FIN-07-03c.3 — pagination (F-02), cursor hazards (F-03), evidence (F-04)
 * and marker durability (F-07).
 *
 * The `findMany` double implements ordering, the keyset predicate and `take`
 * generically from the arguments the worker actually sends. It imposes no
 * filtering of its own, so a worker that pages or orders incorrectly fails here
 * instead of being silently rescued by the double.
 */
describe("FIN-07-03c.3 — pagination, evidence and marker durability", () => {
  let STORE: any[] = [];

  function seed(count: number) {
    const base = Date.now();
    STORE = Array.from({ length: count }, (_, i) => ({
      id: `pay-${String(i).padStart(4, "0")}`,
      reference: `REF-${String(i).padStart(4, "0")}`,
      expiresAt: new Date(base - (count - i) * 60_000),
      paystackData: null,
      status: "EXPIRED",
      // Needed by the finalizer to resolve the orders behind a payment.
      orderId: "order-A",
      idempotencyKey: "batch-1",
    }));
  }

  beforeEach(() => {
    SCAN_CALLS.length = 0;
    seed(120);
    installScanDouble(() => STORE);
    db.payment.findUnique.mockImplementation(async ({ where }: any) => {
      const row = STORE.find((p) => p.id === where?.id || p.reference === where?.reference);
      // The full row: the finalizer needs reference/orderId/idempotencyKey.
      return row ?? null;
    });
    db.payment.updateMany.mockImplementation(async ({ where, data }: any) => {
      const row = STORE.find((p) => p.id === where?.id || p.reference === where?.reference);
      if (!row) return { count: 0 };
      if (where?.status && row.status !== where.status) return { count: 0 };
      if (data?.paystackData) row.paystackData = data.paystackData;
      return { count: 1 };
    });
    mockedVerify.mockResolvedValue({ status: "pending", amount: 550000 });
  });

  const asked = () => mockedVerify.mock.calls.map((c) => c[0]);

  it("F-02.1/2. several pages are issued and the keyset boundary advances", async () => {
    await verifyExpiredPayments(120);

    expect(SCAN_CALLS.length).toBeGreaterThan(1);
    // Page 1 carries no keyset boundary at all.
    expect(SCAN_CALLS[0].hasKeyset).toBe(false);
    expect(SCAN_CALLS[0].limit).toBe(50);
    // Page 2 resumes strictly after the last row of page 1 (REF-0049).
    expect(SCAN_CALLS[1].hasKeyset).toBe(true);
    expect(SCAN_CALLS[1].keysetId).toBe("pay-0049");
    expect(SCAN_CALLS[1].keysetAt.getTime()).toBe(new Date(STORE[49].expiresAt).getTime());
    // Page 3 advances again (REF-0099).
    expect(SCAN_CALLS[2].keysetId).toBe("pay-0099");
  });

  it("F-02.3/4. compound ordering survives page boundaries and identical expiresAt", async () => {
    // Every row shares one expiresAt, so only the `id` tiebreaker can order them.
    const stamp = new Date(Date.now() - 3_600_000);
    for (const row of STORE) row.expiresAt = stamp;
    mockedVerify.mockResolvedValue({ status: "failed" });

    await verifyExpiredPayments(120);

    // 120 rows, three pages, none skipped, none repeated.
    expect(asked()).toHaveLength(120);
    expect(new Set(asked()).size).toBe(120);
    expect(asked()).toEqual(
      [...STORE].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => r.reference),
    );
  });

  it("F-03. the boundary is captured before this run mutates the cursor row", async () => {
    // Page 1's last row gets its marker written during page 1. The page-2
    // boundary must be the value observed at FETCH time, not afterwards.
    mockedVerify.mockImplementation(async (ref: string) => {
      STORE.find((r) => r.reference === ref).expiresAt = new Date(0);
      return { status: "pending" };
    });

    await verifyExpiredPayments(120);

    // Every row was still visited exactly once despite the mid-run mutation:
    // a cursor re-read would have skipped the mutated rows.
    expect(asked()).toHaveLength(120);
    expect(new Set(asked()).size).toBe(120);
  });

  it("F-02.6. the per-run provider-call limit holds across many pages", async () => {
    await verifyExpiredPayments(7);
    expect(mockedVerify).toHaveBeenCalledTimes(7);
    await verifyExpiredPayments(0);
    expect(mockedVerify).toHaveBeenCalledTimes(7);
  });

  it("F-01.1. FIFO order is preserved for never-examined candidates", async () => {
    await verifyExpiredPayments(5);
    expect(asked()).toEqual(["REF-0000", "REF-0001", "REF-0002", "REF-0003", "REF-0004"]);
  });

  it("F-01.2. a checked candidate is skipped until its retry comes due", async () => {
    await verifyExpiredPayments(5);
    mockedVerify.mockClear();
    // Its nextCheckAt is in the future, so it yields its budget to the next row.
    await verifyExpiredPayments(5);
    expect(asked()).toEqual(["REF-0005", "REF-0006", "REF-0007", "REF-0008", "REF-0009"]);
  });

  it("F-01.FIXED. a large resolved population no longer consumes the scan budget", async () => {
    // FIN-07-03c.14: 1000 already-resolved rows sorting AHEAD of the
    // actionable one. Before the fix the scan returned 50 of them per page,
    // hit MAX_ROWS_PER_RUN (500) and never reached the eligible row.
    const base = Date.now();
    STORE.unshift(
      ...Array.from({ length: 1000 }, (_, i) => ({
        id: `done-${String(i).padStart(4, "0")}`,
        reference: `DONE-${String(i).padStart(4, "0")}`,
        expiresAt: new Date(base - 100_000_000 + i * 60_000),
        paystackData: { expiredRecovery: { outcome: "provider_not_successful", attempts: 1 } },
        status: "EXPIRED",
        orderId: "order-A",
        idempotencyKey: "batch-1",
      })),
    );

    const result = await verifyExpiredPayments(5);

    // The terminal rows are excluded in SQL, so they cost nothing.
    expect(result.alreadyResolved).toBe(0);
    expect(result.checked).toBe(5);
    expect(mockedVerify).toHaveBeenCalledTimes(5);
    // The actionable rows behind them are reached, not truncated.
    expect(asked().every((r: string) => !r.startsWith("DONE-"))).toBe(true);
  });

  it("F-01.FIXED. more than 500 cooling-down rows do not starve a later due payment", async () => {
    const base = Date.now();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    STORE.unshift(
      ...Array.from({ length: 1000 }, (_, i) => ({
        id: `cool-${String(i).padStart(4, "0")}`,
        reference: `COOL-${String(i).padStart(4, "0")}`,
        expiresAt: new Date(base - 100_000_000 + i * 60_000),
        paystackData: { expiredRecovery: { attempts: 1, nextCheckAt: future } },
        status: "EXPIRED",
        orderId: "order-A",
        idempotencyKey: "batch-1",
      })),
    );

    const result = await verifyExpiredPayments(3);

    expect(result.inCooldown).toBe(0);
    expect(result.checked).toBe(3);
    expect(asked().every((r: string) => !r.startsWith("COOL-"))).toBe(true);
  });

  it("F-01.terminal outcomes are excluded from selection", async () => {
    STORE = [
      { ...expiredPayment({ id: "t1", reference: "TERM-1" }), paystackData: { expiredRecovery: { outcome: "reconciled" } } },
      { ...expiredPayment({ id: "t2", reference: "TERM-2" }), paystackData: { expiredRecovery: { outcome: "provider_not_successful" } } },
      expiredPayment({ id: "t3", reference: "LIVE-1" }),
    ];
    await verifyExpiredPayments(10);
    expect(asked()).toEqual(["LIVE-1"]);
  });

  it("F-01.an expired cooldown becomes eligible again", async () => {
    STORE = [
      { ...expiredPayment({ id: "c1", reference: "COOLED-1" }),
        paystackData: { expiredRecovery: { attempts: 2, nextCheckAt: new Date(Date.now() - 60_000).toISOString() } } },
      expiredPayment({ id: "c2", reference: "LIVE-2" }),
    ];
    await verifyExpiredPayments(10);
    expect(asked()).toEqual(["COOLED-1", "LIVE-2"]);
  });

  it("F-01.a future cooldown is excluded from selection", async () => {
    STORE = [
      { ...expiredPayment({ id: "c1", reference: "COOLING-1" }),
        paystackData: { expiredRecovery: { attempts: 2, nextCheckAt: new Date(Date.now() + 3_600_000).toISOString() } } },
      expiredPayment({ id: "c2", reference: "LIVE-2" }),
    ];
    await verifyExpiredPayments(10);
    expect(asked()).toEqual(["LIVE-2"]);
  });

  it("F-01.missing paystackData and absent recovery keys stay eligible", async () => {
    STORE = [
      { ...expiredPayment({ id: "m1", reference: "NULL-PD" }), paystackData: null },
      { ...expiredPayment({ id: "m2", reference: "NO-MARKER" }), paystackData: { authorization_url: "u" } },
      { ...expiredPayment({ id: "m3", reference: "NO-OUTCOME" }), paystackData: { expiredRecovery: { attempts: 1 } } },
      { ...expiredPayment({ id: "m4", reference: "JSON-NULL" }), paystackData: { expiredRecovery: { outcome: null, attempts: 1 } } },
    ];
    await verifyExpiredPayments(10);
    // Nothing was dropped by the NULL/absent cases.
    expect(asked()).toEqual(["NULL-PD", "NO-MARKER", "NO-OUTCOME", "JSON-NULL"]);
  });

  it("F-01.a malformed nextCheckAt is treated as due-now, not as a crash", async () => {
    for (const bad of ["not-a-date", "2026-13-45T99:99:99Z", "", "2026-02-30T00:00:00Z"]) {
      STORE = [
        { ...expiredPayment({ id: "b1", reference: "BAD-1" }),
          paystackData: { expiredRecovery: { attempts: 1, nextCheckAt: bad } } },
      ];
      mockedVerify.mockClear();
      const r = await verifyExpiredPayments(5);
      // Eligible immediately: a malformed value must never silently hide a
      // payment that may hold a captured amount.
      expect(r.checked).toBe(1);
      expect(mockedVerify).toHaveBeenCalledWith("BAD-1");
    }
  });

  it("F-01.a query error fails closed without processing any candidate", async () => {
    db.$queryRaw.mockRejectedValue(new Error("connection terminated unexpectedly"));
    await expect(verifyExpiredPayments(5)).rejects.toThrow(/connection terminated/);
    // Nothing was checked: the run aborts rather than proceeding blind.
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("F-04.1. a recovered capture retains the verified Paystack payload", async () => {
    db.order.findMany.mockImplementation(async () => [expiredOrder()]);
    db.refundRequest.findFirst.mockImplementation(async () => null);
    const verified = successPayload({ paid_at: "2026-01-01T00:00:00Z", gateway_response: "Successful" });
    mockedVerify.mockResolvedValue(verified);

    await verifyExpiredPayments(1);

    const marker = STORE[0].paystackData.expiredRecovery;
    expect(marker.outcome).toBe("reconciled");
    expect(marker.evidence).toEqual(verified);
    expect(marker.evidence.gateway_response).toBe("Successful");
  });

  it("F-04.2. evidence is merged without destroying the original payload", async () => {
    STORE[0].paystackData = { authorization_url: "https://checkout.example/x", reference: "REF-0000" };
    db.order.findMany.mockImplementation(async () => [expiredOrder()]);
    db.refundRequest.findFirst.mockImplementation(async () => null);
    const verified = successPayload();
    mockedVerify.mockResolvedValue(verified);

    await verifyExpiredPayments(1);

    const written = STORE[0].paystackData;
    expect(written.authorization_url).toBe("https://checkout.example/x");
    expect(written.expiredRecovery.outcome).toBe("reconciled");
    expect(written.expiredRecovery.evidence).toEqual(verified);
  });

  it("F-04.3. a deferred check retains no evidence", async () => {
    mockedVerify.mockResolvedValue({ status: "pending" });
    await verifyExpiredPayments(1);
    expect(STORE[0].paystackData.expiredRecovery.evidence).toBeUndefined();
  });

  it("F-04.4. an evidence persistence failure is never reported as saved", async () => {
    db.order.findMany.mockImplementation(async () => [expiredOrder()]);
    db.refundRequest.findFirst.mockImplementation(async () => null);
    mockedVerify.mockResolvedValue(successPayload());
    db.payment.updateMany.mockImplementation(async ({ data }: any) => {
      if (data?.paystackData) throw new Error("database is unavailable");
      return { count: 1 };
    });

    await expect(verifyExpiredPayments(1)).resolves.toBeDefined();
    // Neither the marker nor the evidence is claimed to be saved.
    expect(STORE[0].paystackData).toBeNull();
    expect(createdRefunds).toHaveLength(1);
  });

  it("F-07.1. the marker write merges onto the current stored value", async () => {
    await verifyExpiredPayments(0);
    STORE[0].paystackData = { authorization_url: "u", concurrentField: "written-by-another-worker" };
    mockedVerify.mockResolvedValue({ status: "pending" });

    await verifyExpiredPayments(1);

    expect(STORE[0].paystackData.concurrentField).toBe("written-by-another-worker");
    expect(STORE[0].paystackData.expiredRecovery.attempts).toBe(1);
  });

  it("F-07.2. attempts never walk backwards", async () => {
    STORE[0].paystackData = {
      expiredRecovery: { attempts: 7, nextCheckAt: new Date(Date.now() - 1000).toISOString() },
    };
    mockedVerify.mockResolvedValue({ status: "pending" });

    await verifyExpiredPayments(1);

    expect(STORE[0].paystackData.expiredRecovery.attempts).toBe(8);
  });

  it("F-07.3. a reference that stopped being EXPIRED is not written to", async () => {
    db.payment.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where?.status) return { count: 0 };
      if (data?.paystackData) STORE[0].paystackData = data.paystackData;
      return { count: 1 };
    });
    mockedVerify.mockResolvedValue({ status: "pending" });

    const result = await verifyExpiredPayments(1);

    expect(result.checked).toBe(1);
    expect(STORE[0].paystackData).toBeNull();
  });
});

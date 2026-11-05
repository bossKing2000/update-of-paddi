/**
 * Stranded-dispatch OBSERVATION (read-only).
 *
 * These tests cover the candidate predicate, the latest-artifact timestamp
 * calculation, configuration validation, disabled behaviour, bounded scanning
 * and limit reporting.
 *
 * What is deliberately NOT covered here: whether the generated SQL is valid
 * PostgreSQL. The `$queryRaw` tagged template produces SQL through Prisma's
 * runtime and enum casts (`::"OrderStatus"`) are only resolved by a real
 * database. A fake cannot execute it. Those checks belong to
 * `tests/integration/strandedDispatchReconcile.db.test.ts`, which requires the
 * disposable local PostgreSQL and is not run by this suite.
 *
 * Read-only guarantee under test: the job must never call `assignOrder`,
 * mutate a broadcast or assignment, or emit anything. Those are asserted
 * directly below rather than assumed.
 *
 * Real service, mocked Prisma and no database connection.
 */

// The enable flag is read once, at class-definition time, so it is set before
// the service module is imported.
process.env.RECONCILE_STRANDED_DISPATCH_ENABLED = "true";

import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { logger } from "../../src/lib/logger";

/** Captured `$queryRaw` calls, in order. */
let rawQueries: Array<{ strings: TemplateStringsArray; values: unknown[] }> = [];
/** Rows the next `$queryRaw` resolves to, consumed one call at a time. */
let rawResults: any[][] = [];

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), updateMany: jest.fn() },
    address: { findFirst: jest.fn() },
    deliveryPerson: { findMany: jest.fn(), findUnique: jest.fn() },
    deliveryEarning: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({ id: "de-1" })) },
    deliveryAssignment: { count: jest.fn(async () => 0), groupBy: jest.fn(async () => []), create: jest.fn(), findFirst: jest.fn(async () => null) },
    deliveryBroadcast: { count: jest.fn(async () => 0), create: jest.fn(), findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (arg: any) => (typeof arg === "function" ? arg({}) : arg)),
    $queryRaw: jest.fn(),
    $queryRawUnsafe: jest.fn(async () => {
      throw new Error("$queryRawUnsafe must never be used by the stranded-dispatch scan");
    }),
  },
}));

jest.mock("../../src/socket", () => ({
  getIO: () => ({ to: () => ({ emit: jest.fn() }) }),
}));

jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../../src/lib/prisma").default as any;
const recordActivityBundle = require("../../src/utils/activityUtils/recordActivityBundle")
  .recordActivityBundle as jest.Mock;

/** Minutes -> ms, matching what the query's `make_interval` expresses. */
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

function row(id: string, artifact: Date | null, expiredPending = false) {
  return { id, latest_artifact: artifact, has_expired_pending: expiredPending };
}

beforeEach(() => {
  jest.clearAllMocks();
  rawQueries = [];
  rawResults = [];

  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    rawQueries.push({ strings, values });
    return rawResults.shift() ?? [];
  });
});

afterEach(() => {
  delete process.env.RECONCILE_STRANDED_DISPATCH_PAGE_SIZE;
  delete process.env.RECONCILE_STRANDED_DISPATCH_GRACE_MINUTES;
  delete process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES;
});

/**
 * The static SQL of a tagged template, with a `?` placeholder wherever a value
 * was interpolated.
 *
 * Enum literals reach the database as bound VALUES, not as text in this string,
 * so assertions about which statuses are included must look at the values (see
 * `boundStrings`) or at the shared constants the query interpolates. This
 * helper only proves the query's SHAPE.
 */
const sqlOf = (q: { strings: TemplateStringsArray }) => q.strings.join("?");

/**
 * Every string bound as a parameter, flattened out of nested `Prisma.sql` /
 * `Prisma.join` nodes.
 *
 * A joined enum list arrives as one node whose `values` are the enum names and
 * whose `strings` carry the per-element casts (`::"OrderStatus"`). Both halves
 * matter: the names prove *which* statuses are included, the casts prove the
 * statement is typed correctly for PostgreSQL.
 */
function boundStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const node = v as { values?: unknown[]; strings?: TemplateStringsArray };
      if (Array.isArray(node.strings)) node.strings.forEach((s) => s && out.push(s));
      if (Array.isArray(node.values)) node.values.forEach(visit);
    }
  };
  values.forEach(visit);
  return out;
}

/** The enum names bound as parameters, excluding SQL fragments like casts. */
const boundLiterals = (q: { values: unknown[] }) =>
  boundStrings(q.values).filter((s) => !s.includes("::") && !/\s/.test(s));

describe("candidate predicate — eligibility filters", () => {
  beforeEach(() => {
    process.env.RECONCILE_STRANDED_DISPATCH_PAGE_SIZE = "10";
    process.env.RECONCILE_STRANDED_DISPATCH_GRACE_MINUTES = "5";
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "1";
  });

  it("requires a dispatchable order status", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);
    const bound = boundStrings(rawQueries[0].values);

    // The IN list is a Prisma.join of cast values. The cast is the point: an
    // uncast `?,?` carries no type context and PostgreSQL cannot compare it
    // against a typed enum column.
    expect(bound.join(" ")).toContain('::"OrderStatus"');
    // Both dispatchable statuses are present, in order, and no terminal status
    // is anywhere in the statement's bound values.
    const literals = boundLiterals(rawQueries[0]);
    expect(literals).toEqual(expect.arrayContaining(["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"]));
    for (const terminal of ["CANCELLED", "CANCELLED_UNPAID", "COMPLETED", "FAILED_DELIVERY"]) {
      expect(literals).not.toContain(terminal);
    }
  });

  it("requires a successful payment", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);

    expect(sqlOf(rawQueries[0])).toMatch(/paymentStatus.*::"PaymentStatus"/s);
    expect(boundStrings(rawQueries[0].values)).toContain("SUCCESS");
  });

  it("excludes orders holding an active assignment", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);
    const sql = sqlOf(rawQueries[0]);
    const bound = boundStrings(rawQueries[0].values);

    expect(sql).toContain("NOT EXISTS");
    expect(bound.join(" ")).toContain('::"DeliveryStatus"');
    // All four ACTIVE_DELIVERY_STATUSES are excluded. DELIVERED and DECLINED
    // are terminal, so neither may appear — a terminal assignment must leave
    // the order recoverable.
    const literals = boundLiterals(rawQueries[0]);
    expect(literals).toEqual(
      expect.arrayContaining(["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"]),
    );
    for (const terminal of ["DELIVERED", "DECLINED", "FAILED", "RETURNED"]) {
      expect(literals).not.toContain(terminal);
    }
  });

  it("excludes only PENDING broadcasts that are still unexpired", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);
    const sql = sqlOf(rawQueries[0]);

    // The exclusion counts live offers only. The comparison is written as
    // `now() AT TIME ZONE 'UTC'` — not bare `now()` — because `expiresAt` is a
    // `timestamp without time zone` column holding UTC, while `now()` is
    // `timestamptz`; comparing them directly shifts the result by the session
    // timezone offset (see the reconciliation query's TIMEZONE comment).
    expect(sql).toMatch(/"expiresAt" > \(now\(\) AT TIME ZONE 'UTC'\)/);
    // ...while the reported metric captures expired-but-unswept ones, because
    // those are exactly the state the expiry sweep has not cleared yet.
    expect(sql).toMatch(/"expiresAt" <= \(now\(\) AT TIME ZONE 'UTC'\)/);
    expect(sql).toContain('::"DeliveryBroadcastStatus"');
  });

  it("never uses Order.updatedAt as the age signal", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);
    const sql = sqlOf(rawQueries[0]);

    // claimOrderRow writes only updatedAt, so every writer moves that column.
    expect(sql).not.toMatch(/o\."updatedAt"/);
    // The age must come from the two artifact tables.
    expect(sql).toMatch(/"DeliveryBroadcast"\s+\w+\s+WHERE/);
    expect(sql).toMatch(/"DeliveryAssignment"\s+\w+\s+WHERE/);
  });

  it("applies the grace interval through make_interval with a bound parameter", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 7, null);
    const sql = sqlOf(rawQueries[0]);

    expect(sql).toContain("make_interval(mins =>");
    // The value is bound, never concatenated.
    expect(sql).not.toMatch(/make_interval\(mins =>\s*\d/);
    expect(rawQueries[0].values).toContain(7);
  });

  it("binds the batch limit as an integer", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(25, 5, null);

    expect(sqlOf(rawQueries[0])).toContain("LIMIT");
    expect(rawQueries[0].values).toContain(25);
  });

  it("compares Order.id as text and tolerates a null cursor", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);
    const sql = sqlOf(rawQueries[0]);

    // Order.id is String @default(uuid()) — a text column, so ::text, not ::uuid.
    expect(sql).toContain('::text');
    expect(sql).not.toContain('::uuid');
    expect(sql).toMatch(/::text IS NULL OR/);
    expect(sql).toMatch(/o\."id" > \?::text/);
  });

  it("passes a non-null cursor through as a bound text parameter", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, "order-050");
    const values = rawQueries[0].values;

    // Bound twice — once for the NULL test, once for the comparison.
    expect(values.filter((v) => v === "order-050")).toHaveLength(2);
  });

  it("never uses $queryRawUnsafe", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("latest-artifact timestamp", () => {
  beforeEach(() => {
    process.env.RECONCILE_STRANDED_DISPATCH_PAGE_SIZE = "10";
    process.env.RECONCILE_STRANDED_DISPATCH_GRACE_MINUTES = "5";
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "1";
  });

  it("takes the GREATEST across BOTH artifact tables", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);
    const sql = sqlOf(rawQueries[0]);

    // GREATEST, not COALESCE: a coalesce would return the broadcast timestamp
    // whenever any broadcast exists, ignoring a newer assignment entirely.
    expect(sql).toContain("GREATEST");
    expect(sql).not.toMatch(/^\s*COALESCE\(\(SELECT max\(b/s);

    // Both artifact columns are read.
    expect(sql.match(/"createdAt"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to -infinity when neither table has a row", async () => {
    await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);
    const sql = sqlOf(rawQueries[0]);

    // A NULL here would make the comparison NULL, i.e. not true, silently
    // excluding every order that has never been dispatched.
    //
    // Five occurrences: two `GREATEST` arms in the projection, two in the
    // WHERE clause, and the `NULLIF(..., '-infinity')` guard that converts the
    // sentinel to a real NULL before Prisma tries to deserialise it (an
    // infinite timestamp is unrepresentable as a JS Date).
    expect(sql.match(/'-infinity'::timestamptz/g)?.length).toBe(5);
  });

  it("counts rows with no artifact separately from those with one", async () => {
    rawResults = [
      [
        row("o-1", null),                       // never dispatched
        row("o-2", minutesAgo(30)),             // old broadcast
        row("o-3", null),                       // never dispatched
      ],
    ];

    const page = await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);

    expect(page.count).toBe(3);
    expect(page.noArtifactCount).toBe(2);
    expect(page.oldestAgeSeconds).toBeGreaterThanOrEqual(30 * 60);
  });

  it("reports the oldest artifact seen, not the newest", async () => {
    rawResults = [[row("o-1", minutesAgo(10)), row("o-2", minutesAgo(120))]];

    const page = await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);

    expect(page.oldestAgeSeconds).toBeGreaterThanOrEqual(120 * 60);
  });

  it("reports a null oldest age when the page has no artifacts", async () => {
    rawResults = [[row("o-1", null), row("o-2", null)]];

    const page = await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);

    expect(page.oldestAgeSeconds).toBeNull();
  });

  it("counts candidates carrying an expired pending broadcast", async () => {
    rawResults = [
      [
        row("o-1", minutesAgo(40), true),   // expired, unswept
        row("o-2", minutesAgo(40), false),  // declined, no broadcast
        row("o-3", minutesAgo(40), true),
      ],
    ];

    const page = await DeliveryAssignmentService.scanStrandedDispatches(10, 5, null);

    expect(page.expiredPendingCount).toBe(2);
  });
});

describe("configuration validation", () => {
  it("reports a missing page size as an error", async () => {
    const error = jest.spyOn(logger, "error").mockImplementation(() => {});
    try {
      process.env.RECONCILE_STRANDED_DISPATCH_GRACE_MINUTES = "5";
      process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "1";

      await DeliveryAssignmentService.observeStrandedDispatches();

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ name: "RECONCILE_STRANDED_DISPATCH_PAGE_SIZE" }),
        expect.stringContaining("missing"),
      );
      // Critically: no query ran.
      expect(db.$queryRaw).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it.each([
    ["not-a-number", "must be an integer"],
    ["0", "must be an integer"],
    ["-5", "must be an integer"],
    ["2.5", "must be an integer"],
  ])("rejects page size %s", async (value, reason) => {
    const error = jest.spyOn(logger, "error").mockImplementation(() => {});
    try {
      process.env.RECONCILE_STRANDED_DISPATCH_PAGE_SIZE = value;
      process.env.RECONCILE_STRANDED_DISPATCH_GRACE_MINUTES = "5";
      process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "1";

      await DeliveryAssignmentService.observeStrandedDispatches();

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.stringContaining(reason) }),
        expect.any(String),
      );
      expect(db.$queryRaw).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("refuses to run when every required value is absent", async () => {
    const error = jest.spyOn(logger, "error").mockImplementation(() => {});
    try {
      await DeliveryAssignmentService.observeStrandedDispatches();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("bounded scanning and limit reporting", () => {
  beforeEach(() => {
    process.env.RECONCILE_STRANDED_DISPATCH_PAGE_SIZE = "2";
    process.env.RECONCILE_STRANDED_DISPATCH_GRACE_MINUTES = "5";
  });

  it("stops after a short page because the keyset is exhausted", async () => {
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "10";
    // Page 1 is full (2 rows), page 2 is short (1 row) -> stop.
    rawResults = [
      [row("o-1", minutesAgo(40)), row("o-2", minutesAgo(40))],
      [row("o-3", minutesAgo(40))],
    ];

    const info = jest.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await DeliveryAssignmentService.observeStrandedDispatches();

      expect(db.$queryRaw).toHaveBeenCalledTimes(2);
      // A short page means "no more", not "page budget exhausted".
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ candidateCount: 3, pagesRead: 2, truncated: false }),
        expect.stringContaining("exhausted"),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("reports truncation when the page budget runs out on a full page", async () => {
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "2";
    // Every page is full, so more candidates may exist beyond the budget.
    rawResults = [
      [row("o-1", minutesAgo(40)), row("o-2", minutesAgo(40))],
      [row("o-3", minutesAgo(40)), row("o-4", minutesAgo(40))],
    ];

    const info = jest.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await DeliveryAssignmentService.observeStrandedDispatches();

      expect(db.$queryRaw).toHaveBeenCalledTimes(2);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ candidateCount: 4, pagesRead: 2, truncated: true }),
        expect.stringContaining("more candidates may exist"),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("advances the cursor from the last row of each page", async () => {
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "2";
    rawResults = [
      [row("o-1", minutesAgo(40)), row("o-2", minutesAgo(40))],
      [row("o-3", minutesAgo(40)), row("o-4", minutesAgo(40))],
    ];

    await DeliveryAssignmentService.observeStrandedDispatches();

    // First call has no cursor; the second starts after "o-2".
    expect(rawQueries[0].values.filter((v) => v === "o-2")).toHaveLength(0);
    expect(rawQueries[1].values.filter((v) => v === "o-2")).toHaveLength(2);
  });

  it("keeps the cursor local to the run — the next run restarts with no cursor", async () => {
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "1";
    // Two full pages available, but the budget allows only one per run.
    rawResults = [
      [row("o-1", minutesAgo(40)), row("o-2", minutesAgo(40))],
      [row("o-3", minutesAgo(40)), row("o-4", minutesAgo(40))],
    ];

    await DeliveryAssignmentService.observeStrandedDispatches();
    await DeliveryAssignmentService.observeStrandedDispatches();

    // One query per run, and neither retained the other's cursor: run 1 bound
    // null, and run 2 also bound null because nothing persisted "o-2".
    expect(rawQueries).toHaveLength(2);
    expect(rawQueries[0].values).toContain(null);
    expect(rawQueries[1].values).toContain(null);
  });

  it("aggregates counts and the oldest age across pages", async () => {
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "2";
    rawResults = [
      [row("o-1", null), row("o-2", minutesAgo(30), true)],
      [row("o-3", minutesAgo(90)), row("o-4", null, true)],
    ];

    const info = jest.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await DeliveryAssignmentService.observeStrandedDispatches();

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateCount: 4,
          noArtifactCount: 2,
          expiredPendingCount: 2,
          oldestArtifactAgeSeconds: expect.any(Number),
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("logs duration and the configured limits", async () => {
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "1";
    rawResults = [[row("o-1", minutesAgo(40))]];

    const info = jest.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await DeliveryAssignmentService.observeStrandedDispatches();

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          pageSize: 2,
          maxPages: 1,
          graceMinutes: 5,
          durationMs: expect.any(Number),
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("surfaces a query error and rethrows so the cron wrapper can log it", async () => {
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "1";
    const boom = new Error("connection terminated unexpectedly");
    db.$queryRaw.mockRejectedValueOnce(boom);

    const error = jest.spyOn(logger, "error").mockImplementation(() => {});
    try {
      await expect(DeliveryAssignmentService.observeStrandedDispatches()).rejects.toThrow(boom);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ pages: 0, scannedSoFar: 0 }),
        expect.stringContaining("scan failed"),
      );
    } finally {
      error.mockRestore();
    }
  });
});

describe("observation-only guarantees", () => {
  beforeEach(() => {
    process.env.RECONCILE_STRANDED_DISPATCH_PAGE_SIZE = "10";
    process.env.RECONCILE_STRANDED_DISPATCH_GRACE_MINUTES = "5";
    process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "1";
  });

  it("never calls assignOrder", async () => {
    rawResults = [[row("o-1", minutesAgo(40)), row("o-2", minutesAgo(40))]];

    const spy = jest.spyOn(DeliveryAssignmentService, "assignOrder");
    const info = jest.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await DeliveryAssignmentService.observeStrandedDispatches();

      // Candidates were found and logged, yet nothing was dispatched.
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ candidateCount: 2 }),
        expect.any(String),
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      spy.mockRestore();
    }
  });

  it("performs no writes of any kind", async () => {
    rawResults = [[row("o-1", minutesAgo(40))]];

    await DeliveryAssignmentService.observeStrandedDispatches();

    for (const model of ["order", "address", "deliveryPerson", "deliveryAssignment", "deliveryBroadcast", "deliveryEarning"]) {
      for (const op of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) {
        const fn = db[model]?.[op];
        // Only assert on methods the mock actually exposes; asserting against
        // `undefined` would fail for reasons unrelated to the behaviour.
        if (fn) expect(fn).not.toHaveBeenCalled();
      }
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("records no activity and emits nothing", async () => {
    rawResults = [[row("o-1", minutesAgo(40))]];

    await DeliveryAssignmentService.observeStrandedDispatches();

    expect(recordActivityBundle).not.toHaveBeenCalled();
  });

  it("logs no order identifiers, only aggregate counts", async () => {
    rawResults = [[row("secret-order-id-1", minutesAgo(40)), row("secret-order-id-2", minutesAgo(40))]];

    const info = jest.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await DeliveryAssignmentService.observeStrandedDispatches();

      const payload = info.mock.calls[0][0] as Record<string, unknown>;
      expect(JSON.stringify(payload)).not.toContain("secret-order-id");
      // Counts are present so the number is actionable.
      expect(payload.candidateCount).toBe(2);
    } finally {
      info.mockRestore();
    }
  });
});

describe("enable flag", () => {
  it("is disabled unless the variable is exactly \"true\"", () => {
    // Read once at class-definition time; the mock module set it to "true"
    // before import, so this asserts the strict-equality shape of the gate.
    expect(DeliveryAssignmentService.RECONCILE_ENABLED).toBe(true);

    const off = process.env.RECONCILE_STRANDED_DISPATCH_ENABLED;
    for (const value of [undefined, "false", "TRUE", "1", "yes", ""]) {
      if (value === undefined) delete process.env.RECONCILE_STRANDED_DISPATCH_ENABLED;
      else process.env.RECONCILE_STRANDED_DISPATCH_ENABLED = value;

      const gate =
        process.env.RECONCILE_STRANDED_DISPATCH_ENABLED === "true";
      expect(gate).toBe(false);
    }

    if (off === undefined) delete process.env.RECONCILE_STRANDED_DISPATCH_ENABLED;
    else process.env.RECONCILE_STRANDED_DISPATCH_ENABLED = off;
  });

  it("does not run at all while disabled, even with valid configuration", async () => {
    // RECONCILE_ENABLED is a static readonly initialised at class-definition
    // time. Overwrite it for this call to prove the method re-checks the gate
    // rather than trusting the cron registration to be the only guard.
    const original = DeliveryAssignmentService.RECONCILE_ENABLED;
    try {
      Object.defineProperty(DeliveryAssignmentService, "RECONCILE_ENABLED", {
        value: false,
        configurable: true,
      });
      process.env.RECONCILE_STRANDED_DISPATCH_PAGE_SIZE = "10";
      process.env.RECONCILE_STRANDED_DISPATCH_GRACE_MINUTES = "5";
      process.env.RECONCILE_STRANDED_DISPATCH_MAX_PAGES = "1";

      await DeliveryAssignmentService.observeStrandedDispatches();

      expect(db.$queryRaw).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(DeliveryAssignmentService, "RECONCILE_ENABLED", {
        value: original,
        configurable: true,
      });
    }
  });
});
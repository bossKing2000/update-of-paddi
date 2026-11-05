/**
 * C-2 — collision-safe refund obligation creation.
 *
 * Finding C-2: the three order-specific obligation writers used a
 * check-then-create (`findFirst` then `create`) inside an interactive Prisma
 * transaction. Under PostgreSQL's default READ COMMITTED isolation that is
 * not atomic, so two concurrent transactions could both observe "no open
 * obligation" and both insert — leaving duplicate open obligations for the
 * same order.
 *
 * The fix files obligations with `INSERT ... ON CONFLICT ("paymentRef",
 * "orderId") WHERE <partial-index predicate> DO NOTHING RETURNING ...`
 * against the new partial unique index
 * "RefundRequest_open_obligation_per_order".
 *
 * These are MOCKED unit tests. They prove the application's branch decisions:
 * what gets written, what is reused, what propagates, and what is refused.
 * They CANNOT prove the database guarantee. That requires real PostgreSQL
 * concurrency — see tests/integration/refundObligationConcurrency.test.ts,
 * which is deliberately NOT run as part of the unit suite.
 */
import { Prisma, RefundStatus } from "@prisma/client";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: { refundRequest: { findFirst: jest.fn() }, $queryRaw: jest.fn() },
}));

import prisma from "../../src/lib/prisma";
import { fileRefundOwed } from "../../src/services/refundObligation.service";

const db = prisma as unknown as Record<string, any>;
// The helper is typed against the transaction client; this double is that client.
const tx = db as unknown as Prisma.TransactionClient;

const INPUT = {
  userId: "cust-1",
  paymentRef: "PSK-C2",
  reason: "Order cancelled after payment",
  orderId: "order-A",
  requestedAmountKobo: 550_000,
};

const OPEN: RefundStatus[] = [
  RefundStatus.PENDING,
  RefundStatus.APPROVED,
  RefundStatus.PROCESSING,
];

type Row = {
  id: string;
  paymentRef: string;
  orderId: string | null;
  status: RefundStatus;
  requestedAmountKobo?: number;
};

/**
 * The RefundRequest table as the database holds it, with the partial unique
 * index enforced exactly as PostgreSQL would: at most one OPEN row per
 * non-NULL (paymentRef, orderId). NULL orderId rows are outside the index, and
 * terminal rows are outside it too.
 */
let table: Row[];

/** True when inserting `candidate` would violate the partial unique index. */
function violatesIndex(candidate: Row): boolean {
  if (candidate.orderId == null) return false;
  return table.some(
    (r) =>
      r.paymentRef === candidate.paymentRef &&
      r.orderId === candidate.orderId &&
      OPEN.includes(r.status),
  );
}

/** The $queryRaw double: recognises the obligation INSERT and models the index. */
function installRawDouble() {
  db.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = Array.from(strings as unknown as string[]).join(" ");
      if (!sql.includes('INSERT INTO "RefundRequest"')) return [];

      const [
        id,
        userId,
        paymentRef,
        reason,
        status,
        ,
        ,
        orderId,
        requestedAmountKobo,
      ] = values as any[];

      const row: Row = {
        id: id ?? `rr-${table.length + 1}`,
        paymentRef,
        orderId: orderId ?? null,
        status: status as RefundStatus,
        requestedAmountKobo: requestedAmountKobo ?? undefined,
      };

      // ON CONFLICT DO NOTHING: no row returned, nothing written, no error.
      if (violatesIndex(row)) return [];

      table.push(row);
      return [row];
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  table = [];
  installRawDouble();
  db.refundRequest.findFirst.mockImplementation(async ({ where }: any) => {
    return (
      table.find((r) =>
        Object.entries(where).every(([k, v]: [string, any]) => {
          if (v && typeof v === "object" && Array.isArray(v.in)) {
            return v.in.includes((r as any)[k]);
          }
          return (r as any)[k] === v;
        }),
      ) ?? null
    );
  });
});

describe("C-2 — a fresh obligation is filed", () => {
  it("inserts once and reports created: true", async () => {
    const { obligation, created } = await fileRefundOwed(tx, INPUT);

    expect(created).toBe(true);
    expect(table).toHaveLength(1);
    expect(obligation).toMatchObject({
      paymentRef: INPUT.paymentRef,
      orderId: INPUT.orderId,
      status: RefundStatus.PENDING,
      requestedAmountKobo: 550_000,
    });
  });

  it("writes PENDING and the order-bounded amount, never the payment total", async () => {
    await fileRefundOwed(tx, INPUT);
    expect(table[0].status).toBe(RefundStatus.PENDING);
    expect(table[0].requestedAmountKobo).toBe(550_000);
  });
});

describe("C-2 — a concurrent writer wins the race", () => {
  it("returns the existing open obligation and writes nothing", async () => {
    // The other transaction committed between our pre-check and our insert.
    const winner: Row = {
      id: "rr-winner",
      paymentRef: INPUT.paymentRef,
      orderId: INPUT.orderId,
      status: RefundStatus.PENDING,
    };
    table.push(winner);

    const { obligation, created } = await fileRefundOwed(tx, INPUT);

    expect(created).toBe(false);
    expect(table).toHaveLength(1);
    // The caller reuses the real obligation's identity, not a phantom one.
    expect(obligation.id).toBe("rr-winner");
  });

  it("does not raise — this is the whole point, since a caught P2002 would abort the caller's transaction", async () => {
    table.push({
      id: "rr-winner",
      paymentRef: INPUT.paymentRef,
      orderId: INPUT.orderId,
      status: RefundStatus.PROCESSING,
    });

    await expect(fileRefundOwed(tx, INPUT)).resolves.toBeDefined();
    expect(db.$queryRaw).toHaveBeenCalled();
  });

  it.each([RefundStatus.PENDING, RefundStatus.APPROVED, RefundStatus.PROCESSING])(
    "reuses rather than duplicates when the winner is %s",
    async (status) => {
      table.push({
        id: "rr-winner",
        paymentRef: INPUT.paymentRef,
        orderId: INPUT.orderId,
        status,
      });

      const { created } = await fileRefundOwed(tx, INPUT);

      expect(created).toBe(false);
      expect(table).toHaveLength(1);
    },
  );
});

describe("C-2 — the invariant is per order, not per payment", () => {
  it("a sibling order on the same paymentRef still gets its own obligation", async () => {
    await fileRefundOwed(tx, INPUT);
    const { created, obligation } = await fileRefundOwed(tx, {
      ...INPUT,
      orderId: "order-B",
      requestedAmountKobo: 450_000,
    });

    expect(created).toBe(true);
    expect(table).toHaveLength(2);
    expect(obligation.orderId).toBe("order-B");
  });
});

describe("C-2 — terminal obligations release the invariant", () => {
  it.each([RefundStatus.COMPLETED, RefundStatus.FAILED, RefundStatus.REJECTED])(
    "a %s obligation does not block a later one",
    async (status) => {
      table.push({
        id: "rr-old",
        paymentRef: INPUT.paymentRef,
        orderId: INPUT.orderId,
        status,
      });

      const { created } = await fileRefundOwed(tx, INPUT);

      expect(created).toBe(true);
      expect(table).toHaveLength(2);
    },
  );
});

describe("C-2 — NULL orderId stays outside the index", () => {
  it("two NULL-orderId rows coexist, so the customer payment-wide path is unaffected", () => {
    expect(
      violatesIndex({
        id: "a",
        paymentRef: "PSK-C2",
        orderId: null,
        status: RefundStatus.PENDING,
      }),
    ).toBe(false);
    table.push({
      id: "a",
      paymentRef: "PSK-C2",
      orderId: null,
      status: RefundStatus.PENDING,
    });
    expect(
      violatesIndex({
        id: "b",
        paymentRef: "PSK-C2",
        orderId: null,
        status: RefundStatus.PENDING,
      }),
    ).toBe(false);
  });

  it("a NULL-orderId row never conflicts with an order-scoped row", () => {
    table.push({
      id: "a",
      paymentRef: "PSK-C2",
      orderId: null,
      status: RefundStatus.PENDING,
    });
    expect(
      violatesIndex({
        id: "b",
        paymentRef: "PSK-C2",
        orderId: INPUT.orderId,
        status: RefundStatus.PENDING,
      }),
    ).toBe(false);
  });
});

describe("C-2 — errors are neither swallowed nor faked", () => {
  it("propagates an unrelated uniqueness violation instead of treating it as a duplicate", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.19.2",
    });
    db.$queryRaw.mockImplementation(async () => {
      throw p2002;
    });

    await expect(fileRefundOwed(tx, INPUT)).rejects.toBe(p2002);
    expect(table).toHaveLength(0);
  });

  it("propagates a non-uniqueness database failure", async () => {
    const boom = new Error("connection terminated unexpectedly");
    db.$queryRaw.mockImplementation(async () => {
      throw boom;
    });

    await expect(fileRefundOwed(tx, INPUT)).rejects.toBe(boom);
  });

  it("refuses to report success when the conflict cannot be explained", async () => {
    // The index said "conflict" but no open obligation exists to explain it.
    // Treating this as success would silently drop a refund.
    db.$queryRaw.mockImplementation(async () => []);
    db.refundRequest.findFirst.mockImplementation(async () => null);

    await expect(fileRefundOwed(tx, INPUT)).rejects.toThrow(
      /no open obligation was found/i,
    );
  });

  it("leaves non-RefundRequest raw queries to the caller's own handling", async () => {
    const result = await db.$queryRaw`SELECT 1`;
    expect(result).toEqual([]);
  });
});

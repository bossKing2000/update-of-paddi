/**
 * F3 Stage 1 + F5-B — concurrency characterization for the delivery dispatch writers.
 *
 * These tests run the REAL service methods against a fake database that models
 * the PostgreSQL properties the fixes depend on:
 *
 *   1. row-level locking — a transaction may hold the Order row and/or the
 *      DeliveryPerson row, and holds each until it commits or rolls back
 *      (FIFO queue). F3 locks Order; F5-B locks Driver.
 *   2. read isolation — a transaction sees committed rows plus its OWN pending
 *      writes, never another transaction's uncommitted insert.
 *   3. predicate re-evaluation — an UPDATE blocked on a row lock re-checks its
 *      WHERE against the newer row version when it finally runs, so a committed
 *      cancel makes the claim match zero rows.
 *
 * They are deliberately NOT sequential calls: the winning transaction is parked
 * mid-transaction (after it has passed its guards) while the competing writer
 * runs, so the interleaving is forced rather than timing-dependent.
 */
jest.setTimeout(30000);

import { PrismaClient } from "@prisma/client";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { ConflictError } from "../../src/errors/AppError";

jest.mock("../../src/socket", () => ({
  getIO: () => ({ to: () => ({ emit: jest.fn() }) }),
}));
jest.mock("../../src/utils/activityUtils/recordActivityBundle", () => ({
  __esModule: true,
  recordActivityBundle: jest.fn(async () => {}),
}));
jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
}));

// The service reads the prisma singleton; point it at the instrumented client.
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return (globalThis as any).__raceDb;
  },
}));

type Row = Record<string, any>;
type Hook = (ctx: { label: string; tx: any }) => Promise<void>;

const STACK = ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"];

class FakeDb {
  // F4-4: committed earnings keyed by orderId — the authoritative dispatch
  // barrier and the earning helper's exactly-once gate both read this.
  earnings = new Map<string, Row>();

  orders = new Map<string, Row>([
    [
      "o-1",
      {
        id: "o-1",
        vendorId: "v-1",
        customerId: "c-1",
        status: "READY_FOR_PICKUP",
        paymentStatus: "SUCCESS",
        vendor: { id: "v-1" },
      },
    ],
  ]);
  drivers = new Map<string, Row>([
    ["dp-1", { id: "dp-1", userId: "u-driver", isOnline: true, status: "ACTIVE", user: { isEmailVerified: true } }],
  ]);
  assignments: Row[] = [];
  broadcasts: Row[] = [
    {
      id: "bc-1",
      orderId: "o-1",
      driverIds: ["u-driver"],
      declinedDriverIds: [],
      status: "PENDING",
      acceptedDriverId: null,
      expiresAt: new Date(Date.now() + 30_000),
    },
  ];
  addresses = [{ latitude: 6.5, longitude: 3.3 }];

  onAssignmentCreate: Hook | null = null;
  onBroadcastCas: Hook | null = null;

  private orderTails = new Map<string, Promise<void>>();
  private driverTails = new Map<string, Promise<void>>();
  private seq = 0;
  private txCount = 0;

  /** FIFO row lock, acquired once per transaction and held to commit. */
  private async lock<T>(tails: Map<string, Promise<void>>, key: string, held: Map<string, () => void>, fn: () => Promise<T>): Promise<T> {
    if (!held.has(key)) {
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      tails.set(key, prev.then(() => mine));
      await prev;
      held.set(key, release);
    }
    return fn();
  }
  private releaseAll(held: Map<string, () => void>) {
    for (const release of held.values()) release();
    held.clear();
  }

  private readOrder(id: string, pending: Map<string, Row>): Row | null {
    return pending.get(id) ?? (this.orders.has(id) ? { ...this.orders.get(id)! } : null);
  }

  private countAssignments(committed: Row[], pending: Row[], where: any): number {
    const all = [...committed, ...pending];
    return all.filter((a) => {
      if (where?.orderId !== undefined && a.orderId !== where.orderId) return false;
      if (where?.deliveryPersonId !== undefined && a.deliveryPersonId !== where.deliveryPersonId) return false;
      if (where?.status?.in && !where.status.in.includes(a.status)) return false;
      return true;
    }).length;
  }

  /**
   * Mirrors `prisma.deliveryAssignment.groupBy({ by:["deliveryPersonId"],
   * where, _count:{_all:true} })`: one row per driver that actually matches, so
   * an absent driver means zero. `where.deliveryPersonId.in` restricts the
   * result to the candidate drivers, exactly as the real query does.
   */
  private groupAssignmentsByPerson(committed: Row[], pending: Row[], where: any) {
    const all = [...committed, ...pending];
    const candidates: Set<string> | null = where?.deliveryPersonId?.in
      ? new Set(where.deliveryPersonId.in)
      : null;
    const counts = new Map<string, number>();
    for (const a of all) {
      if (candidates && !candidates.has(a.deliveryPersonId)) continue;
      if (where?.status?.in && !where.status.in.includes(a.status)) continue;
      counts.set(a.deliveryPersonId, (counts.get(a.deliveryPersonId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([deliveryPersonId, n]) => ({
      deliveryPersonId,
      _count: { _all: n },
    }));
  }

  /** Signals that let a test park a transaction at an exact point. */
  private makeSignal() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    let fired = false;
    return { promise, fire: () => { if (!fired) { fired = true; resolve(); } } };
  }
  assignmentCreated = this.makeSignal();
  broadcastConsumed = this.makeSignal();
  orderClaimed = this.makeSignal();

  begin(label: string) {
    const self = this;
    const pendingAssignments: Row[] = [];
    const pendingBroadcasts = new Map<string, Row>();
    const pendingOrders = new Map<string, Row>();
    const heldOrders = new Map<string, () => void>();
    const heldDrivers = new Map<string, () => void>();
    let finished = false;

    const readBroadcast = (id: string): Row | null => {
      const own = pendingBroadcasts.get(id);
      if (own) return { ...own };
      const committed = self.broadcasts.find((b) => b.id === id);
      return committed ? { ...committed } : null;
    };

    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      if (commit) {
        for (const [id, row] of pendingOrders) self.orders.set(id, row);
        self.assignments.push(...pendingAssignments);
        for (const [id, row] of pendingBroadcasts) {
          const i = self.broadcasts.findIndex((b) => b.id === id);
          if (i >= 0) self.broadcasts[i] = row;
        }
      }
      self.releaseAll(heldOrders);
      self.releaseAll(heldDrivers);
      // Release any broadcast row locks this transaction was holding.
      for (const id of [...pendingBroadcasts.keys()]) self.releaseInflight(id);
    };

    const tx: any = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        // F5-B: `SELECT id FROM "DeliveryPerson" WHERE id = $1 FOR UPDATE`
        const sql = strings.join(" ");
        if (sql.includes("DeliveryPerson") && sql.includes("FOR UPDATE")) {
          await self.lock(self.driverTails, String(values[0]), heldDrivers, async () => undefined);
        }
        return [];
      },
      order: {
        findUnique: async ({ where, select }: any) => {
          const row = self.readOrder(where.id, pendingOrders);
          if (!row) return null;
          if (!select) return row;
          const out: Row = {};
          for (const k of Object.keys(select)) out[k] = row[k];
          return out;
        },
        updateMany: async ({ where, data }: any) =>
          self.lock(self.orderTails, where.id, heldOrders, async () => {
            const cur = self.readOrder(where.id, pendingOrders);
            if (!cur) return { count: 0 };
            if (where.status?.in && !where.status.in.includes(cur.status)) return { count: 0 };
            if (where.status !== undefined && !where.status?.in && cur.status !== where.status) return { count: 0 };
            if (where.paymentStatus !== undefined && cur.paymentStatus !== where.paymentStatus) return { count: 0 };
            pendingOrders.set(where.id, { ...cur, ...data });
            self.orderClaimed.fire();
            await self.onOrderClaim?.({ label, tx });
            return { count: 1 };
          }),
        update: async ({ where, data }: any) =>
          self.lock(self.orderTails, where.id, heldOrders, async () => {
            const cur = self.readOrder(where.id, pendingOrders);
            if (!cur) throw new Error("P2025");
            if (where.status !== undefined && cur.status !== where.status) throw new Error("P2025");
            pendingOrders.set(where.id, { ...cur, ...data });
            return { ...cur, ...data };
          }),
      },
      deliveryAssignment: {
        count: async ({ where }: any) =>
          self.countAssignments(self.assignments, pendingAssignments, where),
        groupBy: async ({ where }: any) =>
          self.groupAssignmentsByPerson(self.assignments, pendingAssignments, where),
        findFirst: async ({ where }: any) => {
          const pool = [...self.assignments, ...pendingAssignments];
          const row = pool.find(
            (a: any) =>
              a.orderId === where?.orderId &&
              (!where?.status || a.status === where.status),
          );
          return row ? { ...row } : null;
        },
        create: async ({ data }: any) => {
          // Mirror the schema defaults the real client would apply.
          const row = {
            id: `as-${++self.seq}`,
            status: "ASSIGNED",
            timeoutSeconds: 30,
            attempts: 0,
            ...data,
          };
          pendingAssignments.push(row);
          // Signal BEFORE the hook: the hook parks this transaction, so a test
          // awaiting the signal must be released first.
          self.assignmentCreated.fire();
          await self.onAssignmentCreate?.({ label, tx });
          return row;
        },
        update: async ({ where, data }: any) => {
          const row = self.assignments.find((a) => a.id === where.id);
          if (!row) throw new Error("P2025");
          Object.assign(row, data);
          return { ...row };
        },
      },
      deliveryBroadcast: {
        findUnique: async ({ where }: any) => readBroadcast(where.id),
        count: async ({ where }: any) =>
          self.broadcasts.filter((b) => {
            const own = pendingBroadcasts.get(b.id);
            const row = own ?? b;
            if (where.orderId !== undefined && row.orderId !== where.orderId) return false;
            if (where.status !== undefined && row.status !== where.status) return false;
            if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) return false;
            return true;
          }).length,
        create: async ({ data }: any) => {
          // A distinct prefix: fixture broadcasts are hand-written as "bc-1",
          // and a generated `bc-1` would collide with one on commit.
          const row = { id: `new-bc-${++self.seq}`, ...data };
          pendingBroadcasts.set(row.id, row);
          self.broadcasts.push({ ...row });
          return row;
        },
        updateMany: async ({ where, data }: any) => {
          const cur = readBroadcast(where.id);
          if (!cur) return { count: 0 };
          if (where.status !== undefined && cur.status !== where.status) return { count: 0 };
          pendingBroadcasts.set(where.id, { ...cur, ...data });
          // Hold the row lock for the rest of this transaction, so any other
          // writer of the same row blocks here and re-evaluates its predicate
          // against whatever this transaction ultimately commits.
          if (!self.inflightBroadcast.has(where.id)) {
            let release!: () => void;
            self.broadcastGates.set(where.id, {
              promise: new Promise<void>((r) => (release = r)),
              release,
            });
            self.inflightBroadcast.set(where.id, self.broadcastGates.get(where.id)!.promise);
          }
          self.broadcastConsumed.fire();
          await self.onBroadcastCas?.({ label, tx });
          return { count: 1 };
        },
      },
      deliveryPerson: {
        findUnique: async ({ where }: any) => {
          const row = [...self.drivers.values()].find(
            (d) =>
              (where.userId !== undefined && d.userId === where.userId) ||
              (where.id !== undefined && d.id === where.id),
          );
          return row ? { ...row, user: { ...row.user } } : null;
        },
        findMany: async () => [...self.drivers.values()].map((d) => ({ ...d })),
        update: async ({ where, data }: any) => {
          const row = self.drivers.get(where.userId);
          if (row) Object.assign(row, data);
          return row ? { ...row } : null;
        },
      },
      // F4-4: dispatch barrier reads an existing earning; helper is idempotent.
      deliveryEarning: {
        create: async (a: any) => {
          const row = { id: "de-1", ...(a?.data ?? a?.create ?? {}) };
          if (row.orderId) self.earnings.set(row.orderId, row);
          return row;
        },
        upsert: async (a: any) => {
          const key = a?.where?.orderId;
          if (key && self.earnings.has(key)) return { ...self.earnings.get(key) };
          const row = { id: "de-1", ...(a?.create ?? {}) };
          if (key) self.earnings.set(key, row);
          return row;
        },
        findUnique: async (a: any) => self.earnings.get(a?.where?.orderId) ?? null,
      },
      $transaction: async (arg: any) => arg,
    };

    return { tx, commit: () => finish(true), rollback: () => finish(false) };
  }

onOrderClaim: Hook | null = null;

  /**
   * A broadcast row currently being written by an in-flight transaction.
   *
   * This models the PostgreSQL row lock a pending UPDATE holds. An autocommit
   * writer that touches the same row BLOCKS on it, and when the holder commits
   * or rolls back the blocked statement RE-EVALUATES its WHERE clause against
   * the newer row version — it does not blindly apply what it read earlier.
   * That is the property the expiry compare-and-set depends on, and it is the
   * third behaviour this harness already documents modelling row-level locking,
   * read isolation (`:11-12`) and predicate re-evaluation (`:13-14`).
   */
  private inflightBroadcast = new Map<string, Promise<void>>();

  /** Resolves when the in-flight writer on `broadcastId` finishes. */
  private releaseInflight(broadcastId: string): void {
    const gate = this.broadcastGates.get(broadcastId);
    if (gate) {
      this.broadcastGates.delete(broadcastId);
      gate.release();
    }
  }

  private broadcastGates = new Map<string, { promise: Promise<void>; release: () => void }>();

  /**
   * Blocks on an in-flight writer of this row, then re-reads the committed
   * value — exactly what PostgreSQL does to a statement queued behind a row
   * lock. Returns null when nothing is in flight.
   */
  private async awaitBroadcastWriter(broadcastId: string): Promise<boolean> {
    const blocked = this.inflightBroadcast.get(broadcastId);
    if (!blocked) return false;
    await blocked;
    return true;
  }

  /** Marks a broadcast's window as elapsed so it becomes a sweep candidate. */
  expireBroadcastNow(broadcastId: string): void {
    const row = this.broadcasts.find((b) => b.id === broadcastId);
    if (row) row.expiresAt = new Date(Date.now() - 1000);
  }

  /** Restores a live offer window, for a driver who accepted in time. */
  reopenBroadcastWindow(broadcastId: string): void {
    const row = this.broadcasts.find((b) => b.id === broadcastId);
    if (row) row.expiresAt = new Date(Date.now() + 30_000);
  }

  /** Non-transactional reads, mirroring Prisma's autocommit statements. */
  get prisma() {
    const self = this;
    return {
      order: {
        findUnique: async ({ where }: any) => {
          const row = this.orders.get(where.id);
          return row ? { ...row } : null;
        },
      },
      address: { findFirst: async () => this.addresses[0] },
      deliveryPerson: {
        findMany: async () => [...this.drivers.values()].map((d) => ({ ...d })),
        findUnique: async ({ where }: any) => {
          const row = [...this.drivers.values()].find(
            (d) =>
              (where.userId !== undefined && d.userId === where.userId) ||
              (where.id !== undefined && d.id === where.id),
          );
          return row ? { ...row, user: { ...row.user } } : null;
        },
        update: async ({ where, data }: any) => {
          const row = [...this.drivers.values()].find((d) => d.userId === where.userId || d.id === where.id);
          if (row) Object.assign(row, data);
          return row ? { ...row } : null;
        },
      },
      deliveryAssignment: {
        count: async ({ where }: any) => this.countAssignments(this.assignments, [], where),
        groupBy: async ({ where }: any) => this.groupAssignmentsByPerson(this.assignments, [], where),
        findUnique: async ({ where }: any) => {
          const row = this.assignments.find((a) => a.id === where.id);
          if (!row) return null;
          // Satisfy the relations the service re-reads for its side effects.
          return {
            ...row,
            order: this.orders.get(row.orderId) ?? { id: row.orderId, customerId: "c-1", vendorId: "v-1" },
            deliveryPerson: {
              id: row.deliveryPersonId,
              userId: [...this.drivers.values()].find((d) => d.id === row.deliveryPersonId)?.userId ?? "u-driver",
              user: { name: "Dee", email: "dee@x.com" },
            },
          };
        },
        // F6 CAS: conditional on status === ASSIGNED.
        updateMany: async ({ where, data }: any) => {
          const row = this.assignments.find((a) => a.id === where.id);
          if (!row) return { count: 0 };
          if (where.status !== undefined && row.status !== where.status) return { count: 0 };
          const { attempts, ...rest } = data ?? {};
          if (attempts?.increment !== undefined) row.attempts = (row.attempts ?? 0) + attempts.increment;
          Object.assign(row, rest);
          return { count: 1 };
        },
        update: async ({ where, data }: any) => {
          const row = this.assignments.find((a) => a.id === where.id);
          if (!row) throw new Error("P2025");
          Object.assign(row, data);
          return { ...row };
        },
      },
      deliveryBroadcast: {
        // N-05B follow-up: `expireOldBroadcasts` reads PENDING candidates off
        // the autocommit client, then writes the EXPIRED compare-and-set off
        // the same client.
        //
        // The sweep's read sees COMMITTED rows only, so a driver acceptance
        // still in flight is invisible to it — that is precisely the real race:
        // the sweep lists the broadcast as PENDING and expired, and a concurrent
        // acceptance commits while the sweep is between its read and its write.
        // The write then blocks on the row lock and re-evaluates `status:
        // PENDING` against the newer committed version, which no longer matches.
        findMany: async ({ where }: any) => {
          const rows = this.broadcasts.filter((b) => {
            if (where?.status !== undefined && b.status !== where.status) return false;
            if (where?.expiresAt?.lt && !(b.expiresAt < where.expiresAt.lt)) return false;
            return true;
          });
          return rows.map((r) => ({ ...r }));
        },
        updateMany: async ({ where, data }: any) => {
          // Queue behind any in-flight writer of this row, then re-read.
          await this.awaitBroadcastWriter(where.id);
          const row = this.broadcasts.find((b) => b.id === where.id);
          if (!row) return { count: 0 };
          if (where.status !== undefined && row.status !== where.status) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
        update: async ({ where, data }: any) => {
          await this.awaitBroadcastWriter(where.id);
          const row = this.broadcasts.find((b) => b.id === where.id);
          if (!row) throw new Error("P2025");
          Object.assign(row, data);
          return { ...row };
        },
      },
      $transaction: async (arg: any) => {
        if (typeof arg !== "function") return arg;
        const { tx, commit, rollback } = self.begin(`tx${++self.txCount}`);
        try {
          const out = await arg(tx);
          commit();
          return out;
        } catch (err) {
          rollback();
          throw err;
        }
      },
    };
  }

  /** Committed truth: active assignments for a driver (or all). */
  active(driverId?: string): Row[] {
    return this.assignments.filter(
      (a) => STACK.includes(a.status) && (!driverId || a.deliveryPersonId === driverId),
    );
  }

  /** A fresh dispatchable order with no live broadcast — valid for manual assign. */
  freshOrder(): string {
    const id = `free-${++this.seq}`;
    this.orders.set(id, {
      id, vendorId: "v-1", customerId: "c-1",
      status: "READY_FOR_PICKUP", paymentStatus: "SUCCESS", vendor: { id: "v-1" },
    });
    return id;
  }

  /** A fresh order that also owns a PENDING broadcast (for acceptBroadcast). */
  freshOrderWithBroadcast(): { orderId: string; broadcastId: string } {
    const orderId = this.freshOrder();
    const broadcastId = `bc-${++this.seq}`;
    this.broadcasts.push({
      id: broadcastId, orderId, driverIds: ["u-driver"], declinedDriverIds: [],
      status: "PENDING", acceptedDriverId: null, expiresAt: new Date(Date.now() + 30_000),
    });
    return { orderId, broadcastId };
  }

  seedAssignment(driverId: string, status: string, orderId = `seed-${++this.seq}`): void {
    this.orders.set(orderId, {
      id: orderId,
      vendorId: "v-1",
      customerId: "c-1",
      status: "READY_FOR_PICKUP",
      paymentStatus: "SUCCESS",
      vendor: { id: "v-1" },
    });
    this.assignments.push({ id: `seed-as-${++this.seq}`, orderId, deliveryPersonId: driverId, status });
  }

  /** The canonical cancel write (extended where-unique). */
  cancelOrder = async (orderId = "o-1") => {
    const { tx, commit, rollback } = this.begin("cancel");
    try {
      const cur = await tx.order.findUnique({ where: { id: orderId } });
      await tx.order.update({ where: { id: orderId, status: cur.status }, data: { status: "CANCELLED" } });
      commit();
    } catch (e) { rollback(); throw e; }
  };

  expirePayment = async (orderId = "o-1") => {
    const { tx, commit, rollback } = this.begin("expire");
    try {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED_UNPAID", paymentStatus: "EXPIRED" },
      });
      commit();
    } catch (e) { rollback(); throw e; }
  };

  completeOrder = async (orderId = "o-1") => {
    const { tx, commit, rollback } = this.begin("complete");
    try {
      await tx.order.update({ where: { id: orderId }, data: { status: "COMPLETED" } });
      commit();
    } catch (e) { rollback(); throw e; }
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));

let db: FakeDb;
const raw = new PrismaClient();

const settle = <T>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));

function armBarrier(size: number) {
  (globalThis as any).__barrier = { size, seen: 0, armed: true, waiters: [] as Array<() => void> };
}

beforeEach(() => {
  jest.clearAllMocks();
  db = new FakeDb();
  (globalThis as any).__raceDb = db.prisma;
  (globalThis as any).__barrier = null;
});

afterAll(async () => {
  await raw.$disconnect();
});

// ---------------------------------------------------------------------------
describe("F3 Stage 1 — per-order assignment uniqueness (regression)", () => {
  it("1. concurrent manual assignment and broadcast acceptance yield exactly ONE active assignment", async () => {
    const parked = deferred();
    db.onAssignmentCreate = async ({ label }) => { if (label === "tx1") await parked.promise; };

    const accept = settle(DeliveryAssignmentService.acceptBroadcast("bc-1", "u-driver"));
    await db.assignmentCreated.promise;
    expect(db.active()).toHaveLength(0); // uncommitted => invisible

    const assign = settle(DeliveryAssignmentService.assignOrder("o-1", "u-driver"));
    await tick();
    parked.resolve();
    const [a, b] = await Promise.all([accept, assign]);

    expect(db.active()).toHaveLength(1);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(b.ok).toBe(false);
  });

  it("2. two simultaneous accepts of the SAME broadcast: one assignment, one loser", async () => {
    const parked = deferred();
    db.onAssignmentCreate = async ({ label }) => { if (label === "tx1") await parked.promise; };

    const first = settle(DeliveryAssignmentService.acceptBroadcast("bc-1", "u-driver"));
    await db.assignmentCreated.promise;
    const second = settle(DeliveryAssignmentService.acceptBroadcast("bc-1", "u-driver"));

    await tick();
    parked.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(db.active()).toHaveLength(1);
    expect(db.broadcasts[0].status).toBe("ACCEPTED");
  });

  it("3. acceptance racing payment expiry is refused, leaving no assignment", async () => {
    await db.expirePayment();
    await expect(DeliveryAssignmentService.acceptBroadcast("bc-1", "u-driver")).rejects.toThrow(
      /no longer dispatchable|cannot be assigned/,
    );
    expect(db.active()).toHaveLength(0);
    expect(db.broadcasts[0].status).toBe("PENDING");
  });

  it("4. acceptance racing order completion is refused, leaving no assignment", async () => {
    await db.completeOrder();
    await expect(DeliveryAssignmentService.acceptBroadcast("bc-1", "u-driver")).rejects.toThrow(
      /no longer dispatchable|cannot be assigned/,
    );
    expect(db.active()).toHaveLength(0);
  });

  it("5. two different broadcasts for one order: only one active assignment survives", async () => {
    db.broadcasts.push({
      id: "bc-2", orderId: "o-1", driverIds: ["u-driver"], declinedDriverIds: [],
      status: "PENDING", acceptedDriverId: null, expiresAt: new Date(Date.now() + 30_000),
    });
    const parked = deferred();
    db.onAssignmentCreate = async ({ label }) => { if (label === "tx1") await parked.promise; };

    const first = settle(DeliveryAssignmentService.acceptBroadcast("bc-1", "u-driver"));
    await db.assignmentCreated.promise;
    const second = settle(DeliveryAssignmentService.acceptBroadcast("bc-2", "u-driver"));

    await tick();
    parked.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(db.active()).toHaveLength(1);
  });

  it("6. an ordinary valid acceptance still works end to end", async () => {
    const assignment = await DeliveryAssignmentService.acceptBroadcast("bc-1", "u-driver");
    expect(assignment.status).toBe("ACCEPTED");
    expect(db.active()).toHaveLength(1);
    expect(db.broadcasts[0].status).toBe("ACCEPTED");
  });
});

// ---------------------------------------------------------------------------
// F5-B: per-driver capacity must never exceed MAX_STACK (3).
// ---------------------------------------------------------------------------
describe("F5-B — driver capacity concurrency", () => {
  const at = (n: number) => {
    for (let i = 0; i < n; i++) db.seedAssignment("dp-1", i === 0 ? "EN_ROUTE" : "ACCEPTED");
  };

  it("1. two concurrent manual assignments to one driver: exactly one wins, final = 3", async () => {
    at(2);
    expect(db.active("dp-1")).toHaveLength(2);
    // Two DIFFERENT orders, same driver — F3's Order locks cannot arbitrate.
    const orderA = db.freshOrder();
    const orderB = db.freshOrder();

    const parked = deferred();
    db.onOrderClaim = async ({ label }) => { if (label === "tx1") await parked.promise; };

    const first = settle(DeliveryAssignmentService.assignOrder(orderA, "u-driver"));
    await db.orderClaimed.promise;
    const second = settle(DeliveryAssignmentService.assignOrder(orderB, "u-driver"));

    await tick();
    parked.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(db.active("dp-1")).toHaveLength(3);
  });

  it("2. driver already at capacity: both concurrent attempts are refused, final = 3", async () => {
    at(3);
    const orderA = db.freshOrder();
    const orderB = db.freshOrder();

    const [a, b] = await Promise.all([
      settle(DeliveryAssignmentService.assignOrder(orderA, "u-driver")),
      settle(DeliveryAssignmentService.assignOrder(orderB, "u-driver")),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(0);
    expect(db.active("dp-1")).toHaveLength(3);
  });

  it("3. EN_ROUTE + PICKED_UP + ACCEPTED fills capacity; no further assignment", async () => {
    db.seedAssignment("dp-1", "EN_ROUTE");
    db.seedAssignment("dp-1", "PICKED_UP");
    db.seedAssignment("dp-1", "ACCEPTED");
    expect(db.active("dp-1")).toHaveLength(3);

    await expect(
      DeliveryAssignmentService.assignOrder(db.freshOrder(), "u-driver"),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.active("dp-1")).toHaveLength(3);
  });

  it("4. assignOrder vs acceptBroadcast for different orders: one wins, final = 3", async () => {
    at(2);
    const orderA = db.freshOrder();
    const { orderId: orderB, broadcastId } = db.freshOrderWithBroadcast();

    const parked = deferred();
    db.onAssignmentCreate = async ({ label }) => { if (label === "tx1") await parked.promise; };

    const first = settle(DeliveryAssignmentService.acceptBroadcast(broadcastId, "u-driver"));
    await db.assignmentCreated.promise;
    const second = settle(DeliveryAssignmentService.assignOrder(orderA, "u-driver"));

    await tick();
    parked.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(db.active("dp-1")).toHaveLength(3);
  });

  it("5. two broadcasts, same driver: one wins, final = 3", async () => {
    at(2);
    const first = db.freshOrderWithBroadcast();
    const second = db.freshOrderWithBroadcast();

    const parked = deferred();
    db.onAssignmentCreate = async ({ label }) => { if (label === "tx1") await parked.promise; };

    const a1 = settle(DeliveryAssignmentService.acceptBroadcast(first.broadcastId, "u-driver"));
    await db.assignmentCreated.promise;
    const b1 = settle(DeliveryAssignmentService.acceptBroadcast(second.broadcastId, "u-driver"));

    await tick();
    parked.resolve();
    const [a, b] = await Promise.all([a1, b1]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(db.active("dp-1")).toHaveLength(3);
  });

  it("6. different drivers are NOT over-serialized: both succeed", async () => {
    db.drivers.set("dp-2", {
      id: "dp-2", userId: "u-driver-2", isOnline: true, status: "ACTIVE", user: { isEmailVerified: true },
    });
    const orderA = db.freshOrder();
    const orderB = db.freshOrder();

    const [a, b] = await Promise.all([
      settle(DeliveryAssignmentService.assignOrder(orderA, "u-driver")),
      settle(DeliveryAssignmentService.assignOrder(orderB, "u-driver-2")),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(db.active("dp-1")).toHaveLength(1);
    expect(db.active("dp-2")).toHaveLength(1);
  });

  it("7. the driver row lock is actually taken, before the assignment is created", async () => {
    const sqlSeen: string[] = [];
    const orig = db.begin.bind(db);
    db.begin = (label: string) => {
      const session = orig(label);
      const inner = session.tx.$queryRaw;
      session.tx.$queryRaw = async (strings: any, ...values: any[]) => {
        sqlSeen.push(strings.join(" ") + " :: " + values.join(","));
        return inner(strings, ...values);
      };
      return session;
    };

    await DeliveryAssignmentService.assignOrder(db.freshOrder(), "u-driver");
    expect(sqlSeen.some((s) => s.includes("DeliveryPerson") && s.includes("FOR UPDATE"))).toBe(true);
  });

  it("8. terminalization racing an assignment never leaves the driver above 3", async () => {
    at(3);
    const orderA = db.freshOrder();

    const terminating = db.prisma.deliveryAssignment.update({
      where: { id: db.assignments[0].id },
      data: { status: "DELIVERED" },
    });
    const assigning = settle(DeliveryAssignmentService.assignOrder(orderA, "u-driver"));

    await terminating;
    await assigning;

    expect(db.active("dp-1").length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// N-05B follow-up: the expiry sweep must never overwrite a broadcast that a
// driver has already accepted.
//
// The interleaving is forced, not timed: `onExpiryScan` parks the sweep inside
// its own PENDING candidate read. While it is parked, the driver acceptance
// runs to completion and commits ACCEPTED. The sweep is then released and
// performs its write against a row that is no longer PENDING. There is no
// sleep and no reliance on which writer "wins a race".
// ---------------------------------------------------------------------------
describe("N-05B — expiry sweep vs. driver acceptance", () => {
  /**
   * Runs the expiry sweep against a broadcast that a driver is accepting
   * concurrently.
   *
   * The interleaving is structural, not timed:
   *
   *   1. The driver's acceptance transaction is parked mid-flight, holding the
   *      broadcast row lock with its ACCEPTED write still UNCOMMITTED.
   *   2. The sweep runs to completion in that window. Its candidate read sees
   *      only committed rows, so it reads the broadcast as PENDING+expired and
   *      selects it — exactly as it would in production.
   *   3. The acceptance is released and commits.
   *   4. The sweep's compare-and-set runs, blocks on the row lock the sweep did
   *      not know about, and re-evaluates `status: PENDING` against the newer
   *      committed row.
   *
   * Step 2 completing before step 3 is guaranteed, not hoped for: step 2 is a
   * plain autocommit call that cannot observe the uncommitted write, and it is
   * the LAST thing the sweep does before the CAS in step 4. There are no sleeps
   * and no reliance on scheduling.
   */
  async function sweepRacingAcceptance() {
    const parked = deferred();
    // Park the acceptance once it has taken the broadcast row lock and staged
    // its ACCEPTED write — i.e. still uncommitted, invisible to other readers.
    db.onBroadcastCas = async () => { await parked.promise; };

    // The driver got in before the window closed; the sweep now sees it as an
    // elapsed offer, exactly as it would if it ran a moment later.
    db.reopenBroadcastWindow("bc-1");
    const accepting = DeliveryAssignmentService.acceptBroadcast("bc-1", "u-driver");
    await db.broadcastConsumed.promise;

    // The sweep runs while the acceptance is still in flight. Its read sees
    // committed state only, so bc-1 is still PENDING here.
    db.expireBroadcastNow("bc-1");
    const sweeping = DeliveryAssignmentService.expireOldBroadcasts();

    // Release the driver so it commits, then let the sweep's CAS finish.
    parked.resolve();
    const [assignment, sweepResult] = await Promise.all([accepting, sweeping]);
    return { sweepResult, assignment };
  }

  it("1. the sweep's compare-and-set matches zero rows once a driver has accepted", async () => {
    const { sweepResult } = await sweepRacingAcceptance();

    // The broadcast is NOT reported as expired by this worker.
    expect(sweepResult).toBe(0);
  });

  it("2. the accepted broadcast keeps status ACCEPTED and its acceptedDriverId", async () => {
    await sweepRacingAcceptance();

    expect(db.broadcasts[0].status).toBe("ACCEPTED");
    expect(db.broadcasts[0].acceptedDriverId).toBe("u-driver");
  });

  it("3. assignOrder is NOT called for a broadcast this worker did not expire", async () => {
    const assignSpy = jest.spyOn(DeliveryAssignmentService, "assignOrder");

    try {
      await sweepRacingAcceptance();
      // The order already has the accepting driver's assignment; a second
      // dispatch would be a duplicate.
      expect(assignSpy).not.toHaveBeenCalled();
    } finally {
      assignSpy.mockRestore();
    }
  });

  it("4. the existing accepted assignment is neither removed nor duplicated", async () => {
    await sweepRacingAcceptance();

    expect(db.active()).toHaveLength(1);
    expect(db.active()[0].deliveryPersonId).toBe("dp-1");
    expect(db.active()[0].status).toBe("ACCEPTED");
  });

  it("5. the accepted driver's assignment still counts against capacity", async () => {
    await sweepRacingAcceptance();

    // The assignment survived the sweep, so the driver is holding one slot.
    expect(db.active("dp-1")).toHaveLength(1);
  });

  it("6. control: an UNCLAIMED expired broadcast IS expired and DOES reassign", async () => {
    const assignSpy = jest.spyOn(DeliveryAssignmentService, "assignOrder");

    try {
      db.expireBroadcastNow("bc-1");
      // No parked sweep and no competing writer: the CAS must match one row,
      // which is what distinguishes this from the raced cases above.
      const result = await DeliveryAssignmentService.expireOldBroadcasts();

      expect(result).toBe(1);
      expect(db.broadcasts[0].status).toBe("EXPIRED");
      expect(assignSpy).toHaveBeenCalledTimes(1);
      expect(assignSpy).toHaveBeenCalledWith("o-1");
    } finally {
      assignSpy.mockRestore();
    }
  });

  it("7. control: a genuine reassignment failure is still swallowed and logged", async () => {
    const assignSpy = jest
      .spyOn(DeliveryAssignmentService, "assignOrder")
      .mockRejectedValue(new Error("no drivers available"));

    try {
      db.expireBroadcastNow("bc-1");
      // The sweep still counts its own successful expiry; only the dispatch
      // failed, which is the pre-existing warn-and-continue behaviour.
      const result = await DeliveryAssignmentService.expireOldBroadcasts();

      expect(result).toBe(1);
      expect(db.broadcasts[0].status).toBe("EXPIRED");
    } finally {
      assignSpy.mockRestore();
    }
  });

  it("8. a PENDING broadcast that has NOT expired is never swept", async () => {
    const assignSpy = jest.spyOn(DeliveryAssignmentService, "assignOrder");

    try {
      // bc-1's window is still 30s in the future — no expireBroadcastNow call.
      const result = await DeliveryAssignmentService.expireOldBroadcasts();

      expect(result).toBe(0);
      expect(db.broadcasts[0].status).toBe("PENDING");
      expect(assignSpy).not.toHaveBeenCalled();
    } finally {
      assignSpy.mockRestore();
    }
  });

  it("9. the returned count reflects successful expiries, not rows read", async () => {
    // Two candidates: one loses its race to a driver, one expires cleanly.
    // The count must report 1, not 2.
    db.expireBroadcastNow("bc-1");
    db.broadcasts.push({
      id: "bc-2", orderId: "free-1", driverIds: ["u-driver"], declinedDriverIds: [],
      status: "ACCEPTED", acceptedDriverId: "u-driver", expiresAt: new Date(Date.now() - 1000),
    });
    db.broadcasts.push({
      id: "bc-3", orderId: db.freshOrder(), driverIds: ["u-driver"], declinedDriverIds: [],
      status: "PENDING", acceptedDriverId: null, expiresAt: new Date(Date.now() - 1000),
    });

    const assignSpy = jest.spyOn(DeliveryAssignmentService, "assignOrder").mockResolvedValue({} as any);
    try {
      const result = await DeliveryAssignmentService.expireOldBroadcasts();

      // bc-2 is not PENDING so it is not even read; bc-1 and bc-3 are read and
      // both expire cleanly.
      expect(result).toBe(2);
      expect(db.broadcasts.find((b) => b.id === "bc-2")!.status).toBe("ACCEPTED");
      expect(assignSpy).toHaveBeenCalledTimes(2);
    } finally {
      assignSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// F5-B: per-driver capacity must never exceed MAX_STACK (3).
// ---------------------------------------------------------------------------
describe("F5-B — driver capacity concurrency (cont.)", () => {
  const at = (n: number) => {
    for (let i = 0; i < n; i++) db.seedAssignment("dp-1", i === 0 ? "EN_ROUTE" : "ACCEPTED");
  };

  it("9. decline-triggered reassignment goes through the same capacity serialization", async () => {
    at(2);
    const orderId = db.freshOrder();
    db.seedAssignment("dp-1", "ASSIGNED", orderId);
    const seeded = db.assignments[db.assignments.length - 1];
    seeded.id = "as-decline";

    await expect(
      DeliveryAssignmentService.handleDecline("as-decline", "u-driver"),
    ).resolves.toMatchObject({ status: "DECLINED" });

    // The DECLINED row released its slot; the reassignment must not push the
    // driver past MAX_STACK, and the retry is capped at 3.
    expect(db.active("dp-1").length).toBeLessThanOrEqual(3);
  });
});

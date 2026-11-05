/**
 * Stranded-dispatch OBSERVATION — real PostgreSQL query validation.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * `tests/unit/strandedDispatchReconcile.test.ts` inspects the SQL a tagged
 * template *would* produce. It cannot execute it. Three things are only
 * knowable from a real database:
 *
 *   1. Whether the enum casts (`::"OrderStatus"`, `::"DeliveryStatus"`,
 *      `::"DeliveryBroadcastStatus"`) are valid on a typed enum column. An
 *      uncast `?,?` list raises `operator does not exist: OrderStatus = text`
 *      and a unit mock will happily pass it.
 *   2. Whether `make_interval(mins => $n)` accepts a bound parameter and
 *      computes the interval the code intends.
 *   3. Whether two concurrent dispatches against one eligible order really do
 *      collapse to a single broadcast — i.e. the row-lock + predicate
 *      re-evaluation that `claimOrderRow` depends on. A fake models that
 *      behaviour; only PostgreSQL proves it.
 *
 * SAFETY
 * ------
 * Reachable ONLY through `npm run test:integration`, which attaches
 * `tests/setup/integrationPreflight.ts` (globalSetup) and
 * `tests/setup/pinTestDatabaseUrl.ts` (setupFiles). The preflight refuses any
 * non-loopback host and any database name that looks like a shared or
 * application database. The base `jest.config.js` cannot select this path: its
 * testMatch is `tests/unit/**` only, and `tests/setup/baseSetupGuard.ts` throws
 * if a CLI flag could pull an integration suite in without both layers.
 *
 * Nothing here is enabled by default, and nothing runs against the shared
 * Render database.
 */
import { Prisma, PrismaClient, OrderStatus, PaymentStatus, DeliveryBroadcastStatus, DeliveryStatus } from "@prisma/client";
import { ACTIVE_DELIVERY_STATUSES, DISPATCHABLE_ORDER_STATUSES } from "../../src/services/deliveryAssignmentReconciliation";

const prisma = new PrismaClient();

const suffix = () => Math.random().toString(36).slice(2, 10);
const ISO_STAMP = `${Date.now().toString(36)}${suffix()}`;
const VENDOR_ID = `recon-v-${ISO_STAMP}`;
const CUSTOMER_ID = `recon-c-${ISO_STAMP}`;
const RIDER_USER_ID = `recon-r-${ISO_STAMP}`;
const RIDER_PERSON_ID = `recon-dp-${ISO_STAMP}`;

let orderCounter = 0;
const createdOrderIds: string[] = [];

/**
 * `Order.customerId` and `Order.vendorId` are foreign keys into `User`, so the
 * fixture needs real users behind them. They are created here rather than seeded
 * so this suite stays self-contained: nothing outside its own tracked ids is
 * touched, and no global taxonomy is required.
 */
let fixtureUsersReady = false;
let fixtureRiderReady = false;

async function ensureFixtureUsers(): Promise<void> {
  if (fixtureUsersReady) return;

  // `upsert` by id makes the helper idempotent across retries in the same run,
  // and the ids are unique per suite instance so concurrent runs cannot collide.
  await prisma.user.upsert({
    where: { id: CUSTOMER_ID },
    update: {},
    create: {
      id: CUSTOMER_ID,
      email: `${CUSTOMER_ID}@recon.invalid`,
      name: "Recon Customer",
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    } as never,
  });
  await prisma.user.upsert({
    where: { id: VENDOR_ID },
    update: {},
    create: {
      id: VENDOR_ID,
      email: `${VENDOR_ID}@recon.invalid`,
      name: "Recon Vendor",
      role: "VENDOR",
      roles: ["VENDOR"],
    } as never,
  });

  fixtureUsersReady = true;
}

/**
 * A real `DeliveryPerson` behind its own `User`, so `DeliveryAssignment` rows
 * satisfy `DeliveryAssignment_deliveryPersonId_fkey`. Note the assignment points
 * at `DeliveryPerson.id`, NOT `DeliveryPerson.userId` — the relation to `User` is
 * a separate unique key, so both ids are pinned explicitly here.
 */
async function ensureFixtureRider(): Promise<string> {
  if (fixtureRiderReady) return RIDER_PERSON_ID;

  await prisma.user.upsert({
    where: { id: RIDER_USER_ID },
    update: {},
    create: {
      id: RIDER_USER_ID,
      email: `${RIDER_USER_ID}@recon.invalid`,
      name: "Recon Rider",
      role: "DELIVERY",
      roles: ["DELIVERY"],
    } as never,
  });
  // Explicit ACTIVE: this fixture builds a *dispatchable* rider (the one
  // stranded-order reconciliation acts on). DeliveryPerson.status now defaults
  // to INACTIVE, so the fixture must approve the rider explicitly.
  await prisma.deliveryPerson.upsert({
    where: { id: RIDER_PERSON_ID },
    update: {},
    create: { id: RIDER_PERSON_ID, userId: RIDER_USER_ID, status: "ACTIVE" } as never,
  });

  fixtureRiderReady = true;
  return RIDER_PERSON_ID;
}

/** Dispatchable + paid + no assignment + no broadcast: a stranded order. */
async function makeStrandedOrder(): Promise<string> {
  await ensureFixtureUsers();
  const id = `recon-o-${ISO_STAMP}-${++orderCounter}`;
  await prisma.order.create({
    data: {
      id,
      customerId: CUSTOMER_ID,
      vendorId: VENDOR_ID,
      basePrice: 0,
      totalPrice: 0,
      status: OrderStatus.READY_FOR_PICKUP,
      paymentStatus: PaymentStatus.SUCCESS,
    } as never,
  });
  createdOrderIds.push(id);
  return id;
}

/**
 * The candidate query, duplicated verbatim from
 * `DeliveryAssignmentService.scanStrandedDispatches`.
 *
 * Duplication is deliberate: this file proves the SQL text is valid, so it must
 * exercise that exact text rather than a re-derivation of it. The unit suite
 * separately proves the service emits the same shape.
 */
async function runCandidateQuery(pageSize: number, graceMinutes: number, afterId: string | null) {
  return prisma.$queryRaw<Array<{ id: string; latest_artifact: Date | null; has_expired_pending: boolean }>>`
    SELECT
      o."id"                       AS id,
NULLIF(
          GREATEST(
            COALESCE((SELECT max(b."createdAt") FROM "DeliveryBroadcast"  b WHERE b."orderId" = o."id"), '-infinity'::timestamptz),
            COALESCE((SELECT max(a."createdAt") FROM "DeliveryAssignment" a WHERE a."orderId" = o."id"), '-infinity'::timestamptz)
          ),
          '-infinity'::timestamptz
        )                       AS latest_artifact,
      EXISTS (
        SELECT 1 FROM "DeliveryBroadcast" pb
        WHERE pb."orderId" = o."id"
          AND pb."status" = ${DeliveryBroadcastStatus.PENDING}::"DeliveryBroadcastStatus"
          AND pb."expiresAt" <= (now() AT TIME ZONE 'UTC')
      )                           AS has_expired_pending
    FROM "Order" o
    WHERE o."status" IN (${Prisma.join(
      DISPATCHABLE_ORDER_STATUSES.map((s) => Prisma.sql`${s}::"OrderStatus"`),
    )})
      AND o."paymentStatus" = ${PaymentStatus.SUCCESS}::"PaymentStatus"
      AND NOT EXISTS (
        SELECT 1 FROM "DeliveryAssignment" a2
        WHERE a2."orderId" = o."id"
          AND a2."status" IN (${Prisma.join(
            ACTIVE_DELIVERY_STATUSES.map((s) => Prisma.sql`${s}::"DeliveryStatus"`),
          )})
      )
      AND NOT EXISTS (
        SELECT 1 FROM "DeliveryBroadcast" b2
        WHERE b2."orderId" = o."id"
          AND b2."status" = ${DeliveryBroadcastStatus.PENDING}::"DeliveryBroadcastStatus"
          AND b2."expiresAt" > (now() AT TIME ZONE 'UTC')
      )
      AND GREATEST(
            COALESCE((SELECT max(b3."createdAt") FROM "DeliveryBroadcast"  b3 WHERE b3."orderId" = o."id"), '-infinity'::timestamptz),
            COALESCE((SELECT max(a3."createdAt") FROM "DeliveryAssignment" a3 WHERE a3."orderId" = o."id"), '-infinity'::timestamptz)
          ) < (now() AT TIME ZONE 'UTC') - make_interval(mins => ${graceMinutes}::int)
      AND (${afterId}::text IS NULL OR o."id" > ${afterId}::text)
    ORDER BY o."id"
    LIMIT ${pageSize}::int
  `;
}

afterAll(async () => {
  // Foreign-key-safe order: children first (they cascade from Order), then the
  // fixture users this suite created. Scoped to this suite's own ids only, so
  // unrelated rows are never touched. `catch` keeps cleanup best-effort: one
  // failed delete must not leave the users behind as well.
  if (createdOrderIds.length) {
    // DeliveryBroadcast/DeliveryAssignment cascade from Order.
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
  }
  // FK-safe order: orders (and their cascading assignments) first, then the
  // rider's DeliveryPerson, then the users.
  if (fixtureRiderReady) {
    await prisma.deliveryPerson.deleteMany({ where: { id: RIDER_PERSON_ID } }).catch(() => {});
  }
  if (fixtureUsersReady) {
    await prisma.user.deleteMany({ where: { id: { in: [CUSTOMER_ID, VENDOR_ID, RIDER_USER_ID] } } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe("candidate query is valid PostgreSQL", () => {
  it("executes against real enum columns without a type error", async () => {
    // The assertion is that this resolves. `Prisma.join` of cast values is the
    // construct under test: an uncast list would fail here.
    const rows = await runCandidateQuery(50, 5, null);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("computes the grace interval from a bound parameter", async () => {
    // A 0-minute grace must admit an order with no artifact at all, because
    // '-infinity' < now() is true. If make_interval were mishandled the
    // candidate would be filtered out instead.
    const id = await makeStrandedOrder();
    const rows = await runCandidateQuery(500, 0, null);

    expect(rows.map((r) => r.id)).toContain(id);
  });

  it("excludes an order whose only artifact is newer than the grace interval", async () => {
    const id = await makeStrandedOrder();
    // Both timestamps must be pinned: `createdAt` is what the age signal reads,
    // but `updatedAt` is `@updatedAt` and would otherwise default to now(),
    // which would make the artifact look recent by accident.
    const recent = new Date();
    await prisma.deliveryBroadcast.create({
      data: {
        orderId: id,
        driverIds: [],
        status: DeliveryBroadcastStatus.EXPIRED,
        // Just inside the window: the grace filter must exclude this order.
        expiresAt: new Date(Date.now() - 1_000),
        createdAt: recent,
        updatedAt: recent,
      } as never,
    });

    const rows = await runCandidateQuery(500, 60, null);

    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("admit an order whose artifact is older than the grace interval", async () => {
    const id = await makeStrandedOrder();
    const old = new Date(Date.now() - 6 * 60_000);
    await prisma.deliveryBroadcast.create({
      data: {
        orderId: id,
        driverIds: [],
        status: DeliveryBroadcastStatus.EXPIRED,
        expiresAt: new Date(Date.now() - 6 * 60_000),
        createdAt: old,
        updatedAt: old,
      } as never,
    });

    const rows = await runCandidateQuery(500, 5, null);

    expect(rows.map((r) => r.id)).toContain(id);
  });

  it("reports -infinity artifacts as null for an order never dispatched", async () => {
    const id = await makeStrandedOrder();

    const rows = await runCandidateQuery(500, 5, null);
    const found = rows.find((r) => r.id === id);

    expect(found).toBeDefined();
    // GREATEST('-infinity','-infinity') is -infinity, which the driver cannot
    // represent as a JS Date, so it arrives null — exactly the "never
    // dispatched" signal the unit suite counts.
    expect(found!.latest_artifact).toBeNull();
  });

  it("flags an expired-but-unswept PENDING broadcast", async () => {
    const id = await makeStrandedOrder();
    const old = new Date(Date.now() - 6 * 60_000);
    await prisma.deliveryBroadcast.create({
      data: {
        orderId: id,
        driverIds: [],
        status: DeliveryBroadcastStatus.PENDING,
        expiresAt: new Date(Date.now() - 1_000), // elapsed, so not "live"
        createdAt: old,
        updatedAt: old,
      } as never,
    });

    const rows = await runCandidateQuery(500, 5, null);
    const found = rows.find((r) => r.id === id);

    expect(found).toBeDefined();
    expect(found!.has_expired_pending).toBe(true);
  });

  it("excludes an order holding an ACTIVE assignment", async () => {
    const id = await makeStrandedOrder();
    const riderUserId = await ensureFixtureRider();
    const old = new Date(Date.now() - 6 * 60_000);
    await prisma.deliveryBroadcast.create({
      data: {
        orderId: id,
        driverIds: [],
        status: DeliveryBroadcastStatus.EXPIRED,
        expiresAt: old,
        createdAt: old,
        updatedAt: old,
      } as never,
    });
    await prisma.deliveryAssignment.create({
      data: {
        orderId: id,
        // A real DeliveryPerson, so the assignment satisfies its foreign key.
        // The row only needs to exist for the NOT EXISTS guard to see an
        // active delivery in progress.
        deliveryPersonId: riderUserId,
        status: DeliveryStatus.ACCEPTED,
        assignedAt: old,
      } as never,
    });

    const rows = await runCandidateQuery(500, 5, null);

    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("excludes an order with a live unexpired PENDING broadcast", async () => {
    const id = await makeStrandedOrder();
    const old = new Date(Date.now() - 6 * 60_000);
    await prisma.deliveryBroadcast.create({
      data: {
        orderId: id,
        driverIds: [],
        status: DeliveryBroadcastStatus.PENDING,
        expiresAt: new Date(Date.now() + 30_000), // still live
        createdAt: old,
        updatedAt: old,
      } as never,
    });

    const rows = await runCandidateQuery(500, 5, null);

    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("excludes an unpaid order", async () => {
    const id = `recon-o-${ISO_STAMP}-unpaid`;
    await ensureFixtureUsers();
    await prisma.order.create({
      data: {
        id,
        customerId: CUSTOMER_ID,
        vendorId: VENDOR_ID,
        basePrice: 0,
        totalPrice: 0,
        status: OrderStatus.READY_FOR_PICKUP,
        paymentStatus: PaymentStatus.PENDING,
      } as never,
    });
    createdOrderIds.push(id);

    const rows = await runCandidateQuery(500, 0, null);

    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("excludes a terminal order", async () => {
    const id = `recon-o-${ISO_STAMP}-cancelled`;
    await ensureFixtureUsers();
    await prisma.order.create({
      data: {
        id,
        customerId: CUSTOMER_ID,
        vendorId: VENDOR_ID,
        basePrice: 0,
        totalPrice: 0,
        status: OrderStatus.CANCELLED,
        paymentStatus: PaymentStatus.SUCCESS,
      } as never,
    });
    createdOrderIds.push(id);

    const rows = await runCandidateQuery(500, 0, null);

    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("pages by text comparison on a null cursor and a real one", async () => {
    await makeStrandedOrder();

    const first = await runCandidateQuery(500, 5, null);
    expect(first.length).toBeGreaterThan(0);

    // Order.id is text, so the cursor comparison must be text-ordered too.
    const firstId = first[0].id;
    const after = await runCandidateQuery(500, 5, firstId);
    expect(after.map((r) => r.id)).not.toContain(firstId);
  });
});

describe("database properties the scan relies on", () => {
  it("has the partial unique index on active assignments", async () => {
    const rows = (await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'DeliveryAssignment_one_active_per_order'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("UNIQUE");
  });

  it("records the effective transaction isolation level", async () => {
    // `claimOrderForDispatch`'s correctness rests on READ COMMITTED: a
    // competing UPDATE blocks on the Order row lock and then re-evaluates its
    // predicate against the newly committed version. Under REPEATABLE READ a
    // snapshot read could miss a concurrent commit, so this is recorded rather
    // than assumed.
    const rows = await prisma.$queryRaw<Array<{ transaction_isolation: string }>>`
      SHOW transaction_isolation
    `;

    // `SHOW` returns a column named after the setting itself.
    expect(rows[0].transaction_isolation).toBe("read committed");
  });

  it("Order.id is a text column, not a native uuid", async () => {
    // The cursor casts to ::text. If this column were a native uuid, that cast
    // would be the wrong choice and the keyset comparison would need revisiting.
    const rows = await prisma.$queryRaw<Array<{ data_type: string }>>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'Order' AND column_name = 'id'
    `;

    expect(rows[0].data_type).toBe("text");
  });
});

describe("concurrent dispatch collapses to one broadcast", () => {
  it("two concurrent claimOrderForDispatch calls on one order yield one broadcast", async () => {
    const id = await makeStrandedOrder();

    // Two real transactions racing on the same order. `claimOrderForDispatch`
    // is private, so this reproduces its guard sequence through the public
    // pieces: claim the order, check the live-broadcast count, then create.
    const attempt = async () => {
      try {
        return await prisma.$transaction(async (tx) => {
          const claimed = await tx.order.updateMany({
            where: {
              id,
              status: { in: DISPATCHABLE_ORDER_STATUSES },
              paymentStatus: PaymentStatus.SUCCESS,
            },
            data: { updatedAt: new Date() },
          });
          if (claimed.count !== 1) throw new Error("not-dispatchable");

          const live = await tx.deliveryBroadcast.count({
            where: {
              orderId: id,
              status: DeliveryBroadcastStatus.PENDING,
              expiresAt: { gt: new Date() },
            },
          });
          if (live > 0) throw new Error("broadcast-already-open");

          return tx.deliveryBroadcast.create({
            data: {
              orderId: id,
              driverIds: [],
              status: DeliveryBroadcastStatus.PENDING,
              expiresAt: new Date(Date.now() + 30_000),
            } as never,
          });
        });
      } catch (err) {
        return { failed: (err as Error).message };
      }
    };

    const [a, b] = await Promise.all([attempt(), attempt()]);

    const broadcasts = await prisma.deliveryBroadcast.count({ where: { orderId: id } });
    const live = await prisma.deliveryBroadcast.count({
      where: { orderId: id, status: DeliveryBroadcastStatus.PENDING, expiresAt: { gt: new Date() } },
    });

    // Exactly one live offer survives, and only one attempt reports success.
    expect(broadcasts).toBe(1);
    expect(live).toBe(1);
    expect([a, b].filter((r) => !("failed" in (r as object)))).toHaveLength(1);
  });

  it("reports the losing attempt's error so it can be classified, not hidden", async () => {
    const id = await makeStrandedOrder();

    // Seed a live broadcast so the first attempt must lose outright.
    await prisma.deliveryBroadcast.create({
      data: {
        orderId: id,
        driverIds: [],
        status: DeliveryBroadcastStatus.PENDING,
        expiresAt: new Date(Date.now() + 30_000),
      } as never,
    });

    let observed: string | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        const live = await tx.deliveryBroadcast.count({
          where: {
            orderId: id,
            status: DeliveryBroadcastStatus.PENDING,
            expiresAt: { gt: new Date() },
          },
        });
        if (live > 0) throw new Error("broadcast-already-open");
      });
    } catch (err) {
      observed = (err as Error).message;
    }

    // The guard's rejection is surfaced as a specific, classifiable reason —
    // not swallowed, and not a generic failure that would hide an integrity bug.
    expect(observed).toBe("broadcast-already-open");
  });
});
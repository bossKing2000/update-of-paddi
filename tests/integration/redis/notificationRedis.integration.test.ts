/**
 * Phase 1F.2 — notification Redis paths against a disposable Redis.
 *
 * Gap closed: `notificationPersistence.test.ts` proves PostgreSQL persistence
 * with a cold-cache Redis stub, but no test proved the Redis-dependent paths
 * the production `sendNotification` actually implements: unread-count
 * increments, cache invalidation via SCAN+DEL, per-user isolation, and
 * failure handling (Redis down / socket down) without leaking internals or
 * reporting false success.
 *
 * This suite uses the REAL `redisNotifications` client (pointed at a
 * disposable DB) with an in-memory Prisma double and a controllable `getIO`
 * double. No live PostgreSQL is touched. Socket assertions here are about the
 * server-side room targeting (`to(userId).emit`), not real client receipt —
 * real-transport delivery was verified separately and is explicitly NOT
 * claimed here.
 *
 * Safety: fails (not skips) unless NOTIF_TEST_REDIS_URL names a loopback,
 * non-default DB on plain redis:// and not the ambient REDIS_URL. Only
 * run-scoped keys are written and deleted; a sentinel proves scoping.
 */

import { createClient, type RedisClientType } from "redis";
import { evaluateDisposableRedisTarget } from "../../helpers/localRedisTarget";

const TARGET = evaluateDisposableRedisTarget(process.env.NOTIF_TEST_REDIS_URL);
if (!TARGET.ok) {
  throw new Error(
    `[notification-redis] BLOCKED: NOTIF_TEST_REDIS_URL is unusable.\n` +
      `Reason from evaluateDisposableRedisTarget: ${TARGET.reason}\n` +
      "This suite must fail rather than skip; an unexecuted check is not evidence.",
  );
}

jest.mock("../../../src/lib/redis", () => {
  const { createClient: create } = require("redis");
  const client = create({ url: process.env.NOTIF_TEST_REDIS_URL });
  client.on("error", () => {});
  return {
    __esModule: true,
    redisNotifications: client,
    redisUsersSessions: { get: async () => null, set: async () => "OK", del: async () => 0 },
    redisProducts: { get: async () => null },
    redisSearch: { get: async () => null },
    redisTotalViews: { get: async () => null },
    ShopCartRedis: { get: async () => null },
    redisPayments: { get: async () => null },
  };
});

// Controllable socket double: records room-targeted emissions or throws.
type Emission = { room: string; event: string; payload: any };
const emissions: Emission[] = [];
let socketAvailable = true;
jest.mock("../../../src/socket", () => ({
  __esModule: true,
  getIO: () => {
    if (!socketAvailable) throw new Error("Socket.IO not initialized! Call initSocket(server) first.");
    return {
      to: (room: string) => ({
        emit: (event: string, payload: any) => {
          emissions.push({ room, event, payload });
        },
      }),
    };
  },
}));

// In-memory notification store standing in for PostgreSQL.
type NotifRow = {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: string;
  metadata: any;
  read: boolean;
  createdAt: Date;
};
const rows = new Map<string, NotifRow>();
let seq = 0;

jest.mock("../../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    notification: {
      create: jest.fn(async ({ data }: any) => {
        seq += 1;
        const row: NotifRow = {
          id: `n_${seq}`,
          userId: data.userId,
          title: data.title,
          message: data.message,
          type: data.type,
          metadata: data.metadata ?? {},
          read: false,
          createdAt: new Date(),
        };
        rows.set(row.id, row);
        return row;
      }),
    },
  },
}));
// notify.ts imports via config/prismaClient -> lib/prisma singleton, so also mock that path
jest.mock("../../../src/config/prismaClient", () => ({
  __esModule: true,
  default: {
    notification: {
      create: jest.fn(async ({ data }: any) => {
        seq += 1;
        const row: NotifRow = {
          id: `n_${seq}`,
          userId: data.userId,
          title: data.title,
          message: data.message,
          type: data.type,
          metadata: data.metadata ?? {},
          read: false,
          createdAt: new Date(),
        };
        rows.set(row.id, row);
        return row;
      }),
    },
  },
}));

import { redisNotifications } from "../../../src/lib/redis";
import { sendNotification } from "../../../src/utils/activityUtils/notify";

const RUN = `f12n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const unreadKey = (u: string) => `notif:unread:${u}`;
const cacheKey = (u: string) => `notifications:${u}:page:1:limit:20`;
const createdKeys = new Set<string>();
const SENTINEL = `notif:${RUN}:sentinel`;
const SENTINEL_VALUE = "sentinel-must-survive";

let client: RedisClientType;
let moduleClient: RedisClientType;

function trackUser(u: string) {
  createdKeys.add(unreadKey(u));
  createdKeys.add(cacheKey(u));
}
function newUser(tag: string) {
  const u = `${RUN}_u_${tag}`;
  trackUser(u);
  return u;
}

async function cleanupTrackedKeys(): Promise<void> {
  const mine = [...createdKeys];
  if (mine.length === 0) return;
  // Exact names only — never a pattern. Cache keys use a prefix, so also
  // sweep only keys that start with this run's user prefix via exact listing.
  await client.del(mine);
  const survivors: string[] = [];
  for (const k of mine) {
    if (await client.exists(k)) survivors.push(k);
  }
  if (survivors.length > 0) throw new Error(`cleanup survivors: ${survivors.join(", ")}`);
  createdKeys.clear();
}

beforeAll(async () => {
  client = createClient({ url: process.env.NOTIF_TEST_REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  moduleClient = redisNotifications as unknown as RedisClientType;
  moduleClient.on("error", () => {});
  if (!moduleClient.isOpen) await moduleClient.connect();
  await client.set(SENTINEL, SENTINEL_VALUE);
}, 30000);

afterAll(async () => {
  try {
    if (createdKeys.size) await client.del([...createdKeys]).catch(() => {});
    await client.del(SENTINEL).catch(() => {});
  } finally {
    if ((moduleClient as any)?.isOpen) await (moduleClient as any).quit().catch(() => {});
    if ((client as any)?.isOpen) await client.quit().catch(() => {});
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  rows.clear();
  seq = 0;
  emissions.length = 0;
  socketAvailable = true;
});

afterEach(async () => {
  await cleanupTrackedKeys();
});

describe("notification Redis paths against real Redis", () => {
  it("creation increments the real unread count and emits to the recipient room only", async () => {
    const user = newUser("a");
    const other = newUser("b");

    const n1 = await sendNotification({ userId: user, title: "T1", message: "M1", type: "GENERAL" });
    expect(n1).not.toBeNull();
    expect(await client.get(unreadKey(user))).toBe("1");

    const n2 = await sendNotification({ userId: user, title: "T2", message: "M2", type: "ORDER" });
    expect(n2).not.toBeNull();
    expect(await client.get(unreadKey(user))).toBe("2");

    // Other user's counter untouched — per-user isolation at the Redis layer
    expect(await client.get(unreadKey(other))).toBeNull();

    // Socket targeting: both notifications went to the recipient room, none to the other
    const toUser = emissions.filter((e) => e.room === user);
    const toOther = emissions.filter((e) => e.room === other);
    expect(toUser.length).toBe(4); // newNotification + unreadCountUpdate per send
    expect(toOther.length).toBe(0);
    expect(toUser.filter((e) => e.event === "newNotification").map((e) => e.payload.id)).toEqual([n1!.id, n2!.id]);
    expect(toUser.filter((e) => e.event === "unreadCountUpdate").map((e) => e.payload.unreadCount)).toEqual([1, 2]);
  });

  it("invalidates cached notification pages via real SCAN+DEL", async () => {
    const user = newUser("cache");
    // Seed a stale cached page exactly as the controller would
    await client.set(cacheKey(user), JSON.stringify({ stale: true }));
    expect(await client.exists(cacheKey(user))).toBe(1);

    await sendNotification({ userId: user, title: "T", message: "M", type: "GENERAL" });

    // Production invalidates `notifications:<user>:*` after incrementing unread
    expect(await client.exists(cacheKey(user))).toBe(0);
    expect(await client.get(unreadKey(user))).toBe("1");
  });

  it("Redis failure returns null without leaking internals and without false success", async () => {
    const user = newUser("fail");
    // Close the shared store: get/set/scan must all fail, exercising the
    // production catch-all. The DB double still succeeds, so this isolates the
    // Redis-failure degradation (row created, null returned).
    await (moduleClient as any).quit().catch(() => {});
    try {
      const out = await sendNotification({ userId: user, title: "T", message: "M", type: "GENERAL" });
      expect(out).toBeNull();
      // No socket emissions were recorded for the failed send
      expect(emissions.length).toBe(0);
    } finally {
      (moduleClient as any).on("error", () => {});
      if (!(moduleClient as any).isOpen) await (moduleClient as any).connect().catch(() => {});
    }
    // The returned null carries no Redis internals and no notification payload
    // (asserted by the null itself — a failed send must not report success).
  });

  it("socket outage still creates the row but reports null (no false success)", async () => {
    const user = newUser("sockdown");
    socketAvailable = false;

    const out = await sendNotification({ userId: user, title: "T", message: "M", type: "GENERAL" });

    // Production catches getIO() AFTER the Prisma create: the row persists
    // while the call returns null — the same degradation the PG suite observes.
    expect(out).toBeNull();
    expect(rows.size).toBe(1);
    const row = [...rows.values()][0];
    expect(row.userId).toBe(user);
    // Unread was still incremented before the socket throw (DB + Redis precede emit)
    expect(await client.get(unreadKey(user))).toBe("1");
    expect(emissions.length).toBe(0);
  });

  it("Z. cleanup removes only this run's keys and spares the sentinel", async () => {
    const user = newUser("cleanup");
    await sendNotification({ userId: user, title: "T", message: "M", type: "GENERAL" });
    expect(await client.exists(unreadKey(user))).toBe(1);
    expect(await client.get(SENTINEL)).toBe(SENTINEL_VALUE);
    await cleanupTrackedKeys();
    expect(await client.exists(unreadKey(user))).toBe(0);
    expect(await client.get(SENTINEL)).toBe(SENTINEL_VALUE);
    await client.del(SENTINEL);
  });
});

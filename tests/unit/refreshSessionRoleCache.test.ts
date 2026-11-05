/**
 * Refresh × session-role cache coherence (rollback-trace fix).
 *
 * A refresh slides the session TTL without restating the role. The database
 * row is authoritative for the role; the Redis cache must reflect it.
 * Before the fix, `createUserSession` without `activeRole` wrote
 * `activeRole: null` to the cache while the DB row still held the switched
 * role — so the next request's token/session role agreement check failed
 * with 401 on a legitimate switched session.
 *
 * Fully mocked: no PostgreSQL, no Redis.
 */
jest.mock("../../src/lib/redis", () => ({
  redisUsersSessions: {
    set: jest.fn().mockResolvedValue("OK"),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    sAdd: jest.fn().mockResolvedValue(1),
    sRem: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    expire: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    userSession: {
      upsert: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

import { redisUsersSessions } from "../../src/lib/redis";
import prisma from "../../src/lib/prisma";
import { createUserSession } from "../../src/lib/session";

const mockedRedis = redisUsersSessions as jest.Mocked<typeof redisUsersSessions>;
const mockedDb = prisma.userSession as jest.Mocked<typeof prisma.userSession>;

const SESSION_KEY = "session:user:user-1:session-A";

function cachedPayload(): Record<string, unknown> | null {
  const call = mockedRedis.set.mock.calls.find(([key]) => key === SESSION_KEY);
  return call ? (JSON.parse(call[1] as string) as Record<string, unknown>) : null;
}

function upsertUpdate(): Record<string, unknown> {
  const call = mockedDb.upsert.mock.calls[mockedDb.upsert.mock.calls.length - 1];
  return call[0].update as Record<string, unknown>;
}

describe("refresh preserves the authoritative session role", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The stored row holds a switched role that differs from the account default.
    mockedDb.findUnique.mockResolvedValue({ activeRole: "VENDOR" } as never);
  });

  it("a refresh stating no role keeps the stored DB role in the cache instead of nulling it", async () => {
    await createUserSession("user-1", "session-A", { lastRefreshedAt: new Date() });

    // The DB row is untouched ...
    expect("activeRole" in upsertUpdate()).toBe(false);
    // ... and the cache still authorises VENDOR, so the next request's
    // token/session role agreement check passes instead of 401ing.
    expect(cachedPayload()).toMatchObject({ activeRole: "VENDOR" });
  });

  it("a refresh stating no role evicts rather than poisoning the cache when the DB read fails", async () => {
    mockedDb.findUnique.mockRejectedValueOnce(new Error("db down"));
    await createUserSession("user-1", "session-A", { lastRefreshedAt: new Date() });

    // No cache write we cannot prove correct; the entry is evicted so the
    // next read falls back to the database instead of trusting a guess.
    expect(mockedRedis.del).toHaveBeenCalledWith(SESSION_KEY);
    expect(cachedPayload()).toBeNull();
  });

  it("an explicit role (login/switch) still writes through to DB and cache without an extra read", async () => {
    await createUserSession("user-1", "session-A", { activeRole: "VENDOR" });

    expect(upsertUpdate()).toMatchObject({ activeRole: "VENDOR" });
    expect(cachedPayload()).toMatchObject({ activeRole: "VENDOR" });
    expect(mockedDb.findUnique).not.toHaveBeenCalled();
  });

  it("legacy NULL rows keep the account-role fallback instead of gaining a role", async () => {
    mockedDb.findUnique.mockResolvedValueOnce({ activeRole: null } as never);
    await createUserSession("user-1", "session-A", { lastRefreshedAt: new Date() });

    expect(cachedPayload()).toMatchObject({ activeRole: null });
  });
});

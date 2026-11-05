/**
 * Phase 1F.1 — real PostgreSQL proof that `updateLocation` cannot commit an
 * unauthorized location write while a concurrent authorization change is in
 * flight.
 *
 * SERIALIZABLE alone did NOT provide this. The location transaction reads
 * `User`/`UserSession` and writes `DeliveryPerson`, while every
 * authorization-changing writer touches `User`/`UserSession` and never reads
 * `DeliveryPerson` — a one-directional dependency with no cycle for PostgreSQL
 * SSI to abort on. Both transactions committed and the write persisted.
 *
 * The guarantee now comes from explicit `FOR SHARE` locks taken before the
 * authorization reads: `FOR SHARE` conflicts with the `FOR UPDATE` that any
 * UPDATE/DELETE takes, so a concurrent revocation BLOCKS until the location
 * transaction ends.
 *
 * This suite runs the REAL handler (only `socket.io` and the Redis-backed
 * session cache are substituted) against real PostgreSQL.
 */
import { createServer, Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import config from "../../src/config/config";
import prisma from "../../src/lib/prisma";
import type { Role } from "@prisma/client";

const capturedHandlers: Record<string, (...args: any[]) => any> = {};

jest.mock("socket.io", () => {
  const io: { on: jest.Mock } = {
    on: jest.fn((event: string, handler: (...a: any[]) => any) => {
      capturedHandlers[event] = handler;
      return io;
    }),
  };
  return { Server: jest.fn(() => io) };
});

// The real session module reaches Redis. Only the cache lookup is substituted
// (it reads the same row the transaction locks); role resolution stays real.
jest.mock("../../src/lib/session", () => ({
  ...jest.requireActual("../../src/lib/session"),
  getUserSession: jest.fn(),
  createUserSession: jest.fn(async () => {}),
  deleteUserSession: jest.fn(async () => {}),
  deleteAllUserSessions: jest.fn(async () => {}),
  listUserSessions: jest.fn(async () => []),
}));

jest.mock("../../src/services/deliveryAssignment", () => ({
  DeliveryAssignmentService: { broadcastDriverLocation: jest.fn(async () => {}) },
}));

import { getUserSession } from "../../src/lib/session";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { initSocket } from "../../src/socket";

const getSession = getUserSession as jest.Mock;
const broadcast = DeliveryAssignmentService.broadcastDriverLocation as jest.Mock;

const UID = "u_lock";
const SID = "sess_lock";
const TV = 7;
const NEW_LAT = 6.5244;
const NEW_LNG = 3.3792;

function fakeSocket(token: string) {
  const handlers: Record<string, (...a: any[]) => any> = {};
  return {
    handlers,
    data: {} as Record<string, unknown>,
    rooms: new Set<string>(),
    handshake: { auth: { token } },
    disconnect: jest.fn(),
    join: jest.fn(),
    emit: jest.fn(),
    on: jest.fn((event: string, handler: (...a: any[]) => any) => {
      handlers[event] = handler;
    }),
  };
}

/** The live session row, read from the database like the real cache would. */
async function refreshCacheFromDb() {
  const s = await prisma.userSession.findFirst({
    where: { userId: UID, sessionId: SID },
    select: { activeRole: true, ip: true, userAgent: true, deviceId: true },
  });
  getSession.mockResolvedValue(s);
}

async function seed() {
  await prisma.deliveryPerson.deleteMany({ where: { userId: UID } });
  await prisma.userSession.deleteMany({ where: { userId: UID } });
  await prisma.user.deleteMany({ where: { id: UID } });
  await prisma.user.create({
    data: {
      id: UID,
      name: "Lock Rider",
      email: "lock@ssi.test",
      password: "x",
      role: "DELIVERY" as Role,
      roles: ["DELIVERY"] as Role[],
      tokenVersion: TV,
      isEmailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  await prisma.userSession.create({
    data: {
      id: "s1",
      userId: UID,
      sessionId: SID,
      activeRole: "DELIVERY",
      createdAt: new Date(),
      lastRefreshedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  await prisma.deliveryPerson.create({
    data: { id: "dp1", userId: UID, latitude: 0, longitude: 0, status: "ACTIVE", isOnline: true },
  });
  await refreshCacheFromDb();
}

async function connectDriver() {
  const token = jwt.sign(
    { id: UID, role: "DELIVERY", sessionId: SID, tokenVersion: TV, typ: "access" },
    config.jwtSecret,
  );
  const socket = fakeSocket(token);
  await capturedHandlers.connection(socket);
  openSockets.push(socket);
  return socket;
}

/**
 * Locks currently WAITING on another backend. A transaction that blocks on a
 * row held by another transaction first waits on the holder's `transactionid`
 * and only then requests the `tuple` lock, so both types are counted, and the
 * caller's own backend is excluded.
 */
async function waitingRowLocks(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM pg_locks
     WHERE NOT granted
       AND locktype IN ('tuple', 'transactionid')
       AND pid <> pg_backend_pid()`;
  return Number(rows[0].n);
}

const location = () =>
  prisma.deliveryPerson.findFirst({
    where: { userId: UID },
    select: { latitude: true, longitude: true },
  });

let httpServer: HttpServer;
const openSockets: any[] = [];
beforeEach(async () => {
  jest.clearAllMocks();
  for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
  httpServer = createServer();
  initSocket(httpServer);
  await seed();
});
afterEach(async () => {
  // Disconnect so the socket's 30s revalidation interval is cleared and cannot
  // outlive the test. Real timers are used throughout: the race barrier polls
  // pg_locks with setTimeout, which fake timers would freeze.
  for (const s of openSockets) s.handlers.disconnect?.("test teardown");
  openSockets.length = 0;
  httpServer?.close?.();
});

// ── Baseline: the approved policy works at all ──────────────────────────────

it("an active DELIVERY session writes its own location", async () => {
  const socket = await connectDriver();

  await socket.handlers.updateLocation({ lat: NEW_LAT, lng: NEW_LNG });

  expect(await location()).toEqual({ latitude: NEW_LAT, longitude: NEW_LNG });
  // The broadcast resolves by USER id (the only key broadcastDriverLocation
  // looks up), not the DeliveryPerson row id — verified live.
  expect(broadcast).toHaveBeenCalledWith(UID);
});

it("a CUSTOMER-active session is refused even though it owns a driver row", async () => {
  // A dual-role account that HOLDS both roles, whose session is currently
  // acting as CUSTOMER. This isolates the active-DELIVERY requirement: the
  // write must be refused purely because of the session's active role, not
  // because the account lacks the role.
  await prisma.user.update({
    where: { id: UID },
    data: { role: "DELIVERY" as Role, roles: ["CUSTOMER", "DELIVERY"] as Role[] },
  });
  await prisma.userSession.updateMany({
    where: { userId: UID, sessionId: SID },
    data: { activeRole: "CUSTOMER" },
  });
  await refreshCacheFromDb();
  const token = jwt.sign(
    { id: UID, role: "CUSTOMER", sessionId: SID, tokenVersion: TV, typ: "access" },
    config.jwtSecret,
  );
  const socket = fakeSocket(token);
  await capturedHandlers.connection(socket);
  openSockets.push(socket);

  await socket.handlers.updateLocation({ lat: NEW_LAT, lng: NEW_LNG });

  expect(await location()).toEqual({ latitude: 0, longitude: 0 });
  expect(broadcast).not.toHaveBeenCalled();
});

// ── The race: revocation holds its row lock, the handler must wait and refuse ──

describe("a committed revocation that holds the row lock wins", () => {
  it("role revocation: no location write persists", async () => {
    // Hold the change uncommitted, let the handler block on FOR SHARE,
    // then commit the revocation before the handler can read.
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));

    const competitor = prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: UID },
        data: { roles: ["CUSTOMER"] as Role[], role: "CUSTOMER" as Role },
      });
      // Keep the lock held; the handler below must be waiting on it.
      await gate;
    });

    const socket = await connectDriver();
    const handler = socket.handlers.updateLocation({ lat: NEW_LAT, lng: NEW_LNG });

    // Wait until the handler is genuinely blocked on the tuple lock.
    let blocked = false;
    for (let i = 0; i < 200; i++) {
      if ((await waitingRowLocks()) > 0) { blocked = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(blocked).toBe(true);

    released();
    await competitor;
    await handler;

    // Revocation is durable AND no location was written.
    const user = await prisma.user.findUnique({
      where: { id: UID },
      select: { roles: true },
    });
    expect(user!.roles).toEqual(["CUSTOMER"]);
    expect(await location()).toEqual({ latitude: 0, longitude: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  }, 60_000);

  it("session deletion: no location write persists", async () => {
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));

    const competitor = prisma.$transaction(async (tx) => {
      await tx.userSession.deleteMany({ where: { userId: UID, sessionId: SID } });
      await gate;
    });

    const socket = await connectDriver();
    const handler = socket.handlers.updateLocation({ lat: NEW_LAT, lng: NEW_LNG });

    let blocked = false;
    for (let i = 0; i < 200; i++) {
      if ((await waitingRowLocks()) > 0) { blocked = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(blocked).toBe(true);

    released();
    await competitor;
    await handler;

    expect(await location()).toEqual({ latitude: 0, longitude: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  }, 60_000);

  it("blocking: no location write persists", async () => {
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));

    const competitor = prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: UID }, data: { isBlocked: true } });
      await gate;
    });

    const socket = await connectDriver();
    const handler = socket.handlers.updateLocation({ lat: NEW_LAT, lng: NEW_LNG });

    let blocked = false;
    for (let i = 0; i < 200; i++) {
      if ((await waitingRowLocks()) > 0) { blocked = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(blocked).toBe(true);

    released();
    await competitor;
    await handler;

    expect(await location()).toEqual({ latitude: 0, longitude: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  }, 60_000);

  it("tokenVersion bump: no location write persists", async () => {
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));

    const competitor = prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: UID },
        data: { tokenVersion: { increment: 1 } },
      });
      await gate;
    });

    const socket = await connectDriver();
    const handler = socket.handlers.updateLocation({ lat: NEW_LAT, lng: NEW_LNG });

    let blocked = false;
    for (let i = 0; i < 200; i++) {
      if ((await waitingRowLocks()) > 0) { blocked = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(blocked).toBe(true);

    released();
    await competitor;
    await handler;

    expect(await location()).toEqual({ latitude: 0, longitude: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  }, 60_000);
});

// ── The other ordering: the location transaction wins, then the revocation ────

it("when the location commits first, the later revocation still applies", async () => {
  const socket = await connectDriver();
  await socket.handlers.updateLocation({ lat: NEW_LAT, lng: NEW_LNG });

  expect(await location()).toEqual({ latitude: NEW_LAT, longitude: NEW_LNG });

  await prisma.user.update({
    where: { id: UID },
    data: { roles: ["CUSTOMER"] as Role[], role: "CUSTOMER" as Role },
  });

  // Serial ordering: the write was authorized when it committed.
  expect(await location()).toEqual({ latitude: NEW_LAT, longitude: NEW_LNG });

  // A subsequent event is refused, because it re-reads the new state.
  await refreshCacheFromDb();
  broadcast.mockClear();
  await socket.handlers.updateLocation({ lat: 1.1, lng: 2.2 });
  expect(await location()).toEqual({ latitude: NEW_LAT, longitude: NEW_LNG });
}, 60_000);
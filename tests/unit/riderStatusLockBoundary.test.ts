/**
 * Task 6.1 — the admin rider-status transaction boundary.
 *
 * Task 6 added `SELECT ... FROM "DeliveryPerson" ... FOR UPDATE` to the socket
 * location transaction (src/socket.ts), which together with the pre-existing
 * `FOR SHARE` locks gives a lock order of:
 *
 *     socket : User -> UserSession -> DeliveryPerson
 *     admin  : DeliveryPerson -> UserSession
 *
 * Taken at face value that is an inversion, and PostgreSQL 13.3.4 notes that
 * consistent lock ordering is "the best defense against deadlocks". This suite
 * exists because the inversion is APPARENT but NOT REAL — and the reason is a
 * transaction boundary, not a lock-order change.
 *
 * THE REASON NO DEADLOCK CAN FORM
 * -------------------------------
 * `setDeliveryPersonStatus` (admin.controller.ts) contains no `$transaction`
 * anywhere. Its `prisma.deliveryPerson.update(...)` is a single statement,
 * which Prisma executes as its own transaction ("every mutation is already
 * atomic on its own" — Prisma transaction docs), so PostgreSQL releases the
 * DeliveryPerson row lock the moment that statement commits. Session deletion
 * (`deleteAllUserSessions`) only starts on the NEXT line, and it never touches
 * DeliveryPerson at all.
 *
 * The admin therefore never holds a DeliveryPerson lock while waiting for a
 * UserSession lock, so the cycle that would be required for a deadlock
 * ("two transactions each hold locks that the other wants", PostgreSQL 13.3.4)
 * cannot be formed.
 *
 * These tests pin that structural fact. They are MOCKS: they prove which
 * Prisma calls a code path makes, and therefore which transaction boundaries
 * it has. They do NOT prove PostgreSQL row-lock behaviour, transaction
 * visibility, or concurrency — that needs the design-only concurrency test.
 */
jest.mock("../../src/lib/prisma", () => {
  const client: any = {
    deliveryPerson: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    userSession: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    user: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
  };
  return { __esModule: true, default: client };
});

jest.mock("../../src/lib/session", () => ({
  __esModule: true,
  deleteAllUserSessions: jest.fn(async () => true),
  getUserSession: jest.fn(),
  resolveSessionRole: jest.fn(),
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisUsersSessions: {
    sMembers: jest.fn(async () => [] as string[]),
    del: jest.fn(async () => 1),
    scan: jest.fn(async () => ({ cursor: "0", keys: [] })),
  },
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => undefined),
}));

import prisma from "../../src/lib/prisma";
import { deleteAllUserSessions } from "../../src/lib/session";
import { setDeliveryPersonStatus } from "../../src/controllers/admin.controller";
import { DeliveryPersonStatus } from "@prisma/client";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const call = (status: DeliveryPersonStatus, userId = "u-1") =>
  setDeliveryPersonStatus(
    {
      user: { id: "admin-1", role: "ADMIN", sessionId: "s" },
      params: { userId },
      body: { status, reason: "test" },
      ip: "1.2.3.4",
      headers: {},
    } as never,
    res(),
  );

beforeEach(() => {
  jest.clearAllMocks();
  db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1", userId: "u-1", status: "ACTIVE" });
  db.deliveryPerson.update.mockImplementation(async (a: any) => ({
    id: "dp-1",
    ...a.data,
  }));
});

describe("admin rider-status path: no transaction spans DeliveryPerson and UserSession", () => {
  it("never opens a transaction, so the DeliveryPerson lock is released before session deletion", async () => {
    // THE load-bearing assertion. If someone later wraps this handler in
    // prisma.$transaction, the row lock WOULD be held across the session
    // deletion and the deadlock cycle would become real. This test fails then.
    await call(DeliveryPersonStatus.SUSPENDED);

    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("writes the profile in a standalone statement, then revokes sessions afterwards", async () => {
    const order: string[] = [];
    db.deliveryPerson.update.mockImplementation(async (a: any) => {
      order.push("profile-update");
      return { id: "dp-1", ...a.data };
    });
    (deleteAllUserSessions as jest.Mock).mockImplementation(async () => {
      order.push("revoke-sessions");
      return true;
    });

    await call(DeliveryPersonStatus.SUSPENDED);

    expect(order).toEqual(["profile-update", "revoke-sessions"]);
  });

  it("revoke-sessions never touches DeliveryPerson, so it cannot join the cycle", async () => {
    const { deleteAllUserSessions: real } = jest.requireActual("../../src/lib/session");
    jest.clearAllMocks();
    db.userSession.deleteMany.mockResolvedValue({ count: 3 });

    await real("u-1");

    expect(db.userSession.deleteMany).toHaveBeenCalledWith({ where: { userId: "u-1" } });
    // The real helper must not read or write DeliveryPerson at all.
    expect(db.deliveryPerson.findUnique).not.toHaveBeenCalled();
    expect(db.deliveryPerson.update).not.toHaveBeenCalled();
    expect(db.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it("SUSPENDED forces isOnline:false and revokes sessions", async () => {
    await call(DeliveryPersonStatus.SUSPENDED);

    expect(db.deliveryPerson.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-1" },
        data: { status: "SUSPENDED", isOnline: false },
      }),
    );
    expect(deleteAllUserSessions).toHaveBeenCalledWith("u-1");
  });

  it("documents existing behaviour: INACTIVE does NOT revoke sessions", async () => {
    // Not changed by this task — pinned so a future change is deliberate.
    // Note this asymmetry is also why the deadlock cannot form for INACTIVE:
    // that path takes no UserSession lock whatsoever.
    await call(DeliveryPersonStatus.INACTIVE);

    expect(db.deliveryPerson.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "INACTIVE" } }),
    );
    expect(deleteAllUserSessions).not.toHaveBeenCalled();
  });

  it("a session-revocation failure does not abort the status change", async () => {
    (deleteAllUserSessions as jest.Mock).mockRejectedValueOnce(new Error("redis down"));

    await call(DeliveryPersonStatus.SUSPENDED);

    // The handler catches and logs. The profile is still SUSPENDED, which is
    // what the socket's DeliveryPerson lock depends on.
    expect(db.deliveryPerson.update).toHaveBeenCalledTimes(1);
    const r = res();
    expect(r).toBeDefined();
  });
});
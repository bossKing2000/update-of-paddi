/**
 * Phase 1F.1 — Socket.IO security hardening regression tests.
 *
 * The socket handshake is an authenticated entry point: it grants a private
 * room and accepts driver location writes. Before Phase 1F.1 it only checked
 * the JWT signature, so a pre-password-change access token — or a revoked
 * session — could still open one.
 *
 * These tests drive the real `initSocket` connection handler with a mocked
 * socket, so the handshake authorization and the event-boundary revalidation
 * are exercised as written. No client library, no live Redis, no database.
 */
import { createServer } from "http";
import jwt from "jsonwebtoken";
import config from "../../src/config/config";
import { initSocket } from "../../src/socket";

// ── Mocks ───────────────────────────────────────────────────────────────────
// `socket.io` is replaced so `new SocketIOServer()` hands back a fake whose
// `on` captures the connection handler. That is the only way to reach the
// handler without a client library, and it means these tests exercise the real
// `initSocket` code rather than a reimplementation of it.

/** Every handler the fake server registers, keyed by event name. */
const capturedHandlers: Record<string, (...args: any[]) => any> = {};

jest.mock("socket.io", () => {
  const io: {
    on: jest.Mock;
  } = {
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      capturedHandlers[event] = handler;
      return io;
    }),
  };
  return { Server: jest.fn(() => io) };
});

// `src/socket.ts` constructs its own `new PrismaClient()` rather than importing
// the shared singleton, so the integration point is the PrismaClient
// constructor itself. Every construction returns the SAME object so the suite
// asserts against the methods the socket actually calls, no matter how many
// modules construct a client (the real `lib/session` does, via `lib/prisma`).
jest.mock("@prisma/client", () => {
  // Every `new PrismaClient()` in the module graph returns this ONE object, so
  // the suite asserts against the exact methods the socket calls regardless of
  // construction order — the real `lib/session` also builds a client via
  // `lib/prisma`, which runs before this file's body. It is created inside the
  // factory (which executes at import time) and handed back via `__shared`.
  type TxClient = Record<string, any>;
  const shared: TxClient = {
    user: { findUnique: jest.fn() },
    userSession: { findFirst: jest.fn() },
    deliveryPerson: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  };
  // The transaction client is a DISTINCT object. If it aliased `shared`, a
  // test could not tell a write committed inside the transaction from one
  // issued on the bare client — which is precisely the TOCTOU property under
  // test. `user`/`userSession` are shared so fixtures stay in one place.
  const tx: TxClient = {
    user: shared.user,
    userSession: shared.userSession,
    deliveryPerson: { findUnique: jest.fn(), updateMany: jest.fn() },
    $queryRaw: jest.fn(async () => []),
  };
  shared.$transaction = jest.fn(async (fn: (t: TxClient) => unknown): Promise<unknown> => fn(tx));
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    PrismaClient: jest.fn(() => shared),
    __shared: shared,
    __tx: tx,
    Prisma: {
      PrismaClientKnownRequestError,
      TransactionIsolationLevel: { Serializable: "Serializable", ReadCommitted: "ReadCommitted" },
    },
    // Task 3: riderEligibility.service reads DeliveryPersonStatus. Omitting it
    // made every location update fail with a TypeError that the socket's
    // authorization catch was (correctly) no longer swallowing.
    DeliveryPersonStatus: { ACTIVE: "ACTIVE", SUSPENDED: "SUSPENDED", INACTIVE: "INACTIVE" },
  };
});

jest.mock("../../src/lib/session", () => ({
  // Phase 1F.1: the socket now actually CALLS the real role resolver, so the
  // mock must provide it. Spreading the real module keeps this in step with
  // production resolution semantics instead of restating them here. The
  // override must come AFTER the spread so it wins.
  ...jest.requireActual("../../src/lib/session"),
  __esModule: true,
  getUserSession: jest.fn(),
}));

jest.mock("../../src/services/deliveryAssignment", () => ({
  __esModule: true,
  DeliveryAssignmentService: { broadcastDriverLocation: jest.fn() },
}));

import { PrismaClient } from "@prisma/client";
import * as PrismaModule from "@prisma/client";

import { getUserSession } from "../../src/lib/session";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";

const PrismaClientMock = PrismaClient as unknown as jest.Mock;
const getSession = getUserSession as jest.Mock;

// ── Fixtures ────────────────────────────────────────────────────────────────

const USER_ID = "u-1";
const SESSION_ID = "sess-1";
const TOKEN_VERSION = 3;

/** A live access token carrying the current version. */
function accessToken(over: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      id: USER_ID,
      role: "DELIVERY",
      sessionId: SESSION_ID,
      tokenVersion: TOKEN_VERSION,
      typ: "access",
      ...over,
    },
    config.jwtSecret,
  );
}

/** A token signed verbatim, for malformed or foreign shaped claims. */
function rawToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, config.jwtSecret);
}

/** A socket double that records handlers so events can be triggered. */
function fakeSocket(token: string | undefined) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  return {
    handlers,
    data: {} as Record<string, unknown>,
    // A real Socket always has a rooms Set; the handler logs it.
    rooms: new Set<string>(),
    handshake: { auth: token ? { token } : {} },
    disconnect: jest.fn(),
    join: jest.fn(),
    emit: jest.fn(),
    on: jest.fn((event: string, handler: any) => {
      handlers[event] = handler;
    }),
  };
}

/** Resolve the connection handler registered by initSocket. */
function connectionHandler() {
  const handler = capturedHandlers.connection;
  if (!handler) throw new Error("initSocket never registered a connection handler");
  return handler as (socket: any) => Promise<void>;
}

/**
 * Every `new PrismaClient()` in the module graph returns this same object (see
 * the `@prisma/client` mock above), so the suite asserts against the exact
 * methods the socket calls without depending on construction order.
 */
const txDb = (PrismaModule as any).__tx as {
  deliveryPerson: { findUnique: jest.Mock; updateMany: jest.Mock };
  $queryRaw: jest.Mock;
};
const db = (PrismaModule as any).__shared as {
  user: { findUnique: jest.Mock };
  userSession: { findFirst: jest.Mock };
  deliveryPerson: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  $transaction: jest.Mock;
};

/** Default healthy backend state. */
function healthyBackend() {
  getSession.mockResolvedValue({ activeRole: "DELIVERY", ip: "1.2.3.4" });
  // The transaction re-reads the session row from the DATABASE, so the mock
  // must answer that query too — the Redis-cached object above is only the
  // cheap pre-filter.
  db.userSession.findFirst.mockResolvedValue({ activeRole: "DELIVERY" });
  txDb.deliveryPerson.updateMany.mockResolvedValue({ count: 1 });
  // Task 3: persistDriverLocation now applies the shared operational
  // eligibility gate inside its transaction, so the default fixture must model
  // an APPROVED, ON-SHIFT rider with a verified email. Tests that need an
  // ineligible rider override this.
  txDb.deliveryPerson.findUnique.mockResolvedValue({
    id: "dp-1",
    status: "ACTIVE",
    isOnline: true,
    user: { isEmailVerified: true },
  });
  // Phase 1F.1: a session acting as DELIVERY implies the account HOLDS
  // DELIVERY (the same reason `authenticate` reads `account.roles`). The
  // socket revalidation is fail-closed, so a fixture that omits `roles` would
  // model an account that is not authorised for the role it is acting as.
  db.user.findUnique.mockResolvedValue({
    isBlocked: false,
    tokenVersion: TOKEN_VERSION,
    role: "DELIVERY",
    roles: ["DELIVERY"],
  });
}

async function connect(token: string | undefined) {
  const socket = fakeSocket(token);
  await connectionHandler()(socket);
  return socket;
}

let httpServer: ReturnType<typeof createServer>;

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
  // The whole suite runs under fake timers. Without this every connection
  // leaves a real 30s interval behind, and a test that never triggers the
  // disconnect path would keep the Node event loop alive until Jest times
  // the worker out. Under fake timers the interval never arms.
  jest.useFakeTimers();
  httpServer = createServer();
  initSocket(httpServer);
  healthyBackend();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  // Close the throwaway HTTP server so its handle does not outlive the test.
  httpServer?.close?.();
});

// ── Handshake ───────────────────────────────────────────────────────────────

describe("socket handshake authorization", () => {
  it("accepts a valid access token and records the authoritative facts", async () => {
    const socket = await connect(accessToken());

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.userId).toBe(USER_ID);
    expect(socket.data.sessionId).toBe(SESSION_ID);
    expect(socket.data.tokenVersion).toBe(TOKEN_VERSION);
    // The private room is the user's own id, never anything client-supplied.
    expect(socket.join).toHaveBeenCalledWith(USER_ID);
  });

  it("issues exactly one account lookup, never a redundant second one", async () => {
    await connect(accessToken());

    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
    expect(db.user.findUnique.mock.calls[0][0].select).toEqual(
      expect.objectContaining({ isBlocked: true, tokenVersion: true }),
    );
    // And one session lookup, which is what owns the ownership check.
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  it("rejects a request with no token", async () => {
    const socket = await connect(undefined);

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.data.userId).toBeUndefined();
  });

  it("rejects a refresh token offered as a socket credential", async () => {
    // Refresh tokens share the signing secret, so `typ` is the discriminator.
    const socket = await connect(rawToken({ id: USER_ID, tokenVersion: TOKEN_VERSION, sessionId: SESSION_ID }));

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.data.userId).toBeUndefined();
  });

  it("rejects an access token with no sessionId", async () => {
    const socket = await connect(accessToken({ sessionId: undefined }));

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.data.userId).toBeUndefined();
  });

  it("rejects a revoked session", async () => {
    getSession.mockResolvedValue(null);

    const socket = await connect(accessToken());

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.data.userId).toBeUndefined();
  });

  it("rejects a session belonging to a different user", async () => {
    // getUserSession itself scopes by userId, so another user's row reads null.
    getSession.mockResolvedValue(null);

    const socket = await connect(accessToken());

    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("rejects a token whose version predates the account's", async () => {
    // The password-change case: the token says 3, the account is now at 4.
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION + 1,
      role: "DELIVERY",
      roles: ["DELIVERY"],
    });

    const socket = await connect(accessToken());

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.data.userId).toBeUndefined();
  });

  it("rejects a blocked account", async () => {
    db.user.findUnique.mockResolvedValue({
      isBlocked: true,
      tokenVersion: TOKEN_VERSION,
      role: "DELIVERY",
      roles: ["DELIVERY"],
    });

    const socket = await connect(accessToken());

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.data.userId).toBeUndefined();
  });

  it("rejects when the account row cannot be read", async () => {
    db.user.findUnique.mockResolvedValue(null);

    const socket = await connect(accessToken());

    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("fails closed when the session store throws", async () => {
    getSession.mockRejectedValue(new Error("redis down"));

    const socket = await connect(accessToken());

    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("fails closed when the account lookup throws", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));

    const socket = await connect(accessToken());

    expect(socket.disconnect).toHaveBeenCalled();
  });
});

// ── Event-boundary revalidation ─────────────────────────────────────────────

describe("sensitive events revalidate at the boundary", () => {
  it("processes a location update while the session is still valid", async () => {
    const socket = await connect(accessToken());
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1", userId: USER_ID });
    db.deliveryPerson.update.mockResolvedValue({ id: "dp-1" });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    // Phase 1F.1: ownership is part of the WRITE statement, keyed by the
    // authenticated account — not a preceding lookup by driver id.
    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { latitude: 6.5, longitude: 3.3 },
    });
    // And it ran inside a SERIALIZABLE transaction so a concurrent role or
    // session change cannot slip between the check and the commit.
    expect(db.$transaction).toHaveBeenCalled();
    expect(db.$transaction.mock.calls[0][1]).toEqual(
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
  });

  it("refuses a location update once the session is revoked", async () => {
    const socket = await connect(accessToken());
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1", userId: USER_ID });
    getSession.mockResolvedValue(null);

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      "auth_revoked",
      expect.objectContaining({ reason: expect.stringMatching(/revoked|credentials/i) }),
    );
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a location update once the token version is stale", async () => {
    const socket = await connect(accessToken());
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1", userId: USER_ID });
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION + 1,
      role: "DELIVERY",
      roles: ["DELIVERY"],
    });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(socket.disconnect).toHaveBeenCalled();
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a location update once the account is blocked", async () => {
    const socket = await connect(accessToken());
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1", userId: USER_ID });
    db.user.findUnique.mockResolvedValue({
      isBlocked: true,
      tokenVersion: TOKEN_VERSION,
      role: "DELIVERY",
      roles: ["DELIVERY"],
    });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(socket.disconnect).toHaveBeenCalled();
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it("does not write a location for a user with no driver profile", async () => {
    const socket = await connect(accessToken());
    // The ownership-bounded write matches no row: the account owns no
    // DeliveryPerson record, so nothing is persisted.
    txDb.deliveryPerson.updateMany.mockResolvedValue({ count: 0 });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    // The ownership-bounded statement is still issued, but it matches no row,
    // so nothing is persisted. The observable proof that no side effect
    // occurred is the absence of the post-commit broadcast.
    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { latitude: 6.5, longitude: 3.3 },
    });
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith("error", {
      message: expect.stringMatching(/driver profile not found/i),
    });
    // No driver profile is not a revocation, so the connection survives.
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  for (const event of ["orderAccepted", "orderPickedUp", "orderDelivered"]) {
    it(`revalidates ${event} before any work happens`, async () => {
      const socket = await connect(accessToken());

      await socket.handlers[event]({ orderId: "o-1" });

      // Revalidation is exactly one session read plus one account read.
      expect(getSession).toHaveBeenCalledTimes(2);
      expect(db.user.findUnique).toHaveBeenCalledTimes(2);
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  }

  it("denies every sensitive event once the session is revoked", async () => {
    const socket = await connect(accessToken());
    getSession.mockResolvedValue(null);

    for (const event of ["updateLocation", "orderAccepted", "orderPickedUp", "orderDelivered"]) {
      await socket.handlers[event]({ orderId: "o-1" });
    }

    // One denial per sensitive event, and no write ever reached the database.
    expect(socket.disconnect).toHaveBeenCalledTimes(4);
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });
});

// ── Phase 1F.1: role staleness ───────────────────────────────────────────────

/**
 * The socket must never keep acting on the role captured at handshake.
 * `switchRole` deliberately does NOT bump `tokenVersion`, and a role can also
 * be revoked from the account, so neither the token-version bump nor the
 * handshake token's role claim detects either event. Only reading the
 * session's CURRENT activeRole and checking it against the account's CURRENT
 * `roles` does.
 */
describe("role staleness is revalidated, not inherited from the handshake", () => {
  /** Account that holds CUSTOMER and VENDOR; default role CUSTOMER. */
  function dualRoleAccount(over: Record<string, unknown> = {}) {
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION,
      role: "CUSTOMER",
      roles: ["CUSTOMER", "VENDOR"],
      ...over,
    });
  }

  it("handshake rejects a token whose role the account no longer holds", async () => {
    // Account was demoted to CUSTOMER only, but the token still claims VENDOR.
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    });

    const socket = await connect(accessToken({ role: "VENDOR" }));

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.data.userId).toBeUndefined();
  });

  it("handshake rejects a token whose role disagrees with the session's activeRole", async () => {
    // Same rule as HTTP `authenticate`: the session is the authority on which
    // role is in play, so a stale token role is as invalid here as on a request.
    dualRoleAccount();
    getSession.mockResolvedValue({ activeRole: "VENDOR", ip: "1.2.3.4" });

    const socket = await connect(accessToken({ role: "CUSTOMER" }));

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.data.userId).toBeUndefined();
  });

  it("handshake accepts a legacy session that has no activeRole, via the account role", async () => {
    // Pre-1E sessions read activeRole === null and must keep working.
    dualRoleAccount();
    getSession.mockResolvedValue({ activeRole: null, ip: "1.2.3.4" });

    const socket = await connect(accessToken({ role: "CUSTOMER" }));

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.activeRole).toBe("CUSTOMER");
  });

  it("records the session's current role, not merely the token's claim", async () => {
    dualRoleAccount();
    getSession.mockResolvedValue({ activeRole: "VENDOR", ip: "1.2.3.4" });

    const socket = await connect(accessToken({ role: "VENDOR" }));

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.activeRole).toBe("VENDOR");
  });

  it("refuses a protected event once the session role is no longer held", async () => {
    // Connect legitimately as VENDOR first...
    dualRoleAccount();
    getSession.mockResolvedValue({ activeRole: "VENDOR", ip: "1.2.3.4" });
    const socket = await connect(accessToken({ role: "VENDOR" }));
    expect(socket.disconnect).not.toHaveBeenCalled();
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1", userId: USER_ID });
    // ...then the account loses VENDOR while the socket stays open. tokenVersion
    // is unchanged, so only a role check can catch this.
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      "auth_revoked",
      expect.objectContaining({ reason: expect.stringMatching(/revoked|credentials/i) }),
    );
    // The protected write never happened.
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it("refreshes socket.data.activeRole after the session switches role", async () => {
    dualRoleAccount();
    getSession.mockResolvedValue({ activeRole: "VENDOR", ip: "1.2.3.4" });
    const socket = await connect(accessToken({ role: "VENDOR" }));
    expect(socket.data.activeRole).toBe("VENDOR");

    // Same session, now acting as CUSTOMER. The socket must not keep advertising
    // VENDOR to a future role-dependent handler.
    getSession.mockResolvedValue({ activeRole: "CUSTOMER", ip: "1.2.3.4" });
    dualRoleAccount();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(socket.data.activeRole).toBe("CUSTOMER");
    // A switch is legitimate: it is not a revocation, so no disconnect.
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("does not disconnect on a legitimate role switch, but the write is refused", async () => {
    dualRoleAccount();
    getSession.mockResolvedValue({ activeRole: "VENDOR", ip: "1.2.3.4" });
    const socket = await connect(accessToken({ role: "VENDOR" }));

    // The session switches to CUSTOMER. A switch is not a revocation, so the
    // socket must survive...
    getSession.mockResolvedValue({ activeRole: "CUSTOMER", ip: "1.2.3.4" });
    db.userSession.findFirst.mockResolvedValue({ activeRole: "CUSTOMER" });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(socket.disconnect).not.toHaveBeenCalled();
    // ...but it is no longer acting as DELIVERY, so the location write must not
    // happen at all. This is the approved policy, not a lost regression.
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when the account's roles cannot be read", async () => {
    // A missing/non-array `roles` is not evidence the role is held.
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1", userId: USER_ID });
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION,
      role: "DELIVERY",
    });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(socket.disconnect).toHaveBeenCalled();
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it("allows an account that has selected no role at all (null is established)", async () => {
    // `null` means "no role chosen yet" and is NOT the same as unknown, so it
    // must not be treated as a fail-closed condition.
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION,
      role: null,
      roles: [],
    });
    getSession.mockResolvedValue({ activeRole: null, ip: "1.2.3.4" });

    const socket = await connect(accessToken({ role: null }));

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.activeRole).toBeNull();
  });

  it("still enforces ownership: the driver profile is keyed by the token identity", async () => {
    // The client cannot redirect the write: the single update statement uses
    // socket.data.userId established at handshake, never anything supplied in
    // the event payload. There is no separate lookup to redirect.
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1", userId: USER_ID });
    db.deliveryPerson.update.mockResolvedValue({ id: "dp-1" });

    await socket.handlers.updateLocation({
      lat: 6.5,
      lng: 3.3,
      userId: "someone-else",
      driverId: "dp-999",
    } as never);

    // Task 3 added an eligibility READ on DeliveryPerson inside the same
    // transaction. That read decides permission only — it never establishes
    // ownership, so the property this test guards is unchanged and is asserted
    // on the WRITE's shape rather than on the absence of any lookup.
    //
    // The single eligibility read is keyed by the token identity too, and
    // selects nothing that could be redirected at another driver.
    for (const [args] of txDb.deliveryPerson.findUnique.mock.calls) {
      expect(args.where).toEqual({ userId: USER_ID });
    }
    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { latitude: 6.5, longitude: 3.3 },
    });
  });

  it("closes the connection on the periodic backstop once the role is revoked", async () => {
    // DELIVERY is the default healthy state, so this socket connects cleanly.
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    });

    await jest.advanceTimersByTimeAsync(30_000);

    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("does not disconnect when the account role is merely rotated but still held", async () => {
    // tokenVersion is untouched by switchRole; a pure role change must not be
    // mistaken for a credential revocation.
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    dualRoleAccount({ role: "VENDOR" });
    getSession.mockResolvedValue({ activeRole: "VENDOR", ip: "1.2.3.4" });

    await jest.advanceTimersByTimeAsync(30_000);

    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

// ── Phase 1F.1: the approved driver-location policy ─────────────────────────

/**
 * Approved policy: a location update commits ONLY when the session currently
 * has active DELIVERY, the account still holds DELIVERY, and the location
 * belongs to that account's OWN DeliveryPerson record. Owning the record alone
 * is not sufficient.
 */
describe("updateLocation enforces the approved DELIVERY policy", () => {
  /** Account holding only CUSTOMER, session acting as CUSTOMER. */
  function customerBackend() {
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    });
    getSession.mockResolvedValue({ activeRole: "CUSTOMER", ip: "1.2.3.4" });
    db.userSession.findFirst.mockResolvedValue({ activeRole: "CUSTOMER" });
  }

  /** Connect cleanly as a DELIVERY session. */
  async function connectDriver() {
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    expect(socket.disconnect).not.toHaveBeenCalled();
    return socket;
  }

  it("permits an authorised DELIVERY session to update its own location", async () => {
    const socket = await connectDriver();
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1" });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { latitude: 6.5, longitude: 3.3 },
    });
    expect(DeliveryAssignmentService.broadcastDriverLocation).toHaveBeenCalledWith(USER_ID);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("refuses a CUSTOMER-active session even though the account owns a driver record", async () => {
    // Ownership alone is explicitly NOT sufficient under the approved policy.
    customerBackend();
    const socket = await connect(accessToken({ role: "CUSTOMER" }));
    expect(socket.data.activeRole).toBe("CUSTOMER");

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith("error", {
      message: expect.stringMatching(/not authorised/i),
    });
    // Not a revocation: the session is still valid, just not a delivery one.
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("refuses an account that does not hold DELIVERY at all", async () => {
    const socket = await connectDriver();
    // DELIVERY stripped from the account while the session still claims it.
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION,
      role: "CUSTOMER",
      roles: ["CUSTOMER"],
    });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("refuses when the session row cannot be read inside the transaction", async () => {
    const socket = await connectDriver();
    db.userSession.findFirst.mockResolvedValue(null);

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("refuses a blocked account without persisting a location", async () => {
    const socket = await connectDriver();
    db.user.findUnique.mockResolvedValue({
      isBlocked: true,
      tokenVersion: TOKEN_VERSION,
      role: "DELIVERY",
      roles: ["DELIVERY"],
    });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("refuses when tokenVersion was invalidated", async () => {
    const socket = await connectDriver();
    db.user.findUnique.mockResolvedValue({
      isBlocked: false,
      tokenVersion: TOKEN_VERSION + 1,
      role: "DELIVERY",
      roles: ["DELIVERY"],
    });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("cannot be redirected to another delivery person by client-supplied ids", async () => {
    const socket = await connectDriver();

    await socket.handlers.updateLocation({
      lat: 6.5,
      lng: 3.3,
      userId: "victim-user",
      driverId: "dp-999",
      id: "dp-999",
    } as never);

    // The write is keyed by the authenticated account only.
    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { latitude: 6.5, longitude: 3.3 },
    });
    const where = txDb.deliveryPerson.updateMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("id");
    expect(where.userId).toBe(USER_ID);
  });

  it("rejects malformed coordinates instead of persisting them", async () => {
    const socket = await connectDriver();

    for (const bad of [
      { lat: Number.NaN, lng: 3.3 },
      { lat: 6.5, lng: Number.POSITIVE_INFINITY },
      { lat: "6.5", lng: "3.3" },
      {},
    ]) {
      await socket.handlers.updateLocation(bad as never);
    }

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
  });

  it("blocks updates until the active role returns to DELIVERY", async () => {
    const socket = await connectDriver();
    customerBackend();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();

    // Switch back to DELIVERY: the same socket may write again.
    healthyBackend();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });
    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ── Phase 1F.1: the TOCTOU race ─────────────────────────────────────────────

/**
 * The race the Serializable transaction exists to close: authorization used to
 * be read in one statement and the write committed in a later one, so a role
 * change or revocation landing BETWEEN them still produced a committed write.
 */
describe("updateLocation binds authorization to the write (TOCTOU)", () => {
  it("performs the authorization read and the write inside ONE transaction", async () => {
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1" });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    // A Serializable isolation level is what forces PostgreSQL to abort one of
    // two concurrent transactions that conflict on the authorization rows.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction.mock.calls[0][1]).toEqual(
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    // The write went through the TRANSACTION client, not the bare one. With a
    // single aliased mock this could not be observed at all.
    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalledTimes(1);
    expect(db.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it("re-reads session and account from the DATABASE, not the Redis cache", async () => {
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1" });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(db.userSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, sessionId: SESSION_ID } }),
    );
    // handshake, the pre-filter revalidation, and the authoritative in-transaction read.
    expect(db.user.findUnique).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a serialization failure outlasts the bounded retries", async () => {
    // Models "a concurrent authorization change wins every time": nothing may
    // be written and nothing may be broadcast.
    const { Prisma: PrismaNS } = PrismaModule as any;
    const conflict = () =>
      new PrismaNS.PrismaClientKnownRequestError("serialization failed", "P2034");
    db.$transaction.mockImplementation(async () => {
      throw conflict();
    });
    const socket = await connect(accessToken({ role: "DELIVERY" }));

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(db.$transaction).toHaveBeenCalledTimes(3); // bounded, not unbounded
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("retries a serialization failure and succeeds on a later attempt", async () => {
    const { Prisma: PrismaNS } = PrismaModule as any;
    const realTx = (PrismaModule as any).__shared.$transaction.getMockImplementation();
    let calls = 0;
    db.$transaction.mockImplementation(async (fn: (tx: any) => unknown) => {
      calls += 1;
      if (calls === 1) {
        throw new PrismaNS.PrismaClientKnownRequestError("serialization failed", "P2034");
      }
      return fn((PrismaModule as any).__tx);
    });
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1" });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalledTimes(1);
    expect(DeliveryAssignmentService.broadcastDriverLocation).toHaveBeenCalledWith(USER_ID);
    // keep the default implementation available for later tests
    db.$transaction.mockImplementation(realTx);
  });

  it("does NOT retry an unrelated error", async () => {
    db.$transaction.mockImplementation(async () => {
      throw new Error("connection refused");
    });
    const socket = await connect(accessToken({ role: "DELIVERY" }));

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
  });

  it("broadcasts only after the write commits, never before", async () => {
    const order: string[] = [];
    db.$transaction.mockImplementation(async (fn: (tx: any) => unknown) => {
      order.push("commit");
      return fn((PrismaModule as any).__tx);
    });
    (DeliveryAssignmentService.broadcastDriverLocation as jest.Mock).mockImplementation(
      async () => {
        order.push("broadcast");
      },
    );
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    db.deliveryPerson.findUnique.mockResolvedValue({ id: "dp-1" });

    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(order).toEqual(["commit", "broadcast"]);
    (DeliveryAssignmentService.broadcastDriverLocation as jest.Mock).mockReset();
  });
});

// ── Phase 1F.1: the lock protocol that closes the TOCTOU race ────────────────

/**
 * SERIALIZABLE alone does NOT protect these rows: the dependency is
 * one-directional, so PostgreSQL SSI had no cycle to abort on and both
 * transactions committed in the measured race. `FOR SHARE` makes the guarantee
 * unconditional because it conflicts with the `FOR UPDATE` that every
 * UPDATE/DELETE takes.
 */
describe("location write locks the authorization rows before reading them", () => {
  /**
   * A tagged template arrives as the strings array (`raw` on the cooked
   * array), so build the SQL by joining it with a placeholder.
   */
  const sqlOf = (call: any[]) => {
    const t = call[0];
    const parts = Array.isArray(t?.raw) ? t.raw : Array.isArray(t) ? t : [String(t)];
    return parts.join("?");
  };
  /** SQL text of each $queryRaw call, in order. */
  const lockSql = () => txDb.$queryRaw.mock.calls.map(sqlOf);

  beforeEach(async () => {
    await connect(accessToken({ role: "DELIVERY" }));
  });

  it("takes FOR SHARE on the User row", async () => {
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(lockSql().some((s: string) => /FROM "User"/.test(s) && /FOR SHARE/.test(s))).toBe(true);
  });

  it("takes FOR SHARE on the UserSession row", async () => {
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(
      lockSql().some((s: string) => /FROM "UserSession"/.test(s) && /FOR SHARE/.test(s)),
    ).toBe(true);
  });

  it("locks BEFORE reading authorization, so the read cannot be stale", async () => {
    const order: string[] = [];
    const realQuery = txDb.$queryRaw.getMockImplementation();
    txDb.$queryRaw.mockImplementation(async (t: any) => {
      order.push("lock");
      return realQuery ? await realQuery(t) : [];
    });
    db.userSession.findFirst.mockImplementation(async () => {
      order.push("read-session");
      return { activeRole: "DELIVERY" };
    });

    const socket = await connect(accessToken({ role: "DELIVERY" }));
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    // Both locks precede the in-transaction session read. (The pre-filter
    // `revalidateSocket` also reads the account, so the ordering assertion is
    // anchored on `read-session`, which only the transaction performs.)
    const readSession = order.indexOf("read-session");
    expect(readSession).toBeGreaterThan(-1);
    expect(order.slice(0, readSession)).toEqual(["lock", "lock"]);
  });

  it("locks with the session's OWN ids, never client-supplied ones", async () => {
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    await socket.handlers.updateLocation({
      lat: 6.5,
      lng: 3.3,
      userId: "attacker",
      sessionId: "attacker-session",
    } as never);

    const SQL = sqlOf;
    const userLock = txDb.$queryRaw.mock.calls.find((c: any[]) =>
      /^SELECT "id" FROM "User" WHERE/.test(SQL(c)),
    );
    expect(userLock).toBeDefined();
    expect(userLock![1]).toBe(USER_ID);

    const sessionLock = txDb.$queryRaw.mock.calls.find((c: any[]) =>
      /^SELECT "sessionId" FROM "UserSession" WHERE/.test(SQL(c)),
    );
    expect(sessionLock).toBeDefined();
    expect(sessionLock![1]).toBe(USER_ID);
    expect(sessionLock![2]).toBe(SESSION_ID);
  });

  it("re-locks on every retry, so a retry cannot reuse a stale authorization read", async () => {
    const { Prisma: PrismaNS } = PrismaModule as any;
    const realTx = db.$transaction.getMockImplementation();
    let attempts = 0;
    db.$transaction.mockImplementation(async (fn: (t: any) => unknown) => {
      attempts += 1;
      if (attempts === 1) {
        throw new PrismaNS.PrismaClientKnownRequestError("deadlock detected", "P2034");
      }
      return fn((PrismaModule as any).__tx);
    });

    const socket = await connect(accessToken({ role: "DELIVERY" }));
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    // Attempt 1 aborts before running the callback (a real abort releases the
    // locks it took), so the lock statements observed are the ones the RETRY
    // re-issued. All three are present => the retry re-ran the whole locked
    // sequence rather than reusing authorization from the failed attempt.
    //
    // Task 6 added the DeliveryPerson lock to that sequence (it is what makes
    // the eligibility read at :222 conflict with a concurrent suspension), so
    // the per-attempt count is now three, not two.
    expect(attempts).toBe(2);
    expect(txDb.$queryRaw).toHaveBeenCalledTimes(3);
    const sql = lockSql();
    expect(sql.some((q: string) => /^SELECT "id" FROM "User" WHERE/.test(q))).toBe(true);
    expect(sql.some((q: string) => /^SELECT "sessionId" FROM "UserSession" WHERE/.test(q))).toBe(true);
    expect(
      sql.some((q: string) => /^SELECT "id" FROM "DeliveryPerson" WHERE/.test(q)),
    ).toBe(true);
    db.$transaction.mockImplementation(realTx as any);
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe("socket lifecycle cleanup", () => {
  it("registers exactly one disconnect handler and clears the interval on it", async () => {
    const socket = await connect(accessToken());

    const disconnectRegistrations = socket.on.mock.calls.filter((c) => c[0] === "disconnect");
    expect(disconnectRegistrations).toHaveLength(1);

    // Timer cleanup must not throw, and must happen even if the emit throws.
    expect(() => socket.handlers.disconnect("client namespace disconnect")).not.toThrow();
  });

  it("closes the room connection when the periodic revalidation fails", async () => {
    // Backstop test. Runs under the suite-wide fake timers, so advancing past
    // the 30s interval fires it deterministically. Session already revoked.
    const socket = await connect(accessToken());
    getSession.mockResolvedValue(null);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("keeps the connection alive across a successful periodic revalidation", async () => {
    const socket = await connect(accessToken());

    await jest.advanceTimersByTimeAsync(30_000);

    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

/**
 * Task 3.1 — the rider-eligibility read inside the location transaction must
 * use the TRANSACTION-scoped client (`tx`), not the global one.
 *
 * Why this needs an explicit test: `riderEligibility.service.ts` defaults its
 * `client` parameter to the process-wide Prisma client from `lib/prisma`. A
 * caller inside a transaction that forgets to pass `tx` therefore gets a
 * different connection, OUTSIDE the open transaction, and still sees a
 * plausible-looking result — a silent correctness cliff. Prisma's own docs
 * name this the "Querying through db instead of tx" mistake.
 *
 * The suite's mock deliberately keeps `shared.deliveryPerson` and
 * `tx.deliveryPerson` as DISTINCT objects (see the factory comment), so these
 * assertions can actually tell the two apart.
 *
 * LIMITATION: mocked. This proves WHICH client object was called. It does not
 * prove PostgreSQL isolation, row locking, or anything about real concurrent
 * writers.
 */
describe("location eligibility is read through the transaction client", () => {
  beforeEach(() => {
    healthyBackend();
  });

  async function connectDriver() {
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    expect(socket.disconnect).not.toHaveBeenCalled();
    return socket;
  }

  it("reads eligibility from tx, and never from the global client", async () => {
    // Airtight discriminator: the GLOBAL client is poisoned with a profile
    // that would be REFUSED, while the transaction client holds a valid one.
    // If the implementation regressed to the global client, the write below
    // could not happen.
    db.deliveryPerson.findUnique.mockResolvedValue({
      id: "dp-1",
      status: "SUSPENDED",
      isOnline: false,
      user: { isEmailVerified: false },
    });
    txDb.deliveryPerson.findUnique.mockResolvedValue({
      id: "dp-1",
      status: "ACTIVE",
      isOnline: true,
      user: { isEmailVerified: true },
    });

    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        select: expect.objectContaining({ status: true, isOnline: true }),
      }),
    );
    // The global client must not be consulted for eligibility at all.
    expect(db.deliveryPerson.findUnique).not.toHaveBeenCalled();
    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalled();
  });

  it("performs the eligibility read and the location write on the SAME client", async () => {
    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    // Both operations are on `tx`, which is the object the suite reserves for
    // the transaction client — never on `shared`.
    expect(txDb.deliveryPerson.findUnique).toHaveBeenCalled();
    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalled();
    expect(db.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["no rider profile", null],
    [
      "a SUSPENDED rider",
      { id: "dp-1", status: "SUSPENDED", isOnline: true, user: { isEmailVerified: true } },
    ],
    [
      "an INACTIVE applicant",
      { id: "dp-1", status: "INACTIVE", isOnline: true, user: { isEmailVerified: true } },
    ],
    [
      "an on-shift rider with unverified email",
      { id: "dp-1", status: "ACTIVE", isOnline: true, user: { isEmailVerified: false } },
    ],
    [
      "an approved rider who is offline",
      { id: "dp-1", status: "ACTIVE", isOnline: false, user: { isEmailVerified: true } },
    ],
    [
      "a profile whose status could not be read",
      { id: "dp-1", status: undefined, isOnline: true, user: { isEmailVerified: true } },
    ],
  ])("fails closed for %s and writes nothing", async (_label, profile) => {
    txDb.deliveryPerson.findUnique.mockResolvedValue(profile);

    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
    // Denied, not disconnected: the socket stays up, matching every other
    // authorization outcome in this handler.
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("fails closed when the eligibility lookup itself throws", async () => {
    txDb.deliveryPerson.findUnique.mockRejectedValue(new Error("db unavailable"));

    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * Task 6 — the Socket.IO location / rider-suspension race.
 *
 * `persistDriverLocation` re-reads eligibility through the transaction client,
 * but until this task that read took NO lock. `setDeliveryPersonStatus`
 * suspends a rider with `prisma.deliveryPerson.update`, which takes an
 * implicit FOR UPDATE on the same row, so a suspension could commit between
 * the eligibility read and the location write — and the write still committed
 * and still returned `ok`, then broadcast the location.
 *
 * SERIALIZABLE does not close this: SSI aborts only on a CYCLE of
 * rw-antidependencies, and here the dependency is one-directional, exactly as
 * the socket's own protocol comment records for User/UserSession.
 *
 * LIMITATION: fully mocked. These tests prove the lock is issued, that it is
 * issued BEFORE the eligibility read, that eligibility failures write nothing
 * and emit nothing, and that retry re-issues it. They prove NOTHING about real
 * PostgreSQL row-lock conflicts, transaction visibility, or concurrency
 * serialization — see the design-only concurrency test in the Task 6 report.
 */
describe("Task 6: the DeliveryPerson row is locked before eligibility is read", () => {
  beforeEach(() => {
    healthyBackend();
  });

  // `sqlOf`/`lockSql` live inside an earlier describe in this file; they are
  // reproduced here so the SQL is read from the same $queryRaw mock calls.
  const sqlOf = (call: unknown[]) => {
    const t = call[0] as { raw?: unknown[] } | unknown[];
    const parts = Array.isArray((t as { raw?: unknown[] })?.raw)
      ? (t as { raw: unknown[] }).raw
      : Array.isArray(t)
        ? t
        : [String(t)];
    return parts.join("?");
  };
  const lockSql = () => txDb.$queryRaw.mock.calls.map((c: unknown[]) => sqlOf(c));

  async function connectDriver() {
    const socket = await connect(accessToken({ role: "DELIVERY" }));
    expect(socket.disconnect).not.toHaveBeenCalled();
    return socket;
  }

  it("takes a DeliveryPerson FOR UPDATE lock keyed by the caller's userId", async () => {
    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    const sql = lockSql();
    // sqlOf() renders template parameters as "?", so match on the statement
    // text and the lock mode rather than on Prisma's $1 placeholder form.
    expect(
      sql.some(
        (q: string) =>
          /FROM "DeliveryPerson"/.test(q) && /WHERE "userId"/.test(q) && /FOR UPDATE/.test(q),
      ),
    ).toBe(true);
    // Keyed by the authenticated identity, never by a client-supplied id.
    for (const q of sql) {
      expect(q).not.toContain("someone-else");
      expect(q).not.toContain("dp-999");
    }
  });

  it("issues the DeliveryPerson lock BEFORE the eligibility read", async () => {
    // Ordering is the entire fix: a lock taken after the read would not stop
    // the suspension from committing in between.
    const order: string[] = [];
    const origQuery = txDb.$queryRaw.getMockImplementation();
    txDb.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const raw = (args[0] as { raw?: unknown[] });
      const parts = Array.isArray(raw?.raw) ? raw.raw : [String(args[0])];
      if (parts.join(" ").includes("DeliveryPerson")) order.push("dp-lock");
      return origQuery ? origQuery(...(args as [])) : undefined;
    });
    const origFind = txDb.deliveryPerson.findUnique.getMockImplementation();
    txDb.deliveryPerson.findUnique.mockImplementation(async (args: any) => {
      order.push("eligibility-read");
      return origFind ? origFind(args) : ({} as never);
    });

    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(order.indexOf("dp-lock")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("dp-lock")).toBeLessThan(order.indexOf("eligibility-read"));
  });

  it("refuses the location write for a rider suspended before the transaction", async () => {
    txDb.deliveryPerson.findUnique.mockResolvedValue({
      id: "dp-1",
      status: "SUSPENDED",
      isOnline: false,
      user: { isEmailVerified: true },
    });

    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
  });

  it.each([
    ["no rider profile", null],
    ["INACTIVE applicant", { id: "dp-1", status: "INACTIVE", isOnline: true, user: { isEmailVerified: true } }],
    ["an approved rider who is offline", { id: "dp-1", status: "ACTIVE", isOnline: false, user: { isEmailVerified: true } }],
    ["an email-unverified rider", { id: "dp-1", status: "ACTIVE", isOnline: true, user: { isEmailVerified: false } }],
  ])("fails closed for %s: no write, no broadcast", async (_label, profile) => {
    txDb.deliveryPerson.findUnique.mockResolvedValue(profile);

    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
  });

  it("still refuses when the eligibility lookup throws, with no write", async () => {
    txDb.deliveryPerson.findUnique.mockRejectedValue(new Error("db unavailable"));

    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
    expect(DeliveryAssignmentService.broadcastDriverLocation).not.toHaveBeenCalled();
  });

  it("still refuses a blocked account at handshake, before any handler exists", async () => {
    // The DeliveryPerson lock is ADDITIONAL. Pre-existing gates are unchanged,
    // and a blocked account is in fact stopped earlier still: the handshake
    // rejects it, so `updateLocation` is never even registered.
    db.user.findUnique.mockResolvedValue({
      isBlocked: true,
      tokenVersion: TOKEN_VERSION,
      role: "DELIVERY",
      roles: ["DELIVERY"],
    });

    const socket = await connect(accessToken({ role: "DELIVERY" }));

    expect(socket.disconnect).toHaveBeenCalled();
    expect((socket.handlers as Record<string, unknown>).updateLocation).toBeUndefined();
    expect(txDb.deliveryPerson.updateMany).not.toHaveBeenCalled();
  });

  it("an eligible rider still writes exactly one location and broadcasts once", async () => {
    const socket = await connectDriver();
    await socket.handlers.updateLocation({ lat: 6.5, lng: 3.3 });

    expect(txDb.deliveryPerson.updateMany).toHaveBeenCalledTimes(1);
    expect(DeliveryAssignmentService.broadcastDriverLocation).toHaveBeenCalledWith(USER_ID);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

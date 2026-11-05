import { Server as SocketIOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import config from "./config/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { DeliveryAssignmentService } from "./services/deliveryAssignment";
import { getUserSession, deleteUserSession } from "./lib/session";
import { resolveSessionRole } from "./lib/session";
import { hasRole } from "./utils/roles";
import { AppError } from "./errors/AppError";
import {
  assertRiderOperational,
  loadRiderEligibility,
} from "./services/riderEligibility.service";
import { logger } from "./lib/logger";

const prisma = new PrismaClient();
let io: SocketIOServer | null = null;

/**
 * The role a socket is CURRENTLY authorised to act as.
 *
 * Mirrors `authenticate` (src/middlewares/auth.middleware.ts) exactly:
 *   * the session's `activeRole` wins, falling back to the account's global
 *     `role` for a legacy session that has none;
 *   * `null` means "no role selected yet" and is allowed through;
 *   * a role the account no longer holds is NOT authorised — fail closed,
 *     including when `roles` is missing or unreadable (`hasRole` treats a
 *     non-array as "not held").
 *
 * Returns `undefined` when the role cannot be safely established, which every
 * caller must treat as "refuse".
 */
function resolveAuthorisedSocketRole(
  session: { activeRole?: string | null } | null,
  account: { role: string | null; roles?: string[] } | null,
): string | null | undefined {
  if (!account) return undefined;
  const sessionRole = resolveSessionRole(session, account.role);
  if (sessionRole === null) return null;
  return hasRole({ roles: account.roles as never }, sessionRole as never)
    ? sessionRole
    : undefined;
}

/**
 * Revalidate a connected socket's authorization state.
 * Returns false if the socket should be disconnected.
 */
async function revalidateSocket(socket: Socket): Promise<boolean> {
  const userId = socket.data.userId;
  const sessionId = socket.data.sessionId;
  const tokenVersion = socket.data.tokenVersion;

  if (!userId || !sessionId || tokenVersion === undefined) {
    return false;
  }

  try {
    // One session lookup: the socket's session must still exist and belong to
    // this user (Redis cache first, with the PostgreSQL fallback built into
    // `getUserSession`).
    const session = await getUserSession(userId, sessionId);
    if (!session) {
      return false;
    }

    // One account lookup — the same authoritative shape `authenticate` already
    // reads: blocked state, the live tokenVersion, and the roles the account
    // is currently allowed to act as.
    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: { isBlocked: true, tokenVersion: true, role: true, roles: true },
    });
    if (!account || account.isBlocked) {
      return false;
    }

    // The authoritative invalidation. A password change, password reset, or
    // refresh-token replay bumps `tokenVersion`, so a socket whose token
    // predates the bump is refused here — independently of whether the session
    // row survived a failed sweep.
    if (account.tokenVersion !== tokenVersion) {
      return false;
    }

    // Phase 1F.1: the role must still be authorised AT THIS MOMENT. This is
    // the check that was missing: `switchRole` deliberately does NOT bump
    // `tokenVersion`, and a role can also be revoked out from under an open
    // socket, so neither the token-version bump nor the handshake token's role
    // claim detects either event.
    const authorisedRole = resolveAuthorisedSocketRole(session, account);
    if (authorisedRole === undefined) {
      return false;
    }

    // Publish the CURRENTLY authorised role so any role-dependent handler acts
    // on the session's role as it is right now, never on the role captured
    // from the handshake token. Re-derived from the authoritative read above
    // on every revalidation.
    socket.data.activeRole = authorisedRole;
    return true;
  } catch {
    // A failed lookup is not evidence of a valid session. Fail closed.
    return false;
  }
}

/**
 * Disconnect socket with reason
 */
function disconnectSocket(socket: Socket, reason: string) {
  console.log(`🔌 Socket disconnected: ${socket.data.userId} - ${reason}`);
  socket.emit("auth_revoked", { reason });
  socket.disconnect(true);
}

/** Outcome of the atomic, authorization-bound location write. */
type LocationWriteOutcome =
  | { kind: "ok"; driverId: string }
  | { kind: "revoked" }
  | { kind: "forbidden" }
  | { kind: "no_profile" };

/** Bounded attempts for the Serializable location transaction. Mirrors the
 *  established payout-claim retry (`admin.controller.ts`). */
const LOCATION_WRITE_MAX_ATTEMPTS = 3;

function isSerializationFailure(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  // P2034: Prisma surfaces transaction-level serialization aborts as P2034.
  if (err.code === "P2034") return true;
  // P2010: $queryRaw surfaces SSI aborts as a raw-query failure carrying the
  // PostgreSQL serialization SQLSTATE 40001 in its message (observed at
  // src/socket.ts:190-191 under concurrent FOR SHARE/FOR UPDATE contention).
  // Narrow to the serialization SQLSTATE so unrelated raw-query failures are
  // not retried. Retry is bounded by LOCATION_WRITE_MAX_ATTEMPTS and safe:
  // the transaction performs only reads plus one ownership-bounded write, and
  // the broadcast happens after commit, outside it.
  return (
    err.code === "P2010" &&
    typeof err.message === "string" &&
    (err.message.includes("40001") ||
      err.message.includes("could not serialize access"))
  );
}

/**
 * Phase 1F.1 — the approved driver-location policy, applied atomically.
 *
 * A location write is committed ONLY when, inside one SERIALIZABLE
 * transaction, the authorization state is re-read from the database and still
 * holds: the session exists, the account is not blocked, `tokenVersion` is
 * unchanged, and the session's CURRENT active role is `DELIVERY` and is still
 * one the account holds. The write itself is then constrained by
 * `where: { userId }`, so ownership is part of the same statement rather than a
 * prior lookup.
 *
 * Why the explicit `FOR SHARE` locks (see the protocol comment below):
 *   - SERIALIZABLE by itself does NOT close this race. PostgreSQL's SSI only
 *     aborts on a DANGEROUS STRUCTURE — a cycle of read/write dependencies.
 *     Here the dependency is one-directional (see below), so both transactions
 *     committed and an unauthorized location write persisted. Measured against
 *     real PostgreSQL, not assumed.
 *   - `FOR SHARE` makes the guarantee unconditional: it conflicts with the
 *     `FOR UPDATE` every UPDATE/DELETE takes, so any concurrent change to the
 *     authorization rows waits for this transaction to finish.
 *   - A change that commits strictly AFTER this transaction is unaffected —
 *     at that instant the write was correctly authorized, and the next event
 *     re-evaluates authorization from scratch.
 *
 * Retry is safe here because the transaction performs only database reads and
 * the single location write; the broadcast happens after commit, outside it.
 */
async function persistDriverLocation(
  socket: Socket,
  data: { lat: number; lng: number },
): Promise<LocationWriteOutcome> {
  const userId = socket.data.userId as string;
  const sessionId = socket.data.sessionId as string;
  const tokenVersion = socket.data.tokenVersion as number;

  const attempt = async (): Promise<LocationWriteOutcome> =>
    prisma.$transaction(
      async (tx) => {
        // ── Lock protocol (Phase 1F.1) ──────────────────────────────────────
        // SERIALIZABLE alone does NOT protect these rows. PostgreSQL's SSI
        // only aborts on a *dangerous structure* — a CYCLE of rw-antidependencies.
        // The location transaction reads User/UserSession and writes only
        // DeliveryPerson, while every authorization-changing writer touches
        // User/UserSession and never reads DeliveryPerson. That is a
        // ONE-DIRECTIONAL dependency with no cycle, so both transactions
        // committed in the measured race. (Verified against real PostgreSQL.)
        //
        // `FOR SHARE` fixes it by construction: it takes a shared row lock,
        // which CONFLICTS with the `FOR UPDATE` that any UPDATE or DELETE
        // implicitly takes. So a concurrent role switch, role revocation,
        // block, tokenVersion bump or session deletion now BLOCKS until this
        // transaction ends, and the authorization read below cannot be stale.
        //
        // Lock order is fixed (User, then UserSession) to match the foreign-key
        // hierarchy and give every path one consistent order. A deadlock would
        // surface as P2034 and be retried with a full re-read.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
        await tx.$queryRaw`SELECT "sessionId" FROM "UserSession" WHERE "userId" = ${userId} AND "sessionId" = ${sessionId} FOR SHARE`;

        // Authoritative re-read inside the transaction. The Redis-cached
        // session seen by `revalidateSocket` is only a cheap pre-filter; the
        // database is the authority for what actually commits.
        const session = await tx.userSession.findFirst({
          where: { userId, sessionId },
          select: { activeRole: true },
        });
        if (!session) return { kind: "revoked" } as const;

        const account = await tx.user.findUnique({
          where: { id: userId },
          select: { isBlocked: true, tokenVersion: true, role: true, roles: true },
        });
        if (!account || account.isBlocked) return { kind: "revoked" } as const;
        if (account.tokenVersion !== tokenVersion) return { kind: "revoked" } as const;

        // The approved policy: the session must currently be acting as
        // DELIVERY and the account must still hold it. Owning a DeliveryPerson
        // row alone is NOT sufficient.
const authorisedRole = resolveAuthorisedSocketRole(session, account);
        if (authorisedRole !== "DELIVERY") return { kind: "forbidden" } as const;

        // ── Task 6: lock the DeliveryPerson row before reading eligibility ───
        // The eligibility read below needs the SAME conflict guarantee the
        // `FOR SHARE` locks above give the User/UserSession rows — and it did
        // not have it. `loadRiderEligibility` is a plain SELECT: it takes no
        // lock, so `setDeliveryPersonStatus` (admin.controller.ts) could commit
        // `status = SUSPENDED` between that read and the location write below,
        // and this transaction would still persist the write and return `ok`.
        //
        // SERIALIZABLE does not save it. Exactly as the comment above records
        // for the other tables, SSI only aborts on a DANGEROUS STRUCTURE — a
        // CYCLE of rw-antidependencies. Here: this transaction READS
        // DeliveryPerson and WRITES it; the suspension WRITES it and never
        // reads it. That is a single rw-antidependency edge and a
        // write-write edge — no cycle — so both commit. Same one-directional
        // shape that the file's own "Verified against real PostgreSQL" note
        // describes for User/UserSession.
        //
        // FOR UPDATE (not FOR SHARE) because this transaction WRITES this row
        // moments later at the `updateMany` below. Taking FOR UPDATE up front
        // means it already holds the exclusive lock it needs, so there is no
        // lock upgrade that could queue behind a pending suspension request and
        // deadlock. It is the same idiom acceptBroadcast and assignOrder use
        // for the same row.
        //
        // Orderings:
        //   Suspension first -> it holds the row's FOR UPDATE, we block here,
        //                      it commits, the read below observes SUSPENDED
        //                      and the event is refused with no write.
        //   Location first  -> we hold the lock, the rider is eligible, the
        //                      write commits and the broadcast (which happens
        //                      after commit, outside this transaction) is
        //                      ordered strictly BEFORE the suspension, which
        //                      blocks at its own UPDATE until we finish.
        //
        // Lock order becomes User -> UserSession -> DeliveryPerson. No new lock
        // on User or UserSession, and isolation and retry are unchanged.
        await tx.$queryRaw`SELECT "id" FROM "DeliveryPerson" WHERE "userId" = ${userId} FOR UPDATE`;

        // Task 3: holding DELIVERY is identity, not permission. The same
        // operational gate the HTTP PATCH /api/delivery/location route applies,
        // read INSIDE this transaction so it cannot be stale. A suspended or
        // de-activated rider whose socket was already connected stops being
        // able to publish location immediately, without waiting for the
        // handshake to be re-run.
        try {
          assertRiderOperational(await loadRiderEligibility(userId, tx));
        } catch (e) {
          // Only an authorization failure becomes `forbidden`. A blanket catch
          // would silently convert an unexpected error (a bug, a missing enum in
          // a test double) into "you are not allowed", hiding the real cause.
          if (e instanceof AppError) return { kind: "forbidden" } as const;
          throw e;
        }

        // Ownership and the write are ONE statement: a client cannot name a
        // different driver, and the row cannot be swapped between a lookup
        // and the update.
        const written = await tx.deliveryPerson.updateMany({
          where: { userId },
          data: { latitude: data.lat, longitude: data.lng },
        });
        if (written.count === 0) return { kind: "no_profile" } as const;

        // `broadcastDriverLocation` resolves by USER id (see
        // deliveryAssignment.ts), so hand it the caller id — not the
        // DeliveryPerson row id, which would match zero rows.
        return { kind: "ok", driverId: userId } as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

  let lastError: unknown;
  for (let i = 0; i < LOCATION_WRITE_MAX_ATTEMPTS; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isSerializationFailure(err)) throw err;
      lastError = err;
    }
  }
  // Every attempt lost the race. Fail closed: nothing is written.
  console.warn("updateLocation: serialization contention, refusing write", lastError);
  return { kind: "revoked" };
}

/**
 * Periodic revalidation interval (30 seconds)
 */
const REVALIDATION_INTERVAL_MS = 30_000;

export function initSocket(server: any) {
  io = new SocketIOServer(server, {
    cors: {
      origin: config.allowedOrigins,
      credentials: true,
    },
  });

  io.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      console.log("❌ Socket rejected: No token");
      return socket.disconnect();
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret) as any;

      // A non-access token must never open a socket. Refresh tokens are signed
      // with the same secret, so the `typ` discriminator is the only thing that
      // keeps them out — and a token with no sessionId has no session to check.
      if (decoded.typ !== "access" || !decoded.sessionId) {
        console.log("❌ Socket rejected: not an access token");
        return socket.disconnect();
      }

      // `getUserSession` is the single authority on session existence AND
      // ownership: the Redis key is namespaced by userId+sessionId, and the
      // PostgreSQL fallback itself returns null when the row belongs to a
      // different user. A missing session here also means it was revoked.
      const session = await getUserSession(decoded.id, decoded.sessionId);
      if (!session) {
        console.log("❌ Socket rejected: session not found");
        return socket.disconnect();
      }

      // One account lookup, the same authoritative shape `authenticate` reads:
      // blocked state plus the live tokenVersion. A password change, password
      // reset, or refresh-token replay bumps that column, so a token predating
      // the bump is refused here even if its session row survived a failed
      // sweep — the guarantee holds for sockets exactly as it does for HTTP.
      const account = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { isBlocked: true, tokenVersion: true, role: true, roles: true },
      });
      if (!account || account.isBlocked) {
        console.log("❌ Socket rejected: account unavailable or blocked");
        return socket.disconnect();
      }
      if (account.tokenVersion !== decoded.tokenVersion) {
        console.log("❌ Socket rejected: stale token version");
        return socket.disconnect();
      }

      // Phase 1F.1: same role rules the HTTP `authenticate` middleware applies.
      // The session is the authority on which role is in play, so a token
      // whose role claim disagrees with it is as stale here as it would be on
      // the next HTTP request.
      const sessionRole = resolveAuthorisedSocketRole(session, account);
      if (sessionRole === undefined) {
        console.log("❌ Socket rejected: session role no longer authorised");
        return socket.disconnect();
      }
      if ((decoded.role ?? null) !== sessionRole) {
        console.log("❌ Socket rejected: token role out of date for this session");
        return socket.disconnect();
      }

      // Store the authoritative facts the revalidation interval needs. Nothing
      // read back out of `socket.data` is ever treated as proof of identity —
      // `revalidateSocket` re-reads all of it from the database instead, and
      // refreshes `activeRole` on every pass.
      socket.data.userId = decoded.id;
      socket.data.sessionId = decoded.sessionId;
      socket.data.tokenVersion = decoded.tokenVersion;
      socket.data.activeRole = sessionRole;

      console.log(`✅ Socket connected: user ${socket.data.userId}`);

      // Join room for targeted notifications
      socket.join(socket.data.userId);
      console.log("Rooms socket joined:", Array.from(socket.rooms));

      // ==========================
      // PERIODIC REVALIDATION
      // ==========================
      // A successful handshake must not permanently authorize a socket. This
      // interval is the backstop that catches revocation arriving on ANOTHER
      // device or request; it is deliberately NOT the only safeguard — every
      // sensitive handler below revalidates at its own boundary too, so a
      // revoked session is refused immediately on the next event rather than
      // waiting up to 30 seconds.
      const revalidationInterval = setInterval(async () => {
        const isValid = await revalidateSocket(socket);
        if (!isValid) {
          clearInterval(revalidationInterval);
          disconnectSocket(socket, "Session revoked or credentials changed");
        }
      }, REVALIDATION_INTERVAL_MS);

      // One disconnect handler: clears the interval AND logs. Registered once
      // so the timer is always cleaned up and the reason is logged in one place.
      socket.on("disconnect", (reason) => {
        clearInterval(revalidationInterval);
        console.log(`⚠️ User ${socket.data.userId} disconnected: ${reason}`);
      });

      // ==========================
      // DRIVER LOCATION UPDATES
      // ==========================
      socket.on("updateLocation", async (data: { lat: number; lng: number }) => {
        // Cheap pre-filter: session exists, account not blocked, tokenVersion
        // current, and the session's role is still one the account holds.
        // It can be stale, so it never authorises the write on its own —
        // `persistDriverLocation` re-reads everything inside the transaction.
        const isValid = await revalidateSocket(socket);
        if (!isValid) {
          disconnectSocket(socket, "Session revoked or credentials changed");
          return;
        }

        // Only numbers reach the database. A malformed payload is refused
        // rather than persisted as NaN/Infinity.
        if (
          !Number.isFinite(data?.lat) ||
          !Number.isFinite(data?.lng) ||
          typeof data.lat !== "number" ||
          typeof data.lng !== "number"
        ) {
          socket.emit("error", { message: "Invalid location coordinates" });
          return;
        }

        try {
          const outcome = await persistDriverLocation(socket, data);

          if (outcome.kind === "revoked") {
            disconnectSocket(socket, "Session revoked or credentials changed");
            return;
          }
          if (outcome.kind === "forbidden") {
            // The session is still perfectly valid — it simply is not acting as
            // DELIVERY right now. Refuse the write, keep the connection.
            socket.emit("error", { message: "Not authorised to update driver location" });
            return;
          }
          if (outcome.kind === "no_profile") {
            socket.emit("error", { message: "Driver profile not found" });
            return;
          }

          // Broadcast only after the write has committed, so a failed or
          // aborted transaction can never produce a broadcast with no write.
          await DeliveryAssignmentService.broadcastDriverLocation(outcome.driverId);
        } catch (err) {
          logger.error({ err, handler: "updateLocation" }, "Socket updateLocation handler error");
        }
      }); 

      // ==========================
      // ORDER EVENTS (PLACEHOLDERS)
      // ==========================
      socket.on("orderAccepted", async (data) => {
        // Revalidate before sensitive operation
        const isValid = await revalidateSocket(socket);
        if (!isValid) {
          disconnectSocket(socket, "Session revoked or credentials changed");
          return;
        }
        // TODO: Implement order acceptance logic with ownership check
      });

      socket.on("orderPickedUp", async (data) => {
        const isValid = await revalidateSocket(socket);
        if (!isValid) {
          disconnectSocket(socket, "Session revoked or credentials changed");
          return;
        }
        // TODO: Implement order picked up logic
      });

      socket.on("orderDelivered", async (data) => {
        const isValid = await revalidateSocket(socket);
        if (!isValid) {
          disconnectSocket(socket, "Session revoked or credentials changed");
          return;
        }
        // TODO: Implement order delivered logic
      });
    } catch (err) {
      console.log("❌ Socket rejected: Invalid token");
      socket.disconnect();
    }
  });

  console.log("🔥 Socket.IO initialized");
  return io;
}

/**
 * Get the current Socket.IO instance
 */
export function getIO(): SocketIOServer {
  if (!io) throw new Error(
    "Socket.IO not initialized! Call initSocket(server) first."
  );
  return io;
}

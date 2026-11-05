/**
 * Phase 1B — ADMIN/DELIVERY role-combination restrictions over the REAL HTTP path.
 *
 * Exercises the actual request/response contract for the role endpoints, end to
 * end: Express route -> `authenticate` (real JWT + real Redis session lookup +
 * real DB tokenVersion/role check) -> controller -> zod validation -> Prisma
 * writes. Nothing here re-implements the operation; the real controllers and
 * middleware are executed against the disposable PostgreSQL and Redis targets.
 *
 * Routes under test (mounted at /api/auth):
 *   POST /api/auth/select-role   — initial role selection
 *   POST /api/auth/become-vendor — CUSTOMER adds VENDOR
 *   POST /api/auth/switch-role   — session-scoped active-role switch
 *
 * Acceptance gap covered: ADMIN/DELIVERY cannot be granted or activated through
 * the role endpoints, and prohibited role combinations are refused with the
 * documented status codes from the real route/validation contracts.
 *
 * FAILS CLOSED unless REDIS_URL names the authorized disposable loopback target.
 */
import express from "express";
import request from "supertest";
import { generateAccessToken } from "../../src/utils/generateToken";
import { redisUsersSessions } from "../../src/lib/redis";
import authRoutes from "../../src/routes/auth.routes";
import { errorHandler } from "../../src/middlewares/error.middleware";
import prisma from "../../src/lib/prisma";
import type { Role } from "@prisma/client";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL || !REDIS_URL.startsWith("redis://127.0.0.1:")) {
  throw new Error(
    "[multiRoleHttpAuth] BLOCKED: REDIS_URL must name the authorized disposable loopback target.",
  );
}

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use(errorHandler);

const PREFIX = `u_http_${process.pid}_`;
const createdUsers: string[] = [];
const createdSessions: { userId: string; sessionId: string }[] = [];

const sessionKey = (userId: string, sessionId: string) =>
  `session:user:${userId}:${sessionId}`;

async function makeAuthedUser(over: {
  role?: Role | null;
  roles?: Role[];
  tokenVersion?: number;
  isEmailVerified?: boolean;
  activeRole?: Role | null;
} = {}) {
  const id = `${PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // `null ?? x` and `[] ?? x` would coerce explicit null/empty values; only
  // fall back when the caller did not pass the field at all.
  const role = over.role !== undefined ? over.role : "CUSTOMER";
  const roles = over.roles !== undefined ? over.roles : role != null ? [role] : [];
  const tokenVersion = over.tokenVersion ?? 1;
  const activeRole = over.activeRole !== undefined ? over.activeRole : role;

  await prisma.user.create({
    data: {
      id,
      name: id,
      email: `${id}@http.test`,
      password: "x",
      role,
      roles,
      tokenVersion,
      isEmailVerified: over.isEmailVerified ?? true,
    } as any,
  });
  createdUsers.push(id);

  const sessionId = `${id}_sess`;
  await prisma.userSession.create({
    data: { userId: id, sessionId, activeRole, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  createdSessions.push({ userId: id, sessionId });

  // Warm the REAL Redis cache (disposable DB 4) so authenticate's read-through
  // path is exercised, mirroring what a real login does.
  await redisUsersSessions.set(
    sessionKey(id, sessionId),
    JSON.stringify({ activeRole, lastLoginAt: new Date().toISOString() }),
    { EX: 300 },
  );

  const token = generateAccessToken(id, activeRole ?? null, sessionId, tokenVersion);
  return { id, sessionId, token, role, roles, tokenVersion };
}

const auth = (token: string, path: string) =>
  request(app).post(`/api/auth${path}`).set("Authorization", `Bearer ${token}`);
const statusOf = (res: any) => res.status;
const bodyOf = (res: any) => res.body;

beforeAll(async () => {
  await redisUsersSessions.connect().catch(() => {});
});

afterAll(async () => {
  for (const { userId, sessionId } of createdSessions) {
    await redisUsersSessions.del(sessionKey(userId, sessionId)).catch(() => {});
  }
  await redisUsersSessions.quit().catch(() => {});
  if (createdUsers.length) {
    await prisma.deliveryPerson.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.userSession.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  }
});

describe("Phase 1B — ADMIN/DELIVERY HTTP role restrictions", () => {
  it("rejects granting ADMIN via select-role (400 Invalid role)", async () => {
    const { id, sessionId, token } = await makeAuthedUser({ role: null, roles: [], activeRole: null });
    const res = await auth(token, "/select-role").send({ role: "ADMIN" }).expect(400);
    expect(bodyOf(res).message).toBe("Invalid role");
    // The account must still hold nothing — ADMIN was never granted.
    const acct = await prisma.user.findUnique({ where: { id }, select: { role: true, roles: true } });
    expect(acct?.role).toBeNull();
    expect(acct?.roles).toEqual([]);
  });

  it("allows select-role DELIVERY on a fresh account (200, solo DELIVERY)", async () => {
    const { id, sessionId, token } = await makeAuthedUser({ role: null, roles: [], activeRole: null });
    const res = await auth(token, "/select-role").send({ role: "DELIVERY" }).expect(200);
    expect(bodyOf(res).role).toBe("DELIVERY");
    const acct = await prisma.user.findUnique({ where: { id }, select: { role: true, roles: true } });
    expect(acct?.role).toBe("DELIVERY");
    expect(acct?.roles).toEqual(["DELIVERY"]);
  });

  it("refuses become-vendor for an ADMIN holder (403)", async () => {
    const { id, token } = await makeAuthedUser({ role: "ADMIN", roles: ["ADMIN"], activeRole: "ADMIN" });
    const res = await auth(token, "/become-vendor").send({ brandName: "Race Foods" }).expect(403);
    expect(bodyOf(res).message).toBe("ADMIN and DELIVERY accounts cannot become vendors");
    const acct = await prisma.user.findUnique({ where: { id }, select: { roles: true } });
    expect(acct?.roles).toEqual(["ADMIN"]);
  });

  it("refuses become-vendor for a DELIVERY holder (403)", async () => {
    const { id, token } = await makeAuthedUser({ role: "DELIVERY", roles: ["DELIVERY"], activeRole: "DELIVERY" });
    const res = await auth(token, "/become-vendor").send({ brandName: "Race Foods" }).expect(403);
    expect(bodyOf(res).message).toBe("ADMIN and DELIVERY accounts cannot become vendors");
    const acct = await prisma.user.findUnique({ where: { id }, select: { roles: true } });
    expect(acct?.roles).toEqual(["DELIVERY"]);
  });

  it("allows become-vendor for an eligible verified CUSTOMER (200, appends VENDOR)", async () => {
    const { id, token } = await makeAuthedUser({ role: "CUSTOMER", roles: ["CUSTOMER"], activeRole: "CUSTOMER" });
    const res = await auth(token, "/become-vendor").send({ brandName: "Race Foods" }).expect(200);
    expect(bodyOf(res).roles).toEqual(expect.arrayContaining(["CUSTOMER", "VENDOR"]));
    const acct = await prisma.user.findUnique({ where: { id }, select: { role: true, roles: true } });
    expect(acct?.roles).toEqual(expect.arrayContaining(["CUSTOMER", "VENDOR"]));
    expect(acct?.role).toBe("CUSTOMER"); // active role unchanged
  });

  it("refuses become-vendor with a missing brandName (422 validation)", async () => {
    const { token } = await makeAuthedUser({ role: "CUSTOMER", roles: ["CUSTOMER"], activeRole: "CUSTOMER" });
    await auth(token, "/become-vendor").send({}).expect(422);
  });

  it("refuses switch-role to a role the account does not hold: VENDOR (403)", async () => {
    const { id, token } = await makeAuthedUser({ role: "CUSTOMER", roles: ["CUSTOMER"], activeRole: "CUSTOMER" });
    const res = await auth(token, "/switch-role").send({ role: "VENDOR" }).expect(403);
    expect(bodyOf(res).message).toBe("Account does not hold the requested role");
    // Active role must not move.
    const sess = await prisma.userSession.findUnique({ where: { sessionId: `${id}_sess` } });
    expect(sess?.activeRole).toBe("CUSTOMER");
  });

  it("refuses activating DELIVERY via switch-role (403, account does not hold DELIVERY role)", async () => {
    const { token } = await makeAuthedUser({ role: "CUSTOMER", roles: ["CUSTOMER"], activeRole: "CUSTOMER" });
    await auth(token, "/switch-role").send({ role: "DELIVERY" }).expect(403);
  });

  it("allows switch-role CUSTOMER -> VENDOR on a dual holder (200) and invalidates the stale token", async () => {
    const { id, token, sessionId } = await makeAuthedUser({
      role: "CUSTOMER",
      roles: ["CUSTOMER", "VENDOR"],
      activeRole: "CUSTOMER",
    });

    // First switch CUSTOMER -> VENDOR succeeds and moves the session role.
    const first = await auth(token, "/switch-role").send({ role: "VENDOR" }).expect(200);
    expect(bodyOf(first).role).toBe("VENDOR");

    const sess = await prisma.userSession.findUnique({ where: { sessionId } });
    expect(sess?.activeRole).toBe("VENDOR");

    // The account-wide default role never moves.
    const acct = await prisma.user.findUnique({ where: { id }, select: { role: true, roles: true } });
    expect(acct?.role).toBe("CUSTOMER");
    expect(acct?.roles).toEqual(["CUSTOMER", "VENDOR"]);

    // Reusing the OLD token (still claiming CUSTOMER) is rejected because the
    // session is now the authority on the active role — this is the Phase 1E
    // "session is authority" behavior, not a defect.
    await auth(token, "/switch-role").send({ role: "CUSTOMER" }).expect(401);
  });
});
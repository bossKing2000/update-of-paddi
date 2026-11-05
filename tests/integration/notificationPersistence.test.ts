/**
 * Notification-persistence regression tests (real PostgreSQL).
 *
 * Gap closed: every previous notification assertion ran against mocked
 * Prisma/Redis, so no test proved that the application's real
 * notification-producing flow persists a real Notification row. This suite
 * drives the REAL business action (`changeVendorStatus`) and the REAL
 * notification service (`sendNotification`) against the disposable
 * PostgreSQL target and asserts the persisted rows field-by-field, plus
 * retrieval and privacy through the REAL retrieval controller
 * (`getMyNotifications` / `markNotificationAsRead`).
 *
 * What is deliberately NOT real here, and why:
 * - Redis is a neutral cold-cache stub (`get` → null, `set`/`del` → ok,
 *   `scanKeys` → []). The assertions under test are PostgreSQL persistence
 *   and controller retrieval scoping — both use real Prisma. The stub keeps
 *   test-owned keys off the shared development Redis and makes the run
 *   independent of Redis availability.
 * - Socket fan-out is genuinely unavailable in tests (`getIO()` throws
 *   without an initialized server). Production `sendNotification` catches
 *   that AFTER the Prisma create, so the row persists while the call
 *   returns null — the same degradation observed live in the PostgreSQL
 *   batch (Redis-down notify failures with intact commits). The suite
 *   asserts the persisted row, not the null return.
 *
 * No claim is made about connected-client Socket.IO receipt: no suitable
 * client library exists in this repository and none was added.
 */
import prisma from "../../src/lib/prisma";
import type { Role } from "@prisma/client";
import { VendorStatus as Status } from "@prisma/client";
import { changeVendorStatus } from "../../src/services/vendorStatus.service";
import {
  getMyNotifications,
  markNotificationAsRead,
} from "../../src/controllers/notificationController";

// Neutral cold-cache stand-in for Redis: real Prisma stays live, while no
// test-owned key ever reaches the shared development Redis.
jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisNotifications: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 0),
  },
  redisUsersSessions: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 0),
  },
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(async () => []),
}));

const VENDOR = "u_np";
const OTHER = "u_np_other";
const ADMIN = "u_np_admin";

async function makeUser(
  id: string,
  role: Role,
  overrides: Record<string, unknown> = {},
) {
  await prisma.user.create({
    data: {
      id,
      name: `Notif ${id}`,
      email: `${id}@np.test`,
      password: "x",
      role,
      roles: [role],
      tokenVersion: 1,
      isEmailVerified: true,
      ...overrides,
    } as any,
  });
}

async function reset() {
  await prisma.notification.deleteMany({
    where: { userId: { in: [VENDOR, OTHER] } },
  });
  await prisma.auditLog.deleteMany({
    where: { userId: { in: [VENDOR, OTHER, ADMIN] } },
  });
  await prisma.userSession.deleteMany({
    where: { userId: { in: [VENDOR, OTHER] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [VENDOR, OTHER, ADMIN] } },
  });

  await makeUser(VENDOR, "VENDOR" as Role, {
    brandName: `${VENDOR} Foods`,
    kycStatus: "VERIFIED",
  });
  await makeUser(OTHER, "CUSTOMER" as Role);
  await makeUser(ADMIN, "ADMIN" as Role);
}

function res() {
  const r: any = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
}
const bodyOf = (r: any) => r.json.mock.calls[0]?.[0]?.data;

function reqAs(userId: string, extra: Record<string, unknown> = {}) {
  return { user: { id: userId }, query: {}, params: {}, ...extra } as any;
}

/** Drives NULL → NEW → ACTIVE → SUSPENDED through the real admin path. */
async function runLifecycle() {
  await changeVendorStatus(VENDOR, Status.NEW, "intake review", ADMIN);
  await changeVendorStatus(VENDOR, Status.ACTIVE, undefined, ADMIN);
  await changeVendorStatus(VENDOR, Status.SUSPENDED, "policy violation", ADMIN);
}

async function cleanupFixtures() {
  await prisma.notification.deleteMany({
    where: { userId: { in: [VENDOR, OTHER] } },
  });
  await prisma.auditLog.deleteMany({
    where: { userId: { in: [VENDOR, OTHER, ADMIN] } },
  });
  await prisma.userSession.deleteMany({
    where: { userId: { in: [VENDOR, OTHER] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [VENDOR, OTHER, ADMIN] } },
  });
}

beforeEach(async () => {
  await reset();
});

afterAll(async () => {
  // Remove only rows this suite created; the next run's reset is idempotent.
  await cleanupFixtures();
  await prisma.$disconnect();
});

it("persists one exact notification row per lifecycle transition", async () => {
  await runLifecycle();

  const rows = await prisma.notification.findMany({
    where: { userId: VENDOR },
    orderBy: { createdAt: "asc" },
  });
  expect(rows).toHaveLength(3);

  expect(rows[0]).toMatchObject({
    userId: VENDOR,
    title: "Vendor account new",
    message: "Your vendor account status is now new: intake review",
    type: "GENERAL",
    read: false,
  });
  expect(rows[0].metadata).toEqual({ from: null, to: "NEW" });

  expect(rows[1]).toMatchObject({
    userId: VENDOR,
    title: "Vendor account active",
    message: "Your vendor account status is now active.",
    type: "GENERAL",
    read: false,
  });
  expect(rows[1].metadata).toEqual({ from: "NEW", to: "ACTIVE" });

  expect(rows[2]).toMatchObject({
    userId: VENDOR,
    title: "Vendor account suspended",
    message:
      "Your vendor account was suspended: policy violation Your listings are paused but your data is intact.",
    type: "GENERAL",
    read: false,
  });
  expect(rows[2].metadata).toEqual({ from: "ACTIVE", to: "SUSPENDED" });

  for (const row of rows) {
    expect(typeof row.id).toBe("string");
    expect(row.createdAt).toBeInstanceOf(Date);
  }
});

it("retrieves the persisted rows through the real retrieval path", async () => {
  await runLifecycle();

  const r = res();
  await getMyNotifications(reqAs(VENDOR), r);
  const data = bodyOf(r);

  expect(data.unreadCount).toBe(3);
  expect(data.pagination.total).toBe(3);
  expect(data.notifications).toHaveLength(3);
  // Newest first: the suspension notice leads.
  expect(data.notifications[0].title).toBe("Vendor account suspended");
  expect(data.notifications[0].userId).toBe(VENDOR);
  expect(data.notifications.map((n: any) => n.type)).toEqual([
    "GENERAL",
    "GENERAL",
    "GENERAL",
  ]);
});

it("scopes retrieval to the owner and enforces read privacy", async () => {
  await runLifecycle();

  // Another user sees none of the victim's rows.
  const rOther = res();
  await getMyNotifications(reqAs(OTHER), rOther);
  expect(bodyOf(rOther).pagination.total).toBe(0);
  expect(bodyOf(rOther).notifications).toEqual([]);

  const victimRow = await prisma.notification.findFirstOrThrow({
    where: { userId: VENDOR },
    orderBy: { createdAt: "asc" },
  });

  // A non-owner cannot mark the victim's notification as read.
  await expect(
    markNotificationAsRead(
      reqAs(OTHER, { params: { notificationId: victimRow.id } }),
      res(),
    ),
  ).rejects.toThrow("doesn't belong to you");
  expect(
    (await prisma.notification.findUnique({ where: { id: victimRow.id } }))!
      .read,
  ).toBe(false);

  // The owner can.
  const rRead = res();
  await markNotificationAsRead(
    reqAs(VENDOR, { params: { notificationId: victimRow.id } }),
    rRead,
  );
  expect(
    (await prisma.notification.findUnique({ where: { id: victimRow.id } }))!
      .read,
  ).toBe(true);

  // Retrieval reflects the new unread count.
  const rAfter = res();
  await getMyNotifications(reqAs(VENDOR), rAfter);
  expect(bodyOf(rAfter).unreadCount).toBe(2);
});

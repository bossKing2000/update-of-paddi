/**
 * Real-transport Socket.IO delivery regression test.
 *
 * Gap closed: every previous socket test drove the connection handler with a
 * mocked socket (or mocked `socket.io` itself), so no test proved that bytes
 * actually travel from the real server to a real client. This suite binds a
 * REAL HTTP server on loopback, runs the REAL `initSocket` implementation
 * (no `socket.io` mock), and connects with the REAL `socket.io-client`
 * package over a genuine Engine.IO transport.
 *
 * Flow exercised (all existing contracts, nothing invented):
 * - handshake auth with real JWT access tokens (`typ: "access"`, live
 *   `sessionId`, current `tokenVersion`) against real User/UserSession rows;
 * - driver `updateLocation` {lat,lng} → `persistDriverLocation` (real PG
 *   transaction) → `broadcastDriverLocation` → `driverLocationUpdate`
 *   {lat,lng} emitted to the order's customerId/vendorId rooms.
 *
 * Session reads use the real `getUserSession` (ambient local Redis cache
 * with PostgreSQL fallback); only test-scoped session keys are touched.
 * No event name, payload, room semantic, or message is invented here.
 */
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import { io as clientIO, type Socket as ClientSocket } from "socket.io-client";
import config from "../../src/config/config";
import { initSocket } from "../../src/socket";
import prisma from "../../src/lib/prisma";
import type { Role } from "@prisma/client";
import { DeliveryStatus } from "@prisma/client";
import type { Server as SocketIOServer } from "socket.io";

const DRIVER = "srt-driver";
const CUSTOMER = "srt-customer";
const VENDOR = "srt-vendor";
const OTHER = "srt-other";
const IDS = [DRIVER, CUSTOMER, VENDOR, OTHER];
const sessOf = (id: string) => `sess-${id}`;
const LAT = 6.5244;
const LNG = 3.3792;

function accessToken(id: string, role: string): string {
  // Real mechanism, test-only credentials. Tokens are never logged.
  return jwt.sign(
    { id, role, sessionId: sessOf(id), tokenVersion: 1, typ: "access" },
    config.jwtSecret,
  );
}

async function makeUser(id: string, role: Role) {
  await prisma.user.create({
    data: {
      id,
      name: `SocketRT ${id}`,
      email: `${id}@srt.test`,
      password: "x",
      role,
      roles: [role],
      tokenVersion: 1,
      isEmailVerified: true,
    } as any,
  });
  await prisma.userSession.create({
    data: {
      userId: id,
      sessionId: sessOf(id),
      activeRole: role,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
}

async function reset() {
  await prisma.deliveryAssignment.deleteMany({
    where: { order: { customerId: { in: IDS } } },
  });
  await prisma.order.deleteMany({
    where: { customerId: { in: IDS } },
  });
  await prisma.deliveryPerson.deleteMany({
    where: { userId: { in: IDS } },
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: IDS } } });
  await prisma.user.deleteMany({ where: { id: { in: IDS } } });

  await makeUser(DRIVER, "DELIVERY" as Role);
  await makeUser(CUSTOMER, "CUSTOMER" as Role);
  await makeUser(VENDOR, "VENDOR" as Role);
  await makeUser(OTHER, "CUSTOMER" as Role);

  // Explicit ACTIVE + ON SHIFT: this suite drives the real socket `updateLocation`
  // handler, which asserts operational eligibility (ACTIVE + verified email +
  // on shift). Since DeliveryPerson.status defaults to INACTIVE and isOnline
  // defaults to false, the fixture must approve the rider itself or the
  // location write is refused as "forbidden" and never broadcast.
  await prisma.deliveryPerson.create({ data: { userId: DRIVER, status: "ACTIVE", isOnline: true } });
  const order = await prisma.order.create({
    data: {
      customerId: CUSTOMER,
      vendorId: VENDOR,
      basePrice: 5000,
      totalPrice: 5500,
      status: "AWAITING_PAYMENT",
      idempotencyKey: "srt-key-1",
    },
  });
  const dp = await prisma.deliveryPerson.findUniqueOrThrow({
    where: { userId: DRIVER },
  });
  await prisma.deliveryAssignment.create({
    data: {
      orderId: order.id,
      deliveryPersonId: dp.id,
      status: DeliveryStatus.ACCEPTED,
    },
  });
}

let httpServer: HttpServer;
let io: SocketIOServer;
let url = "";
const clients: ClientSocket[] = [];

function connectClient(token?: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = clientIO(url, {
      auth: token ? { token } : {},
      reconnection: false,
      timeout: 5000,
    });
    clients.push(socket);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("client connect timed out"));
    }, 8000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForEvent<T>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });
}

function disconnectClient(socket: ClientSocket) {
  const i = clients.indexOf(socket);
  if (i >= 0) clients.splice(i, 1);
  if (socket.connected) socket.disconnect();
  else socket.close();
}

beforeAll(async () => {
  await reset();
  httpServer = createServer();
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = httpServer.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;
  io = initSocket(httpServer);
}, 60_000);

afterAll(async () => {
  for (const c of [...clients]) {
    try {
      disconnectClient(c);
    } catch {
      /* best-effort teardown */
    }
  }
  // Server-side 30s revalidation intervals die with their sockets; closing
  // the server releases anything left so no handle outlives the worker.
  io?.close();
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  await prisma.deliveryAssignment.deleteMany({
    where: { order: { customerId: { in: IDS } } },
  });
  await prisma.order.deleteMany({ where: { customerId: { in: IDS } } });
  await prisma.deliveryPerson.deleteMany({ where: { userId: { in: IDS } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: IDS } } });
  await prisma.user.deleteMany({ where: { id: { in: IDS } } });
  await prisma.$disconnect();
}, 60_000);

it("delivers the persisted driver location to the order customer and vendor rooms", async () => {
  const driver = await connectClient(accessToken(DRIVER, "DELIVERY"));
  const customer = await connectClient(accessToken(CUSTOMER, "CUSTOMER"));
  const vendor = await connectClient(accessToken(VENDOR, "VENDOR"));
  try {
    const customerGot = waitForEvent<{ lat: number; lng: number }>(
      customer,
      "driverLocationUpdate",
    );
    const vendorGot = waitForEvent<{ lat: number; lng: number }>(
      vendor,
      "driverLocationUpdate",
    );

    // Real Engine.IO transport through the real updateLocation handler.
    driver.emit("updateLocation", { lat: LAT, lng: LNG });

    // The payload must be EXACTLY what the server emits post-commit.
    await expect(customerGot).resolves.toEqual({ lat: LAT, lng: LNG });
    await expect(vendorGot).resolves.toEqual({ lat: LAT, lng: LNG });

    // And the server must have persisted the same coordinates first —
    // broadcast-after-commit is the production ordering guarantee.
    const persisted = await prisma.deliveryPerson.findUniqueOrThrow({
      where: { userId: DRIVER },
    });
    expect(persisted.latitude).toBeCloseTo(LAT, 5);
    expect(persisted.longitude).toBeCloseTo(LNG, 5);
  } finally {
    disconnectClient(driver);
    disconnectClient(customer);
    disconnectClient(vendor);
  }
});

it("does not deliver the private event to another authenticated user", async () => {
  const driver = await connectClient(accessToken(DRIVER, "DELIVERY"));
  const customer = await connectClient(accessToken(CUSTOMER, "CUSTOMER"));
  const other = await connectClient(accessToken(OTHER, "CUSTOMER"));
  let leaked: unknown;
  other.on("driverLocationUpdate", (payload) => {
    leaked = payload;
  });
  try {
    // Prove the broadcast happened on the wire before judging the negative.
    const customerGot = waitForEvent(customer, "driverLocationUpdate");
    driver.emit("updateLocation", { lat: LAT, lng: LNG });
    await expect(customerGot).resolves.toEqual({ lat: LAT, lng: LNG });

    // Bounded observation window AFTER proven delivery: rooms are per-user,
    // so the outsider must stay silent.
    await new Promise((r) => setTimeout(r, 1500));
    expect(leaked).toBeUndefined();
  } finally {
    disconnectClient(driver);
    disconnectClient(customer);
    disconnectClient(other);
  }
});

it("refuses an unauthenticated connection before any protected event", async () => {
  const socket = clientIO(url, { auth: {}, reconnection: false });
  clients.push(socket);
  try {
    // The server disconnects token-less sockets in the connection handler;
    // the client must observe a server-initiated disconnect, never a
    // successful authenticated session.
    const reason = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("unauthenticated socket was not refused")),
        5000,
      );
      socket.on("disconnect", (r: string) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
    expect(reason).toBe("io server disconnect");
  } finally {
    disconnectClient(socket);
  }
});

/**
 * Stage F (E-02) — P2002 race-loser reuse at the controller level.
 * All externals mocked (no Paystack, no Redis, no DB): proves that when
 * the partial unique backstop rejects a loser insert, the application
 * rereads the winner and returns the existing contract — never a second
 * Paystack init/charge, never a second row, never a bare 500.
 */
import { Prisma } from "@prisma/client";
import axios from "axios";
import {
  initiateOrderPayment,
  chargeSavedCard,
} from "../../src/controllers/paymentController";
import prisma from "../../src/lib/prisma";
import { acquireLock, releaseLock } from "../../src/lib/redisLock";
import { initializePayment } from "../../src/services/paymentService";
import { finalizePaymentSuccess } from "../../src/services/paymentFinalizer.service";

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    order: { findMany: jest.fn(), updateMany: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    payment: { findFirst: jest.fn(), create: jest.fn() },
    userPaymentMethod: { findFirst: jest.fn() },
    auditLog: { create: jest.fn(async () => ({})) },
  },
}));
jest.mock("../../src/lib/redisLock", () => ({
  acquireLock: jest.fn(async () => ({ key: "k", token: "t" })),
  releaseLock: jest.fn(async () => true),
}));
jest.mock("../../src/services/paymentService", () => ({
  initializePayment: jest.fn(async () => ({
    reference: "PSK-INIT",
    authorization_url: "https://paystack.test/init",
    access_code: "ac",
  })),
  verifyPayment: jest.fn(),
  SUPPORTED_CHANNELS: ["card", "bank", "ussd", "bank_transfer"],
}));
jest.mock("../../src/services/paymentFinalizer.service", () => ({
  finalizePaymentSuccess: jest.fn(async () => ({ outcome: "SUCCESS", orders: [] })),
}));
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

const mockedPrisma = prisma as unknown as {
  order: { findMany: jest.Mock; updateMany: jest.Mock };
  user: { findUnique: jest.Mock; findMany: jest.Mock };
  payment: { findFirst: jest.Mock; create: jest.Mock };
  userPaymentMethod: { findFirst: jest.Mock };
  auditLog: { create: jest.Mock };
};
const mockedInit = initializePayment as jest.Mock;
const mockedFinalize = finalizePaymentSuccess as jest.Mock;
const mockedAxiosPost = (axios.post as unknown) as jest.Mock;

const FUTURE = new Date(Date.now() + 10 * 60_000);
// Deliberately far-past (not just expired): toUtc() shifts Date inputs by
// the host timezone offset, so a merely-minutes-old expiry is
// timezone-fragile in test environments. See Stage F finding E-08.
const PAST = new Date(Date.now() - 25 * 60 * 60_000);

function mockReq(body: object) {
  return {
    user: { id: "u1" },
    body,
    headers: {},
    params: {},
    query: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as never;
}
function mockRes() {
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnThis(), json } as never;
  return { res, json };
}
function batchOrders() {
  return [
    {
      id: "o1",
      customerId: "u1",
      vendorId: "v1",
      status: "AWAITING_PAYMENT",
      totalPrice: 5500,
      payments: [],
      items: [{ product: { id: "p", name: "P", archived: false } }],
    },
  ];
}
function liveVendors() {
  return [
    {
      id: "v1",
      name: "V",
      brandName: "VB",
      isLive: true,
      vendorStatus: "ACTIVE",
      deliveryPreferences: null,
    },
  ];
}
function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

// sendSuccess/sendCreated wrap payloads as { success, message, data }.
function expectPayload(json: jest.Mock, data: object, message?: string) {
  expect(json).toHaveBeenCalledTimes(1);
  const envelope = json.mock.calls[0][0] as {
    success: boolean;
    message: string;
    data: unknown;
  };
  expect(envelope.success).toBe(true);
  expect(envelope.data).toEqual(expect.objectContaining(data));
  if (message !== undefined) expect(envelope.message).toBe(message);
}

beforeEach(() => {
  jest.clearAllMocks();
  (acquireLock as jest.Mock).mockResolvedValue({ key: "k", token: "t" });
  (releaseLock as jest.Mock).mockResolvedValue(true);
  mockedPrisma.order.findMany.mockResolvedValue(batchOrders());
  mockedPrisma.order.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.user.findMany.mockResolvedValue(liveVendors());
  mockedPrisma.user.findUnique.mockResolvedValue({ id: "u1", email: "u@x.test" });
  mockedPrisma.userPaymentMethod.findFirst.mockResolvedValue({
    id: "m1",
    cardToken: "tok",
    userId: "u1",
  });
  mockedInit.mockResolvedValue({
    reference: "PSK-INIT",
    authorization_url: "https://paystack.test/init",
    access_code: "ac",
  });
  mockedAxiosPost.mockResolvedValue({
    data: { data: { status: "success", reference: "PSK-SC", amount: 550000 } },
  });
});

function winnerRow(reference = "PSK-WIN", status = "PENDING") {
  return {
    id: "pay-win",
    reference,
    status,
    userId: "u1",
    idempotencyKey: "k1",
    startedAt: new Date(),
    createdAt: new Date(),
    expiresAt: FUTURE,
    paystackData: { authorization_url: "https://paystack.test/win" },
  };
}

describe("E-02 P2002 reread/reuse", () => {
  it("normal path: P2002 on create reuses the winner, no second Paystack init", async () => {
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.payment.create.mockRejectedValueOnce(p2002());
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(winnerRow());
    const { res, json } = mockRes();
    await initiateOrderPayment(mockReq({ idempotencyKey: "k1" }), res);
    expect(mockedInit).toHaveBeenCalledTimes(1);
    expectPayload(json, { reference: "PSK-WIN" }, "Payment already initialized");
  });

  it("normal path: non-P2002 create errors are rethrown, not swallowed", async () => {
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.payment.create.mockRejectedValueOnce(new Error("db down"));
    const { res } = mockRes();
    await expect(
      initiateOrderPayment(mockReq({ idempotencyKey: "k1" }), res),
    ).rejects.toThrow("db down");
  });

  it("saved-card: P2002 on success-create reuses winner PENDING without finalize", async () => {
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.payment.create.mockRejectedValueOnce(p2002());
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(winnerRow());
    const { res, json } = mockRes();
    await chargeSavedCard(mockReq({ idempotencyKey: "k1", cardId: "m1" }), res);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockedFinalize).not.toHaveBeenCalled();
    expectPayload(
      json,
      { reference: "PSK-WIN" },
      "Payment already in progress for this order",
    );
  });

  it("saved-card: P2002 resolves to OTP continuation when winner is INITIATED", async () => {
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.payment.create.mockRejectedValueOnce(p2002());
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(
      winnerRow("PSK-OTP", "INITIATED"),
    );
    const { res, json } = mockRes();
    await chargeSavedCard(mockReq({ idempotencyKey: "k1", cardId: "m1" }), res);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0].data).toEqual({
      requiresOtp: true,
      reference: "PSK-OTP",
    });
    expect(json.mock.calls[0][0].message).toBe(
      "OTP required to complete this charge",
    );
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it("saved-card: P2002 on OTP-create reuses winner without charging again", async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: { data: { status: "send_otp", reference: "PSK-LOSE" } },
    });
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.payment.create.mockRejectedValueOnce(p2002());
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(winnerRow());
    const { res, json } = mockRes();
    await chargeSavedCard(mockReq({ idempotencyKey: "k1", cardId: "m1" }), res);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    expectPayload(json, { reference: "PSK-WIN" });
  });

  it("saved-card: existing active payment is reused with no charge and no create", async () => {
    mockedPrisma.payment.findFirst.mockResolvedValueOnce(winnerRow());
    const { res, json } = mockRes();
    await chargeSavedCard(mockReq({ idempotencyKey: "k1", cardId: "m1" }), res);
    expect(mockedAxiosPost).not.toHaveBeenCalled();
    expect(mockedPrisma.payment.create).not.toHaveBeenCalled();
    expectPayload(
      json,
      { reference: "PSK-WIN" },
      "Payment already in progress for this order",
    );
  });

  it("saved-card: expired existing payment proceeds to a fresh charge", async () => {
    mockedPrisma.payment.findFirst.mockResolvedValueOnce({
      ...winnerRow(),
      expiresAt: PAST,
    });
    mockedPrisma.payment.create.mockResolvedValueOnce({ id: "pay-new" });
    const { res } = mockRes();
    await chargeSavedCard(mockReq({ idempotencyKey: "k1", cardId: "m1" }), res);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.payment.create).toHaveBeenCalledTimes(1);
  });
});

describe("lock timeout fail-closed", () => {
  it("normal path: a Redis timeout acquiring the lock throws — no Paystack init, no payment row", async () => {
    (acquireLock as jest.Mock).mockRejectedValueOnce(new Error("Command timed out"));
    const { res } = mockRes();
    await expect(
      initiateOrderPayment(mockReq({ idempotencyKey: "k1" }), res),
    ).rejects.toThrow("Command timed out");
    // Fail-closed: the request never reached Paystack and never wrote a row.
    expect(mockedInit).not.toHaveBeenCalled();
    expect(mockedPrisma.payment.create).not.toHaveBeenCalled();
  });

  it("saved-card: a Redis timeout acquiring the lock throws — no charge, no payment row", async () => {
    (acquireLock as jest.Mock).mockRejectedValueOnce(new Error("Command timed out"));
    const { res } = mockRes();
    await expect(
      chargeSavedCard(mockReq({ idempotencyKey: "k1", cardId: "m1" }), res),
    ).rejects.toThrow("Command timed out");
    expect(mockedAxiosPost).not.toHaveBeenCalled();
    expect(mockedPrisma.payment.create).not.toHaveBeenCalled();
  });
});

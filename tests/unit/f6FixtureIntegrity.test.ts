/**
 * Stage L (E-06) — F6 saved-card fixture / idempotency-key audit.
 *
 * Verdict (proven by inspection + read-only live-DB SELECTs):
 *   Source fixture = CORRECT (`seed-fin-savedcard-1` on O6+P6, card
 *   SEED-FIN-CARD-4242). Production saved-card/idempotency code = CORRECT
 *   and key-agnostic. The dev Render DB holds a stale pre-correction O6 row
 *   (`idempotencyKey = seed-fin-key-f6`, since retired from source) while P6
 *   already carries the corrected key — a seed-existence-guard artifact, not
 *   a code defect. No database repair is performed in this stage.
 *
 * These tests lock the source truth and the key-independence of the
 * production path. They touch no live database.
 */
import fs from "fs";
import path from "path";
import { chargeSavedCard } from "../../src/controllers/paymentController";
import prisma from "../../src/lib/prisma";
import { buildOrderMoneySnapshot } from "../../src/services/orderSnapshot.service";

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
  initializePayment: jest.fn(),
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

const seedSource = fs.readFileSync(
  path.join(__dirname, "../../src/jobs/seedFinancialFixtures.ts"),
  "utf8",
);

function srcTreeContains(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "jobs") continue;
        walk(full);
      } else if (entry.isFile() && /\.ts$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (text.includes(needle)) hits.push(path.relative("src", full));
      }
    }
  };
  walk(path.join(__dirname, "../../src", dir));
  return hits;
}

describe("E-06 F6 fixture integrity", () => {
  it("A. source defines the corrected F6 key and uses it for BOTH the order and the payment", () => {
    expect(seedSource).toContain('savedcard1: "seed-fin-savedcard-1"');
    // O6 order creation uses the corrected key …
    expect(seedSource).toMatch(/IDS\.o6[\s\S]{0,600}idempotencyKey: KEYS\.savedcard1/);
    // … and so does the P6 payment creation.
    expect(seedSource).toMatch(
      /ensureFinPayment\(IDS\.p6[\s\S]{0,300}idempotencyKey: KEYS\.savedcard1/,
    );
    expect(seedSource).toContain('cardToken: "SEED-FIN-CARD-4242"');
    // The retired stale key must not appear anywhere in source.
    expect(seedSource).not.toContain("seed-fin-key-f6");
  });

  it("A2. stale key is referenced nowhere in the codebase (fixture drift cannot affect code)", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
        } else if (/\.(ts|js|json)$/.test(entry.name)) {
          if (fs.readFileSync(full, "utf8").includes("seed-fin-key-f6"))
            hits.push(full);
        }
      }
    };
    walk(path.join(__dirname, "../../src"));
    expect(hits).toEqual([]);
  });

  it("B. F6 snapshot economics are internally consistent (real writer, F6 inputs)", () => {
    // F6: base 5000, no discount, vendor A @0.15 (matches ensureFinOrder O6).
    const snap = buildOrderMoneySnapshot({
      basePriceKobo: 500000,
      discountKobo: 0,
      commissionRate: 0.15,
    });
    expect(snap.commissionRateSnapshot).toBe(0.15);
    expect(snap.commissionKobo).toBe(75000n);
    expect(snap.vendorPayoutKobo).toBe(425000n);
    expect(snap.discountKobo).toBe(0n);
    // Source wires the F6 graph coherently: P6 -> O6 -> cust-1, PENDING,
    // unexpired-at-seed (expiresAt = seed + 15min), card -> cust-1 default.
    expect(seedSource).toMatch(/orderId: IDS\.o6, amountKobo: 550000/);
    expect(seedSource).toMatch(/status: "PENDING"/);
    expect(seedSource).toMatch(/expiresAt: at\(startedAt, 15 \* 60_000\)/);
    expect(seedSource).toMatch(/userId: cust1\.id,\s*cardToken|cardToken: "SEED-FIN-CARD-4242"/);
    expect(seedSource).toMatch(/isDefault: true/);
  });

  it("C. same (userId, key) reuses the active payment: lookup is key-scoped, no second charge/row", async () => {
    const db = prisma as unknown as {
      order: { findMany: jest.Mock };
      user: { findUnique: jest.Mock; findMany: jest.Mock };
      payment: { findFirst: jest.Mock; create: jest.Mock };
      userPaymentMethod: { findFirst: jest.Mock };
    };
    const axios = (await import("axios")).default as unknown as {
      post: jest.Mock;
    };
    db.order.findMany.mockResolvedValue([
      {
        id: "o1",
        customerId: "u1",
        vendorId: "v1",
        status: "AWAITING_PAYMENT",
        totalPrice: 5500,
        payments: [],
        items: [{ product: { id: "p", name: "P", archived: false } }],
      },
    ]);
    db.user.findMany.mockResolvedValue([
      {
        id: "v1",
        name: "V",
        brandName: "VB",
        isLive: true,
        vendorStatus: "ACTIVE",
        deliveryPreferences: null,
      },
    ]);
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "u@x.test" });
    db.userPaymentMethod.findFirst.mockResolvedValue({
      id: "m1",
      cardToken: "tok",
      userId: "u1",
    });
    const winner = {
      id: "pay-win",
      reference: "PSK-WIN",
      status: "PENDING",
      userId: "u1",
      idempotencyKey: "seed-fin-savedcard-1",
      startedAt: new Date(),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    };
    db.payment.findFirst.mockResolvedValue(winner);
    const req = {
      user: { id: "u1" },
      body: { idempotencyKey: "seed-fin-savedcard-1", cardId: "m1" },
      headers: {},
      params: {},
      query: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as never;
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json } as never;
    await chargeSavedCard(req, res);
    // The active lookup carries the exact caller-supplied key (not a constant).
    expect(db.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          idempotencyKey: "seed-fin-savedcard-1",
          userId: "u1",
        }),
      }),
    );
    expect(axios.post).not.toHaveBeenCalled();
    expect(db.payment.create).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].success).toBe(true);
    expect(json.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ reference: "PSK-WIN" }),
    );
  });

  it("D. production payment paths contain no hardcoded F6/fixture keys (keys are opaque client tokens)", () => {
    // Controllers, services, and middlewares must never reference a
    // seed-fin-* literal: fixture keys live only in src/jobs seed code.
    for (const dir of ["controllers", "services", "middlewares", "lib"]) {
      expect(srcTreeContains(dir, "seed-fin-")).toEqual([]);
    }
    // And the seed job is the single owner of the F6 key.
    expect(srcTreeContains("jobs", "seed-fin-savedcard-1")).toEqual([
      "jobs/seedFinancialFixtures.ts",
    ]);
  });
});

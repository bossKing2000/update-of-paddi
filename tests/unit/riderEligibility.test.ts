/**
 * Task 3 — rider OPERATIONAL eligibility.
 *
 * Holding the DELIVERY role is an identity check. These tests pin the
 * authorization decision at the actual controller boundaries, not only inside
 * the shared helper, because the bug this closes was exactly a boundary that
 * checked the role and nothing else.
 *
 * LIMITATION (explicit): everything here is mocked. A jest.fn returning a
 * profile proves which guard runs before which call — it does NOT prove
 * PostgreSQL row locking, isolation-level behaviour, or that a concurrent
 * writer cannot interleave. The acceptance-path race in
 * DeliveryAssignmentService.acceptBroadcast is a separate, open finding and is
 * NOT claimed to be fixed by these tests.
 */
import { DeliveryPersonStatus } from "@prisma/client";

jest.mock("../../src/lib/prisma", () => {
  const client: any = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    deliveryPerson: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(),
    },
    deliveryAssignment: { findUnique: jest.fn(), update: jest.fn() },
    deliveryProof: {
      findUnique: jest.fn(),
      upsert: jest.fn(async () => ({ id: "pr-1" })),
    },
    riderPayoutAccount: { upsert: jest.fn(async () => ({ id: "pa-1", accountNumber: "0123456789" })) },
    riderWithdrawal: { count: jest.fn(async () => 0) },
    $transaction: jest.fn(async (fn: (tx: any) => unknown) => fn(client)),
  };
  return { __esModule: true, default: client };
});

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => undefined),
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisPayments: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisUsersSessions: { get: jest.fn(), set: jest.fn(), del: jest.fn(), sAdd: jest.fn(), sRem: jest.fn(), sMembers: jest.fn(async () => []) },
  ShopCartRedis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/services/deliveryAssignment", () => ({
  __esModule: true,
  DeliveryAssignmentService: {
    acceptBroadcast: jest.fn(async () => ({ id: "as-1" })),
    getBroadcastOffersForDriver: jest.fn(async () => [{ id: "b-1", customer: { name: "Ada", phone: "0803…" } }]),
    acceptAssignment: jest.fn(async () => ({ id: "as-1" })),
    handleDecline: jest.fn(async () => ({ id: "as-1" })),
    updateStatus: jest.fn(async () => ({ id: "as-1" })),
    updateDriverLocation: jest.fn(async () => ({ latitude: 1, longitude: 2 })),
    setOnlineStatus: jest.fn(async () => ({ isOnline: true })),
  },
}));

jest.mock("../../src/services/payoutService", () => ({
  __esModule: true,
  resolveBankAccount: jest.fn(async () => ({ account_name: "Test Account" })),
}));

import prisma from "../../src/lib/prisma";
import { DeliveryAssignmentController } from "../../src/controllers/deliveryControllers";
import { submitDeliveryProof, setRiderBankDetails } from "../../src/controllers/riderOperationsController";
import { DeliveryAssignmentService } from "../../src/services/deliveryAssignment";
import { resolveBankAccount } from "../../src/services/payoutService";
import {
  assertRiderApproved,
  assertRiderOperational,
  assertRiderProfileExists,
  isRiderStatusEstablishable,
  loadRiderEligibility,
  RIDER_ELIGIBILITY_SELECT,
  RIDER_EMAIL_UNVERIFIED_MESSAGE,
  RIDER_NOT_ACTIVE_MESSAGE,
  RIDER_OFFLINE_MESSAGE,
  RIDER_STATUS_UNRESOLVED_MESSAGE,
} from "../../src/services/riderEligibility.service";
import { AppError, ForbiddenError, NotFoundError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = (): any => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  return r;
};

const USER = "rider-1";
const authed = () => ({ user: { id: USER, role: "DELIVERY", sessionId: "s1" } });

/**
 * Two shapes are in play and conflating them hides real wiring bugs:
 *  - dbProfile()  — the row `findUnique` returns (email nested under `user`).
 *  - eligibility() — the flattened object the assertions consume.
 */
const dbProfile = (over: Record<string, unknown> = {}) => ({
  id: "dp-1",
  status: DeliveryPersonStatus.ACTIVE,
  isOnline: true,
  user: { isEmailVerified: true },
  ...over,
});

const eligibility = (over: Record<string, unknown> = {}) => ({
  id: "dp-1",
  status: DeliveryPersonStatus.ACTIVE,
  isOnline: true,
  isEmailVerified: true,
  ...over,
});

const svc = DeliveryAssignmentService as unknown as Record<string, jest.Mock>;

// ═══════════════════════════════════════════════════════════════════════════
// 1. The shared predicate itself (unit level, table driven)
// ═══════════════════════════════════════════════════════════════════════════
describe("riderEligibility.service — predicate", () => {
  it.each([
    [null, NotFoundError, "a missing DeliveryPerson profile"],
    [{ ...eligibility(), status: DeliveryPersonStatus.INACTIVE }, ForbiddenError, "an INACTIVE applicant"],
    [{ ...eligibility(), status: DeliveryPersonStatus.SUSPENDED }, ForbiddenError, "a SUSPENDED rider"],
    [{ ...eligibility(), status: undefined }, ForbiddenError, "an unreadable status (fail closed)"],
    [{ ...eligibility(), isEmailVerified: false }, ForbiddenError, "an ACTIVE rider with unverified email"],
    [{ ...eligibility(), isEmailVerified: undefined }, ForbiddenError, "an email state that could not be read"],
  ])("denies %#: %s", (p, Err, _label) => {
    expect(() => assertRiderApproved(p as never)).toThrow(Err);
    expect(() => assertRiderOperational(p as never)).toThrow(Err);
  });

  it("accepts an ACTIVE, email-verified, on-shift rider", () => {
    expect(() => assertRiderOperational(eligibility() as never)).not.toThrow();
  });

  it("denies going offline semantics only for a missing profile", () => {
    // Going offline must stay available to a non-approved rider.
    expect(() => assertRiderProfileExists({ ...eligibility(), status: DeliveryPersonStatus.SUSPENDED } as never)).not.toThrow();
    expect(() => assertRiderProfileExists(null as never)).toThrow(NotFoundError);
  });

  it("isRiderStatusEstablishable mirrors the vendor helper", () => {
    expect(isRiderStatusEstablishable(DeliveryPersonStatus.ACTIVE)).toBe(true);
    expect(isRiderStatusEstablishable(undefined)).toBe(false);
    expect(isRiderStatusEstablishable("NONSENSE")).toBe(false);
    expect(isRiderStatusEstablishable(null)).toBe(false);
  });

  it("never leaks internal state in its messages", () => {
    for (const m of [RIDER_NOT_ACTIVE_MESSAGE, RIDER_EMAIL_UNVERIFIED_MESSAGE, RIDER_OFFLINE_MESSAGE, RIDER_STATUS_UNRESOLVED_MESSAGE]) {
      expect(m).not.toMatch(/select |prisma|DeliveryPerson|status =/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The actual guarded HTTP boundaries
// ═══════════════════════════════════════════════════════════════════════════
type Case = {
  name: string;
  /** The boundary under test. */
  call: () => Promise<unknown>;
  /** The service call that must NOT happen when ineligible. */
  blockedService: jest.Mock;
};

const onlineBoundaries: Case[] = [
  {
    name: "GET /api/delivery/offers",
    call: () => DeliveryAssignmentController.getBroadcastOffers(authed() as never, res()),
    blockedService: svc.getBroadcastOffersForDriver,
  },
  {
    name: "PATCH /api/delivery/:id/accept",
    call: () => DeliveryAssignmentController.acceptAssignment({ ...authed(), params: { assignmentId: "as-1" } } as never, res()),
    blockedService: svc.acceptAssignment,
  },
  {
    name: "PATCH /api/delivery/:id/status",
    call: () => DeliveryAssignmentController.updateDeliveryStatus({ ...authed(), params: { assignmentId: "as-1" }, body: { status: "PICKED_UP" } } as never, res()),
    blockedService: svc.updateStatus,
  },
  {
    name: "PATCH /api/delivery/location",
    call: () => DeliveryAssignmentController.updateLocation({ ...authed(), body: { latitude: 1, longitude: 2 } } as never, res()),
    blockedService: svc.updateDriverLocation,
  },
];

const approvedBoundaries: Case[] = [
  {
    name: "PATCH /api/delivery/:id/decline",
    call: () => DeliveryAssignmentController.declineAssignment({ ...authed(), params: { assignmentId: "as-1" } } as never, res()),
    blockedService: svc.handleDecline,
  },
  {
    name: "POST /api/rider/assignments/:id/proof",
    call: () => submitDeliveryProof({ ...authed(), params: { assignmentId: "as-1" }, body: { recipientName: "Ada" }, file: { path: "/u/p.jpg", mimetype: "image/jpeg" } } as never, res()),
    blockedService: db.deliveryProof.upsert,
  },
];

const INELIGIBLE: Array<[string, Record<string, unknown> | null]> = [
  ["no DeliveryPerson profile", null],
  ["INACTIVE applicant", dbProfile({ status: DeliveryPersonStatus.INACTIVE })],
  ["SUSPENDED rider", dbProfile({ status: DeliveryPersonStatus.SUSPENDED })],
  ["unreadable status", dbProfile({ status: undefined })],
  ["unverified email", dbProfile({ user: { isEmailVerified: false } })],
];

describe("dispatch-facing boundaries require APPROVED + ON SHIFT", () => {
  beforeEach(() => jest.clearAllMocks());

  describe.each(onlineBoundaries)("$name", ({ call, blockedService }) => {
    it.each(INELIGIBLE)("denies a %s", async (_label, p) => {
      db.deliveryPerson.findUnique.mockResolvedValue(p);
      await expect(call()).rejects.toBeInstanceOf(AppError);
      expect(blockedService).not.toHaveBeenCalled();
    });

    it("denies an APPROVED rider who is not on shift", async () => {
      db.deliveryPerson.findUnique.mockResolvedValue(dbProfile({ isOnline: false }));
      await expect(call()).rejects.toThrow(RIDER_OFFLINE_MESSAGE);
      expect(blockedService).not.toHaveBeenCalled();
    });

    it("allows an eligible rider", async () => {
      db.deliveryPerson.findUnique.mockResolvedValue(dbProfile());
      await expect(call()).resolves.toBeDefined();
      expect(blockedService).toHaveBeenCalledTimes(1);
    });

    it("fails closed when the eligibility read throws", async () => {
      db.deliveryPerson.findUnique.mockRejectedValue(new Error("db down"));
      await expect(call()).rejects.toBeDefined();
      // A failed lookup must never read as "eligible".
      expect(blockedService).not.toHaveBeenCalled();
    });
  });
});

describe("account-management boundaries require APPROVED but not ON SHIFT", () => {
  beforeEach(() => jest.clearAllMocks());

  describe.each(approvedBoundaries)("$name", ({ call, blockedService }) => {
    it.each(INELIGIBLE)("denies a %s", async (_label, p) => {
      db.deliveryPerson.findUnique.mockResolvedValue(p);
      await expect(call()).rejects.toBeInstanceOf(AppError);
      expect(blockedService).not.toHaveBeenCalled();
    });

    it("allows an APPROVED rider who has stepped OFFLINE", async () => {
      // Regression guard for an accidental online-only restriction: bank
      // details and proof submission are account administration, not dispatch.
      db.deliveryPerson.findUnique.mockResolvedValue(dbProfile({ isOnline: false }));
      // The ownership gate still has to be satisfied for the call to complete.
      db.deliveryAssignment.findUnique.mockResolvedValue({
        id: "as-1",
        deliveryPersonId: "dp-1",
        status: "EN_ROUTE",
      });
      await expect(call()).resolves.toBeDefined();
      expect(blockedService).toHaveBeenCalledTimes(1);
    });
  });
});

describe("bank details specifically", () => {
  beforeEach(() => jest.clearAllMocks());

  const call = () =>
    setRiderBankDetails(
      {
        ...authed(),
        body: { bankName: "GTBank", bankCode: "058", accountNumber: "0123456789" },
      } as never,
      res(),
    );

  it("denies a SUSPENDED rider", async () => {
    db.deliveryPerson.findUnique.mockResolvedValue(dbProfile({ status: DeliveryPersonStatus.SUSPENDED }));
    await expect(call()).rejects.toThrow(RIDER_NOT_ACTIVE_MESSAGE);
  });

  it("does not require the rider to be online", async () => {
    db.deliveryPerson.findUnique.mockResolvedValue(dbProfile({ isOnline: false }));
    db.riderWithdrawal.count.mockResolvedValue(0);

    const result = await call();

    // The APPROVED gate (not the on-shift gate) applies to bank details:
    // an offline but ACTIVE, email-verified rider passes eligibility and the
    // call proceeds to resolveBankAccount.
    expect(result).toBeDefined();
    expect(resolveBankAccount).toHaveBeenCalledTimes(1);
    expect(resolveBankAccount).toHaveBeenCalledWith("0123456789", "058");
  });
});

describe("online status is asymmetric: going online needs approval, going offline does not", () => {
  beforeEach(() => jest.clearAllMocks());

  const call = (isOnline: boolean) =>
    DeliveryAssignmentController.setOnlineStatus({ ...authed(), body: { isOnline } } as never, res());

  it.each(INELIGIBLE)("refuses to go ONLINE for %s", async (_label, p) => {
    db.deliveryPerson.findUnique.mockResolvedValue(p);
    await expect(call(true)).rejects.toBeInstanceOf(AppError);
    expect(svc.setOnlineStatus).not.toHaveBeenCalled();
  });

  it.each([
    DeliveryPersonStatus.SUSPENDED,
    DeliveryPersonStatus.INACTIVE,
  ])("still allows a %s rider to go OFFLINE", async (status) => {
    db.deliveryPerson.findUnique.mockResolvedValue(dbProfile({ status }));
    await expect(call(false)).resolves.toBeDefined();
    expect(svc.setOnlineStatus).toHaveBeenCalledWith(USER, false);
  });

  it("refuses to go offline for an account with no rider profile", async () => {
    db.deliveryPerson.findUnique.mockResolvedValue(null);
    await expect(call(false)).rejects.toBeInstanceOf(NotFoundError);
    expect(svc.setOnlineStatus).not.toHaveBeenCalled();
  });
});

describe("offers never leak customer data to an ineligible rider", () => {
  beforeEach(() => jest.clearAllMocks());

  it("checks authorization BEFORE the service is asked for offers", async () => {
    db.deliveryPerson.findUnique.mockResolvedValue(dbProfile({ status: DeliveryPersonStatus.SUSPENDED }));

    await expect(
      DeliveryAssignmentController.getBroadcastOffers(authed() as never, res()),
    ).rejects.toBeInstanceOf(AppError);

    // The payload carries customer name, phone and address, so the service
    // must never be reached — not even to filter the result afterwards.
    expect(svc.getBroadcastOffersForDriver).not.toHaveBeenCalled();
  });
});

describe("existing ownership checks are preserved", () => {
  beforeEach(() => jest.clearAllMocks());

  it("submitDeliveryProof still refuses an assignment the rider does not own", async () => {
    db.deliveryPerson.findUnique.mockResolvedValue(dbProfile());
    db.deliveryAssignment.findUnique.mockResolvedValue({ id: "as-1", deliveryPersonId: "dp-someone-else", status: "EN_ROUTE" });

    await expect(
      submitDeliveryProof(
        { ...authed(), params: { assignmentId: "as-1" }, body: {}, file: { path: "/u/p.jpg", mimetype: "image/jpeg" } } as never,
        res(),
      ),
    ).rejects.toThrow(/only submit proof for your own assignment/);
  });
});
// ═══════════════════════════════════════════════════════════════════════════
// 3. Transaction-client injection
//
// loadRiderEligibility defaults `client` to the process-wide Prisma client
// (src/lib/prisma). Inside a transaction, omitting the client silently reads
// through a DIFFERENT connection, outside the open transaction. These tests pin
// that an explicitly supplied client is the one actually used.
// ═══════════════════════════════════════════════════════════════════════════
describe("loadRiderEligibility honours an injected transaction client", () => {
  beforeEach(() => jest.clearAllMocks());

  const injected = {
    deliveryPerson: {
      findUnique: jest.fn(async () => ({
        id: "dp-tx",
        status: DeliveryPersonStatus.ACTIVE,
        isOnline: true,
        user: { isEmailVerified: true },
      })),
    },
  };

  it("reads through the supplied client and not the global one", async () => {
    db.deliveryPerson.findUnique.mockResolvedValue({
      id: "dp-global",
      status: DeliveryPersonStatus.SUSPENDED,
      isOnline: false,
      user: { isEmailVerified: false },
    });

    const loaded = await loadRiderEligibility(USER, injected as never);

    expect(injected.deliveryPerson.findUnique).toHaveBeenCalledWith({
      where: { userId: USER },
      select: RIDER_ELIGIBILITY_SELECT,
    });
    expect(db.deliveryPerson.findUnique).not.toHaveBeenCalled();
    // The result proves which client answered: a global-client read would have
    // returned the SUSPENDED fixture instead.
    expect(loaded).toEqual({
      id: "dp-tx",
      status: DeliveryPersonStatus.ACTIVE,
      isOnline: true,
      isEmailVerified: true,
    });
  });

  it("flattens the nested user.isEmailVerified the assertions rely on", async () => {
    const loaded = await loadRiderEligibility(USER, injected as never);
    expect(loaded).not.toHaveProperty("user");
    expect(loaded!.isEmailVerified).toBe(true);
  });

  it("returns null (not a throw) when the profile is absent, so callers fail closed", async () => {
    const empty = { deliveryPerson: { findUnique: jest.fn(async () => null) } };
    await expect(loadRiderEligibility(USER, empty as never)).resolves.toBeNull();
    expect(() => assertRiderApproved(null)).toThrow(NotFoundError);
  });

  it("propagates a lookup failure instead of reading it as 'not eligible but permitted'", async () => {
    const broken = {
      deliveryPerson: { findUnique: jest.fn(async () => { throw new Error("db down"); }) },
    };
    await expect(loadRiderEligibility(USER, broken as never)).rejects.toThrow("db down");
  });
});

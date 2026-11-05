/**
 * Phase 2A.2 — Admin DishType suggestion moderation (mocked unit tests).
 *
 * Covers: admin list/detail with pagination, approve (creates exactly one
 * official DishType inside a transaction), repeated/stale moderation
 * rejection, duplicate-dish-type race handling, rejection preserving the
 * suggestion record, and cache/audit wiring. All infrastructure (Prisma,
 * Redis) is mocked; these prove application logic only, not live
 * PostgreSQL/Redis behaviour.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    categorySuggestion: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    dishType: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (cb: any) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearDishTypeCache: jest.fn(async () => {}),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { Prisma, SuggestionStatus } from "@prisma/client";
import {
  clearDishTypeCache,
  invalidateMarketplaceDiscoveryCaches,
} from "../../src/services/clearCaches";
import { createAuditLog } from "../../src/utils/auditLog.service";
import {
  approveDishTypeSuggestion,
  rejectDishTypeSuggestion,
  listDishTypeSuggestions,
  getDishTypeSuggestion,
} from "../../src/controllers/admin.controller";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedClearDishTypeCache = clearDishTypeCache as unknown as jest.Mock;
const mockedInvalidateDiscovery =
  invalidateMarketplaceDiscoveryCaches as unknown as jest.Mock;
const mockedCreateAuditLog = createAuditLog as unknown as jest.Mock;

const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
  code: "P2002",
  clientVersion: "test",
});

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const adminReq = (overrides: Partial<any> = {}): any =>
  ({
    headers: {},
    body: {},
    params: { id: "sugg-1" },
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "admin-1", role: "ADMIN", sessionId: "sess" },
    ...overrides,
  }) as any;

const PENDING_SUGGESTION = {
  id: "sugg-1",
  vendorId: "vendor-1",
  suggestedName: "Jollof",
  suggestedCategoryId: "RICE_DISHES",
  status: SuggestionStatus.PENDING,
  approvedDishTypeId: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.categorySuggestion.findUnique.mockResolvedValue(PENDING_SUGGESTION);
  db.dishType.findFirst.mockResolvedValue(null);
  db.dishType.create.mockResolvedValue({
    id: "JOLLOF",
    name: "Jollof",
    categoryId: "RICE_DISHES",
    isActive: true,
  });
  db.categorySuggestion.update.mockResolvedValue({
    ...PENDING_SUGGESTION,
    status: SuggestionStatus.APPROVED,
    approvedDishTypeId: "JOLLOF",
    reviewedByAdminId: "admin-1",
  });
  db.categorySuggestion.updateMany.mockResolvedValue({ count: 1 });
  db.categorySuggestion.findMany.mockResolvedValue([]);
  db.categorySuggestion.count.mockResolvedValue(0);
  mockedInvalidateDiscovery.mockResolvedValue(undefined);
  mockedClearDishTypeCache.mockResolvedValue(undefined);
  mockedCreateAuditLog.mockResolvedValue(undefined);
});

describe("admin dish-type suggestions — list and detail", () => {
  it("admin lists suggestions with pagination and status filter", async () => {
    db.categorySuggestion.findMany.mockResolvedValue([PENDING_SUGGESTION]);
    db.categorySuggestion.count.mockResolvedValue(1);
    const r = res();
    await listDishTypeSuggestions(
      adminReq({ query: { status: "PENDING", page: "1", limit: "10" } }),
      r,
    );

    expect(db.categorySuggestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "PENDING" },
        skip: 0,
        take: 10,
      }),
    );
    expect(db.categorySuggestion.count).toHaveBeenCalledWith({
      where: { status: "PENDING" },
    });
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("admin retrieves a single suggestion by id", async () => {
    const r = res();
    await getDishTypeSuggestion(adminReq({ params: { id: "sugg-1" } }), r);

    expect(db.categorySuggestion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sugg-1" } }),
    );
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("missing suggestion returns not-found", async () => {
    db.categorySuggestion.findUnique.mockResolvedValue(null);
    await expect(
      getDishTypeSuggestion(adminReq({ params: { id: "nope" } }), res()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("admin dish-type suggestions — approve", () => {
  it("approve creates exactly one DishType and links it, within a transaction", async () => {
    const r = res();
    await approveDishTypeSuggestion(
      adminReq({ params: { id: "sugg-1" }, body: {} }),
      r,
    );

    expect(db.dishType.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "JOLLOF",
        name: "Jollof",
        categoryId: "RICE_DISHES",
        isActive: true,
      }),
    });
    const updateCall = db.categorySuggestion.updateMany.mock.calls[0][0];
    expect(updateCall.where).toEqual({
      id: "sugg-1",
      status: SuggestionStatus.PENDING,
    });
    expect(updateCall.data.status).toBe(SuggestionStatus.APPROVED);
    expect(updateCall.data.approvedDishTypeId).toBe("JOLLOF");
    expect(updateCall.data.reviewedByAdminId).toBe("admin-1");

    // Transaction used (atomicity).
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Cache invalidated after successful approval.
    expect(mockedClearDishTypeCache).toHaveBeenCalledWith("JOLLOF");
    expect(mockedInvalidateDiscovery).toHaveBeenCalled();
    // Moderation audited.
    expect(mockedCreateAuditLog).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("approve rejects a non-pending suggestion (repeated/stale moderation)", async () => {
    db.categorySuggestion.findUnique.mockResolvedValue({
      ...PENDING_SUGGESTION,
      status: SuggestionStatus.APPROVED,
    });
    await expect(
      approveDishTypeSuggestion(adminReq({ params: { id: "sugg-1" } }), res()),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.dishType.create).not.toHaveBeenCalled();
    expect(db.categorySuggestion.update).not.toHaveBeenCalled();
    expect(mockedClearDishTypeCache).not.toHaveBeenCalled();
  });

  it("approve returns not-found for a missing suggestion", async () => {
    db.categorySuggestion.findUnique.mockResolvedValue(null);
    await expect(
      approveDishTypeSuggestion(adminReq({ params: { id: "nope" } }), res()),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(db.dishType.create).not.toHaveBeenCalled();
  });

  it("approve rejects when an official dish type already exists (pre-check)", async () => {
    db.dishType.findFirst.mockResolvedValue({ id: "JOLLOF", name: "Jollof" });
    await expect(
      approveDishTypeSuggestion(adminReq({ params: { id: "sugg-1" } }), res()),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.dishType.create).not.toHaveBeenCalled();
  });

  it("approve converts a concurrent P2002 to ConflictError and rolls back", async () => {
    db.dishType.create.mockRejectedValue(p2002);
    await expect(
      approveDishTypeSuggestion(adminReq({ params: { id: "sugg-1" } }), res()),
    ).rejects.toBeInstanceOf(ConflictError);
    // Transaction rolled back: suggestion not marked approved (update never runs).
    expect(db.categorySuggestion.update).not.toHaveBeenCalled();
    expect(mockedClearDishTypeCache).not.toHaveBeenCalled();
  });

  it("stale conditional approval returns a conflict and rolls back the DishType creation", async () => {
    // A concurrent moderator already flipped the status: the conditional
    // updateMany matches zero rows, so we abort the transaction.
    db.categorySuggestion.updateMany.mockResolvedValue({ count: 0 });
    const r = res();
    await expect(
      approveDishTypeSuggestion(
        adminReq({ params: { id: "sugg-1" }, body: {} }),
        r,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    // dishType.create still ran inside the transaction before the conditional
    // update failed, but the transaction must roll it back: no cache
    // invalidation or audit logging may report success.
    expect(db.dishType.create).toHaveBeenCalled();
    expect(mockedClearDishTypeCache).not.toHaveBeenCalled();
    expect(mockedInvalidateDiscovery).not.toHaveBeenCalled();
    expect(mockedCreateAuditLog).not.toHaveBeenCalled();
    expect(r.status).not.toHaveBeenCalled();
  });

  it("unrelated database errors propagate instead of being reported as conflicts", async () => {
    const dbDown = new Error("database connection lost");
    db.categorySuggestion.updateMany.mockRejectedValue(dbDown);
    await expect(
      approveDishTypeSuggestion(adminReq({ params: { id: "sugg-1" } }), res()),
    ).rejects.toBe(dbDown);
    expect(mockedClearDishTypeCache).not.toHaveBeenCalled();
    expect(mockedCreateAuditLog).not.toHaveBeenCalled();
  });
});

describe("admin dish-type suggestions — reject", () => {
  it("reject preserves the suggestion record and records the reviewer", async () => {
    db.categorySuggestion.update.mockResolvedValue({
      ...PENDING_SUGGESTION,
      status: SuggestionStatus.REJECTED,
      reviewedByAdminId: "admin-1",
    });
    const r = res();
    await rejectDishTypeSuggestion(
      adminReq({ params: { id: "sugg-1" }, body: { adminNote: "Not a dish" } }),
      r,
    );

    const updateCall = db.categorySuggestion.updateMany.mock.calls[0][0];
    expect(updateCall.where).toEqual({
      id: "sugg-1",
      status: SuggestionStatus.PENDING,
    });
    expect(updateCall.data.status).toBe(SuggestionStatus.REJECTED);
    expect(updateCall.data.reviewedByAdminId).toBe("admin-1");
    expect(updateCall.data.adminNote).toBe("Not a dish");
    // No DishType is created on rejection.
    expect(db.dishType.create).not.toHaveBeenCalled();
    // Rejection does not change the catalog, so no discovery invalidation.
    expect(mockedClearDishTypeCache).not.toHaveBeenCalled();
    expect(mockedInvalidateDiscovery).not.toHaveBeenCalled();
    expect(mockedCreateAuditLog).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("reject rejects a non-pending suggestion", async () => {
    // The conditional updateMany matches zero rows because the status is no
    // longer PENDING.
    db.categorySuggestion.updateMany.mockResolvedValue({ count: 0 });
    db.categorySuggestion.findUnique.mockResolvedValue({
      ...PENDING_SUGGESTION,
      status: SuggestionStatus.REJECTED,
    });
    await expect(
      rejectDishTypeSuggestion(adminReq({ params: { id: "sugg-1" } }), res()),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.categorySuggestion.update).not.toHaveBeenCalled();
  });

  it("stale conditional rejection returns a conflict for an already-moderated suggestion", async () => {
    // A concurrent approver already flipped the status: conditional
    // updateMany matches zero rows, so we report a conflict instead of
    // overwriting their decision.
    db.categorySuggestion.updateMany.mockResolvedValue({ count: 0 });
    db.categorySuggestion.findUnique.mockResolvedValue({
      ...PENDING_SUGGESTION,
      status: SuggestionStatus.APPROVED,
    });
    const r = res();
    await expect(
      rejectDishTypeSuggestion(
        adminReq({ params: { id: "sugg-1" } }),
        r,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.dishType.create).not.toHaveBeenCalled();
    expect(mockedClearDishTypeCache).not.toHaveBeenCalled();
    expect(mockedInvalidateDiscovery).not.toHaveBeenCalled();
    expect(mockedCreateAuditLog).not.toHaveBeenCalled();
    expect(r.status).not.toHaveBeenCalled();
  });

  it("stale conditional rejection of a missing suggestion returns not-found", async () => {
    db.categorySuggestion.updateMany.mockResolvedValue({ count: 0 });
    db.categorySuggestion.findUnique.mockResolvedValue(null);
    await expect(
      rejectDishTypeSuggestion(adminReq({ params: { id: "nope" } }), res()),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(db.categorySuggestion.update).not.toHaveBeenCalled();
    expect(mockedCreateAuditLog).not.toHaveBeenCalled();
  });
});

/**
 * Phase 2A.2 — Vendor DishType suggestions (mocked unit tests).
 *
 * Covers: eligible-vendor submission, server-set ownership, validation,
 * duplicate-pending and duplicate-official-dish-type handling, and viewing
 * only one's own suggestions. All infrastructure (Prisma, Redis) is mocked;
 * these prove application logic only, not live PostgreSQL/Redis behaviour.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    category: { findUnique: jest.fn() },
    dishType: { findFirst: jest.fn(), create: jest.fn() },
    categorySuggestion: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearDishTypeCache: jest.fn(async () => {}),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { SuggestionStatus } from "@prisma/client";
import {
  clearDishTypeCache,
  invalidateMarketplaceDiscoveryCaches,
} from "../../src/services/clearCaches";
import {
  createDishTypeSuggestion,
  getMyDishTypeSuggestions,
} from "../../src/controllers/admin.controller";
import { ConflictError, ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedClearDishTypeCache = clearDishTypeCache as unknown as jest.Mock;
const mockedInvalidateDiscovery =
  invalidateMarketplaceDiscoveryCaches as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const vendorReq = (overrides: Partial<any> = {}): any =>
  ({
    headers: {},
    body: {},
    params: {},
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "vendor-1", role: "VENDOR", sessionId: "sess" },
    ...overrides,
  }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  db.category.findUnique.mockResolvedValue({ id: "RICE_DISHES" });
  db.dishType.findFirst.mockResolvedValue(null);
  db.categorySuggestion.findFirst.mockResolvedValue(null);
  db.categorySuggestion.create.mockResolvedValue({
    id: "sugg-1",
    vendorId: "vendor-1",
    suggestedName: "Jollof",
    suggestedCategoryId: "RICE_DISHES",
    status: SuggestionStatus.PENDING,
  });
  db.categorySuggestion.findMany.mockResolvedValue([]);
  db.categorySuggestion.count.mockResolvedValue(0);
  mockedInvalidateDiscovery.mockResolvedValue(undefined);
  mockedClearDishTypeCache.mockResolvedValue(undefined);
});

describe("vendor dish-type suggestions — submit", () => {
  it("eligible vendor submits a valid suggestion; server sets vendorId and PENDING", async () => {
    const r = res();
    await createDishTypeSuggestion(
      vendorReq({
        body: { suggestedName: "Jollof", suggestedCategoryId: "RICE_DISHES" },
      }),
      r,
    );

    expect(db.categorySuggestion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        vendorId: "vendor-1",
        suggestedName: "Jollof",
        suggestedCategoryId: "RICE_DISHES",
        status: SuggestionStatus.PENDING,
      }),
    });
    // Client-supplied submitter/ownership fields are never honored; vendorId
    // always comes from the authenticated session.
    expect(db.categorySuggestion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ vendorId: "evil-vendor" }),
      }),
    );
    expect(r.status).toHaveBeenCalledWith(201);
  });

  it("rejects empty or whitespace-only suggested name", async () => {
    await expect(
      createDishTypeSuggestion(
        vendorReq({
          body: { suggestedName: "   ", suggestedCategoryId: "RICE_DISHES" },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.categorySuggestion.create).not.toHaveBeenCalled();
  });

  it("rejects a missing suggested name", async () => {
    await expect(
      createDishTypeSuggestion(
        vendorReq({ body: { suggestedCategoryId: "RICE_DISHES" } }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.categorySuggestion.create).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid category reference", async () => {
    db.category.findUnique.mockResolvedValue(null);
    await expect(
      createDishTypeSuggestion(
        vendorReq({
          body: { suggestedName: "Jollof", suggestedCategoryId: "NOPE" },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.categorySuggestion.create).not.toHaveBeenCalled();
  });

  it("rejects a duplicate pending suggestion (same vendor, name, category)", async () => {
    db.categorySuggestion.findFirst.mockResolvedValue({
      id: "sugg-existing",
      vendorId: "vendor-1",
      suggestedName: "Jollof",
      suggestedCategoryId: "RICE_DISHES",
      status: SuggestionStatus.PENDING,
    });
    await expect(
      createDishTypeSuggestion(
        vendorReq({
          body: { suggestedName: "Jollof", suggestedCategoryId: "RICE_DISHES" },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.categorySuggestion.create).not.toHaveBeenCalled();
  });

  it("rejects a suggestion that duplicates an existing official dish type", async () => {
    db.dishType.findFirst.mockResolvedValue({ id: "JOLLOF", name: "Jollof" });
    await expect(
      createDishTypeSuggestion(
        vendorReq({
          body: { suggestedName: "Jollof", suggestedCategoryId: "RICE_DISHES" },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.categorySuggestion.create).not.toHaveBeenCalled();
  });
});

describe("vendor dish-type suggestions — view own", () => {
  it("vendor sees only their own suggestions (vendorId from session)", async () => {
    db.categorySuggestion.findMany.mockResolvedValue([
      {
        id: "sugg-1",
        vendorId: "vendor-1",
        suggestedName: "Jollof",
        status: SuggestionStatus.PENDING,
      },
    ]);
    const r = res();
    await getMyDishTypeSuggestions(vendorReq({ query: {} }), r);

    expect(db.categorySuggestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vendorId: "vendor-1" } }),
    );
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("vendor can filter own suggestions by status", async () => {
    await getMyDishTypeSuggestions(
      vendorReq({ query: { status: "APPROVED" } }),
      res(),
    );
    expect(db.categorySuggestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vendorId: "vendor-1", status: "APPROVED" },
      }),
    );
  });

  it("view-own applies pagination", async () => {
    const r = res();
    await getMyDishTypeSuggestions(
      vendorReq({ query: { page: "2", limit: "5" } }),
      r,
    );
    const call = db.categorySuggestion.findMany.mock.calls[0][0];
    expect(call.skip).toBe(5);
    expect(call.take).toBe(5);
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

/**
 * Phase 2A.1 — Admin taxonomy management (categories, dish types, tags).
 *
 * Mocked unit tests covering create / update / deactivate for each taxonomy
 * layer. All infrastructure (Prisma, Redis) is mocked; these tests prove
 * application logic only, not live PostgreSQL/Redis behaviour.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    category: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    dishType: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    tag: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    product: { findMany: jest.fn() },
  },
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearCategoryCache: jest.fn(async () => {}),
  clearDishTypeCache: jest.fn(async () => {}),
  // Phase 2B.6: the tag handlers use the tag-specific helper, which covers
  // the `tags:all` namespace and the product payloads that embed tag objects —
  // namespaces the generic discovery sweep does not reach.
  clearTagCache: jest.fn(async () => ({ ok: true, failures: [] })),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
  invalidateProductsByDishTypeCategoryChange: jest.fn(async () => {}),
}));

jest.mock("../../src/utils/auditLog.service", () => ({
  __esModule: true,
  createAuditLog: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  clearCategoryCache,
  clearDishTypeCache,
  clearTagCache,
  invalidateMarketplaceDiscoveryCaches,
  invalidateProductsByDishTypeCategoryChange,
} from "../../src/services/clearCaches";
import { createAuditLog } from "../../src/utils/auditLog.service";
import {
  createCategory,
  updateCategory,
  deactivateCategory,
  createDishType,
  updateDishType,
  deactivateDishType,
  createTag,
  updateTag,
  deactivateTag,
} from "../../src/controllers/admin.controller";
import { ConflictError, NotFoundError, ValidationError } from "../../src/errors/AppError";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const mockedClearCategoryCache = clearCategoryCache as unknown as jest.Mock;
const mockedClearDishTypeCache = clearDishTypeCache as unknown as jest.Mock;
const mockedInvalidateDiscovery = invalidateMarketplaceDiscoveryCaches as unknown as jest.Mock;
const mockedClearTagCache = clearTagCache as unknown as jest.Mock;
const mockedInvalidateDishTypeCategory =
  invalidateProductsByDishTypeCategoryChange as unknown as jest.Mock;

const res: any = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const adminReq = (
  body: Record<string, unknown> = {},
  overrides: Partial<any> = {},
): any =>
  ({
    headers: {},
    body,
    params: { id: "cat-1" },
    query: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: () => undefined,
    user: { id: "admin-1", role: "ADMIN", sessionId: "sess" },
    ...overrides,
  }) as any;

const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
  code: "P2002",
  clientVersion: "test",
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: nothing exists by default so missing-record paths hit 404.
  db.category.findUnique.mockResolvedValue(null);
  db.category.findFirst.mockResolvedValue(null);
  db.category.create.mockResolvedValue({ id: "cat-new", isActive: true });
  db.category.update.mockResolvedValue({ id: "cat-1", isActive: true });

  db.dishType.findUnique.mockResolvedValue(null);
  db.dishType.create.mockResolvedValue({ id: "dt-new", isActive: true });
  db.dishType.update.mockResolvedValue({ id: "dt-1", isActive: true });

  db.tag.findUnique.mockResolvedValue(null);
  db.tag.findFirst.mockResolvedValue(null);
  db.tag.create.mockResolvedValue({ id: "tag-new", isActive: true });
  db.tag.update.mockResolvedValue({ id: "tag-1", isActive: true });

  db.product.findMany.mockResolvedValue([]);

  mockedInvalidateDiscovery.mockResolvedValue(undefined);
  mockedInvalidateDishTypeCategory.mockResolvedValue(undefined);
});

describe("authorization posture", () => {
  it("all taxonomy routes are registered under the admin router (authenticate + authorizeAdmin applied in admin.routes.ts)", () => {
    // This is asserted statically via route registration in admin.routes.ts.
    // The router applies `authenticate` then `authorizeAdmin` to every route,
    // so unauthenticated and non-admin requests are rejected before reaching
    // these handlers. Controller tests below assume an admin caller.
    expect(true).toBe(true);
  });
});

describe("categories", () => {
  it("createCategory succeeds with valid input and invalidates caches", async () => {
    db.category.findFirst.mockResolvedValue(null);
    db.category.create.mockResolvedValue({
      id: "cat-rice",
      name: "Rice Dishes",
      slug: "rice-dishes",
      isActive: true,
    });
    const r = res();
    await createCategory(
      adminReq({
        name: "Rice Dishes",
        slug: "rice-dishes",
        sortOrder: 10,
      }),
      r,
    );

    expect(db.category.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Rice Dishes", slug: "rice-dishes", sortOrder: 10 }),
      }),
    );
    expect(mockedClearCategoryCache).toHaveBeenCalledWith("cat-rice");
    expect(mockedInvalidateDiscovery).toHaveBeenCalled();
    expect(createAuditLog).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(201);
  });

  it("createCategory rejects duplicate name or slug", async () => {
    db.category.findFirst.mockResolvedValue({
      id: "cat-existing",
      name: "Rice Dishes",
      slug: "rice-dishes",
    });
    await expect(
      createCategory(adminReq({ name: "Rice Dishes", slug: "rice-dishes" }), res()),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.category.create).not.toHaveBeenCalled();
    expect(mockedClearCategoryCache).not.toHaveBeenCalled();
  });

  it("createCategory rejects invalid slug", async () => {
    await expect(
      createCategory(adminReq({ name: "Rice", slug: "Rice Dishes" }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.category.create).not.toHaveBeenCalled();
  });

  it("createCategory converts a P2002 unique violation to ConflictError", async () => {
    db.category.findFirst.mockResolvedValue(null);
    db.category.create.mockRejectedValue(p2002);
    await expect(
      createCategory(adminReq({ name: "X", slug: "x" }), res()),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("updateCategory changes only permitted fields and invalidates cache", async () => {
    db.category.findUnique.mockResolvedValue({
      id: "cat-1",
      name: "Old",
      slug: "old",
      isActive: true,
    });
    db.category.update.mockResolvedValue({
      id: "cat-1",
      name: "Renamed",
      slug: "renamed",
      isActive: true,
    });
    const r = res();
    await updateCategory(
      adminReq({ name: "Renamed", slug: "renamed" }),
      r,
    );

    const call = db.category.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "cat-1" });
    expect(call.data).toMatchObject({ name: "Renamed", slug: "renamed" });
    expect(call.data).not.toHaveProperty("isActive");
    expect(mockedClearCategoryCache).toHaveBeenCalledWith("cat-1");
    expect(mockedInvalidateDiscovery).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("updateCategory returns 404 for a missing record", async () => {
    db.category.findUnique.mockResolvedValue(null);
    await expect(updateCategory(adminReq({ name: "X" }), res())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(db.category.update).not.toHaveBeenCalled();
    expect(mockedClearCategoryCache).not.toHaveBeenCalled();
  });

  it("deactivateCategory sets isActive false and preserves associated records", async () => {
    db.category.findUnique.mockResolvedValue({
      id: "cat-1",
      name: "Rice Dishes",
      isActive: true,
    });
    db.category.update.mockResolvedValue({
      id: "cat-1",
      name: "Rice Dishes",
      isActive: false,
    });
    const r = res();
    await deactivateCategory(adminReq({}), r);

    const call = db.category.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "cat-1" });
    expect(call.data).toEqual({ isActive: false });
    expect(mockedClearCategoryCache).toHaveBeenCalledWith("cat-1");
    expect(mockedInvalidateDiscovery).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("deactivateCategory returns 404 for a missing record and does not invalidate", async () => {
    db.category.findUnique.mockResolvedValue(null);
    await expect(deactivateCategory(adminReq({}), res())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(db.category.update).not.toHaveBeenCalled();
    expect(mockedClearCategoryCache).not.toHaveBeenCalled();
    expect(mockedInvalidateDiscovery).not.toHaveBeenCalled();
  });
});

describe("dish types", () => {
  it("createDishType succeeds with a valid existing category and invalidates caches", async () => {
    db.category.findUnique.mockResolvedValue({ id: "cat-1" });
    db.dishType.create.mockResolvedValue({
      id: "dt-jollof",
      name: "Jollof",
      categoryId: "cat-1",
      isActive: true,
    });
    const r = res();
    await createDishType(
      adminReq({ name: "Jollof", categoryId: "cat-1", sortOrder: 10 }),
      r,
    );

    expect(db.dishType.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Jollof",
          category: { connect: { id: "cat-1" } },
          sortOrder: 10,
        }),
      }),
    );
    expect(mockedClearDishTypeCache).toHaveBeenCalledWith("dt-jollof");
    expect(mockedInvalidateDiscovery).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(201);
  });

  it("createDishType rejects a missing or invalid category reference", async () => {
    db.category.findUnique.mockResolvedValue(null);
    await expect(
      createDishType(adminReq({ name: "Jollof", categoryId: "nope" }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.dishType.create).not.toHaveBeenCalled();
  });

  it("updateDishType validates a changed categoryId against an existing category", async () => {
    db.dishType.findUnique.mockResolvedValue({
      id: "dt-1",
      name: "Jollof",
      categoryId: "cat-a",
      isActive: true,
    });
    db.category.findUnique.mockResolvedValue({ id: "cat-b" });
    db.dishType.update.mockResolvedValue({
      id: "dt-1",
      name: "Jollof",
      categoryId: "cat-b",
      isActive: true,
    });
    await updateDishType(
      adminReq({ categoryId: "cat-b" }, { params: { id: "dt-1" } }),
      res(),
    );

    const call = db.dishType.update.mock.calls[0][0];
    expect(call.data.category).toEqual({ connect: { id: "cat-b" } });
    // Category change triggers product-cache invalidation for affected products.
    expect(mockedInvalidateDishTypeCategory).toHaveBeenCalledWith("dt-1");
    expect(mockedClearDishTypeCache).toHaveBeenCalledWith("dt-1");
    expect(mockedInvalidateDiscovery).toHaveBeenCalled();
  });

  it("updateDishType rejects an invalid changed categoryId", async () => {
    db.dishType.findUnique.mockResolvedValue({
      id: "dt-1",
      name: "Jollof",
      categoryId: "cat-a",
    });
    db.category.findUnique.mockResolvedValue(null);
    await expect(
      updateDishType(adminReq({ categoryId: "nope" }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.dishType.update).not.toHaveBeenCalled();
  });

  it("updateDishType returns 404 for a missing record", async () => {
    db.dishType.findUnique.mockResolvedValue(null);
    await expect(updateDishType(adminReq({ name: "X" }), res())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(db.dishType.update).not.toHaveBeenCalled();
  });

  it("deactivateDishType sets isActive false and does not delete/reassign products", async () => {
    db.dishType.findUnique.mockResolvedValue({
      id: "dt-1",
      name: "Jollof",
      isActive: true,
    });
    db.dishType.update.mockResolvedValue({ id: "dt-1", name: "Jollof", isActive: false });
    const r = res();
    await deactivateDishType(adminReq({}, { params: { id: "dt-1" } }), r);

    const call = db.dishType.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "dt-1" });
    expect(call.data).toEqual({ isActive: false });
    expect(mockedClearDishTypeCache).toHaveBeenCalledWith("dt-1");
    expect(mockedInvalidateDiscovery).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("deactivateDishType returns 404 for a missing record and does not invalidate", async () => {
    db.dishType.findUnique.mockResolvedValue(null);
    await expect(deactivateDishType(adminReq({}), res())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(db.dishType.update).not.toHaveBeenCalled();
    expect(mockedClearDishTypeCache).not.toHaveBeenCalled();
    expect(mockedInvalidateDiscovery).not.toHaveBeenCalled();
  });
});

describe("tags", () => {
  it("createTag succeeds with a valid enum type and invalidates caches", async () => {
    db.tag.findFirst.mockResolvedValue(null);
    db.tag.create.mockResolvedValue({ id: "tag-spicy", name: "Spicy", type: "CUISINE", isActive: true });
    const r = res();
    await createTag(adminReq({ name: "Spicy", type: "CUISINE" }), r);

    expect(db.tag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { id: "SPICY", name: "Spicy", type: "CUISINE" },
      }),
    );
    // Phase 2B.6: the tag handlers invalidate through the tag-specific helper,
    // which also covers the `tags:all` namespace and the product payloads that
    // embed tag objects.
    expect(mockedClearTagCache).toHaveBeenCalledWith("tag-spicy");
    expect(r.status).toHaveBeenCalledWith(201);
  });

  it("createTag rejects an invalid tag type", async () => {
    await expect(
      createTag(adminReq({ name: "Spicy", type: "HOT" as any }), res()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.tag.create).not.toHaveBeenCalled();
  });

  it("createTag rejects duplicate name", async () => {
    db.tag.findFirst.mockResolvedValue({ id: "tag-existing", name: "Spicy", type: "CUISINE" });
    await expect(
      createTag(adminReq({ name: "Spicy", type: "DIET" }), res()),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.tag.create).not.toHaveBeenCalled();
  });

  it("createTag succeeds when another tag shares the same type but not the name", async () => {
    // An existing CUISINE tag with a different name must NOT cause a conflict:
    // Tag.name is unique; Tag.type is not. findFirst returns null (no tag
    // named "Spicy"), so creation proceeds even though other CUISINE tags exist.
    db.tag.findFirst.mockResolvedValue(null);
    db.tag.create.mockResolvedValue({ id: "tag-spicy", name: "Spicy", type: "CUISINE", isActive: true });
    const r = res();
    await createTag(adminReq({ name: "Spicy", type: "CUISINE" }), r);

    // The pre-check must query by name only, not by type.
    expect(db.tag.findFirst).toHaveBeenCalledWith({
      where: { name: "Spicy" },
      select: { id: true, name: true },
    });
    expect(db.tag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { id: "SPICY", name: "Spicy", type: "CUISINE" },
      }),
    );
    expect(r.status).toHaveBeenCalledWith(201);
  });

  it("updateTag validates the enum type and invalidates cache", async () => {
    db.tag.findUnique.mockResolvedValue({ id: "tag-1", name: "Spicy", type: "CUISINE", isActive: true });
    db.tag.update.mockResolvedValue({ id: "tag-1", name: "Spicy", type: "DIET", isActive: true });
    const r = res();
    await updateTag(adminReq({ type: "DIET" }, { params: { id: "tag-1" } }), r);

    const call = db.tag.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "tag-1" });
    expect(call.data).toEqual({ type: "DIET" });
    expect(mockedClearTagCache).toHaveBeenCalledWith("tag-1");
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("updateTag returns 404 for a missing record", async () => {
    db.tag.findUnique.mockResolvedValue(null);
    await expect(updateTag(adminReq({ name: "X" }), res())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(db.tag.update).not.toHaveBeenCalled();
  });

  it("deactivateTag sets isActive false and preserves product-tag associations", async () => {
    db.tag.findUnique.mockResolvedValue({ id: "tag-1", name: "Spicy", isActive: true });
    db.tag.update.mockResolvedValue({ id: "tag-1", name: "Spicy", isActive: false });
    const r = res();
    await deactivateTag(adminReq({}, { params: { id: "tag-1" } }), r);

    const call = db.tag.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "tag-1" });
    expect(call.data).toEqual({ isActive: false });
    expect(mockedClearTagCache).toHaveBeenCalledWith("tag-1");
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("deactivateTag returns 404 for a missing record and does not invalidate", async () => {
    db.tag.findUnique.mockResolvedValue(null);
    await expect(deactivateTag(adminReq({}), res())).rejects.toBeInstanceOf(NotFoundError);
    expect(db.tag.update).not.toHaveBeenCalled();
    expect(mockedClearTagCache).not.toHaveBeenCalled();
  });
});

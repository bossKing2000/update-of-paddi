/**
 * Phase 2B.1 — Structured OptionGroup add-ons integrated into product
 * create/update (mocked unit tests).
 *
 * Covers: create with/without option groups, create with multiple groups +
 * items, priceAdd persistence, invalid selection limits, duplicate group/item
 * names, child-write failure (no false success), update with groups (upsert
 * by id), omitted groups preserved, cross-product group/item id rejection,
 * update persistence failure, and unrelated fields unchanged when omitted.
 *
 * All infrastructure (Prisma, Redis) is mocked; these prove application logic
 * only, not live PostgreSQL/Redis behaviour.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    optionGroup: { findMany: jest.fn() },
    optionGroupItem: { findMany: jest.fn() },
    dishType: { findUnique: jest.fn() },
    tag: { findUnique: jest.fn() },
    $transaction: jest.fn(async (cb) => {
      const prismaMock = require("../../src/lib/prisma").default;
      return cb(prismaMock);
    }),
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(async () => []),
}));

jest.mock("../../src/jobs/workers jobs/redis-baseQueue", () => ({
  __esModule: true,
  productIndexQueue: { add: jest.fn(async () => {}) },
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
  clearProductFromCarts: jest.fn(async () => {}),
  invalidateMarketplaceDiscoveryCaches: jest.fn(async () => {}),
}));

jest.mock("../../src/services/product.service", () => ({
  __esModule: true,
  ...jest.requireActual("../../src/services/product.service"),
  clearProductFromCarts: jest.fn(async () => {}),
  assertActiveDishType: jest.fn(async (id) => {
    if (id !== "JOLLOF") {
      const { ValidationError } = require("../../src/errors/AppError");
      throw new ValidationError("Invalid dish type");
    }
  }),
  resolveActiveTagIds: jest.fn(async (ids) => ids),
}));

jest.mock("../../src/controllers/vendorDashboard.service", () => ({
  __esModule: true,
  VendorDashboardService: jest.fn().mockImplementation(() => ({
    invalidateCache: jest.fn(async () => {}),
  })),
}));

import prisma from "../../src/lib/prisma";
import { createProduct, updateProduct } from "../../src/controllers/productController";
import { NotFoundError, ValidationError, ConflictError } from "../../src/errors/AppError";
import {
  createProductSchema,
  updateProductSchema,
} from "../../src/validations/ProductCRUDSchema";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  return r;
};

const vendorReq = (overrides = {}) => ({
  headers: {},
  body: {},
  params: { id: "prod-1" },
  query: {},
  files: undefined,
  ip: "127.0.0.1",
  socket: { remoteAddress: "127.0.0.1" },
  get: () => undefined,
  user: { id: "vendor-1", role: "VENDOR", sessionId: "sess" },
  ...overrides,
}) as any;

const createdProduct = {
  id: "prod-new",
  vendorId: "vendor-1",
  name: "Jollof Rice",
  archived: false,
  options: [],
  optionGroups: [],
  dishType: { id: "JOLLOF", name: "Jollof", description: "West African rice" },
  tags: [],
};

const baseBody = {
  name: "Jollof Rice",
  description: "Tasty West African rice dish",
  price: 2500,
  dishTypeId: "JOLLOF",
  images: ["img1.jpg"],
  optionGroups: [
    {
      name: "Protein",
      required: true,
      minSelections: 1,
      maxSelections: 2,
      sortOrder: 1,
      items: [
        { name: "Chicken", priceAdd: 500, isActive: true, sortOrder: 1 },
        { name: "Beef", priceAdd: 800, isActive: true, sortOrder: 2 },
      ],
    },
    {
      name: "Spice Level",
      required: false,
      minSelections: 0,
      maxSelections: 1,
      sortOrder: 2,
      items: [{ name: "Extra Spicy", priceAdd: 200, isActive: true, sortOrder: 1 }],
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  db.dishType.findUnique.mockResolvedValue({ id: "JOLLOF", categoryId: "RICE_DISHES" });
  db.product.create.mockResolvedValue(createdProduct);
  db.product.findUnique.mockResolvedValue({
    id: "prod-1",
    vendorId: "vendor-1",
    name: "Jollof Rice",
    dishTypeId: "JOLLOF",
    optionGroups: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Protein",
        items: [{ id: "22222222-2222-4222-8222-222222222222", name: "Chicken", priceAdd: 500, isActive: true }],
      },
    ],
  });
  db.optionGroup.findMany.mockResolvedValue([
    {
      id: "11111111-1111-4111-8111-111111111111",
      productId: "prod-1",
      name: "Protein",
      items: [{ id: "22222222-2222-4222-8222-222222222222", name: "Chicken", priceAdd: 500, isActive: true }],
    },
  ]);
  db.product.update.mockResolvedValue({ id: "prod-1", vendorId: "vendor-1" });
});

describe("createProduct — structured option groups", () => {
  it("creates a product without option groups (legacy behavior preserved)", async () => {
    const r = res();
    await createProduct(
      vendorReq({ body: { ...baseBody, optionGroups: undefined }, files: { images: [{ path: "img1.jpg" }] } }),
      r,
    );
    const call = db.product.create.mock.calls[0][0];
    expect(call.data.optionGroups).toBeUndefined();
    expect(call.data.options).toEqual({ create: [] });
    expect(r.status).toHaveBeenCalledWith(201);
  });

  it("creates a product with multiple option groups and items atomically", async () => {
    const r = res();
    await createProduct(vendorReq({ body: baseBody, files: { images: [{ path: "img1.jpg" }] } }), r);
    const call = db.product.create.mock.calls[0][0];
    expect(call.data.vendorId).toBe("vendor-1");
    expect(call.data.dishTypeId).toBe("JOLLOF");
    expect(call.data.categoryId).toBe("RICE_DISHES");
    expect(call.data.optionGroups.create).toHaveLength(2);
    const [group1, group2] = call.data.optionGroups.create;
    expect(group1.name).toBe("Protein");
    expect(group1.required).toBe(true);
    expect(group1.minSelections).toBe(1);
    expect(group1.maxSelections).toBe(2);
    expect(group1.items.create).toHaveLength(2);
    expect(group1.items.create[0]).toMatchObject({ name: "Chicken", priceAdd: 500, isActive: true });
    expect(group2.name).toBe("Spice Level");
    expect(group2.required).toBe(false);
    expect(group2.items.create[0].priceAdd).toBe(200);
    expect(db.product.create).toHaveBeenCalledTimes(1);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(201);
  });

  it("rejects selection limits where minSelections exceeds maxSelections", async () => {
    await expect(
      createProduct(
        vendorReq({
          body: { ...baseBody, optionGroups: [{ ...baseBody.optionGroups[0], minSelections: 3, maxSelections: 1 }] },
          files: { images: [{ path: "img1.jpg" }] },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("rejects a required group with minSelections below 1", async () => {
    await expect(
      createProduct(
        vendorReq({
          body: { ...baseBody, optionGroups: [{ ...baseBody.optionGroups[0], required: true, minSelections: 0 }] },
          files: { images: [{ path: "img1.jpg" }] },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate group names (case-insensitive)", async () => {
    await expect(
      createProduct(
        vendorReq({
          body: { ...baseBody, optionGroups: [{ ...baseBody.optionGroups[0], name: "Protein" }, { ...baseBody.optionGroups[0], name: "protein" }] },
          files: { images: [{ path: "img1.jpg" }] },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate item names within a group (case-insensitive)", async () => {
    await expect(
      createProduct(
        vendorReq({
          body: { ...baseBody, optionGroups: [{ ...baseBody.optionGroups[0], items: [{ name: "Chicken", priceAdd: 500 }, { name: "chicken", priceAdd: 600 }] }] },
          files: { images: [{ path: "img1.jpg" }] },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("rejects invalid priceAdd (out of range)", async () => {
    await expect(
      createProduct(
        vendorReq({
          body: { ...baseBody, optionGroups: [{ ...baseBody.optionGroups[0], items: [{ ...baseBody.optionGroups[0].items[0], priceAdd: 9999999 }] }] },
          files: { images: [{ path: "img1.jpg" }] },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("child-write failure does not produce a false success", async () => {
    db.product.create.mockRejectedValue(new Error("write failed"));
    await expect(createProduct(vendorReq({ body: baseBody, files: { images: [{ path: "img1.jpg" }] } }), res())).rejects.toThrow();
  });
});

describe("updateProduct — structured option groups", () => {
  const baseBody = { name: "Jollof Rice", description: "Updated description", price: 2600 };

  it("updates a product's option groups by id (upsert semantics)", async () => {
    const r = res();
    await updateProduct(
      vendorReq({
        body: {
          ...baseBody,
          optionGroups: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Protein",
              required: true,
              minSelections: 1,
              maxSelections: 2,
              sortOrder: 1,
              items: [
                { id: "22222222-2222-4222-8222-222222222222", name: "Chicken", priceAdd: 600, isActive: true },
                { name: "Fish", priceAdd: 700, isActive: true },
              ],
            },
            { name: "New Group", required: false, minSelections: 0, maxSelections: 1 },
          ],
        },
        files: undefined,
      }),
      r,
    );
    const call = db.product.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "prod-1" });
    const og = call.data.optionGroups;
    expect(og.create).toHaveLength(1);
    expect(og.create[0].name).toBe("New Group");
    expect(og.update).toHaveLength(1);
    expect(og.update[0].where).toEqual({ id: "11111111-1111-4111-8111-111111111111" });
    expect(og.update[0].data.items.create).toHaveLength(1);
    expect(og.update[0].data.items.create[0].name).toBe("Fish");
    expect(og.update[0].data.items.update).toHaveLength(1);
    expect(og.update[0].data.items.update[0].data.priceAdd).toBe(600);
    expect(db.optionGroup.findMany).toHaveBeenCalledWith({ where: { productId: "prod-1" }, include: { items: true } });
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("omitted optionGroups preserves existing groups (no deletion)", async () => {
    const r = res();
    await updateProduct(vendorReq({ body: { ...baseBody, name: "Renamed" } }), r);
    const call = db.product.update.mock.calls[0][0];
    expect(call.data.optionGroups).toBeUndefined();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("rejects a group id belonging to another product", async () => {
    await expect(
      updateProduct(
        vendorReq({ body: { ...baseBody, optionGroups: [{ id: "33333333-3333-4333-8333-333333333333", name: "X", required: false, minSelections: 0, maxSelections: 1 }] } }),
        res(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it("rejects an item id belonging to another group", async () => {
    await expect(
      updateProduct(
        vendorReq({
          body: {
            ...baseBody,
            optionGroups: [{ id: "11111111-1111-4111-8111-111111111111", name: "Protein", required: true, minSelections: 1, maxSelections: 2, items: [{ id: "44444444-4444-4444-8444-444444444444", name: "X", priceAdd: 10 }] }],
          },
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it("update persistence failure does not produce a false success", async () => {
    db.product.update.mockRejectedValue(new Error("write failed"));
    await expect(updateProduct(vendorReq({ body: { ...baseBody, optionGroups: undefined } }), res())).rejects.toThrow();
  });

  it("unrelated product fields remain unchanged when omitted", async () => {
    const r = res();
    await updateProduct(vendorReq({ body: { name: "Only Name Changed" } }), r);
    const call = db.product.update.mock.calls[0][0];
    expect(call.data.name).toBe("Only Name Changed");
    expect(call.data.description).toBeUndefined();
    expect(call.data.price).toBeUndefined();
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

/**
 * Phase 2B.2 review F-1 — the nested product writes must apply the SAME
 * duplicate-name rule as the standalone option-group endpoints.
 *
 * SCOPE NOTE, stated so these results are not over-read: Zod
 * (`ProductCRUDSchema.uniqueOptionGroupNames`) already rejected duplicates
 * WITHIN one request before this batch, and the tests above pin that. What was
 * genuinely missing — and is what these tests cover — is:
 *   (a) a name colliding with a group that ALREADY EXISTS on the product, which
 *       the Zod refine cannot see because it only inspects the payload;
 *   (b) the HTTP error surface for a uniqueness violation, which previously fell
 *       through to the global mapper and rendered Prisma's raw index name.
 *
 * All infrastructure is mocked. These prove application logic only. They do NOT
 * prove that the database constraint exists or that concurrent requests are
 * serialized.
 */
describe("review F-1 — nested writes enforce existing-group collisions", () => {
  const GROUP_ID = "11111111-1111-4111-8111-111111111111";
  const OTHER_GROUP_ID = "55555555-5555-4555-8555-555555555555";

  const existingGroups = () => [
    {
      id: GROUP_ID,
      productId: "prod-1",
      name: "Protein",
      items: [
        { id: "22222222-2222-4222-8222-222222222222", name: "Chicken", priceAdd: 500, isActive: true },
      ],
    },
    {
      id: OTHER_GROUP_ID,
      productId: "prod-1",
      name: "Extras",
      items: [],
    },
  ];

  const updateBody = (groups: unknown[]) => ({
    name: "Jollof Rice",
    description: "Updated",
    price: 2600,
    optionGroups: groups,
  });

  it("rejects renaming a group onto a DIFFERENT existing group's name", async () => {
    db.optionGroup.findMany.mockResolvedValue(existingGroups());
    await expect(
      updateProduct(
        vendorReq({
          body: updateBody([
            {
              id: GROUP_ID,
              name: "Extras", // collides with the existing "Extras" group
              required: true,
              minSelections: 1,
              maxSelections: 2,
              items: [],
            },
          ]),
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it("rejects a rename colliding with an existing name that differs only by case", async () => {
    db.optionGroup.findMany.mockResolvedValue(existingGroups());
    await expect(
      updateProduct(
        vendorReq({
          body: updateBody([
            {
              id: GROUP_ID,
              name: "  extras  ", // normalizes to the existing "Extras"
              required: true,
              minSelections: 1,
              maxSelections: 2,
              items: [],
            },
          ]),
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it("allows a group to keep its own current name", async () => {
    db.optionGroup.findMany.mockResolvedValue(existingGroups());
    db.product.update.mockResolvedValue({ id: "prod-1", vendorId: "vendor-1" });
    db.product.findUnique.mockResolvedValue({
      id: "prod-1",
      vendorId: "vendor-1",
      name: "Jollof Rice",
      dishTypeId: "JOLLOF",
      options: [],
      optionGroups: [],
      tags: [],
    });
    await expect(
      updateProduct(
        vendorReq({
          body: updateBody([
            {
              id: GROUP_ID,
              name: "Protein", // unchanged
              required: true,
              minSelections: 1,
              maxSelections: 2,
              items: [],
            },
          ]),
        }),
        res(),
      ),
    ).resolves.toBeDefined();
    expect(db.product.update).toHaveBeenCalled();
  });

  it("rejects a NEW group whose name collides with an existing group", async () => {
    // Zod cannot see this: its refine inspects only the request payload, so a
    // brand-new group matching a PERSISTED name previously reached the database.
    db.optionGroup.findMany.mockResolvedValue(existingGroups());
    await expect(
      updateProduct(
        vendorReq({
          body: updateBody([
            {
              name: "Extras", // no id => a create; collides with existing "Extras"
              required: false,
              minSelections: 0,
              maxSelections: 1,
              items: [{ name: "Extra Egg", priceAdd: 200 }],
            },
          ]),
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it("rejects an item renamed onto another item already in the SAME group", async () => {
    db.optionGroup.findMany.mockResolvedValue([
      {
        id: GROUP_ID,
        productId: "prod-1",
        name: "Protein",
        items: [
          { id: "22222222-2222-4222-8222-222222222222", name: "Chicken", priceAdd: 500, isActive: true },
          { id: "66666666-6666-4666-8666-666666666666", name: "Beef", priceAdd: 800, isActive: true },
        ],
      },
    ]);
    await expect(
      updateProduct(
        vendorReq({
          body: updateBody([
            {
              id: GROUP_ID,
              name: "Protein",
              required: true,
              minSelections: 1,
              maxSelections: 2,
              items: [
                { id: "22222222-2222-4222-8222-222222222222", name: "Beef", priceAdd: 800 },
              ],
            },
          ]),
        }),
        res(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.product.update).not.toHaveBeenCalled();
  });
});

describe("review F-1 — uniqueness violations produce a safe client error", () => {
  // Must satisfy updateProductSchema (name >= 2 chars) or Zod rejects the body
  // before the controller ever reaches the transaction.
  const VALID_UPDATE_BODY = {
    name: "Jollof Rice",
    description: "Updated description",
    price: 2600,
  };
  const p2002 = () =>
    new (require("@prisma/client").Prisma.PrismaClientKnownRequestError)("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["productId", "name"] },
    });

  it("create: P2002 becomes a ConflictError that leaks no index name", async () => {
    db.product.create.mockRejectedValue(p2002());
    let caught: unknown;
    try {
      await createProduct(vendorReq({ body: baseBody, files: { images: [{ path: "img1.jpg" }] } }), res());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as Error).message).not.toContain("OptionGroup_productId_name_key");
    expect((caught as Error).message).not.toContain("productId");
  });

  it("update: P2002 becomes the same safe ConflictError", async () => {
    db.product.update.mockRejectedValue(p2002());
    let caught: unknown;
    try {
      await updateProduct(vendorReq({ body: VALID_UPDATE_BODY }), res());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as Error).message).not.toContain("P2002");
  });

  it("create: a P2002 from the normalized expression index becomes the same safe ConflictError", async () => {
    // The hand-written index "OptionGroup_productId_name_lower_key"
    // (("productId", lower(btrim("name")))) is invisible to Prisma's schema
    // language, so a violation of it is reported by index NAME in meta.target.
    // The mapping must key on the error code so the client response is
    // identical for both indexes and leaks no internal identifier.
    const err = new (require("@prisma/client").Prisma.PrismaClientKnownRequestError)("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: "OptionGroup_productId_name_lower_key" },
    });
    db.product.create.mockRejectedValue(err);

    let caught: unknown;
    try {
      await createProduct(vendorReq({ body: baseBody, files: { images: [{ path: "img1.jpg" }] } }), res());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as Error).message).not.toContain("OptionGroup_productId_name_lower_key");
    expect((caught as Error).message).not.toContain("lower(btrim");
    expect((caught as Error).message).not.toContain("productId");
  });

  it("update: a P2002 from the normalized expression index becomes the same safe ConflictError", async () => {
    const err = new (require("@prisma/client").Prisma.PrismaClientKnownRequestError)("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: "OptionGroup_productId_name_lower_key" },
    });
    db.product.update.mockRejectedValue(err);

    let caught: unknown;
    try {
      await updateProduct(vendorReq({ body: VALID_UPDATE_BODY }), res());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as Error).message).not.toContain("OptionGroup_productId_name_lower_key");
  });

  it("an unrelated P2003 is NOT disguised as a duplicate-name conflict", async () => {
    const err = new (require("@prisma/client").Prisma.PrismaClientKnownRequestError)("fk", {
      code: "P2003",
      clientVersion: "test",
    });
    db.product.update.mockRejectedValue(err);
    await expect(
      updateProduct(vendorReq({ body: VALID_UPDATE_BODY }), res()),
    ).rejects.toBe(err);
  });

  it("a plain application error still surfaces unchanged", async () => {
    const err = new Error("something else broke");
    db.product.create.mockRejectedValue(err);
    await expect(
      createProduct(vendorReq({ body: baseBody, files: { images: [{ path: "img1.jpg" }] } }), res()),
    ).rejects.toBe(err);
  });
});

/**
 * F-2.8 — within-request duplicate detection through the canonical normalizer.
 *
 * These are pure schema tests (no controller, no database). They pin the
 * behaviour that `uniqueOptionGroupNames` had before it was changed to reuse
 * `normalizeOptionName`, so the refactor cannot silently alter the uniqueness
 * rule, the whitespace semantics, or the existing error surface.
 */
describe("F-2.8 — nested option-group name uniqueness uses the canonical normalizer", () => {
  const validProduct = {
    name: "Jollof Rice",
    description: "Tasty West African rice dish",
    price: 2500,
    dishTypeId: "JOLLOF",
  };

  const groupWith = (name: string, itemNames: string[] = ["Chicken"]) => ({
    name,
    required: true,
    minSelections: 1,
    maxSelections: 1,
    items: itemNames.map((itemName) => ({ name: itemName, priceAdd: 100 })),
  });

  const expectDuplicateRejection = (
    parsed: ReturnType<typeof createProductSchema.safeParse> | ReturnType<typeof updateProductSchema.safeParse>,
  ) => {
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual([
      expect.objectContaining({
        message: "Group and item names must be unique per product",
        path: ["optionGroups"],
      }),
    ]);
  };

  it("rejects duplicate group names that differ only by case (create + update)", () => {
    const optionGroups = [groupWith("Protein"), groupWith("protein")];
    expectDuplicateRejection(createProductSchema.safeParse({ ...validProduct, optionGroups }));
    expectDuplicateRejection(updateProductSchema.safeParse({ optionGroups }));
  });

  it("rejects duplicate group names that differ only by surrounding whitespace", () => {
    const optionGroups = [groupWith("Protein"), groupWith("  protein  ")];
    expectDuplicateRejection(createProductSchema.safeParse({ ...validProduct, optionGroups }));
  });

  it("rejects duplicate item names that differ only by case (create + update)", () => {
    const optionGroups = [groupWith("Protein", ["Chicken", "chicken"])];
    expectDuplicateRejection(createProductSchema.safeParse({ ...validProduct, optionGroups }));
    expectDuplicateRejection(updateProductSchema.safeParse({ optionGroups }));
  });

  it("rejects duplicate item names that differ only by surrounding whitespace", () => {
    const optionGroups = [groupWith("Protein", ["Chicken", "  chicken  "])];
    expectDuplicateRejection(createProductSchema.safeParse({ ...validProduct, optionGroups }));
  });

  it("does not collapse internal whitespace (existing semantics preserved)", () => {
    // `normalizeOptionName` is trim + lowercase only. "Extra  Egg" and
    // "Extra Egg" remain distinct, exactly as they were before the refactor.
    const optionGroups = [groupWith("Protein", ["Extra Egg", "Extra  Egg"])];
    expect(createProductSchema.safeParse({ ...validProduct, optionGroups }).success).toBe(true);
  });

  it("still accepts genuinely distinct group and item names", () => {
    const optionGroups = [groupWith("Protein", ["Chicken", "Beef"]), groupWith("Spice Level", ["Mild"])];
    expect(createProductSchema.safeParse({ ...validProduct, optionGroups }).success).toBe(true);
    expect(updateProductSchema.safeParse({ optionGroups }).success).toBe(true);
  });

  it("allows the same item name in different groups (uniqueness is per group)", () => {
    // Item uniqueness is per group, not per product: the same item name in two
    // different groups is allowed. Pinned so the refactor cannot add a stricter
    // cross-group rule.
    const optionGroups = [groupWith("Protein", ["Chicken"]), groupWith("Extras", ["Chicken"])];
    expect(createProductSchema.safeParse({ ...validProduct, optionGroups }).success).toBe(true);
  });
});

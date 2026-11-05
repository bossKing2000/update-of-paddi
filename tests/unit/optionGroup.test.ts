/**
 * Phase 2B.3 — OptionGroup/OptionGroupItem vendor management:
 * CRUD, ownership (IDOR), validation, ordering, legacy isolation.
 */
jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findUnique: jest.fn() },
    optionGroup: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    optionGroupItem: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    // Phase 3.1.1: delete paths pre-check OrderItemOption history.
    orderItemOption: { findFirst: jest.fn() },
    // Block-hard-deletion policy: delete paths also pre-check live cart
    // selections before removing a group/item.
    cartItemOption: { findFirst: jest.fn() },
  },
}));

jest.mock("../../src/services/clearCaches", () => ({
  __esModule: true,
  clearProductCache: jest.fn(async () => {}),
}));

// Cart invalidation is exercised in cartDeletionInvalidation.test.ts; keep this
// suite free of real Redis connections while still asserting it is invoked.
jest.mock("../../src/services/product.service", () => ({
  __esModule: true,
  clearProductFromCarts: jest.fn(async () => {}),
}));

import prisma from "../../src/lib/prisma";
import { clearProductFromCarts } from "../../src/services/product.service";
import { ForbiddenError, ValidationError, ConflictError } from "../../src/errors/AppError";
import { Prisma } from "@prisma/client";
import {
  createOptionGroup,
  updateOptionGroup,
  deleteOptionGroup,
  listOptionGroups,
  createOptionGroupItem,
  updateOptionGroupItem,
  deleteOptionGroupItem,
} from "../../src/services/optionGroup.service";
import {
  createOptionGroupSchema,
  updateOptionGroupSchema,
  createOptionGroupItemSchema,
  updateOptionGroupItemSchema,
} from "../../src/validations/ProductCRUDSchema";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const OWN_PRODUCT = { id: "prod-1", vendorId: "vendor-1" };
const OWN_GROUP = {
  id: "group-1",
  productId: "prod-1",
  name: "Add-ons",
  required: false,
  minSelections: 0,
  maxSelections: 2,
  sortOrder: 0,
  product: { id: "prod-1", vendorId: "vendor-1" },
};
const OWN_ITEM = {
  id: "item-1",
  optionGroupId: "group-1",
  name: "Extra Meat",
  priceAdd: 500,
  isActive: true,
  sortOrder: 0,
  optionGroup: { id: "group-1", productId: "prod-1", product: { id: "prod-1", vendorId: "vendor-1" } },
};

beforeEach(() => {
  jest.clearAllMocks();
  db.product.findUnique.mockResolvedValue({ ...OWN_PRODUCT });
  db.optionGroup.findUnique.mockResolvedValue({ ...OWN_GROUP });
  db.optionGroup.findMany.mockResolvedValue([]);
  db.optionGroup.create.mockImplementation(async (args: any) => ({ id: "group-new", ...args.data }));
  db.optionGroup.update.mockImplementation(async (args: any) => ({ ...OWN_GROUP, ...args.data }));
  db.optionGroup.delete.mockImplementation(async (args: any) => ({ id: args.where.id }));
  db.optionGroupItem.findUnique.mockResolvedValue({ ...OWN_ITEM });
  db.optionGroupItem.findMany.mockResolvedValue([]);
  db.optionGroupItem.create.mockImplementation(async (args: any) => ({ id: "item-new", ...args.data }));
  db.optionGroupItem.update.mockImplementation(async (args: any) => ({ ...OWN_ITEM, ...args.data }));
  db.optionGroupItem.delete.mockImplementation(async (args: any) => ({ id: args.where.id }));
  // Phase 3.1.1: no order history by default, so deletes proceed.
  db.orderItemOption.findFirst.mockResolvedValue(null);
  // Block-hard-deletion policy: no live cart selection by default.
  db.cartItemOption.findFirst.mockResolvedValue(null);
  (clearProductFromCarts as jest.Mock).mockClear();
});

describe("group creation", () => {
  it("creates a group for an owned product", async () => {
    const group = await createOptionGroup("vendor-1", "prod-1", {
      name: " Choose Protein ",
      required: true,
      minSelections: 1,
      maxSelections: 1,
      sortOrder: 2,
    });
    expect(db.optionGroup.create).toHaveBeenCalledWith({
      data: {
        productId: "prod-1",
        name: "Choose Protein",
        required: true,
        minSelections: 1,
        maxSelections: 1,
        sortOrder: 2,
      },
    });
    expect(group).toMatchObject({ productId: "prod-1" });
  });

  it("rejects Vendor A creating under Vendor B's product", async () => {
    db.product.findUnique.mockResolvedValue({ id: "prod-1", vendorId: "vendor-2" });
    await expect(
      createOptionGroup("vendor-1", "prod-1", { name: "X", required: false, minSelections: 0, maxSelections: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.optionGroup.create).not.toHaveBeenCalled();
  });

  it("rejects unknown products without leaking existence", async () => {
    db.product.findUnique.mockResolvedValue(null);
    await expect(
      createOptionGroup("vendor-1", "nope", { name: "X", required: false, minSelections: 0, maxSelections: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects required=true with minSelections=0", async () => {
    await expect(
      createOptionGroup("vendor-1", "prod-1", { name: "X", required: true, minSelections: 0, maxSelections: 2 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.optionGroup.create).not.toHaveBeenCalled();
  });

  it("rejects minSelections > maxSelections", async () => {
    await expect(
      createOptionGroup("vendor-1", "prod-1", { name: "X", required: false, minSelections: 3, maxSelections: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

/**
 * Phase 2B.2: `@@unique([productId, name])` on OptionGroup. These prove the
 * two layers — pre-check (friendly 409) and P2002 (race) — never leak a raw
 * Prisma error to the vendor.
 */
describe("group name uniqueness", () => {
  const INPUT = { required: false, minSelections: 0, maxSelections: 1 };

  it("rejects a duplicate group name on the same product with 409", async () => {
    db.optionGroup.findMany.mockResolvedValue([{ id: "group-1", name: "Extras" }]);
    await expect(createOptionGroup("vendor-1", "prod-1", { ...INPUT, name: "Extras" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(db.optionGroup.create).not.toHaveBeenCalled();
  });

  it("treats names differing only by case/whitespace as duplicates", async () => {
    db.optionGroup.findMany.mockResolvedValue([{ id: "group-1", name: "  extras " }]);
    await expect(createOptionGroup("vendor-1", "prod-1", { ...INPUT, name: "Extras" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(db.optionGroup.create).not.toHaveBeenCalled();
  });

  it("allows the same group name on a DIFFERENT product", async () => {
    // findMany is scoped to the product being written, so this is inherently
    // allowed; the test pins that scoping contract.
    db.optionGroup.findMany.mockResolvedValue([]);
    await createOptionGroup("vendor-1", "prod-2", { ...INPUT, name: "Extras" });
    expect(db.optionGroup.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productId: "prod-2", name: "Extras" }) }),
    );
  });

  it("maps a P2002 race on create to the same 409 without leaking internals", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["productId", "name"] },
    });
    db.optionGroup.create.mockRejectedValueOnce(err);
    let caught: unknown;
    try {
      await createOptionGroup("vendor-1", "prod-1", { ...INPUT, name: "Extras" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as Error).message).not.toContain("P2002");
    expect((caught as Error).message).not.toContain("productId");
  });

  it("rejects a rename that would collide with a sibling group", async () => {
    db.optionGroup.findMany.mockResolvedValue([{ id: "group-2", name: "Extras" }]);
    await expect(updateOptionGroup("vendor-1", "group-1", { name: "Extras" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(db.optionGroup.update).not.toHaveBeenCalled();
  });

  it("allows a no-op rename of a group onto its own name", async () => {
    db.optionGroup.findMany.mockResolvedValue([{ id: "group-1", name: "Extras" }]);
    await expect(updateOptionGroup("vendor-1", "group-1", { name: "Extras" })).resolves.toBeTruthy();
    expect(db.optionGroup.update).toHaveBeenCalled();
  });

  it("does not check group uniqueness when the patch has no name", async () => {
    await updateOptionGroup("vendor-1", "group-1", { maxSelections: 4 });
    expect(db.optionGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { maxSelections: 4 } }),
    );
  });

  it("maps a P2002 race on rename to the same 409", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    db.optionGroup.update.mockRejectedValueOnce(err);
    await expect(updateOptionGroup("vendor-1", "group-1", { name: "Extras" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("maps a P2002 from the normalized expression index on create to the same 409", async () => {
    // The hand-written index "OptionGroup_productId_name_lower_key"
    // (("productId", lower(btrim("name")))) is invisible to Prisma's schema
    // language, so a violation of it is reported by index NAME. The mapping
    // keys on the error code, so the client gets the same safe 409.
    const err = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: "OptionGroup_productId_name_lower_key" },
    });
    db.optionGroup.create.mockRejectedValueOnce(err);

    let caught: unknown;
    try {
      await createOptionGroup("vendor-1", "prod-1", { ...INPUT, name: "Extras" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as Error).message).not.toContain("OptionGroup_productId_name_lower_key");
    expect((caught as Error).message).not.toContain("lower(btrim");
  });

  it("maps a P2002 from the normalized expression index on rename to the same 409", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: "OptionGroup_productId_name_lower_key" },
    });
    db.optionGroup.update.mockRejectedValueOnce(err);

    let caught: unknown;
    try {
      await updateOptionGroup("vendor-1", "group-1", { name: "extras" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as Error).message).not.toContain("OptionGroup_productId_name_lower_key");
  });

  it("re-throws non-uniqueness database errors unchanged", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("boom", {
      code: "P2025",
      clientVersion: "test",
    });
    db.optionGroup.create.mockRejectedValueOnce(err);
    await expect(createOptionGroup("vendor-1", "prod-1", { ...INPUT, name: "Extras" })).rejects.toBe(err);
  });
});

describe("group update", () => {
  it("updates allowed fields and validates the merged result", async () => {
    const group = await updateOptionGroup("vendor-1", "group-1", { name: "Extras", maxSelections: 5 });
    expect(db.optionGroup.update).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: { name: "Extras", maxSelections: 5 },
    });
    expect(group).toBeDefined();
  });

  it("rejects a patch that breaks merged invariants", async () => {
    // Stored: required=false, min=0, max=2. Patching required=true alone
    // would leave min=0 — the merged check must catch it.
    await expect(updateOptionGroup("vendor-1", "group-1", { required: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(db.optionGroup.update).not.toHaveBeenCalled();
  });

  it("rejects Vendor A updating Vendor B's group", async () => {
    db.optionGroup.findUnique.mockResolvedValue({
      ...OWN_GROUP,
      product: { id: "prod-1", vendorId: "vendor-2" },
    });
    await expect(updateOptionGroup("vendor-1", "group-1", { name: "Hijacked" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(db.optionGroup.update).not.toHaveBeenCalled();
  });
});

describe("group deletion", () => {
  it("deletes an owned group (items cascade in DB, legacy rows untouched)", async () => {
    const result = await deleteOptionGroup("vendor-1", "group-1");
    expect(db.optionGroup.delete).toHaveBeenCalledWith({ where: { id: "group-1" } });
    expect(db.cartItemOption.findFirst).toHaveBeenCalledWith({
      where: { optionGroupItem: { optionGroupId: "group-1" } },
      select: { id: true },
    });
    expect(clearProductFromCarts).toHaveBeenCalledWith("prod-1");
    expect(result).toEqual({ id: "group-1" });
  });

  it("refuses to delete a group selected in a live customer cart", async () => {
    db.cartItemOption.findFirst.mockResolvedValue({ id: "cart-option-1" });

    await expect(deleteOptionGroup("vendor-1", "group-1")).rejects.toBeInstanceOf(ConflictError);
    expect(db.optionGroup.delete).not.toHaveBeenCalled();
    expect(clearProductFromCarts).not.toHaveBeenCalled();
  });

  it("rejects Vendor A deleting Vendor B's group", async () => {
    db.optionGroup.findUnique.mockResolvedValue({
      ...OWN_GROUP,
      product: { id: "prod-1", vendorId: "vendor-2" },
    });
    await expect(deleteOptionGroup("vendor-1", "group-1")).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.optionGroup.delete).not.toHaveBeenCalled();
    expect(db.cartItemOption.findFirst).not.toHaveBeenCalled();
  });
});

describe("group listing order", () => {
  it("orders groups and items by sortOrder with id tie-break", async () => {
    await listOptionGroups("vendor-1", "prod-1");
    expect(db.optionGroup.findMany).toHaveBeenCalledWith({
      where: { productId: "prod-1" },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      include: { items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
    });
  });

  it("rejects Vendor A listing Vendor B's groups", async () => {
    db.product.findUnique.mockResolvedValue({ id: "prod-1", vendorId: "vendor-2" });
    await expect(listOptionGroups("vendor-1", "prod-1")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("item creation", () => {
  it("creates an item with exact fields", async () => {
    const item = await createOptionGroupItem("vendor-1", "group-1", {
      name: " Extra Chicken ",
      priceAdd: 500,
      isActive: true,
      sortOrder: 1,
    });
    expect(db.optionGroupItem.create).toHaveBeenCalledWith({
      data: { optionGroupId: "group-1", name: "Extra Chicken", priceAdd: 500, isActive: true, sortOrder: 1 },
    });
    expect(item).toBeDefined();
  });

  it("rejects duplicate names case-insensitively within the group", async () => {
    db.optionGroupItem.findMany.mockResolvedValue([{ id: "item-9", name: "extra meat" }]);
    await expect(
      createOptionGroupItem("vendor-1", "group-1", { name: "Extra Meat", priceAdd: 100 }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.optionGroupItem.create).not.toHaveBeenCalled();
  });

  it("maps a P2002 from the normalized item index on create to the same 409", async () => {
    // The item-name constraint is a hand-written EXPRESSION index
    // ("optionGroupId", lower(btrim(name))), so its metadata need not look
    // like an ordinary field constraint. The mapping must key on the error
    // CODE and must not echo the index name or the expression.
    const err = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["optionGroupId", "lower(btrim(name))"] },
    });
    db.optionGroupItem.create.mockRejectedValueOnce(err);

    let caught: unknown;
    try {
      await createOptionGroupItem("vendor-1", "group-1", { name: "Extra Meat", priceAdd: 100 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const message = (caught as Error).message;
    expect(message).not.toContain("OptionGroupItem_optionGroupId_name_lower_key");
    expect(message).not.toContain("lower(btrim");
    expect(message).not.toContain("optionGroupId");
    expect(message).not.toContain("P2002");
  });

  it("maps a P2002 from the normalized item index on rename to the same 409", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["optionGroupId", "name"] },
    });
    db.optionGroupItem.update.mockRejectedValueOnce(err);

    let caught: unknown;
    try {
      await updateOptionGroupItem("vendor-1", "item-9", { name: "Extra Meat" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as Error).message).not.toContain("OptionGroupItem_optionGroupId_name_lower_key");
    expect((caught as Error).message).not.toContain("lower(btrim");
  });

  it("does not let the meta.target shape change the mapping", async () => {
    // A non-array target (as a hand-written index may report) and a missing
    // target must both still map to the conflict.
    for (const meta of [undefined, { target: "OptionGroupItem_optionGroupId_name_lower_key" }, { target: [] }]) {
      db.optionGroupItem.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "test",
          meta: meta as never,
        }),
      );
      await expect(
        createOptionGroupItem("vendor-1", "group-1", { name: "Extra Meat", priceAdd: 100 }),
      ).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it("re-throws unrelated item-write database errors unchanged", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("fk", {
      code: "P2003",
      clientVersion: "test",
    });
    db.optionGroupItem.create.mockRejectedValueOnce(err);
    await expect(
      createOptionGroupItem("vendor-1", "group-1", { name: "Extra Meat", priceAdd: 100 }),
    ).rejects.toBe(err);

    const missing = new Prisma.PrismaClientKnownRequestError("not found", {
      code: "P2025",
      clientVersion: "test",
    });
    db.optionGroupItem.update.mockRejectedValueOnce(missing);
    await expect(updateOptionGroupItem("vendor-1", "item-9", { name: "X" })).rejects.toBe(missing);
  });

  it("rejects Vendor A creating under Vendor B's group", async () => {
    db.optionGroup.findUnique.mockResolvedValue({
      ...OWN_GROUP,
      product: { id: "prod-1", vendorId: "vendor-2" },
    });
    await expect(
      createOptionGroupItem("vendor-1", "group-1", { name: "X", priceAdd: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.optionGroupItem.create).not.toHaveBeenCalled();
  });
});

describe("item update", () => {
  it("updates allowed fields and never reassigns optionGroupId", async () => {
    await updateOptionGroupItem("vendor-1", "item-1", { priceAdd: 750, isActive: false });
    const data = db.optionGroupItem.update.mock.calls[0][0].data;
    expect(data).toEqual({ priceAdd: 750, isActive: false });
    expect(data).not.toHaveProperty("optionGroupId");
  });

  it("rejects rename clashes excluding itself", async () => {
    db.optionGroupItem.findMany.mockResolvedValue([
      { id: "item-1", name: "Extra Meat" },
      { id: "item-2", name: "Double Portion" },
    ]);
    // Renaming to its own name (different case) is fine.
    await updateOptionGroupItem("vendor-1", "item-1", { name: "EXTRA MEAT" });
    expect(db.optionGroupItem.update).toHaveBeenCalled();
    // Renaming onto a sibling is not.
    await expect(updateOptionGroupItem("vendor-1", "item-1", { name: "double portion" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("rejects Vendor A updating Vendor B's item through the full chain", async () => {
    db.optionGroupItem.findUnique.mockResolvedValue({
      ...OWN_ITEM,
      optionGroup: { ...OWN_ITEM.optionGroup, product: { id: "prod-1", vendorId: "vendor-2" } },
    });
    await expect(updateOptionGroupItem("vendor-1", "item-1", { priceAdd: 1 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(db.optionGroupItem.update).not.toHaveBeenCalled();
  });
});

describe("item deletion", () => {
  it("deletes only the new item row", async () => {
    const result = await deleteOptionGroupItem("vendor-1", "item-1");
    expect(db.optionGroupItem.delete).toHaveBeenCalledWith({ where: { id: "item-1" } });
    expect(db.cartItemOption.findFirst).toHaveBeenCalledWith({
      where: { optionGroupItemId: "item-1" },
      select: { id: true },
    });
    expect(clearProductFromCarts).toHaveBeenCalledWith("prod-1");
    expect(result).toEqual({ id: "item-1" });
  });

  it("refuses to delete an item selected in a live customer cart", async () => {
    db.cartItemOption.findFirst.mockResolvedValue({ id: "cart-option-1" });

    await expect(deleteOptionGroupItem("vendor-1", "item-1")).rejects.toBeInstanceOf(ConflictError);
    expect(db.optionGroupItem.delete).not.toHaveBeenCalled();
    expect(clearProductFromCarts).not.toHaveBeenCalled();
  });

  it("rejects Vendor A deleting Vendor B's item", async () => {
    db.optionGroupItem.findUnique.mockResolvedValue({
      ...OWN_ITEM,
      optionGroup: { ...OWN_ITEM.optionGroup, product: { id: "prod-1", vendorId: "vendor-2" } },
    });
    await expect(deleteOptionGroupItem("vendor-1", "item-1")).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.optionGroupItem.delete).not.toHaveBeenCalled();
    expect(db.cartItemOption.findFirst).not.toHaveBeenCalled();
  });
});

describe("validation schemas", () => {
  it("accepts negative priceAdd (Float/naira surcharge range)", () => {
    expect(createOptionGroupItemSchema.safeParse({ name: "Discount", priceAdd: -200 }).success).toBe(true);
  });

  it("rejects non-finite and out-of-range priceAdd", () => {
    expect(createOptionGroupItemSchema.safeParse({ name: "X", priceAdd: NaN }).success).toBe(false);
    expect(createOptionGroupItemSchema.safeParse({ name: "X", priceAdd: 2000000 }).success).toBe(false);
  });

  it("rejects required=true with minSelections=0 at the schema level", () => {
    expect(
      createOptionGroupSchema.safeParse({ name: "G", required: true, minSelections: 0, maxSelections: 2 }).success,
    ).toBe(false);
  });

  it("allows partial updates that stay coherent", () => {
    expect(updateOptionGroupSchema.safeParse({ maxSelections: 5 }).success).toBe(true);
    expect(updateOptionGroupItemSchema.safeParse({ isActive: false }).success).toBe(true);
  });
});

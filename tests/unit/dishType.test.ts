jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    dishType: { findMany: jest.fn() },
    product: { groupBy: jest.fn() },
  },
}));

jest.mock("../../src/lib/redis", () => ({
  __esModule: true,
  redisProducts: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSearch: { get: jest.fn() },
  redisTotalViews: { get: jest.fn() },
  ShopCartRedis: {},
}));

import prisma from "../../src/lib/prisma";
import { redisProducts } from "../../src/lib/redis";
import {
  dishTypeIdSchema,
  createProductSchema,
  updateProductSchema,
} from "../../src/validations/ProductCRUDSchema";
import {
  isProductInStock,
  isProductCurrentlyAvailable,
} from "../../src/services/vendorAvailability.service";
import { assertActiveDishType, fetchWhatsInThePot } from "../../src/services/product.service";
import { ValidationError } from "../../src/errors/AppError";

const mockedDishFindMany = (prisma as any).dishType.findMany as jest.Mock;
const mockedRedisGet = (redisProducts as any).get as jest.Mock;

const ACTIVE_DISHES = [
  { id: "JOLLOF", name: "Jollof Rice", description: null, imageUrl: null, sortOrder: 10 },
  { id: "SUYA", name: "Suya", description: null, imageUrl: null, sortOrder: 300 },
  { id: "OTHER", name: "Other", description: null, imageUrl: null, sortOrder: 9999 },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockedRedisGet.mockResolvedValue(null);
  mockedDishFindMany.mockResolvedValue(ACTIVE_DISHES);
});

describe("dishTypeIdSchema — shape validation", () => {
  it("accepts canonical ids", () => {
    expect(dishTypeIdSchema.safeParse("JOLLOF").success).toBe(true);
    expect(dishTypeIdSchema.safeParse("EWA_AGOYIN").success).toBe(true);
    expect(dishTypeIdSchema.safeParse("OTHER").success).toBe(true);
  });

  it("rejects lowercase (prevents Ofada/ofada/OFADA duplicates)", () => {
    expect(dishTypeIdSchema.safeParse("ofada").success).toBe(false);
    expect(dishTypeIdSchema.safeParse("Jollof").success).toBe(false);
  });

  it("rejects empty and overlong values", () => {
    expect(dishTypeIdSchema.safeParse("").success).toBe(false);
    expect(dishTypeIdSchema.safeParse("   ").success).toBe(false);
    expect(dishTypeIdSchema.safeParse("A".repeat(41)).success).toBe(false);
  });
});

describe("createProductSchema — Bottom Pot food model", () => {
  const base = {
    name: "Smoky Party Jollof",
    description: "Smoky Nigerian party jollof with fried plantain and chicken.",
    price: 3500,
    dishTypeId: "JOLLOF",
  };

  it("accepts a valid dish with dish type", () => {
    const r = createProductSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("requires a dish type", () => {
    const { dishTypeId, ...rest } = base;
    expect(createProductSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects meaningless names and invalid prices", () => {
    expect(createProductSchema.safeParse({ ...base, name: "AB" }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, price: 0 }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, price: -5 }).success).toBe(false);
  });

  it("accepts portion and inventory fields", () => {
    const r = createProductSchema.safeParse({
      ...base,
      portionLabel: "Family Pack — serves 4–5",
      trackInventory: true,
      stock: 10,
    });
    expect(r.success).toBe(true);
  });

  it("defers duplicate add-on detection to the controller (shape accepts)", () => {
    // Uniqueness is enforced in updateProduct/createProduct, not zod.
    const r = createProductSchema.safeParse({
      ...base,
      options: [
        { name: "Extra Meat", price: 1000 },
        { name: "extra meat", price: 1200 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects more than 20 add-ons", () => {
    const options = Array.from({ length: 21 }, (_, i) => ({ name: `Extra ${i}`, price: 100 }));
    expect(createProductSchema.safeParse({ ...base, options }).success).toBe(false);
  });

  it("update schema accepts partial dish/inventory edits", () => {
    expect(updateProductSchema.safeParse({ portionLabel: "1 portion" }).success).toBe(true);
    expect(updateProductSchema.safeParse({ stock: 0 }).success).toBe(true);
    expect(
      updateProductSchema.safeParse({ options: [{ name: "Fish", price: 1500, isActive: false }] }).success,
    ).toBe(true);
  });
});

describe("isProductInStock — stock rule", () => {
  it("untracked products are always in stock", () => {
    expect(isProductInStock({ trackInventory: false })).toBe(true);
    expect(isProductInStock({})).toBe(true);
    expect(isProductInStock({ trackInventory: false, stock: 0 })).toBe(true);
  });

  it("tracked products need stock > 0", () => {
    expect(isProductInStock({ trackInventory: true, stock: 10 })).toBe(true);
    expect(isProductInStock({ trackInventory: true, stock: 1 })).toBe(true);
    expect(isProductInStock({ trackInventory: true, stock: 0 })).toBe(false);
    expect(isProductInStock({ trackInventory: true, stock: null })).toBe(false);
  });
});

describe("isProductCurrentlyAvailable — archived + stock", () => {
  it("available when unarchived and in stock", () => {
    expect(isProductCurrentlyAvailable({ archived: false })).toBe(true);
    expect(
      isProductCurrentlyAvailable({ archived: false, trackInventory: true, stock: 3 }),
    ).toBe(true);
  });

  it("unavailable when archived, even with stock", () => {
    expect(
      isProductCurrentlyAvailable({ archived: true, trackInventory: false }),
    ).toBe(false);
  });

  it("unavailable when sold out (tracked, zero stock)", () => {
    expect(
      isProductCurrentlyAvailable({ archived: false, trackInventory: true, stock: 0 }),
    ).toBe(false);
  });
});

describe("assertActiveDishType — vocabulary enforcement", () => {
  it("accepts an active dish type id", async () => {
    await expect(assertActiveDishType("JOLLOF")).resolves.toBeUndefined();
  });

  it("rejects unknown ids", async () => {
    await expect(assertActiveDishType("BREAKFAST")).rejects.toThrow(ValidationError);
    await expect(assertActiveDishType("NOPE")).rejects.toThrow(ValidationError);
  });
});

describe("fetchWhatsInThePot — dynamic dish discovery", () => {
  it("returns only dish types with orderable products, ranked by count", async () => {
    const mockedGroupBy = (prisma as any).product.groupBy as jest.Mock;
    mockedGroupBy.mockResolvedValue([
      { dishTypeId: "SUYA", _count: { _all: 5 } },
      { dishTypeId: "JOLLOF", _count: { _all: 12 } },
      { dishTypeId: "OTHER", _count: { _all: 3 } },
    ]);

    const pot = await fetchWhatsInThePot();
    expect(pot.map((p) => p.dishType.id)).toEqual(["JOLLOF", "SUYA", "OTHER"]);
    expect(pot[0].count).toBe(12);
  });

  it("excludes dish types with nothing orderable", async () => {
    const mockedGroupBy = (prisma as any).product.groupBy as jest.Mock;
    mockedGroupBy.mockResolvedValue([{ dishTypeId: "JOLLOF", _count: { _all: 2 } }]);

    const pot = await fetchWhatsInThePot();
    expect(pot).toHaveLength(1);
    expect(pot[0].dishType.id).toBe("JOLLOF");
  });

  it("scopes counts to orderable products (vendor operating + in stock)", async () => {
    const mockedGroupBy = (prisma as any).product.groupBy as jest.Mock;
    mockedGroupBy.mockResolvedValue([]);
    await fetchWhatsInThePot();

    const where = mockedGroupBy.mock.calls[0][0].where;
    expect(where.archived).toBe(false);
    expect(where.vendor).toBeDefined();
    expect(where.OR).toBeDefined();
  });
});

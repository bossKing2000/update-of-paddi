/**
 * F-2.10 — seed fixture collision recovery.
 *
 * Pure unit tests for the extracted guard used by the demo seeder's showcase
 * `OptionGroup` / `OptionGroupItem` fixtures. No database, Redis, or external
 * service is touched: the lookup and create functions are injected.
 */
import { Prisma } from "@prisma/client";
import {
  ensureSeedFixture,
  SeedFixtureIdentityConflictError,
  SeedFixtureMismatchError,
} from "../../src/jobs/seedFixtureRecovery";

const GROUP_ID = "seed-showcase-size";
const PRODUCT_ID = "seed-showcase-jollof";
const ITEM_ID = "seed-showcase-size-m";

const GROUP_EXPECTED = {
  productId: PRODUCT_ID,
  name: "Size",
  required: true,
  minSelections: 1,
  maxSelections: 1,
  sortOrder: 0,
};

type GroupRow = typeof GROUP_EXPECTED & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
};

function groupRow(overrides: Partial<GroupRow> = {}): GroupRow {
  return {
    id: GROUP_ID,
    ...GROUP_EXPECTED,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const ITEM_EXPECTED = {
  optionGroupId: GROUP_ID,
  name: "Medium",
  priceAdd: 500,
  isActive: true,
  sortOrder: 1,
};

type ItemRow = typeof ITEM_EXPECTED & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
};

function itemRow(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: ITEM_ID,
    ...ITEM_EXPECTED,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("unique", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["productId", "name"] },
  });

const p2003 = () =>
  new Prisma.PrismaClientKnownRequestError("fk", {
    code: "P2003",
    clientVersion: "test",
  });

const runGroup = (
  findById: () => Promise<GroupRow | null>,
  create: () => Promise<GroupRow>,
) =>
  ensureSeedFixture<GroupRow>({
    fixture: "OptionGroup",
    id: GROUP_ID,
    expected: GROUP_EXPECTED,
    findById,
    create,
  });

const runItem = (
  findById: () => Promise<ItemRow | null>,
  create: () => Promise<ItemRow>,
) =>
  ensureSeedFixture<ItemRow>({
    fixture: "OptionGroupItem",
    id: ITEM_ID,
    expected: ITEM_EXPECTED,
    findById,
    create,
  });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

describe("ensureSeedFixture — OptionGroup", () => {
  it("creates the fixture when no row exists at the fixed ID", async () => {
    const findById = jest.fn<Promise<GroupRow | null>, []>().mockResolvedValue(null);
    const created = groupRow();
    const create = jest.fn<Promise<GroupRow>, []>().mockResolvedValue(created);

    await expect(runGroup(findById, create)).resolves.toBe(created);
    expect(findById).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing matching group without creating", async () => {
    const findById = jest.fn<Promise<GroupRow | null>, []>().mockResolvedValue(groupRow());
    const create = jest.fn<Promise<GroupRow>, []>();

    await expect(runGroup(findById, create)).resolves.toEqual(groupRow());
    expect(create).not.toHaveBeenCalled();
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it("rejects an existing group with drifted fields and names them", async () => {
    const findById = jest
      .fn<Promise<GroupRow | null>, []>()
      .mockResolvedValue(groupRow({ name: "Sizes", maxSelections: 2 }));
    const create = jest.fn<Promise<GroupRow>, []>();

    const error = (await rejection(runGroup(findById, create))) as SeedFixtureMismatchError;

    expect(error).toBeInstanceOf(SeedFixtureMismatchError);
    expect(error.fixture).toBe("OptionGroup");
    expect(error.fixtureId).toBe(GROUP_ID);
    expect(error.mismatchedFields).toEqual(["name", "maxSelections"]);
    expect(error.message).toContain(GROUP_ID);
    expect(error.message).toContain("maxSelections");
    expect(error.message).toContain("expected 1");
    expect(error.message).toContain("found 2");
    expect(create).not.toHaveBeenCalled();
  });

  it("recovers a matching group created by a concurrent winner after P2002", async () => {
    const findById = jest
      .fn<Promise<GroupRow | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(groupRow());
    const create = jest.fn<Promise<GroupRow>, []>().mockRejectedValue(p2002());

    await expect(runGroup(findById, create)).resolves.toEqual(groupRow());
    expect(findById).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects a drifted group found after P2002", async () => {
    const findById = jest
      .fn<Promise<GroupRow | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(groupRow({ required: false }));
    const create = jest.fn<Promise<GroupRow>, []>().mockRejectedValue(p2002());

    const error = (await rejection(runGroup(findById, create))) as SeedFixtureMismatchError;

    expect(error).toBeInstanceOf(SeedFixtureMismatchError);
    expect(error.mismatchedFields).toEqual(["required"]);
    expect(error.message).toContain("required");
  });

  it("reports an identity conflict when P2002 leaves no row at the fixed ID", async () => {
    const findById = jest
      .fn<Promise<GroupRow | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const create = jest.fn<Promise<GroupRow>, []>().mockRejectedValue(p2002());

    const error = (await rejection(runGroup(findById, create))) as SeedFixtureIdentityConflictError;

    expect(error).toBeInstanceOf(SeedFixtureIdentityConflictError);
    expect(error).not.toBeInstanceOf(SeedFixtureMismatchError);
    expect(error.fixture).toBe("OptionGroup");
    expect(error.fixtureId).toBe(GROUP_ID);
    expect(error.message).toContain(GROUP_ID);
    expect(error.message).toContain("normalized name");
  });
});

describe("ensureSeedFixture — OptionGroupItem", () => {
  it("reuses an existing matching item without creating", async () => {
    const findById = jest.fn<Promise<ItemRow | null>, []>().mockResolvedValue(itemRow());
    const create = jest.fn<Promise<ItemRow>, []>();

    await expect(runItem(findById, create)).resolves.toEqual(itemRow());
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an item that belongs to the wrong group", async () => {
    const findById = jest
      .fn<Promise<ItemRow | null>, []>()
      .mockResolvedValue(itemRow({ optionGroupId: "seed-showcase-protein" }));
    const create = jest.fn<Promise<ItemRow>, []>();

    const error = (await rejection(runItem(findById, create))) as SeedFixtureMismatchError;

    expect(error).toBeInstanceOf(SeedFixtureMismatchError);
    expect(error.mismatchedFields).toEqual(["optionGroupId"]);
    expect(error.message).toContain("seed-showcase-protein");
  });

  it("rejects an item with the wrong price", async () => {
    const findById = jest
      .fn<Promise<ItemRow | null>, []>()
      .mockResolvedValue(itemRow({ priceAdd: 900 }));
    const create = jest.fn<Promise<ItemRow>, []>();

    const error = (await rejection(runItem(findById, create))) as SeedFixtureMismatchError;

    expect(error).toBeInstanceOf(SeedFixtureMismatchError);
    expect(error.mismatchedFields).toEqual(["priceAdd"]);
    expect(error.message).toContain("expected 500");
    expect(error.message).toContain("found 900");
  });

  it("rejects an item whose isActive differs from the fixture default", async () => {
    const findById = jest
      .fn<Promise<ItemRow | null>, []>()
      .mockResolvedValue(itemRow({ isActive: false }));
    const create = jest.fn<Promise<ItemRow>, []>();

    const error = (await rejection(runItem(findById, create))) as SeedFixtureMismatchError;

    expect(error).toBeInstanceOf(SeedFixtureMismatchError);
    expect(error.mismatchedFields).toEqual(["isActive"]);
    expect(error.message).toContain("isActive");
  });

  it("recovers a matching item created by a concurrent winner after P2002", async () => {
    const findById = jest
      .fn<Promise<ItemRow | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(itemRow());
    const create = jest.fn<Promise<ItemRow>, []>().mockRejectedValue(p2002());

    await expect(runItem(findById, create)).resolves.toEqual(itemRow());
    expect(findById).toHaveBeenCalledTimes(2);
  });

  it("reports an identity conflict when P2002 leaves no item at the fixed ID", async () => {
    const findById = jest
      .fn<Promise<ItemRow | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const create = jest.fn<Promise<ItemRow>, []>().mockRejectedValue(p2002());

    const error = (await rejection(runItem(findById, create))) as SeedFixtureIdentityConflictError;

    expect(error).toBeInstanceOf(SeedFixtureIdentityConflictError);
    expect(error.fixture).toBe("OptionGroupItem");
    expect(error.fixtureId).toBe(ITEM_ID);
  });
});

describe("ensureSeedFixture — error propagation", () => {
  it("propagates a non-P2002 creation error unchanged", async () => {
    const failure = new Error("connection reset");
    const findById = jest.fn<Promise<GroupRow | null>, []>().mockResolvedValue(null);
    const create = jest.fn<Promise<GroupRow>, []>().mockRejectedValue(failure);

    await expect(runGroup(findById, create)).rejects.toBe(failure);
    // No recovery re-read: a non-unique error is not a collision.
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it("does not treat a P2003 foreign-key error as a duplicate", async () => {
    const failure = p2003();
    const findById = jest.fn<Promise<GroupRow | null>, []>().mockResolvedValue(null);
    const create = jest.fn<Promise<GroupRow>, []>().mockRejectedValue(failure);

    await expect(runGroup(findById, create)).rejects.toBe(failure);
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it("propagates a recovery re-read failure unchanged, not as a conflict", async () => {
    const readFailure = new Error("recovery read failed");
    const findById = jest
      .fn<Promise<GroupRow | null>, []>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(readFailure);
    const create = jest.fn<Promise<GroupRow>, []>().mockRejectedValue(p2002());

    await expect(runGroup(findById, create)).rejects.toBe(readFailure);
  });
});

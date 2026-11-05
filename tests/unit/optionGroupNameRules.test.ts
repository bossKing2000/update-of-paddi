/**
 * Phase 2B.2 review F-1 — canonical option-group NAME rules.
 *
 * Pure functions, no database. These tests pin the behaviour that the nested
 * `product.create` / `product.update` writes and the standalone option-group
 * endpoints must share.
 */
import { Prisma } from "@prisma/client";
import { ConflictError } from "../../src/errors/AppError";
import {
  assertNoDuplicateNames,
  isUniqueConstraintConflict,
  toNestedUniqueConflict,
} from "../../src/services/optionGroupNameRules";

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("unique", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["productId", "name"] },
  });

const p2003 = () =>
  new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test" });

describe("assertNoDuplicateNames — within a single request", () => {
  it("accepts distinct group names", () => {
    expect(() =>
      assertNoDuplicateNames([{ name: "Size" }, { name: "Extras" }], [], "option group"),
    ).not.toThrow();
  });

  it("rejects two identical names", () => {
    expect(() =>
      assertNoDuplicateNames([{ name: "Extras" }, { name: "Extras" }], [], "option group"),
    ).toThrow(ConflictError);
  });

  it("rejects names differing only by case", () => {
    expect(() =>
      assertNoDuplicateNames([{ name: "Extras" }, { name: "extras" }], [], "option group"),
    ).toThrow(ConflictError);
  });

  it("rejects names differing only by surrounding whitespace", () => {
    expect(() =>
      assertNoDuplicateNames([{ name: "Extras" }, { name: "  extras  " }], [], "option group"),
    ).toThrow(ConflictError);
  });

  it("accepts a valid multi-group creation", () => {
    expect(() =>
      assertNoDuplicateNames(
        [{ name: "Size" }, { name: "Spice Level" }, { name: "Extras" }],
        [],
        "option group",
      ),
    ).not.toThrow();
  });
});

describe("assertNoDuplicateNames — against persisted rows", () => {
  it("rejects a new group colliding with an existing one", () => {
    expect(() =>
      assertNoDuplicateNames([{ name: "Extras" }], [{ id: "g1", name: "Extras" }], "option group"),
    ).toThrow(ConflictError);
  });

  it("rejects a collision that differs only by case", () => {
    expect(() =>
      assertNoDuplicateNames([{ name: "EXTRAS" }], [{ id: "g1", name: "extras" }], "option group"),
    ).toThrow(ConflictError);
  });

  it("the same name on a DIFFERENT product is valid (existing set is per-product)", () => {
    // The caller scopes `existing` to one product, so an unrelated product's
    // group never appears here.
    expect(() => assertNoDuplicateNames([{ name: "Extras" }], [], "option group")).not.toThrow();
  });

  it("allows a group to keep its own current name when renaming", () => {
    expect(() =>
      assertNoDuplicateNames(
        [{ id: "g1", name: "Extras" }],
        [{ id: "g1", name: "Extras" }],
        "option group",
      ),
    ).not.toThrow();
  });

  it("allows renaming onto a new unique name", () => {
    expect(() =>
      assertNoDuplicateNames(
        [{ id: "g1", name: "Toppings" }],
        [{ id: "g1", name: "Extras" }, { id: "g2", name: "Size" }],
        "option group",
      ),
    ).not.toThrow();
  });

  it("rejects renaming onto another existing group's name", () => {
    expect(() =>
      assertNoDuplicateNames(
        [{ id: "g1", name: "Size" }],
        [{ id: "g1", name: "Extras" }, { id: "g2", name: "Size" }],
        "option group",
      ),
    ).toThrow(ConflictError);
  });

  it("rejects two existing groups renamed to the same name in one request", () => {
    expect(() =>
      assertNoDuplicateNames(
        [{ id: "g1", name: "Toppings" }, { id: "g2", name: "Toppings" }],
        [{ id: "g1", name: "Extras" }, { id: "g2", name: "Size" }],
        "option group",
      ),
    ).toThrow(ConflictError);
  });

  it("rejects a new group colliding with a group renamed in the same request", () => {
    expect(() =>
      assertNoDuplicateNames(
        [{ id: "g1", name: "Extras" }, { name: "extras" }],
        [{ id: "g1", name: "Toppings" }],
        "option group",
      ),
    ).toThrow(ConflictError);
  });
});

describe("error surface", () => {
  it("the conflict message never contains an internal index or column name", () => {
    try {
      assertNoDuplicateNames([{ name: "Extras" }], [{ id: "g1", name: "Extras" }], "option group");
      throw new Error("expected a ConflictError");
    } catch (err) {
      const message = (err as Error).message;
      expect(err).toBeInstanceOf(ConflictError);
      expect(message).not.toContain("OptionGroup_productId_name_key");
      expect(message).not.toContain("productId");
      expect(message).not.toContain("P2002");
    }
  });

  it("distinguishes group conflicts from add-on conflicts via the label", () => {
    const groupMsg = (() => {
      try {
        assertNoDuplicateNames([{ name: "A" }], [{ id: "1", name: "A" }], "option group");
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    const itemMsg = (() => {
      try {
        assertNoDuplicateNames([{ name: "A" }], [{ id: "1", name: "A" }], "add-on");
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    expect(groupMsg).toContain("option group");
    expect(itemMsg).toContain("add-on");
    expect(groupMsg).not.toBe(itemMsg);
  });
});

describe("Prisma error mapping", () => {
  it("recognises P2002 only", () => {
    expect(isUniqueConstraintConflict(p2002())).toBe(true);
    expect(isUniqueConstraintConflict(p2003())).toBe(false);
    expect(isUniqueConstraintConflict(new Error("nope"))).toBe(false);
    expect(isUniqueConstraintConflict(null)).toBe(false);
  });

  it("maps P2002 to a ConflictError that leaks no index name", () => {
    const mapped = toNestedUniqueConflict(p2002()) as Error;
    expect(mapped).toBeInstanceOf(ConflictError);
    expect(mapped.message).not.toContain("OptionGroup_productId_name_key");
    expect(mapped.message).not.toContain("productId");
  });

  it("maps a P2002 raised by the normalized expression index to the same safe conflict", () => {
    // The hand-written index
    //   "OptionGroup_productId_name_lower_key" ON ("productId", lower(btrim("name")))
    // is not declared in schema.prisma, so Prisma reports it by NAME rather
    // than by column list. The mapping must key on the error CODE, never on
    // meta.target, so both indexes produce the same safe 409.
    const expressionIndexP2002 = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: "OptionGroup_productId_name_lower_key" },
    });

    expect(isUniqueConstraintConflict(expressionIndexP2002)).toBe(true);

    const mapped = toNestedUniqueConflict(expressionIndexP2002) as Error;
    expect(mapped).toBeInstanceOf(ConflictError);
    // No internal database identifier may reach the client.
    expect(mapped.message).not.toContain("OptionGroup_productId_name_lower_key");
    expect(mapped.message).not.toContain("OptionGroup_productId_name_key");
    expect(mapped.message).not.toContain("lower(btrim");
    expect(mapped.message).not.toContain("productId");
  });

  it("returns unrelated errors UNCHANGED so they are never disguised as conflicts", () => {
    const original = p2003();
    expect(toNestedUniqueConflict(original)).toBe(original);
    const plain = new Error("connection reset");
    expect(toNestedUniqueConflict(plain)).toBe(plain);
    expect(toNestedUniqueConflict(undefined)).toBeUndefined();
  });
});
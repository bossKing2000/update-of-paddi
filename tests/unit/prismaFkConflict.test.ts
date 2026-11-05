/**
 * Unit coverage for the shared foreign-key delete-conflict classifier used by
 * the vendor/admin product delete paths and the option group/item delete
 * paths.
 *
 * The two error shapes asserted here were captured from real runs of
 * prisma@6.19.2 against PostgreSQL 18.6:
 *   - ON DELETE RESTRICT -> PrismaClientUnknownRequestError with code === null;
 *     SQLSTATE 23001 and the constraint name survive only in the rendered
 *     engine message.
 *   - NO ACTION          -> PrismaClientKnownRequestError P2003 naming the
 *     constraint after a backtick.
 *
 * Real-database proof lives in tests/integration (the migration-chain/RESTRICT
 * suites); this file only pins the classifier's behavior, including the
 * fail-closed cases that keep unrelated database failures from being
 * relabelled as business conflicts.
 */
import { Prisma } from "@prisma/client";

import {
  getForeignKeyConflictConstraint,
  isForeignKeyConflictFor,
  OPTION_DELETE_FK_CONSTRAINTS,
  PRODUCT_DELETE_FK_CONSTRAINTS,
} from "../../src/lib/prismaFkConflict";

function restrictViolation(
  constraint: string,
  opts: { escapeQuotes?: boolean } = {},
) {
  const q = opts.escapeQuotes === false ? '"' : '\\"';
  const message =
    "ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(" +
    'PostgresError { code: "23001", message: "update or delete on table "Product" ' +
    `violates RESTRICT setting of foreign key constraint ${q}${constraint}${q} on table "CartItem"", ` +
    'severity: "ERROR", detail: None, column: None, hint: None }), transient: false })';
  return new Prisma.PrismaClientUnknownRequestError(message, {
    clientVersion: "test",
  });
}

function p2003(constraint?: string, meta?: Record<string, unknown>) {
  const message = constraint
    ? `Foreign key constraint violated on the constraint: \`${constraint}\``
    : "Foreign key constraint violated";
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: "P2003",
    clientVersion: "test",
    meta,
  });
}

describe("getForeignKeyConflictConstraint", () => {
  it("extracts the constraint from a RESTRICT violation (escaped rendering)", () => {
    expect(
      getForeignKeyConflictConstraint(
        restrictViolation("CartItem_productId_fkey"),
      ),
    ).toBe("CartItem_productId_fkey");
  });

  it("tolerates an unescaped rendering of the same violation", () => {
    expect(
      getForeignKeyConflictConstraint(
        restrictViolation("CartItem_productId_fkey", { escapeQuotes: false }),
      ),
    ).toBe("CartItem_productId_fkey");
  });

  it("returns null for an UnknownRequestError without SQLSTATE 23001", () => {
    const err = new Prisma.PrismaClientUnknownRequestError("other failure", {
      clientVersion: "test",
    });
    expect(getForeignKeyConflictConstraint(err)).toBeNull();
  });

  it("returns null when 23001 is present but no constraint can be extracted", () => {
    const err = new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "23001", message: "unrecognized shape" }',
      { clientVersion: "test" },
    );
    expect(getForeignKeyConflictConstraint(err)).toBeNull();
  });

  it("prefers meta.constraint on a P2003 when the engine populates it", () => {
    expect(
      getForeignKeyConflictConstraint(
        p2003(undefined, { constraint: "CartItem_productId_fkey" }),
      ),
    ).toBe("CartItem_productId_fkey");
  });

  it("reads the constraint from the P2003 message", () => {
    expect(
      getForeignKeyConflictConstraint(p2003("CartItem_productId_fkey")),
    ).toBe("CartItem_productId_fkey");
  });

  it("falls back to meta.field_name when the message names no constraint", () => {
    expect(
      getForeignKeyConflictConstraint(
        p2003(undefined, { field_name: "OrderItemOption_optionGroupItemId_fkey" }),
      ),
    ).toBe("OrderItemOption_optionGroupItemId_fkey");
  });

  it("returns null for a P2003 with no constraint information at all", () => {
    expect(
      getForeignKeyConflictConstraint(p2003(undefined, { modelName: "CartItem" })),
    ).toBeNull();
  });

  it("returns null for other Prisma error codes", () => {
    const err = new Prisma.PrismaClientKnownRequestError("not found", {
      code: "P2025",
      clientVersion: "test",
    });
    expect(getForeignKeyConflictConstraint(err)).toBeNull();
  });

  it("returns null for plain/unknown errors", () => {
    expect(getForeignKeyConflictConstraint(new Error("connection reset"))).toBeNull();
    expect(getForeignKeyConflictConstraint(undefined)).toBeNull();
    expect(getForeignKeyConflictConstraint("P2003")).toBeNull();
  });
});

describe("isForeignKeyConflictFor", () => {
  it("matches only constraints in the operation's expected set", () => {
    expect(
      isForeignKeyConflictFor(
        restrictViolation("CartItem_productId_fkey"),
        PRODUCT_DELETE_FK_CONSTRAINTS,
      ),
    ).toBe(true);
    expect(
      isForeignKeyConflictFor(
        restrictViolation("OrderItem_productId_fkey"),
        PRODUCT_DELETE_FK_CONSTRAINTS,
      ),
    ).toBe(true);
    expect(
      isForeignKeyConflictFor(
        restrictViolation("CartItemOption_optionGroupItemId_fkey"),
        PRODUCT_DELETE_FK_CONSTRAINTS,
      ),
    ).toBe(false);
    expect(
      isForeignKeyConflictFor(
        restrictViolation("CartItemOption_optionGroupItemId_fkey"),
        OPTION_DELETE_FK_CONSTRAINTS,
      ),
    ).toBe(true);
    expect(
      isForeignKeyConflictFor(
        p2003("CartItem_productId_fkey"),
        PRODUCT_DELETE_FK_CONSTRAINTS,
      ),
    ).toBe(true);
    expect(
      isForeignKeyConflictFor(
        p2003("UnrelatedTable_unrelatedId_fkey"),
        PRODUCT_DELETE_FK_CONSTRAINTS,
      ),
    ).toBe(false);
  });

  it("pins the schema's RESTRICT-backed product/option constraints", () => {
    expect(PRODUCT_DELETE_FK_CONSTRAINTS).toEqual([
      "CartItem_productId_fkey",
      "OrderItem_productId_fkey",
    ]);
    expect(OPTION_DELETE_FK_CONSTRAINTS).toEqual([
      "CartItemOption_optionGroupItemId_fkey",
      "OrderItemOption_optionGroupItemId_fkey",
    ]);
  });
});

import { Prisma } from "@prisma/client";

/**
 * PostgreSQL raises SQLSTATE 23001 (`restrict_violation`) when an
 * `ON DELETE RESTRICT` foreign key blocks a delete. Prisma 6.19.2 does NOT
 * map that SQLSTATE to a structured error code: it surfaces as
 * `PrismaClientUnknownRequestError` with `code === null`, and the violated
 * constraint survives only in the rendered engine message, e.g.
 *
 *   PostgresError { code: "23001", message: "update or delete on table
 *   \"Product\" violates RESTRICT setting of foreign key constraint
 *   \"CartItem_productId_fkey\" on table \"CartItem\"", ... }
 *
 * Because the message is a Rust-debug rendering, the quotes around the
 * constraint name normally arrive backslash-escaped; the optional
 * backslashes below tolerate escaped and unescaped renderings alike.
 * (Verified against prisma@6.19.2 + PostgreSQL 18.6.)
 */
const PG_RESTRICT_SQLSTATE = "23001";
const RESTRICT_CONSTRAINT_PATTERN =
  /violates RESTRICT setting of foreign key constraint \\{0,2}"([A-Za-z0-9_]+)\\{0,2}"/;

/**
 * Prisma's own P2003 rendering names the constraint after a backtick:
 *
 *   Foreign key constraint violated on the constraint: `CartItem_productId_fkey`
 *
 * `meta.constraint` is preferred when the engine populates it; the rendered
 * message is checked before `meta.field_name`, because older engine shapes
 * put the FIELD name there (e.g. `productId`), which is not what callers
 * match against.
 */
const P2003_CONSTRAINT_PATTERN = /constraint: `([A-Za-z0-9_]+)`/;

/**
 * Foreign keys that can block a product hard-delete (prisma/schema.prisma):
 *   CartItem.product  -> Product       ON DELETE RESTRICT (live customer carts)
 *   OrderItem.product -> Product       ON DELETE RESTRICT (order history)
 */
export const PRODUCT_DELETE_FK_CONSTRAINTS: readonly string[] = [
  "CartItem_productId_fkey",
  "OrderItem_productId_fkey",
];

/**
 * Foreign keys that can block an option-item / option-group hard-delete:
 *   CartItemOption.optionGroupItem  -> OptionGroupItem  ON DELETE RESTRICT
 *   OrderItemOption.optionGroupItem -> OptionGroupItem  ON DELETE RESTRICT
 *
 * An option-group delete cascades its items, so PostgreSQL reports these
 * same constraints when it blocks the cascade.
 */
export const OPTION_DELETE_FK_CONSTRAINTS: readonly string[] = [
  "CartItemOption_optionGroupItemId_fkey",
  "OrderItemOption_optionGroupItemId_fkey",
];

function constraintFromKnownError(
  err: Prisma.PrismaClientKnownRequestError,
): string | null {
  const metaConstraint = err.meta?.constraint;
  if (typeof metaConstraint === "string" && metaConstraint.length > 0) {
    return metaConstraint;
  }

  const fromMessage = P2003_CONSTRAINT_PATTERN.exec(err.message)?.[1];
  if (fromMessage) return fromMessage;

  const metaField = err.meta?.field_name;
  if (typeof metaField === "string" && metaField.length > 0) return metaField;

  return null;
}

/**
 * Returns the foreign-key constraint named by a delete-conflict error, or
 * `null` when the error is not a single recognizable FK violation.
 *
 * Fail-closed by design: an unrecognized error shape returns `null` so the
 * caller rethrows it. A raw database failure must never be relabelled as a
 * business conflict merely because it happened during a delete.
 */
export function getForeignKeyConflictConstraint(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code !== "P2003") return null;
    return constraintFromKnownError(err);
  }

  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    if (!err.message.includes(PG_RESTRICT_SQLSTATE)) return null;
    return RESTRICT_CONSTRAINT_PATTERN.exec(err.message)?.[1] ?? null;
  }

  return null;
}

/**
 * True only when `err` is a foreign-key delete conflict on one of the
 * expected constraints for the operation being performed.
 *
 * Callers pass the operation's own constraint set, so an unrelated foreign
 * key failure can never be reported as that operation's cart/order-history
 * conflict.
 */
export function isForeignKeyConflictFor(
  err: unknown,
  constraints: readonly string[],
): boolean {
  const constraint = getForeignKeyConflictConstraint(err);
  return constraint !== null && constraints.includes(constraint);
}

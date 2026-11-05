/**
 * Phase 2B.2 (review follow-up, F-1) — canonical option-group NAME rules.
 *
 * One rule, one place. Before this module, `optionGroup.service.ts` enforced
 * duplicate-name rejection for the standalone endpoints while the nested writes
 * in `productController.ts` (`product.create({ optionGroups: { create } })` and
 * the `create`/`update` arms of `product.update`) bypassed it entirely, so the
 * same logical rule behaved differently depending on which endpoint the caller
 * used.
 *
 * These functions are PURE: no database, no Prisma client. The caller supplies
 * what it already knows (the requested set and the currently persisted set), so
 * the identical rule is reusable from a controller, a service, a job, or a test.
 *
 * Normalization is `normalizeOptionName` (trim + lowercase) — the same rule the
 * item path already used, so group names and item names cannot drift apart.
 *
 * SCOPE OF THE GUARANTEE (read before relying on this):
 *   - This is a PRE-CHECK. It closes "duplicates within one request" and
 *     "collides with a group that already exists".
 *   - It CANNOT close a concurrent race, because the database constraint is an
 *     EXACT-match unique index on `(productId, name)`; "Extras" and "extras" are
 *     distinct to PostgreSQL. Two simultaneous requests that differ only in case
 *     or surrounding whitespace can both pass this pre-check and both insert.
 *   - The residual case-folding race is a DATABASE-level gap, not a logic gap.
 *     Closing it requires a normalized unique index, e.g.
 *       CREATE UNIQUE INDEX ... ON "OptionGroup" ("productId", lower(btrim("name")));
 *     which Prisma's schema language cannot express. That is a separate,
 *     explicitly authorized change — see the Phase 2B.2 review report.
 */
import { Prisma } from "@prisma/client";
import { ConflictError } from "../errors/AppError";
import { normalizeOptionName } from "./optionName";

/** A group/item the caller wants to create or rename to. */
export interface RequestedNamedRow {
  /** Present when renaming an existing row; absent for a new row. */
  id?: string;
  name: string;
}

/** A row that currently exists in the database. */
export interface ExistingNamedRow {
  id: string;
  name: string;
}

/**
 * Reject duplicate names across `requested`, treating `existing` as the rows
 * that are NOT being renamed by this request.
 *
 * Covers, in one pass:
 *   1. two new rows in the same request with the same name;
 *   2. a new/renamed row colliding with a persisted row that stays put;
 *   3. two persisted rows renamed to the same name by this request (the first
 *      one claims the name, the second collides with it);
 *   4. a row renaming onto ITS OWN current name (allowed — self is excluded via
 *      `id`).
 *
 * Comparison is case- and whitespace-insensitive.
 */
export function assertNoDuplicateNames(
  requested: RequestedNamedRow[],
  existing: ExistingNamedRow[],
  label: string,
): void {
  // Names held by rows that survive this request untouched.
  const claimed = new Set<string>();
  const renamedIds = new Set(requested.map((r) => r.id).filter((id): id is string => id !== undefined));
  for (const row of existing) {
    if (!renamedIds.has(row.id)) claimed.add(normalizeOptionName(row.name));
  }

  for (const row of requested) {
    const key = normalizeOptionName(row.name);
    if (claimed.has(key)) {
      throw new ConflictError(
        `Another ${label} with this name already exists for this product`,
      );
    }
    claimed.add(key);
  }
}

/**
 * True when `error` is a Prisma unique-constraint violation (v6 `P2002`).
 *
 * Narrow on purpose: every other database error must keep propagating so an
 * unrelated failure is never disguised as a duplicate-name conflict.
 */
export function isUniqueConstraintConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Convert a `P2002` raised by a nested write into a safe, client-facing
 * ConflictError; return any other error UNCHANGED so the caller can rethrow it
 * with `throw toNestedUniqueConflict(err)`.
 *
 * Returned rather than thrown so TypeScript can narrow `let product` after a
 * `catch` — a bare `never`-returning helper in a catch block would make
 * `product` "possibly unassigned".
 *
 * WHY NOT USE THE GLOBAL MAPPER: `error.middleware.ts` formats `P2002` as
 * `${target} already exists`, which renders Prisma's raw index name
 * (`OptionGroup_productId_name_key`) into an HTTP response body. That leaks an
 * internal database identifier to API clients on every nested add-on write.
 *
 * The message below is deliberately vague about WHICH constraint fired. A
 * product write can trip `P2002` on OptionGroup `(productId, name)`, on the
 * legacy ProductOption `(productId, name)`, or on the ProductTag join table,
 * and `meta.target` cannot distinguish those three (the first two are
 * field-identical). Naming one of them would be a guess, so the message states
 * only what is true: a conflicting add-on name already exists for this product.
 */
export function toNestedUniqueConflict(error: unknown): unknown {
  if (isUniqueConstraintConflict(error)) {
    return new ConflictError(
      "An add-on or option group with this name already exists for this product",
    );
  }
  return error;
}
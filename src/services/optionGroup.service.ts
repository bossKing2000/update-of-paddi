import prisma from "../lib/prisma";
import { ForbiddenError, ValidationError, ConflictError } from "../errors/AppError";
import {
  isForeignKeyConflictFor,
  OPTION_DELETE_FK_CONSTRAINTS,
} from "../lib/prismaFkConflict";
import { clearProductCache } from "./clearCaches";
import { clearProductFromCarts } from "./product.service";
import { assertNoDuplicateNames, isUniqueConstraintConflict } from "./optionGroupNameRules";

// Phase 2B.3 vendor management authority for structured add-ons.
//
// Ownership rule (every operation): resolve product → vendorId from the
// database and compare with the caller. Client-supplied productId /
// groupId / itemId alone never authorizes anything.
//
// Legacy ProductOption is intentionally untouched here: no reads, no
// writes, no synchronization.

export interface OptionGroupInput {
  name: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder?: number;
}

export interface OptionGroupItemInput {
  name: string;
  priceAdd: number;
  isActive?: boolean;
  sortOrder?: number;
}

const GROUP_ORDER = [{ sortOrder: "asc" as const }, { id: "asc" as const }];

function checkSelectionInvariants(min: number, max: number, required: boolean): void {
  if (min > max)
    throw new ValidationError("minSelections must not exceed maxSelections");
  if (required && min < 1)
    throw new ValidationError("A required group must have minSelections >= 1");
}

/** Load a product's vendor, throwing 404/403 without leaking existence. */
async function requireOwnedProduct(productId: string, vendorId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, vendorId: true },
  });
  if (!product || product.vendorId !== vendorId)
    throw new ForbiddenError("Unauthorized or product not found");
  return product;
}

/** Load a group with its product vendor attached, enforcing ownership. */
async function requireOwnedGroup(groupId: string, vendorId: string) {
  const group = await prisma.optionGroup.findUnique({
    where: { id: groupId },
    include: { product: { select: { id: true, vendorId: true } } },
  });
  if (!group || group.product.vendorId !== vendorId)
    throw new ForbiddenError("Unauthorized or option group not found");
  return group;
}

/**
 * Phase 2B.2 / review F-1: these load the current rows and then hand the
 * decision to `assertNoDuplicateNames`, the SAME pure rule the nested
 * `product.create` / `product.update` paths use. The rule itself lives in
 * `optionGroupNameRules.ts`; nothing here re-implements normalization.
 */
async function assertUniqueItemName(
  optionGroupId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const existing = await prisma.optionGroupItem.findMany({
    where: { optionGroupId },
    select: { id: true, name: true },
  });
  assertNoDuplicateNames([{ id: exceptId, name }], existing, "add-on");
}

/**
 * Phase 2B.2: `OptionGroup` carries `@@unique([productId, name])`. Pre-check it
 * so the caller gets the project's 409 ConflictError shape instead of a raw
 * database error — and, per review F-1, so the standalone endpoints and the
 * nested product writes share one rule.
 */
async function assertUniqueGroupName(productId: string, name: string, exceptId?: string): Promise<void> {
  const existing = await prisma.optionGroup.findMany({
    where: { productId },
    select: { id: true, name: true },
  });
  assertNoDuplicateNames([{ id: exceptId, name }], existing, "option group");
}

export async function createOptionGroup(vendorId: string, productId: string, input: OptionGroupInput) {
  await requireOwnedProduct(productId, vendorId);
  checkSelectionInvariants(input.minSelections, input.maxSelections, input.required);
  await assertUniqueGroupName(productId, input.name);
  let group;
  try {
    group = await prisma.optionGroup.create({
      data: {
        productId,
        name: input.name.trim(),
        required: input.required,
        minSelections: input.minSelections,
        maxSelections: input.maxSelections,
        sortOrder: input.sortOrder ?? 0,
      },
    });
  } catch (err) {
    // Lost a race against a concurrent create of the same (productId, name).
    if (isUniqueConstraintConflict(err)) {
      throw new ConflictError("An option group with this name already exists on this product");
    }
    throw err;
  }
  await clearProductCache(productId, vendorId);
  return group;
}

export async function updateOptionGroup(
  vendorId: string,
  groupId: string,
  patch: Partial<OptionGroupInput>,
) {
  const group = await requireOwnedGroup(groupId, vendorId);
  // Merge with stored values so partial patches are validated as a whole.
  const min = patch.minSelections ?? group.minSelections;
  const max = patch.maxSelections ?? group.maxSelections;
  const required = patch.required ?? group.required;
  checkSelectionInvariants(min, max, required);
  // Renaming must not collide with a sibling group on the same product.
  if (patch.name !== undefined) await assertUniqueGroupName(group.productId, patch.name, group.id);
  let updated;
  try {
    updated = await prisma.optionGroup.update({
      where: { id: group.id },
      data: {
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.required !== undefined && { required: patch.required }),
        ...(patch.minSelections !== undefined && { minSelections: patch.minSelections }),
        ...(patch.maxSelections !== undefined && { maxSelections: patch.maxSelections }),
        ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
      },
    });
  } catch (err) {
    if (isUniqueConstraintConflict(err)) {
      throw new ConflictError("An option group with this name already exists on this product");
    }
    throw err;
  }
  await clearProductCache(group.productId, vendorId);
  return updated;
}

/**
 * Phase 3.1.1: a group referenced by historical order records cannot be
 * deleted — the database RESTRICT constraint is the ultimate safeguard
 * against races, but the pre-check below returns the project's
 * established 409 Conflict shape (same convention as product deletion)
 * instead of a raw constraint error. The constraint catch covers the
 * narrow race where a reference lands between the check and the delete
 * (Prisma 6 reports PostgreSQL's RESTRICT violation as a
 * PrismaClientUnknownRequestError carrying SQLSTATE 23001); it maps the
 * expected option constraints to the same ConflictError without exposing
 * SQL internals.
 */
export async function deleteOptionGroup(vendorId: string, groupId: string) {
  const group = await requireOwnedGroup(groupId, vendorId);
  const hasOrderHistory = await prisma.orderItemOption.findFirst({
    where: { optionGroupItem: { optionGroupId: group.id } },
    select: { id: true },
  });
  if (hasOrderHistory) {
    throw new ConflictError(
      "This option group is used in past orders and can't be deleted — deactivate its items via isActive instead to stop offering them while keeping history intact.",
    );
  }
  // A live cart selection is customer-owned state. Refuse the delete rather
  // than letting the database cascade (previously) or restrict (now) decide.
  const hasCartSelections = await prisma.cartItemOption.findFirst({
    where: { optionGroupItem: { optionGroupId: group.id } },
    select: { id: true },
  });
  if (hasCartSelections) {
    throw new ConflictError(
      "This option group is selected in a customer's cart and can't be deleted — deactivate its items via isActive instead so customer carts are not changed.",
    );
  }
  try {
    // Items cascade at the database level; legacy ProductOption rows are
    // unrelated to this delete and are never touched.
    await prisma.optionGroup.delete({ where: { id: group.id } });
  } catch (err) {
    if (isForeignKeyConflictFor(err, OPTION_DELETE_FK_CONSTRAINTS)) {
      throw new ConflictError(
        "This option group is still referenced by past orders or customer carts and can't be deleted — deactivate its items via isActive instead to stop offering them while keeping history intact.",
      );
    }
    throw err;
  }
  await clearProductCache(group.productId, vendorId);
  await clearProductFromCarts(group.productId);
  return { id: group.id };
}

export async function listOptionGroups(vendorId: string, productId: string) {
  await requireOwnedProduct(productId, vendorId);
  return prisma.optionGroup.findMany({
    where: { productId },
    orderBy: GROUP_ORDER,
    include: { items: { orderBy: GROUP_ORDER } },
  });
}

export async function createOptionGroupItem(
  vendorId: string,
  groupId: string,
  input: OptionGroupItemInput,
) {
  const group = await requireOwnedGroup(groupId, vendorId);
  await assertUniqueItemName(group.id, input.name);
  let item;
  try {
    item = await prisma.optionGroupItem.create({
      data: {
        optionGroupId: group.id,
        name: input.name.trim(),
        priceAdd: input.priceAdd,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });
  } catch (err) {
    // Lost a race against a concurrent create of the same normalized name in
    // this group. The database index is the AUTHORITATIVE backstop; the
    // pre-check above is only the fast, user-friendly sequential path.
    //
    // The conflict is detected by ERROR CODE, never by `meta.target` or an
    // index name: the constraint is a hand-written expression index, so its
    // metadata need not look like an ordinary field constraint. The message
    // must not echo the index name or the expression.
    if (isUniqueConstraintConflict(err)) {
      throw new ConflictError("An add-on with this name already exists in this group");
    }
    throw err;
  }
  await clearProductCache(group.productId, vendorId);
  return item;
}

export async function updateOptionGroupItem(
  vendorId: string,
  itemId: string,
  patch: Partial<OptionGroupItemInput>,
) {
  const item = await prisma.optionGroupItem.findUnique({
    where: { id: itemId },
    include: { optionGroup: { include: { product: { select: { id: true, vendorId: true } } } } },
  });
  if (!item || item.optionGroup.product.vendorId !== vendorId)
    throw new ForbiddenError("Unauthorized or option item not found");
  if (patch.name !== undefined) await assertUniqueItemName(item.optionGroupId, patch.name, item.id);
  let updated;
  try {
    updated = await prisma.optionGroupItem.update({
      where: { id: item.id },
      data: {
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.priceAdd !== undefined && { priceAdd: patch.priceAdd }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
        ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
      },
    });
  } catch (err) {
    // Lost a race against a concurrent rename onto the same normalized name in
    // this group. Detected by ERROR CODE only — see createOptionGroupItem.
    if (isUniqueConstraintConflict(err)) {
      throw new ConflictError("An add-on with this name already exists in this group");
    }
    throw err;
  }
  await clearProductCache(item.optionGroup.product.id, vendorId);
  return updated;
}

export async function deleteOptionGroupItem(vendorId: string, itemId: string) {
  const item = await prisma.optionGroupItem.findUnique({
    where: { id: itemId },
    include: { optionGroup: { include: { product: { select: { id: true, vendorId: true } } } } },
  });
  if (!item || item.optionGroup.product.vendorId !== vendorId)
    throw new ForbiddenError("Unauthorized or option item not found");
  const hasOrderHistory = await prisma.orderItemOption.findFirst({
    where: { optionGroupItemId: item.id },
    select: { id: true },
  });
  if (hasOrderHistory) {
    throw new ConflictError(
      "This option item is used in past orders and can't be deleted — set isActive to false instead to stop offering it while keeping history intact.",
    );
  }
  // A live cart selection is customer-owned state. Refuse the delete rather
  // than letting the database cascade (previously) or restrict (now) decide.
  const hasCartSelections = await prisma.cartItemOption.findFirst({
    where: { optionGroupItemId: item.id },
    select: { id: true },
  });
  if (hasCartSelections) {
    throw new ConflictError(
      "This option item is selected in a customer's cart and can't be deleted — set isActive to false instead so customer carts are not changed.",
    );
  }
  try {
    // Only the new item row is removed — never any ProductOption row.
    await prisma.optionGroupItem.delete({ where: { id: item.id } });
  } catch (err) {
    if (isForeignKeyConflictFor(err, OPTION_DELETE_FK_CONSTRAINTS)) {
      throw new ConflictError(
        "This option item is still referenced by past orders or customer carts and can't be deleted — set isActive to false instead to stop offering it while keeping history intact.",
      );
    }
    throw err;
  }
  await clearProductCache(item.optionGroup.product.id, vendorId);
  await clearProductFromCarts(item.optionGroup.product.id);
  return { id: item.id };
}

/**
 * FIN-07-05 — shared DishType fixture for integration suites.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Product.dishTypeId` is a REQUIRED foreign key to `DishType`. Five suites
 * (paymentFiniteAmount, cartItemOptionConstraint, orderItemOptionConstraint,
 * orderSnapshotPersistence, financialHistoryDeletionProtection) hard-code
 *
 *     dishTypeId: "JOLLOF"
 *
 * which only resolves if a seed has already run. The integration workflow does
 * not seed, so every one of those suites failed at product creation with
 *
 *     Foreign key constraint violated on the constraint: `Product_dishTypeId_fkey`
 *
 * The FK is correct and must not be weakened; the fixture was incomplete. This
 * helper materialises the dish type the tests already reference, so no test
 * literal has to change.
 *
 * `DishType` itself requires a `Category` (required `categoryId`, and Category
 * needs unique `name` and `slug`), so both are created here.
 *
 * SAFETY
 * ------
 * Idempotent: if a real seeded "JOLLOF" already exists it is reused and NOT
 * deleted, so this can never destroy seeded data. Only rows this helper created
 * are removed by `dispose()`, and it is a no-op when the dish type pre-existed.
 */
import type { PrismaClient } from "@prisma/client";

export const TEST_DISH_TYPE_ID = "JOLLOF";

export type TestDishTypeHandle = {
  dishTypeId: string;
  /** Removes only what this helper created. Safe to call twice. */
  dispose: () => Promise<void>;
};

export async function ensureTestDishType(
  prisma: PrismaClient,
  dishTypeId: string = TEST_DISH_TYPE_ID,
): Promise<TestDishTypeHandle> {
  const existing = await prisma.dishType.findUnique({ where: { id: dishTypeId } });
  if (existing) {
    // Pre-existing (seeded) row: reuse it, never delete it.
    return { dishTypeId, dispose: async () => {} };
  }

  // A stable, clearly test-scoped category id, reused across runs so repeated
  // invocations converge rather than accumulating rows.
  const categoryId = `TEST_CAT_${dishTypeId}`;
  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  const createdCategory = category
    ? null
    : await prisma.category.create({
        data: { id: categoryId, name: `Test Category ${dishTypeId}`, slug: `test-cat-${dishTypeId.toLowerCase()}` },
      });

  await prisma.dishType.create({
    data: { id: dishTypeId, name: `Test Dish ${dishTypeId}`, categoryId },
  });

  let disposed = false;
  return {
    dishTypeId,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      // Products first: the FK is Restrict, so the dish type cannot be removed
      // while a product still references it.
      await prisma.dishType
        .delete({ where: { id: dishTypeId } })
        .catch(() => undefined);
      if (createdCategory) {
        await prisma.category
          .delete({ where: { id: createdCategory.id } })
          .catch(() => undefined);
      }
    },
  };
}

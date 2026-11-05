-- Protect customer carts from catalog hard-deletion (R-1 / R-2).
--
-- Policy
-- ------
-- Cart rows are customer-owned state, not catalog history. Deleting a product
-- or an option-group item must therefore never cascade into a live cart. The
-- application now refuses such deletes with HTTP 409 while a CartItem /
-- CartItemOption reference exists; these constraints are the database-level
-- backstop for the race where a cart reference lands between that check and
-- the DELETE.
--
-- The previous referential actions were both ON DELETE CASCADE:
--   * "CartItem_productId_fkey"             -> Product
--   * "CartItemOption_optionGroupItemId_fkey" -> OptionGroupItem
--
-- PostgreSQL's RESTRICT is stricter than NO ACTION: it is checked immediately
-- and cannot be deferred, so a concurrent cart write cannot be committed and
-- then leave the catalog delete silently succeeding. Prisma reports the
-- resulting foreign-key violation as P2003; the application maps the relevant
-- P2003 races to its existing 409 conflict response instead of a 500.
--
-- Scope
-- -----
-- Only these two foreign keys change. OrderItem -> Product and
-- OrderItemOption -> OptionGroupItem are ALREADY RESTRICT and are not touched.
-- The legacy CartItemOption -> ProductOption cascade, all catalog cascades,
-- the ON UPDATE actions, indexes and columns are unchanged.
--
-- Rollback
-- --------
-- This migration is reversible by dropping and re-adding the same two
-- constraints with ON DELETE CASCADE. It is NOT applied by this task and has
-- only been reviewed statically.

ALTER TABLE "CartItem" DROP CONSTRAINT "CartItem_productId_fkey";
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CartItemOption" DROP CONSTRAINT "CartItemOption_optionGroupItemId_fkey";
ALTER TABLE "CartItemOption" ADD CONSTRAINT "CartItemOption_optionGroupItemId_fkey" FOREIGN KEY ("optionGroupItemId") REFERENCES "OptionGroupItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

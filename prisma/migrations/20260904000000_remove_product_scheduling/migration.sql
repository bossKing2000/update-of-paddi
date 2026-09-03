-- Stage 1: Remove the old product scheduling architecture (Bottom Pot simplification).
-- Product orderability is now: vendor.isLive AND acceptingOrders !== false AND product.archived = false.
-- Data destroyed by this migration (verified 2026-09-04 on the Render database):
--   - 746 "ProductSchedule" rows (all type ONE_TIME; zero WEEKLY windows existed)
--   - 0 "ProductScheduleWindow" rows
--   - Product.isLive / Product.liveUntil mirrors (recomputed values, not source of truth)
--   - User.operatingHours (zero vendors had a value set)
--   - User.timezone (200 vendors had a value; used only for recurring-schedule evaluation)
--   - User.order_openAT / order_closeAT (write-only mirrors of Monday's operating-hours row)
-- Unrelated drift already present in the database (tsvector_col, CustomerSupportTicket,
-- UserSession) is intentionally NOT touched by this migration.

-- Drop scheduling tables (windows first due to FK).
DROP TABLE IF EXISTS "ProductScheduleWindow";
DROP TABLE IF EXISTS "ProductSchedule";

-- Drop the scheduling-only enum.
DROP TYPE IF EXISTS "ProductScheduleType";

-- Drop product live mirrors.
DROP INDEX IF EXISTS "Product_isLive_idx";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "isLive";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "liveUntil";

-- Drop vendor scheduling fields (operating-hours system + timezone fallback + Monday mirrors).
ALTER TABLE "User" DROP COLUMN IF EXISTS "operatingHours";
ALTER TABLE "User" DROP COLUMN IF EXISTS "timezone";
ALTER TABLE "User" DROP COLUMN IF EXISTS "order_openAT";
ALTER TABLE "User" DROP COLUMN IF EXISTS "order_closeAT";

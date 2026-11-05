-- =============================================================================
-- Foodi Paddi — Phase 3A: monetary Float (naira) → integer kobo
-- =============================================================================
--
-- Converts every authoritative monetary column from Float (naira) to integer
-- kobo (minor currency unit). All subsequent application math is exact integer
-- kobo; naira is only a display conversion at API boundaries.
--
-- CONVERSION POLICY (deterministic):
--   Every source column stores naira as a Float (double precision) with at most
--   two decimal places. The conversion is:
--     ROUND(val::numeric * 100)::INTEGER|BIGINT
--   The source value is cast to `numeric` BEFORE multiplying by 100, so all
--   arithmetic is exact decimal. `ROUND(numeric)` rounds ties away from zero,
--   which PostgreSQL guarantees for the numeric type (see
--   https://www.postgresql.org/docs/current/functions-math.html).
--
--   IMPORTANT LIMITATION: the source value is a double-precision Float. Not
--   every decimal naira value is exactly representable in binary floating
--   point (e.g. ₦1.005 may be stored as 1.00499999... or 1.00500001...). The
--   conversion deterministically converts whatever binary value is stored;
--   it cannot recover the "intended" decimal value if the Float already lost
--   precision. This is inherent to the Float→numeric conversion and cannot be
--   fixed in the migration.
--
-- SAFETY GUARDS:
--   * NaN is rejected with a clear exception. PostgreSQL treats NaN == NaN
--     (for sorting/indexing), so `val != val` is unreliable. NaN and
--     +/-Infinity are detected by comparing against quoted special-value
--     literals cast to double precision
--     (see https://www.postgresql.org/docs/18/datatype-numeric.html).
--   * +/-Infinity is rejected with a clear exception before any arithmetic,
--     since Infinity * 100 overflows double precision.
--   * INTEGER-range overflow is rejected with a clear exception before casting.
--   * NULL is preserved (nullable columns only); NOT NULL columns with
--     historical NULLs will fail the ALTER (no silent NULL→0 conversion).
--   * No silent truncation, capping, or value substitution. If a value cannot
--     be converted safely, the ALTER COLUMN statement fails.
--
-- TYPE NOTES:
--   * VendorPayout.{grossRevenue, commission, amount} become BIGINT because
--     payouts aggregate revenue across many orders and can exceed INTEGER range
--     (~₦21M in kobo) on a large settlement run. Consistent with the Order
--     kobo snapshot convention (commissionKobo/vendorPayoutKobo/discountKobo).
--   * Order.commissionKobo / vendorPayoutKobo / discountKobo are already
--     BigInt and are NOT altered here.
--   * Promotion.value is deliberately LEFT as Float: it is polymorphic
--     (percentage 0–100 for PERCENTAGE type, naira for FIXED/DELIVERY type).
--     Callers must check `type` before interpreting it; it is converted to
--     kobo at the calculation boundary, not stored as kobo.
--   * Columns already in kobo (Payment.amount, Payment.refundedAmount,
--     RefundRequest.requestedAmountKobo) are NOT touched.
--
-- RANGE LIMITS (PostgreSQL, https://www.postgresql.org/docs/current/datatype-numeric.html):
--   INTEGER:  -2,147,483,648 to +2,147,483,647   (~₦21.47M in kobo)
--   BIGINT:   -9,223,372,036,854,775,808 to +9,223,372,036,854,775,807
--             (~₦92 quadrillion in kobo — practically unreachable for monetary
--             amounts, so BIGINT overflow is not explicitly guarded; the cast
--             will fail naturally if it ever occurs)
--
-- TRANSACTIONALITY:
--   This migration file has no `-- prisma-migrate-disable-next-transaction`
--   header. Prisma's migration runner wraps each migration file's execution in
--   a transaction by default on PostgreSQL, so if any ALTER COLUMN fails, the
--   entire file's changes are rolled back. No partial conversion remains.
--   This is Prisma runner behavior, not PostgreSQL DDL behavior per se; it is
--   documented in Prisma's migration execution behavior and should be confirmed
--   by running the migration on a disposable database before production use.
--
-- ROLLBACK:
--   Reversing a Float→integer conversion is lossy. Treat as one-way.
-- =============================================================================

-- Helper: convert double-precision naira to integer kobo with safety guards.
-- Casts to numeric BEFORE multiplying by 100 for exact decimal arithmetic.
-- ROUND(numeric) rounds ties away from zero (deterministic).
-- Rejects NaN, +/-Infinity, and INTEGER overflow with clear exceptions.
CREATE OR REPLACE FUNCTION _kobo_from_naira_int(val double precision)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  scaled numeric;
  rounded numeric;
BEGIN
  IF val IS NULL THEN
    RETURN NULL;
  END IF;

  -- PostgreSQL treats NaN == NaN (for sorting/indexing), so val != val is
  -- unreliable. Detect NaN and +/-Infinity by comparing against quoted
  -- special-value literals cast to double precision.
  IF val = 'NaN'::double precision THEN
    RAISE EXCEPTION 'cannot convert NaN naira value to integer kobo';
  END IF;

  -- Reject +/-Infinity before any arithmetic, since Infinity * 100 overflows
  -- double precision and would corrupt the conversion.
  IF val = 'Infinity'::double precision OR val = '-Infinity'::double precision THEN
    RAISE EXCEPTION 'cannot convert infinite naira value to integer kobo';
  END IF;

  -- Cast to numeric FIRST, then multiply by 100. All arithmetic below is
  -- exact decimal; no double-precision rounding on the product.
  scaled := val::numeric * 100;

  rounded := ROUND(scaled);

  -- Check INTEGER bounds before casting. ROUND(scaled) could push a value
  -- just over the boundary (e.g. 2147483647.5 -> 2147483648), so we check
  -- the rounded result.
  IF rounded > 2147483647::numeric OR rounded < -2147483648::numeric THEN
    RAISE EXCEPTION 'naira value % exceeds INTEGER kobo range', val;
  END IF;

  RETURN rounded::INTEGER;
END;
$$;

-- Helper: convert double-precision naira to BIGINT kobo with safety guards.
-- Same NaN/+/-Infinity guards as _kobo_from_naira_int. BIGINT overflow is
-- practically unreachable for monetary amounts (~₦92 quadrillion limit), but
-- the cast will fail naturally if it ever occurs.
CREATE OR REPLACE FUNCTION _kobo_from_naira_bigint(val double precision)
RETURNS BIGINT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  scaled numeric;
  rounded numeric;
BEGIN
  IF val IS NULL THEN
    RETURN NULL;
  END IF;

  -- Detect NaN and +/-Infinity by comparing against quoted special-value
  -- literals cast to double precision.
  IF val = 'NaN'::double precision THEN
    RAISE EXCEPTION 'cannot convert NaN naira value to BIGINT kobo';
  END IF;

  -- Reject +/-Infinity before any arithmetic, since Infinity * 100 overflows
  -- double precision and would corrupt the conversion.
  IF val = 'Infinity'::double precision OR val = '-Infinity'::double precision THEN
    RAISE EXCEPTION 'cannot convert infinite naira value to BIGINT kobo';
  END IF;

  scaled := val::numeric * 100;
  rounded := ROUND(scaled);

  IF rounded > 9223372036854775807::numeric OR rounded < -9223372036854775808::numeric THEN
    RAISE EXCEPTION 'naira value % exceeds BIGINT kobo range', val;
  END IF;

  RETURN rounded::BIGINT;
END;
$$;

-- Product: unit price → integer kobo
ALTER TABLE "Product" ALTER COLUMN "price" TYPE INTEGER USING _kobo_from_naira_int("price");

-- ProductOption: add-on price → integer kobo
ALTER TABLE "ProductOption" ALTER COLUMN "price" TYPE INTEGER USING _kobo_from_naira_int("price");

-- OptionGroupItem: add-on surcharge → integer kobo (may be negative)
ALTER TABLE "OptionGroupItem" ALTER COLUMN "priceAdd" TYPE INTEGER USING _kobo_from_naira_int("priceAdd");

-- Order: financial snapshot totals → integer kobo
ALTER TABLE "Order" ALTER COLUMN "basePrice" TYPE INTEGER USING _kobo_from_naira_int("basePrice");
ALTER TABLE "Order" ALTER COLUMN "extraCharge" TYPE INTEGER USING _kobo_from_naira_int("extraCharge");
ALTER TABLE "Order" ALTER COLUMN "deliveryFee" TYPE INTEGER USING _kobo_from_naira_int("deliveryFee");
ALTER TABLE "Order" ALTER COLUMN "totalPrice" TYPE INTEGER USING _kobo_from_naira_int("totalPrice");

-- OrderItem: snapshotted line prices → integer kobo
ALTER TABLE "OrderItem" ALTER COLUMN "unitPrice" TYPE INTEGER USING _kobo_from_naira_int("unitPrice");
ALTER TABLE "OrderItem" ALTER COLUMN "subtotal" TYPE INTEGER USING _kobo_from_naira_int("subtotal");

-- OrderItemOption: snapshotted option price → integer kobo
ALTER TABLE "OrderItemOption" ALTER COLUMN "price" TYPE INTEGER USING _kobo_from_naira_int("price");

-- Cart: cart totals → integer kobo
ALTER TABLE "Cart" ALTER COLUMN "basePrice" TYPE INTEGER USING _kobo_from_naira_int("basePrice");
ALTER TABLE "Cart" ALTER COLUMN "totalPrice" TYPE INTEGER USING _kobo_from_naira_int("totalPrice");

-- CartItem: cart line prices → integer kobo
ALTER TABLE "CartItem" ALTER COLUMN "unitPrice" TYPE INTEGER USING _kobo_from_naira_int("unitPrice");
ALTER TABLE "CartItem" ALTER COLUMN "subtotal" TYPE INTEGER USING _kobo_from_naira_int("subtotal");

-- CartItemOption: cart option price → integer kobo
ALTER TABLE "CartItemOption" ALTER COLUMN "price" TYPE INTEGER USING _kobo_from_naira_int("price");

-- Promotion: discount cap and minimum order → integer kobo
--   `value` is intentionally left Float (polymorphic: percentage or naira).
ALTER TABLE "Promotion" ALTER COLUMN "maxDiscount" TYPE INTEGER USING _kobo_from_naira_int("maxDiscount");
ALTER TABLE "Promotion" ALTER COLUMN "minOrderAmount" TYPE INTEGER USING _kobo_from_naira_int("minOrderAmount");

-- PromotionUsage: discount applied in a redemption → integer kobo
ALTER TABLE "PromotionUsage" ALTER COLUMN "discount" TYPE INTEGER USING _kobo_from_naira_int("discount");

-- VendorPayout: settlement amounts → BIGINT kobo (aggregate may exceed INT)
ALTER TABLE "VendorPayout" ALTER COLUMN "grossRevenue" TYPE BIGINT USING _kobo_from_naira_bigint("grossRevenue");
ALTER TABLE "VendorPayout" ALTER COLUMN "commission" TYPE BIGINT USING _kobo_from_naira_bigint("commission");
ALTER TABLE "VendorPayout" ALTER COLUMN "amount" TYPE BIGINT USING _kobo_from_naira_bigint("amount");

-- DeliveryPerson: rider wallet balance → integer kobo
ALTER TABLE "DeliveryPerson" ALTER COLUMN "walletBalance" TYPE INTEGER USING _kobo_from_naira_int("walletBalance");

-- DeliveryEarning: rider earning components → integer kobo
ALTER TABLE "DeliveryEarning" ALTER COLUMN "baseFee" TYPE INTEGER USING _kobo_from_naira_int("baseFee");
ALTER TABLE "DeliveryEarning" ALTER COLUMN "distanceFee" TYPE INTEGER USING _kobo_from_naira_int("distanceFee");
ALTER TABLE "DeliveryEarning" ALTER COLUMN "tip" TYPE INTEGER USING _kobo_from_naira_int("tip");
ALTER TABLE "DeliveryEarning" ALTER COLUMN "deductions" TYPE INTEGER USING _kobo_from_naira_int("deductions");
ALTER TABLE "DeliveryEarning" ALTER COLUMN "totalEarned" TYPE INTEGER USING _kobo_from_naira_int("totalEarned");

-- RiderWithdrawal: withdrawal amount and balance snapshot → integer kobo
ALTER TABLE "RiderWithdrawal" ALTER COLUMN "amount" TYPE INTEGER USING _kobo_from_naira_int("amount");
ALTER TABLE "RiderWithdrawal" ALTER COLUMN "balanceSnapshot" TYPE INTEGER USING _kobo_from_naira_int("balanceSnapshot");

-- SpecialOrderOffer: vendor bid price → integer kobo
ALTER TABLE "SpecialOrderOffer" ALTER COLUMN "price" TYPE INTEGER USING _kobo_from_naira_int("price");

-- ReferralReward: referral reward amount → integer kobo
ALTER TABLE "ReferralReward" ALTER COLUMN "amount" TYPE INTEGER USING _kobo_from_naira_int("amount");

-- Drop helper functions (no longer needed after this migration)
DROP FUNCTION IF EXISTS _kobo_from_naira_int(double precision);
DROP FUNCTION IF EXISTS _kobo_from_naira_bigint(double precision);

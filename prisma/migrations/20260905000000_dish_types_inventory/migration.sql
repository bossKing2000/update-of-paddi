-- Bottom Pot Product model: dish types, portions, inventory, add-on state.
-- Replaces the mandatory Breakfast/Lunch/Dinner Category enum with a curated
-- DishType table (expandable without deployments). All existing products are
-- backfilled by name keyword matching; unmatched products become OTHER.
-- Data verified 2026-09-05: 701 products, 1318 options (no duplicate
-- option names per product), 0 products with blank names/prices.

-- 1. DishType table.
CREATE TABLE "DishType" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "imageUrl" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 100,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DishType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DishType_name_key" ON "DishType"("name");
CREATE INDEX "DishType_isActive_sortOrder_idx" ON "DishType"("isActive", "sortOrder");

-- 2. Curated seed vocabulary (fixed stable ids).
INSERT INTO "DishType" ("id", "name", "description", "sortOrder", "isActive") VALUES
  ('JOLLOF', 'Jollof Rice', 'Smoky party-style jollof and its cousins', 10, true),
  ('FRIED_RICE', 'Fried Rice', 'Nigerian fried rice dishes', 20, true),
  ('OFADA', 'Ofada Rice', 'Ofada with ayamase or designer stew', 30, true),
  ('WHITE_RICE', 'White Rice', 'Plain white rice with stews and sauces', 40, true),
  ('COCONUT_RICE', 'Coconut Rice', 'Coconut rice dishes', 50, true),
  ('AMALA', 'Amala', 'Amala with gbegiri, ewedu and stews', 60, true),
  ('EBA', 'Eba', 'Eba with soups', 70, true),
  ('POUNDED_YAM', 'Pounded Yam', 'Pounded yam with soups', 80, true),
  ('FUFU', 'Fufu', 'Fufu with soups', 90, true),
  ('SEMOVITA', 'Semovita & Wheat', 'Semovita, semolina and wheat swallows', 100, true),
  ('TUWO', 'Tuwo', 'Tuwo masara, tuwo shinkafa and northern swallows', 110, true),
  ('EWA_AGOYIN', 'Ewa Agoyin', 'Ewa agoyin with agege bread', 120, true),
  ('BEANS', 'Beans & Porridge', 'Beans, beans porridge and bean-based mains', 130, true),
  ('MOI_MOI', 'Moi Moi', 'Moi moi (moin moin) in all forms', 140, true),
  ('AKARA', 'Akara', 'Akara bean cakes', 150, true),
  ('PUFF_PUFF', 'Puff Puff', 'Puff puff snacks', 160, true),
  ('EGUSI', 'Egusi Soup', 'Egusi soup with any swallow', 170, true),
  ('OGBONO', 'Ogbono Soup', 'Ogbono soup with any swallow', 180, true),
  ('OKRA', 'Okra Soup', 'Okra soup with any swallow', 190, true),
  ('EFO_RIRO', 'Efo Riro', 'Efo riro vegetable soup', 200, true),
  ('AFANG', 'Afang Soup', 'Afang and okazi soups', 210, true),
  ('EDIKANG', 'Edikang Ikong', 'Edikang ikong soup', 220, true),
  ('BANGA', 'Banga Soup', 'Banga soup, starch and pairings', 230, true),
  ('OHA', 'Oha Soup', 'Oha soup', 240, true),
  ('BITTERLEAF', 'Bitterleaf Soup', 'Bitterleaf soup', 250, true),
  ('NSALA', 'Nsala Soup', 'Nsala white soup', 260, true),
  ('FISHERMAN', 'Fisherman Soup', 'Riverside fisherman soup', 270, true),
  ('PEPPER_SOUP', 'Pepper Soup', 'Goat meat, catfish, chicken and yam pepper soups', 280, true),
  ('ASUN', 'Asun', 'Spicy grilled goat meat', 290, true),
  ('SUYA', 'Suya', 'Grilled suya meats', 300, true),
  ('BOLI', 'Boli', 'Roasted plantain with sides', 310, true),
  ('PLANTAIN', 'Plantain', 'Boiled, fried and porridge plantain dishes', 320, true),
  ('FRIED_YAM', 'Fried Yam', 'Fried yam with sauces', 330, true),
  ('YAM_PORRIDGE', 'Yam Porridge', 'Yam porridge (asaro) and yam mains', 340, true),
  ('ABACHA', 'Abacha', 'Abacha African salad', 350, true),
  ('NKWOBI', 'Nkwobi', 'Nkwobi cow-foot delicacy', 360, true),
  ('ISIEWU', 'Isi Ewu', 'Isi ewu goat-head delicacy', 370, true),
  ('KILISHI', 'Kilishi', 'Kilishi beef jerky', 380, true),
  ('PONMO', 'Ponmo', 'Peppered ponmo cow skin', 390, true),
  ('OKPA', 'Okpa', 'Okpa and corn pudding', 400, true),
  ('AGIDI_PAP', 'Agidi, Pap & Custard', 'Agidi, pap, akamu and custard', 410, true),
  ('CHICKEN', 'Chicken & Turkey', 'Chicken and turkey mains', 420, true),
  ('GOAT_MEAT', 'Goat Meat', 'Goat meat mains and stews', 430, true),
  ('FISH', 'Fish & Seafood', 'Grilled, fried and sauced fish and seafood', 440, true),
  ('SMALL_CHOPS', 'Small Chops', 'Samosa, spring rolls and party chops', 450, true),
  ('SNACKS', 'Snacks & Pastries', 'Meat pie, sausage rolls, egg rolls, chin chin', 460, true),
  ('SHAWARMA', 'Shawarma', 'Naija-style shawarma', 470, true),
  ('NOODLES', 'Noodles & Pasta', 'Indomie, noodles and pasta dishes', 480, true),
  ('DRINKS', 'Drinks', 'Zobo, kunu, smoothies, juices and drinks', 490, true),
  ('OTHER', 'Other', 'Everything else in the pot', 9999, true);

-- 3. New Product columns (dishTypeId nullable until backfilled below).
ALTER TABLE "Product" ADD COLUMN "dishTypeId" TEXT;
ALTER TABLE "Product" ADD COLUMN "portionLabel" TEXT;
ALTER TABLE "Product" ADD COLUMN "trackInventory" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "stock" INTEGER;

-- 4. Backfill dishTypeId from product names. Specific multi-word matches
-- come first; short words use word-boundary regex to avoid false hits
-- (e.g. "pap" must not match "papaya", "eba" must not match "kebab").
UPDATE "Product" SET "dishTypeId" = CASE
  WHEN lower("name") LIKE '%jollof%' THEN 'JOLLOF'
  WHEN lower("name") LIKE '%fried rice%' THEN 'FRIED_RICE'
  WHEN lower("name") LIKE '%ofada%' OR lower("name") LIKE '%ayamase%' THEN 'OFADA'
  WHEN lower("name") LIKE '%white rice%' THEN 'WHITE_RICE'
  WHEN lower("name") LIKE '%coconut rice%' THEN 'COCONUT_RICE'
  WHEN lower("name") LIKE '%amala%' OR lower("name") LIKE '%gbegiri%' THEN 'AMALA'
  WHEN lower("name") ~ '\meba\M' THEN 'EBA'
  WHEN lower("name") LIKE '%pounded yam%' THEN 'POUNDED_YAM'
  WHEN lower("name") LIKE '%fufu%' THEN 'FUFU'
  WHEN lower("name") LIKE '%semovita%' OR lower("name") LIKE '%semolina%' OR lower("name") LIKE '%wheat%' THEN 'SEMOVITA'
  WHEN lower("name") LIKE '%tuwo%' OR lower("name") LIKE '%miyan%' THEN 'TUWO'
  WHEN lower("name") LIKE '%ewa%' OR lower("name") LIKE '%agoyin%' THEN 'EWA_AGOYIN'
  WHEN lower("name") LIKE '%moin%' OR lower("name") LIKE '%moi moi%' THEN 'MOI_MOI'
  WHEN lower("name") LIKE '%akara%' OR lower("name") LIKE '%bean cake%' THEN 'AKARA'
  WHEN lower("name") LIKE '%puff%' THEN 'PUFF_PUFF'
  WHEN lower("name") LIKE '%egusi%' THEN 'EGUSI'
  WHEN lower("name") LIKE '%ogbono%' THEN 'OGBONO'
  WHEN lower("name") LIKE '%okra%' THEN 'OKRA'
  WHEN lower("name") LIKE '%efo%' THEN 'EFO_RIRO'
  WHEN lower("name") LIKE '%afang%' OR lower("name") LIKE '%okazi%' THEN 'AFANG'
  WHEN lower("name") LIKE '%edikang%' OR lower("name") LIKE '%ikong%' THEN 'EDIKANG'
  WHEN lower("name") LIKE '%banga%' OR lower("name") LIKE '%starch%' THEN 'BANGA'
  WHEN lower("name") ~ '\moha\M' THEN 'OHA'
  WHEN lower("name") LIKE '%bitterleaf%' OR lower("name") LIKE '%bitter leaf%' THEN 'BITTERLEAF'
  WHEN lower("name") LIKE '%nsala%' OR lower("name") LIKE '%white soup%' THEN 'NSALA'
  WHEN lower("name") LIKE '%fisherman%' THEN 'FISHERMAN'
  WHEN lower("name") LIKE '%pepper soup%' OR lower("name") LIKE '%point and kill%' OR lower("name") LIKE '%ukodo%' THEN 'PEPPER_SOUP'
  WHEN lower("name") LIKE '%asun%' THEN 'ASUN'
  WHEN lower("name") LIKE '%suya%' THEN 'SUYA'
  WHEN lower("name") LIKE '%boli%' OR lower("name") LIKE '%roasted plantain%' OR lower("name") LIKE '%booli%' THEN 'BOLI'
  WHEN lower("name") LIKE '%fried yam%' THEN 'FRIED_YAM'
  WHEN lower("name") LIKE '%plantain porridge%' THEN 'PLANTAIN'
  WHEN lower("name") LIKE '%beans%' OR lower("name") LIKE '%porridge%' THEN 'BEANS'
  WHEN lower("name") LIKE '%plantain%' OR lower("name") ~ '\mdodo\M' THEN 'PLANTAIN'
  WHEN lower("name") LIKE '%yam porridge%' OR lower("name") LIKE '%asaro%' THEN 'YAM_PORRIDGE'
  WHEN lower("name") LIKE '%abacha%' OR lower("name") LIKE '%african salad%' THEN 'ABACHA'
  WHEN lower("name") LIKE '%nkwobi%' THEN 'NKWOBI'
  WHEN lower("name") LIKE '%isi ewu%' THEN 'ISIEWU'
  WHEN lower("name") LIKE '%kilishi%' OR lower("name") LIKE '%jerky%' THEN 'KILISHI'
  WHEN lower("name") LIKE '%ponmo%' OR lower("name") LIKE '%cow skin%' THEN 'PONMO'
  WHEN lower("name") LIKE '%okpa%' OR lower("name") LIKE '%corn pudding%' THEN 'OKPA'
  WHEN lower("name") LIKE '%agidi%' OR lower("name") LIKE '%akamu%' OR lower("name") LIKE '%custard%' OR lower("name") ~ '\mpap\M' OR lower("name") ~ '\mogi\M' THEN 'AGIDI_PAP'
  WHEN lower("name") LIKE '%chicken%' OR lower("name") LIKE '%turkey%' THEN 'CHICKEN'
  WHEN lower("name") LIKE '%goat%' THEN 'GOAT_MEAT'
  WHEN lower("name") LIKE '%fish%' OR lower("name") LIKE '%croaker%' OR lower("name") LIKE '%tilapia%' OR lower("name") LIKE '%catfish%' OR lower("name") LIKE '%titus%' OR lower("name") LIKE '%stockfish%' OR lower("name") LIKE '%seafood%' OR lower("name") LIKE '%shrimp%' OR lower("name") LIKE '%prawn%' THEN 'FISH'
  WHEN lower("name") LIKE '%small chop%' OR lower("name") LIKE '%samosa%' OR lower("name") LIKE '%spring roll%' THEN 'SMALL_CHOPS'
  WHEN lower("name") LIKE '%meat pie%' OR lower("name") LIKE '%sausage%' OR lower("name") LIKE '%gala%' OR lower("name") LIKE '%egg roll%' OR lower("name") LIKE '%scotch egg%' OR lower("name") LIKE '%chin chin%' THEN 'SNACKS'
  WHEN lower("name") LIKE '%shawarma%' THEN 'SHAWARMA'
  WHEN lower("name") LIKE '%indomie%' OR lower("name") LIKE '%noodle%' OR lower("name") LIKE '%spaghetti%' OR lower("name") LIKE '%pasta%' THEN 'NOODLES'
  WHEN lower("name") LIKE '%zobo%' OR lower("name") LIKE '%kunu%' OR lower("name") LIKE '%smoothie%' OR lower("name") LIKE '%juice%' OR lower("name") LIKE '%tigernut%' OR lower("name") LIKE '%drink%' THEN 'DRINKS'
  ELSE 'OTHER'
END;

-- 5. Enforce dishTypeId, add FK + indexes.
ALTER TABLE "Product" ALTER COLUMN "dishTypeId" SET NOT NULL;
ALTER TABLE "Product" ADD CONSTRAINT "Product_dishTypeId_fkey" FOREIGN KEY ("dishTypeId") REFERENCES "DishType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Product_dishTypeId_idx" ON "Product"("dishTypeId");
CREATE INDEX "Product_vendorId_archived_idx" ON "Product"("vendorId", "archived");

-- 6. Drop the meal-time Category enum (replaced by DishType).
ALTER TABLE "Product" DROP COLUMN "category";
DROP TYPE "Category";

-- 7. Add-on enable/disable + per-product name uniqueness
-- (verified: no existing duplicate option names per product).
ALTER TABLE "ProductOption" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_productId_name_key" UNIQUE ("productId", "name");

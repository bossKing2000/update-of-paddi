import { PrismaClient, TagType } from "@prisma/client";
import { assertSeedAllowed, SEED_OPT_IN_ENV, SEED_OPT_IN_VALUE } from "../src/jobs/seedGuard";

const prisma = new PrismaClient();

const CATEGORIES = [
  { id: "RICE_DISHES", name: "Rice Dishes", slug: "rice-dishes", sortOrder: 10 },
  { id: "SOUPS_AND_SWALLOW", name: "Soups and Swallow", slug: "soups-and-swallow", sortOrder: 20 },
  { id: "GRILLS_AND_PROTEINS", name: "Grills and Proteins", slug: "grills-and-proteins", sortOrder: 30 },
  { id: "SNACKS_AND_SMALL_CHOPS", name: "Snacks and Small Chops", slug: "snacks-and-small-chops", sortOrder: 40 },
  { id: "BREAKFAST", name: "Breakfast", slug: "breakfast", sortOrder: 50 },
  { id: "DRINKS", name: "Drinks", slug: "drinks", sortOrder: 60 },
  { id: "PASTRIES_AND_BAKERY", name: "Pastries and Bakery", slug: "pastries-and-bakery", sortOrder: 70 },
  { id: "LOCAL_SPECIALS", name: "Local Specials", slug: "local-specials", sortOrder: 80 },
  { id: "NOODLES_AND_PASTA", name: "Noodles and Pasta", slug: "noodles-and-pasta", sortOrder: 90 },
  { id: "SALADS_AND_HEALTHY", name: "Salads and Healthy", slug: "salads-and-healthy", sortOrder: 100 },
  { id: "COMBOS_AND_PACKS", name: "Combos and Packs", slug: "combos-and-packs", sortOrder: 110 },
  { id: "DESSERTS_AND_SMOOTHIES", name: "Desserts and Smoothies", slug: "desserts-and-smoothies", sortOrder: 120 },
];

const DISH_TYPES = [
  { id: "JOLLOF", name: "Jollof Rice", description: "Smoky party-style jollof and its cousins", sortOrder: 10, categoryId: "RICE_DISHES" },
  { id: "FRIED_RICE", name: "Fried Rice", description: "Nigerian fried rice dishes", sortOrder: 20, categoryId: "RICE_DISHES" },
  { id: "OFADA", name: "Ofada Rice", description: "Ofada with ayamase or designer stew", sortOrder: 30, categoryId: "RICE_DISHES" },
  { id: "WHITE_RICE", name: "White Rice", description: "Plain white rice with stews and sauces", sortOrder: 40, categoryId: "RICE_DISHES" },
  { id: "COCONUT_RICE", name: "Coconut Rice", description: "Coconut rice dishes", sortOrder: 50, categoryId: "RICE_DISHES" },
  { id: "AMALA", name: "Amala", description: "Amala with gbegiri, ewedu and stews", sortOrder: 60, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "EBA", name: "Eba", description: "Eba with soups", sortOrder: 70, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "POUNDED_YAM", name: "Pounded Yam", description: "Pounded yam with soups", sortOrder: 80, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "FUFU", name: "Fufu", description: "Fufu with soups", sortOrder: 90, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "SEMOVITA", name: "Semovita & Wheat", description: "Semovita, semolina and wheat swallows", sortOrder: 100, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "TUWO", name: "Tuwo", description: "Tuwo masara, tuwo shinkafa and northern swallows", sortOrder: 110, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "EWA_AGOYIN", name: "Ewa Agoyin", description: "Ewa agoyin with agege bread", sortOrder: 120, categoryId: "BREAKFAST" },
  { id: "BEANS", name: "Beans & Porridge", description: "Beans, beans porridge and bean-based mains", sortOrder: 130, categoryId: "BREAKFAST" },
  { id: "MOI_MOI", name: "Moi Moi", description: "Moi moi (moin moin) in all forms", sortOrder: 140, categoryId: "BREAKFAST" },
  { id: "AKARA", name: "Akara", description: "Akara bean cakes", sortOrder: 150, categoryId: "SNACKS_AND_SMALL_CHOPS" },
  { id: "PUFF_PUFF", name: "Puff Puff", description: "Puff puff snacks", sortOrder: 160, categoryId: "SNACKS_AND_SMALL_CHOPS" },
  { id: "EGUSI", name: "Egusi Soup", description: "Egusi soup with any swallow", sortOrder: 170, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "OGBONO", name: "Ogbono Soup", description: "Ogbono soup with any swallow", sortOrder: 180, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "OKRA", name: "Okra Soup", description: "Okra soup with any swallow", sortOrder: 190, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "EFO_RIRO", name: "Efo Riro", description: "Efo riro vegetable soup", sortOrder: 200, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "AFANG", name: "Afang Soup", description: "Afang and okazi soups", sortOrder: 210, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "EDIKANG", name: "Edikang Ikong", description: "Edikang ikong soup", sortOrder: 220, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "BANGA", name: "Banga Soup", description: "Banga soup, starch and pairings", sortOrder: 230, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "OHA", name: "Oha Soup", description: "Oha soup", sortOrder: 240, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "BITTERLEAF", name: "Bitterleaf Soup", description: "Bitterleaf soup", sortOrder: 250, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "NSALA", name: "Nsala Soup", description: "Nsala white soup", sortOrder: 260, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "FISHERMAN", name: "Fisherman Soup", description: "Riverside fisherman soup", sortOrder: 270, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "PEPPER_SOUP", name: "Pepper Soup", description: "Goat meat, catfish, chicken and yam pepper soups", sortOrder: 280, categoryId: "SOUPS_AND_SWALLOW" },
  { id: "ASUN", name: "Asun", description: "Spicy grilled goat meat", sortOrder: 290, categoryId: "GRILLS_AND_PROTEINS" },
  { id: "SUYA", name: "Suya", description: "Grilled suya meats", sortOrder: 300, categoryId: "GRILLS_AND_PROTEINS" },
  { id: "BOLI", name: "Boli", description: "Roasted plantain with sides", sortOrder: 310, categoryId: "SNACKS_AND_SMALL_CHOPS" },
  { id: "PLANTAIN", name: "Plantain", description: "Boiled, fried and porridge plantain dishes", sortOrder: 320, categoryId: "SNACKS_AND_SMALL_CHOPS" },
  { id: "FRIED_YAM", name: "Fried Yam", description: "Fried yam with sauces", sortOrder: 330, categoryId: "SNACKS_AND_SMALL_CHOPS" },
  { id: "YAM_PORRIDGE", name: "Yam Porridge", description: "Yam porridge (asaro) and yam mains", sortOrder: 340, categoryId: "BREAKFAST" },
  { id: "ABACHA", name: "Abacha", description: "Abacha African salad", sortOrder: 350, categoryId: "LOCAL_SPECIALS" },
  { id: "NKWOBI", name: "Nkwobi", description: "Nkwobi cow-foot delicacy", sortOrder: 360, categoryId: "LOCAL_SPECIALS" },
  { id: "ISIEWU", name: "Isi Ewu", description: "Isi ewu goat-head delicacy", sortOrder: 370, categoryId: "LOCAL_SPECIALS" },
  { id: "KILISHI", name: "Kilishi", description: "Kilishi beef jerky", sortOrder: 380, categoryId: "GRILLS_AND_PROTEINS" },
  { id: "PONMO", name: "Ponmo", description: "Peppered ponmo cow skin", sortOrder: 390, categoryId: "GRILLS_AND_PROTEINS" },
  { id: "OKPA", name: "Okpa", description: "Okpa and corn pudding", sortOrder: 400, categoryId: "LOCAL_SPECIALS" },
  { id: "AGIDI_PAP", name: "Agidi, Pap & Custard", description: "Agidi, pap, akamu and custard", sortOrder: 410, categoryId: "BREAKFAST" },
  { id: "CHICKEN", name: "Chicken & Turkey", description: "Chicken and turkey mains", sortOrder: 420, categoryId: "GRILLS_AND_PROTEINS" },
  { id: "GOAT_MEAT", name: "Goat Meat", description: "Goat meat mains and stews", sortOrder: 430, categoryId: "GRILLS_AND_PROTEINS" },
  { id: "FISH", name: "Fish & Seafood", description: "Grilled, fried and sauced fish and seafood", sortOrder: 440, categoryId: "GRILLS_AND_PROTEINS" },
  { id: "SMALL_CHOPS", name: "Small Chops", description: "Samosa, spring rolls and party chops", sortOrder: 450, categoryId: "SNACKS_AND_SMALL_CHOPS" },
  { id: "SNACKS", name: "Snacks & Pastries", description: "Meat pie, sausage rolls, egg rolls, chin chin", sortOrder: 460, categoryId: "SNACKS_AND_SMALL_CHOPS" },
  { id: "SHAWARMA", name: "Shawarma", description: "Naija-style shawarma", sortOrder: 470, categoryId: "SNACKS_AND_SMALL_CHOPS" },
  { id: "NOODLES", name: "Noodles & Pasta", description: "Indomie, noodles and pasta dishes", sortOrder: 480, categoryId: "NOODLES_AND_PASTA" },
  { id: "DRINKS", name: "Drinks", description: "Zobo, kunu, smoothies, juices and drinks", sortOrder: 490, categoryId: "DRINKS" },
  { id: "MEAT_PIE", name: "Meat Pie", description: "Flaky meat pies and savory pastries", sortOrder: 500, categoryId: "PASTRIES_AND_BAKERY" },
  { id: "FISH_PIE", name: "Fish Pie", description: "Fish pies and seafood pastries", sortOrder: 510, categoryId: "PASTRIES_AND_BAKERY" },
  { id: "SAUSAGE_ROLL", name: "Sausage Roll", description: "Sausage rolls and wrapped snacks", sortOrder: 520, categoryId: "PASTRIES_AND_BAKERY" },
  { id: "DOUGHNUT", name: "Doughnut", description: "Glazed and filled doughnuts", sortOrder: 530, categoryId: "PASTRIES_AND_BAKERY" },
  { id: "BREAD", name: "Bread", description: "Agege bread, loaves and buns", sortOrder: 540, categoryId: "PASTRIES_AND_BAKERY" },
  { id: "BANANA_BREAD", name: "Banana Bread", description: "Banana bread loaves and slices", sortOrder: 550, categoryId: "PASTRIES_AND_BAKERY" },
  { id: "NIGERIAN_SALAD", name: "Nigerian Salad", description: "Classic Naija salad with eggs and tuna", sortOrder: 600, categoryId: "SALADS_AND_HEALTHY" },
  { id: "CHICKEN_SALAD", name: "Chicken Salad", description: "Grilled chicken salads and bowls", sortOrder: 610, categoryId: "SALADS_AND_HEALTHY" },
  { id: "FRUIT_SALAD", name: "Fruit Salad", description: "Fresh fruit salads and cups", sortOrder: 620, categoryId: "SALADS_AND_HEALTHY" },
  { id: "ICE_CREAM", name: "Ice Cream", description: "Ice cream cups, cones and sundaes", sortOrder: 700, categoryId: "DESSERTS_AND_SMOOTHIES" },
  { id: "PARFAIT", name: "Parfait", description: "Yogurt parfaits and layered desserts", sortOrder: 710, categoryId: "DESSERTS_AND_SMOOTHIES" },
  { id: "SMOOTHIE", name: "Smoothie", description: "Blended fruit smoothies and shakes", sortOrder: 720, categoryId: "DESSERTS_AND_SMOOTHIES" },
  { id: "BREAKFAST_COMBO", name: "Breakfast Combo", description: "Curated breakfast packs for one or more", sortOrder: 800, categoryId: "COMBOS_AND_PACKS" },
  { id: "FAMILY_PACK", name: "Family Pack", description: "Family-sized combo packs", sortOrder: 810, categoryId: "COMBOS_AND_PACKS" },
  { id: "PARTY_PACK", name: "Party Pack", description: "Party platters and bulk celebration packs", sortOrder: 820, categoryId: "COMBOS_AND_PACKS" },
  { id: "OTHER", name: "Other", description: "Everything else in the pot", sortOrder: 9999, categoryId: "LOCAL_SPECIALS" },
];

const TAGS: { id: string; name: string; type: TagType }[] = [
  { id: "NIGERIAN", name: "Nigerian", type: TagType.CUISINE },
  { id: "YORUBA", name: "Yoruba", type: TagType.CUISINE },
  { id: "IGBO", name: "Igbo", type: TagType.CUISINE },
  { id: "HAUSA", name: "Hausa", type: TagType.CUISINE },
  { id: "WEST_AFRICAN", name: "West African", type: TagType.CUISINE },
  { id: "HALAL", name: "Halal", type: TagType.DIET },
  { id: "VEGETARIAN", name: "Vegetarian", type: TagType.DIET },
  { id: "VEGAN", name: "Vegan", type: TagType.DIET },
  { id: "HIGH_PROTEIN", name: "High Protein", type: TagType.DIET },
  { id: "LOW_CARB", name: "Low Carb", type: TagType.DIET },
  { id: "GLUTEN_FREE", name: "Gluten Free", type: TagType.DIET },
  { id: "BREAKFAST", name: "Breakfast", type: TagType.OCCASION },
  { id: "LUNCH", name: "Lunch", type: TagType.OCCASION },
  { id: "DINNER", name: "Dinner", type: TagType.OCCASION },
  { id: "PARTY", name: "Party", type: TagType.OCCASION },
  { id: "FAMILY", name: "Family", type: TagType.OCCASION },
  { id: "DATE_NIGHT", name: "Date Night", type: TagType.OCCASION },
  { id: "QUICK_MEAL", name: "Quick Meal", type: TagType.OCCASION },
  { id: "COMFORT_FOOD", name: "Comfort Food", type: TagType.OCCASION },
  { id: "WEEKEND", name: "Weekend", type: TagType.OCCASION },
];

/**
 * Fails closed if required taxonomy is missing after the upserts.
 *
 * The per-stage `count/length` logs below are informational only — a partially
 * applied taxonomy used to log a shortfall and still exit 0, letting the demo
 * seeder fail hundreds of rows deep instead. This turns a real shortfall into a
 * non-zero exit. Expected totals are derived from the arrays above, so they can
 * never drift from the source definitions.
 */
function assertComplete(
  label: string,
  present: number,
  expected: number,
  problems: string[],
): void {
  if (present !== expected) problems.push(`${label} ${present}/${expected}`);
}

async function main() {
  // Opt-in guard runs before the first database write.
  assertSeedAllowed("prisma/seed.ts");
  console.log("🌱 Seeding catalog reference data...");

  // Categories first: DishTypes reference them.
  for (const c of CATEGORIES) {
    await prisma.category.upsert({
      where: { id: c.id },
      // Never force isActive on reseed: manual deactivation survives.
      update: { name: c.name, slug: c.slug, sortOrder: c.sortOrder },
      create: { ...c, isActive: true },
    });
  }
  const categoryCount = await prisma.category.count({
    where: { id: { in: CATEGORIES.map((c) => c.id) } },
  });
  console.log(`✅ Categories present: ${categoryCount}/${CATEGORIES.length}`);
  const problems: string[] = [];
  assertComplete("categories", categoryCount, CATEGORIES.length, problems);

  for (const dt of DISH_TYPES) {
    await prisma.dishType.upsert({
      where: { id: dt.id },
      // Never force isActive on reseed: manual deactivation survives.
      update: {
        name: dt.name,
        description: dt.description,
        sortOrder: dt.sortOrder,
        categoryId: dt.categoryId,
      },
      create: { ...dt, isActive: true },
    });
  }
  const dishCount = await prisma.dishType.count({
    where: { id: { in: DISH_TYPES.map((d) => d.id) } },
  });
  console.log(`✅ DishType seed complete. Canonical records present: ${dishCount}/${DISH_TYPES.length}`);
  assertComplete("dishTypes", dishCount, DISH_TYPES.length, problems);

  for (const t of TAGS) {
    await prisma.tag.upsert({
      where: { id: t.id },
      update: { name: t.name, type: t.type },
      create: { ...t, isActive: true },
    });
  }
  const tagCount = await prisma.tag.count({
    where: { id: { in: TAGS.map((t) => t.id) } },
  });
  console.log(`✅ Tag seed complete. Canonical records present: ${tagCount}/${TAGS.length}`);
  assertComplete("tags", tagCount, TAGS.length, problems);

  if (problems.length > 0) {
    throw new Error(
      `Taxonomy seed incomplete after upsert: ${problems.join("; ")}. ` +
        `Re-run "${SEED_OPT_IN_ENV}=${SEED_OPT_IN_VALUE} npm run db:seed:taxonomy" against an empty schema.`,
    );
  }
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

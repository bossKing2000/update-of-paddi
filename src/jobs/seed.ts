import {
  Prisma,
  PrismaClient,
  Role,
  OrderStatus,
  PaymentStatus,
  DeliveryPersonStatus,
  DeliveryStatus,
  SupportTicketStatus,
  SpecialOrderRequestStatus,
  SpecialOrderOfferStatus,
  ActivityType,
  DiscountType,
  PromotionScope,
  ReferralRewardStatus,
} from "@prisma/client";
import { faker } from "@faker-js/faker";

// // npx ts-node src/jobs/seed.ts
// // npx prisma db push --force-reset
// // npx prisma db push
// // to make the html live run this : live-server
// // npx prisma migrate resolve --applied "20251004214831_full_migration"

// // for locally
// // npx prisma migrate reset
// // npx prisma migrate dev --name init --create-only
// // npx prisma migrate dev

const prisma = new PrismaClient();

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

type CountRange = { min: number; max: number };

function envRange(
  minName: string,
  maxName: string,
  defaultMin: number,
  defaultMax: number,
): CountRange {
  const min = envInt(minName, defaultMin);
  const max = envInt(maxName, defaultMax);
  if (max < min)
    throw new Error(`${maxName} must be greater than or equal to ${minName}`);
  return { min, max };
}

/** Change these defaults, or override any value with the matching SEED_* env variable. */
export const SEED_CONFIG = {
  vendors: envInt("SEED_VENDORS", 200),
  customers: envInt("SEED_CUSTOMERS", 1000),
  deliveryPeople: envInt("SEED_DELIVERY", 20),
  addressesPerUser: envRange("SEED_ADDRESSES_MIN", "SEED_ADDRESSES_MAX", 1, 2),
  productsPerVendor: envRange("SEED_PRODUCTS_MIN", "SEED_PRODUCTS_MAX", 1, 10),
  optionsPerProduct: envRange("SEED_OPTIONS_MIN", "SEED_OPTIONS_MAX", 1, 3),
  productReviewsPerProduct: envRange(
    "SEED_PRODUCT_REVIEWS_MIN",
    "SEED_PRODUCT_REVIEWS_MAX",
    10,
    50,
  ),
  vendorReviewsPerVendor: envRange(
    "SEED_VENDOR_REVIEWS_MIN",
    "SEED_VENDOR_REVIEWS_MAX",
    5,
    23,
  ),
  carts: envRange("SEED_CARTS_MIN", "SEED_CARTS_MAX", 3, 30),
  cartItemsPerCart: envRange(
    "SEED_CART_ITEMS_MIN",
    "SEED_CART_ITEMS_MAX",
    1,
    5,
  ),
  orders: envRange("SEED_ORDERS_MIN", "SEED_ORDERS_MAX", 5, 200),
  orderItemsPerOrder: envRange(
    "SEED_ORDER_ITEMS_MIN",
    "SEED_ORDER_ITEMS_MAX",
    1,
    4,
  ),
  assignments: envRange("SEED_ASSIGNMENTS_MIN", "SEED_ASSIGNMENTS_MAX", 10, 30),
  notifications: envRange(
    "SEED_NOTIFICATIONS_MIN",
    "SEED_NOTIFICATIONS_MAX",
    20,
    40,
  ),
  followers: envRange("SEED_FOLLOWERS_MIN", "SEED_FOLLOWERS_MAX", 5, 30),
  promotions: envRange("SEED_PROMOTIONS_MIN", "SEED_PROMOTIONS_MAX", 0, 10),
  supportTickets: envRange(
    "SEED_SUPPORT_TICKETS_MIN",
    "SEED_SUPPORT_TICKETS_MAX",
    0,
    5,
  ),
  specialRequests: envRange(
    "SEED_SPECIAL_REQUESTS_MIN",
    "SEED_SPECIAL_REQUESTS_MAX",
    0,
    5,
  ),
  referralRewards: envRange(
    "SEED_REFERRAL_REWARDS_MIN",
    "SEED_REFERRAL_REWARDS_MAX",
    0,
    5,
  ),
  dateRangeDays: envRange("SEED_DATE_DAYS_MIN", "SEED_DATE_DAYS_MAX", 10, 10),
  clearRedis: process.env.SEED_CLEAR_REDIS === "true",
};

export const seederState = {
  running: false,
  current: 0,
  total: 100,
  message: "Idle",
  stopRequested: false,
};

export function getSeederStatus() {
  return {
    running: seederState.running,
    progress: `${seederState.current} / ${seederState.total}`,
    message: seederState.message,
    stopRequested: seederState.stopRequested,
  };
}

export function stopSeeder() {
  if (!seederState.running) return false;
  seederState.stopRequested = true;
  seederState.message = "Stop requested";
  return true;
}

export function runSeeder() {
  if (seederState.running) return false;
  seederState.running = true;
  seederState.current = 0;
  seederState.stopRequested = false;
  seederState.message = "Starting seeder";
  seedDatabase()
    .then(() => {
      seederState.message = "Completed";
    })
    .catch((error: unknown) => {
      console.error("Seeder failed:", error);
      seederState.message = `Failed: ${error instanceof Error ? error.message : String(error)}`;
    })
    .finally(() => {
      seederState.running = false;
      seederState.stopRequested = false;
      seederState.current = 100;
    });
  return true;
}

const imageUrls = [
  "https://images.unsplash.com/photo-1600891964599-f61ba0e24092?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1551218808-94e220e084d2?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1589927986089-35812388d1f4?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1593642532973-d31b6557fa68?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1541698444083-023c97d3f4b6?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/70497/pexels-photo-70497.jpeg",
  "https://images.pexels.com/photos/461198/pexels-photo-461198.jpeg",
  "https://images.pexels.com/photos/825661/pexels-photo-825661.jpeg",
  "https://images.pexels.com/photos/1639557/pexels-photo-1639557.jpeg",
  "https://images.pexels.com/photos/2862154/pexels-photo-2862154.jpeg",
  "https://images.pexels.com/photos/8951563/pexels-photo-8951563.jpeg",
  "https://images.unsplash.com/photo-1494597564530-871f2b93ac55?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/1251208/pexels-photo-1251208.jpeg",
  "https://images.pexels.com/photos/376464/pexels-photo-376464.jpeg",
  "https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/327098/pexels-photo-327098.jpeg",
  "https://images.pexels.com/photos/302478/pexels-photo-302478.jpeg",
  "https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/312418/pexels-photo-312418.jpeg",
  "https://images.unsplash.com/photo-1563805042-7684c019e1cb?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/842571/pexels-photo-842571.jpeg",
  "https://images.unsplash.com/photo-1549931319-a545dcf3bc73?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/1132047/pexels-photo-1132047.jpeg",
  "https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/1633578/pexels-photo-1633578.jpeg",
  "https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/2347311/pexels-photo-2347311.jpeg",
  "https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/539451/pexels-photo-539451.jpeg",
  "https://images.unsplash.com/photo-1551106652-a5bcf4b29ab6?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/2673353/pexels-photo-2673353.jpeg",
  "https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/674574/pexels-photo-674574.jpeg",
  "https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/128242/pexels-photo-128242.jpeg",
  "https://images.unsplash.com/photo-1484980972926-edee96e0960d?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg",
  "https://images.unsplash.com/photo-1476224203421-9ac39bcb3327?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/2097090/pexels-photo-2097090.jpeg",
  "https://images.pexels.com/photos/718742/pexels-photo-718742.jpeg",
  "https://images.pexels.com/photos/1092730/pexels-photo-1092730.jpeg",
  "https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/410648/pexels-photo-410648.jpeg",
  "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/3659862/pexels-photo-3659862.jpeg",
  "https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/3219547/pexels-photo-3219547.jpeg",
  "https://images.unsplash.com/photo-1563379926898-05f4575a45d8?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/1234535/pexels-photo-1234535.jpeg",
  "https://images.pexels.com/photos/769289/pexels-photo-769289.jpeg",
  "https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/1352278/pexels-photo-1352278.jpeg",
  "https://images.unsplash.com/photo-1574484284002-952d92456975?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/2474661/pexels-photo-2474661.jpeg",
  "https://images.pexels.com/photos/691114/pexels-photo-691114.jpeg",
  "https://images.unsplash.com/photo-1481931098730-318b6f776db0?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/2299028/pexels-photo-2299028.jpeg",
  "https://images.unsplash.com/photo-1490818387583-1baba5e638af?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/2133985/pexels-photo-2133985.jpeg",
  "https://images.unsplash.com/photo-1511690743698-d9d85f2fbf38?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1527515862127-a4fc05baf7a5?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/2059151/pexels-photo-2059151.jpeg",
  "https://images.unsplash.com/photo-1552611052-33e04de081de?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.pexels.com/photos/1640777/pexels-photo-1640777.jpeg",
  "https://images.unsplash.com/photo-1571091655789-405eb7a3a3a8?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1546069901-d5bfd2cbfb1f?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1484723091739-30a097e8f929?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1546549032-9571cd6b27df?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1529042410759-befb1204b468?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1533089860892-a7c6f0a88666?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1559715745-e1b33a271c8f?w=400&h=300&fit=crop&auto=format&q=80",
  "https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=400&h=300&fit=crop&auto=format&q=80",
];

// Mirrors the dish-type backfill in migration
// 20260905000000_dish_types_inventory (ordered, specific-first). Seeded
// products get a best-effort dish type; anything unmatched is OTHER.
const DISH_KEYWORDS: [string, RegExp][] = [
  ["JOLLOF", /jollof/i],
  ["FRIED_RICE", /fried rice/i],
  ["OFADA", /ofada|ayamase/i],
  ["WHITE_RICE", /white rice/i],
  ["COCONUT_RICE", /coconut rice/i],
  ["AMALA", /amala|gbegiri/i],
  ["EBA", /\beba\b/i],
  ["POUNDED_YAM", /pounded yam/i],
  ["FUFU", /fufu/i],
  ["SEMOVITA", /semovita|semolina|wheat/i],
  ["TUWO", /tuwo|miyan/i],
  ["EWA_AGOYIN", /\bewa\b|agoyin/i],
  ["MOI_MOI", /moin|moi moi/i],
  ["AKARA", /akara|bean cake/i],
  ["PUFF_PUFF", /puff/i],
  ["EGUSI", /egusi/i],
  ["OGBONO", /ogbono/i],
  ["OKRA", /okra/i],
  ["EFO_RIRO", /\befo\b/i],
  ["AFANG", /afang|okazi/i],
  ["EDIKANG", /edikang|ikong/i],
  ["BANGA", /banga|starch/i],
  ["OHA", /\boha\b/i],
  ["BITTERLEAF", /bitterleaf|bitter leaf/i],
  ["NSALA", /nsala|white soup/i],
  ["FISHERMAN", /fisherman/i],
  ["PEPPER_SOUP", /pepper soup|point and kill|ukodo/i],
  ["ASUN", /asun/i],
  ["SUYA", /suya/i],
  ["BOLI", /boli|roasted plantain|booli/i],
  ["FRIED_YAM", /fried yam/i],
  ["PLANTAIN", /plantain porridge/i],
  ["BEANS", /beans|porridge/i],
  ["PLANTAIN", /plantain|\bdodo\b/i],
  ["YAM_PORRIDGE", /yam porridge|asaro/i],
  ["ABACHA", /abacha|african salad/i],
  ["NKWOBI", /nkwobi/i],
  ["ISIEWU", /isi ewu/i],
  ["KILISHI", /kilishi|jerky/i],
  ["PONMO", /ponmo|cow skin/i],
  ["OKPA", /okpa|corn pudding/i],
  ["AGIDI_PAP", /agidi|akamu|custard|\bpap\b|\bogi\b/i],
  ["CHICKEN", /chicken|turkey/i],
  ["GOAT_MEAT", /goat/i],
  ["FISH", /fish|croaker|tilapia|catfish|titus|stockfish|seafood|shrimp|prawn/i],
  ["SMALL_CHOPS", /small chop|samosa|spring roll/i],
  ["SNACKS", /meat pie|sausage|gala|egg roll|scotch egg|chin chin/i],
  ["SHAWARMA", /shawarma/i],
  ["NOODLES", /indomie|noodle|spaghetti|pasta/i],
  ["DRINKS", /zobo|kunu|smoothie|juice|tigernut|drink/i],
];

function classifyDishType(name: string): string {
  for (const [id, re] of DISH_KEYWORDS) {
    if (re.test(name)) return id;
  }
  return "OTHER";
}

const foodNames = [
  // 🍔 Global foods you had
  "Cheeseburger",
  "Margherita Pizza",
  "California Roll",
  "Spaghetti Carbonara",
  "Caesar Salad",
  "Grilled Ribeye Steak",
  "Club Sandwich",
  "Beef Taco",
  "Tom Yum Soup",
  "Pork Dumplings",
  "Chocolate Ice Cream",
  "Blueberry Pancakes",
  "Chicken Curry",
  "Loaded Fries",
  "Red Velvet Cake",
  "Strawberry Smoothie",
  "Everything Bagel",
  "Chicken Burrito",
  "Belgian Waffle",
  "Glazed Donut",
  "Chili Hotdog",
  "Nacho Supreme",
  "Seafood Lasagna",
  "Tonkotsu Ramen",
  "Chicken Quesadilla",
  "Falafel Wrap",
  "Caprese Grilled Cheese",
  "Vegetable Samosa",
  "Beef Chow Mein",
  "Pho Bo",
  "Pad Thai with Shrimp",
  "Spinach Gnocchi",
  "Mac & Cheese with Bacon",
  "Cheese Omelette",
  "Beer-battered Fish & Chips",
  "Buffalo Chicken Wings",
  "Bruschetta with Tomato & Basil",
  "Beef Empanadas",
  "Seafood Paella",
  "Nutella Crepes",
  "Chicken Biryani",
  "Lamb Shawarma",
  "Ceviche with Lime",
  "Banana Muffin",
  "Greek Pita Sandwich",
  "Fruit Tart",
  "Chicken Fajitas",
  "Cobb Salad with Blue Cheese",
  "Vegetable Spring Rolls",
  "Miso Soup with Tofu",

  // 🇳🇬 Nigerian dishes (~90)
  "Jollof Rice",
  "Fried Rice",
  "Ofada Rice with Ayamase Sauce",
  "Banga Soup",
  "Egusi Soup",
  "Ogbono Soup",
  "Okra Soup",
  "Efo Riro",
  "Nsala (White Soup)",
  "Afang Soup",
  "Edikang Ikong",
  "Oha Soup",
  "Bitterleaf Soup",
  "Gbegiri Soup",
  "Ewedu Soup",
  "Amala with Gbegiri and Ewedu",
  "Pounded Yam with Egusi",
  "Semovita with Ogbono Soup",
  "Starch with Banga Soup",
  "Tuwo Shinkafa with Miyan Kuka",
  "Tuwo Masara with Miyan Taushe",
  "Waina (Masa)",
  "Moin Moin",
  "Akara (Bean Cakes)",
  "Suya (Spicy Grilled Meat)",
  "Kilishi (Beef Jerky)",
  "Nkwobi (Cow Foot Delicacy)",
  "Isi Ewu (Goat Head)",
  "Ukodo (Yam Pepper Soup)",
  "Goat Meat Pepper Soup",
  "Catfish Pepper Soup",
  "Chicken Pepper Soup",
  "Palm Nut Soup",
  "Yam Porridge (Asaro)",
  "Beans Porridge",
  "Plantain Porridge",
  "Ewa Agoyin with Agege Bread",
  "Ofada Rice and Designer Stew",
  "Ojojo (Water Yam Fritters)",
  "Ekpang Nkukwo",
  "Abacha (African Salad)",
  "Ugba with Fish",
  "Fisherman Soup",
  "Atama Soup",
  "Afang Okazi Soup",
  "Corn Pudding (Okpa)",
  "Agidi Jollof",
  "Agidi White with Pepper Soup",
  "Boli (Roasted Plantain) with Groundnut",
  "Roasted Corn with Coconut",
  "Yam and Egg Sauce",
  "Boiled Plantain with Garden Egg Sauce",
  "Beans and Plantain",
  "Beans and Pap",
  "Akamu (Pap/Ogi) with Akara",
  "Custard with Moi Moi",
  "Nigerian Meat Pie",
  "Chicken Pie",
  "Nigerian Fish Roll",
  "Scotch Egg (Nigerian style)",
  "Shawarma (Naija Style)",
  "Gala Sausage Roll",
  "Puff Puff",
  "Chin Chin",
  "Meat Kebab",
  "Asun (Spicy Goat Meat)",
  "Ponmo Alata (Peppered Cow Skin)",
  "Spaghetti Jollof",
  "Indomie Stir Fry with Egg",
  "Egg Roll (Nigerian Style)",
  "Beans Cake Sandwich",
  "Peppered Snail",
  "Grilled Croaker Fish",
  "Fried Titus Fish with Stew",
  "Dry Fish with Palm Oil Sauce",
  "Stockfish in Palm Oil Sauce",
  "Ofada Sauce (Ayamase)",
  "Goat Meat Stew",
  "Turkey Stew",
  "Chicken in Tomato Stew",
  "Ofe Akwu (Palm Nut Stew)",
  "Garden Egg Stew",
  "Okpa Enugu",
  "Nigerian Pancake",
  "Coconut Rice",
  "Jollof Spaghetti",
  "Boiled Yam with Palm Oil Sauce",
  "Wheat with Ogbono Soup",
  "Oatmeal Swallow with Efo Riro",

  // 🇮🇳 Indian dishes
  "Paneer Butter Masala",
  "Masala Dosa",
  "Chicken Tikka Masala",
  "Rogan Josh",
  "Dal Makhani",
  "Hyderabadi Biryani",
  "Kadai Paneer",
  "Pav Bhaji",
  "Chole Bhature",
  "Pani Puri",
  "Aloo Paratha",
  "Palak Paneer",
  "Vindaloo Curry",
  "Lamb Rogan Josh",
  "Butter Naan",
  "Malai Kofta",
  "Samosa Chaat",
  "Gulab Jamun",
  "Rasmalai",
  "Jalebi",

  // 🇲🇽 Mexican dishes
  "Beef Enchiladas",
  "Chicken Enchiladas Verde",
  "Churros with Chocolate",
  "Tamales Rojos",
  "Carnitas Tacos",
  "Huevos Rancheros",
  "Mole Poblano",
  "Pozole Rojo",
  "Chilaquiles Verdes",
  "Elote (Mexican Street Corn)",
  "Queso Fundido",
  "Sopes con Carne",
  "Tres Leches Cake",

  // 🇮🇹 Italian & Mediterranean
  "Fettuccine Alfredo",
  "Penne Arrabbiata",
  "Risotto alla Milanese",
  "Osso Buco",
  "Caprese Salad",
  "Prosciutto with Melon",
  "Arancini Rice Balls",
  "Tiramisu",
  "Panna Cotta",
  "Cannoli",
  "Cioppino Seafood Stew",

  // 🇹🇭 Thai & Southeast Asian
  "Green Curry Chicken",
  "Massaman Curry",
  "Som Tum Papaya Salad",
  "Pad Kra Pao Basil Chicken",
  "Mango Sticky Rice",
  "Khao Soi",
  "Satay Skewers",
  "Laksa Noodle Soup",

  // 🇯🇵 Japanese
  "Salmon Nigiri Sushi",
  "Tempura Udon",
  "Chicken Katsu Curry",
  "Okonomiyaki Pancake",
  "Takoyaki Octopus Balls",
  "Gyudon Beef Bowl",
  "Unagi Donburi",
  "Yakisoba Noodles",

  // 🇪🇹 Ethiopian & others
  "Injera with Doro Wat",
  "Misir Wot (Red Lentil Stew)",
  "Shiro Wat",
  "Kitfo (Spiced Beef Tartare)",
  "Tibs Stir Fry",
  "Baklava",
  "Shish Kebab",
  "Hummus with Pita",
  "Baba Ganoush",
  "French Onion Soup",
  "Coq au Vin",
  "Beef Bourguignon",
  "Ratatouille",
  "Croque Monsieur",
  "Quiche Lorraine",
  "Crème Brûlée",
];

const videoUrls = [
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4", // 15s
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4", // 10s
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4", // 15s
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4", // 15s
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4", // 1
  // Big Buck Bunny - various lengths
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_5s_1MB.mp4",
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_3s_1MB.mp4",
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_2s_1MB.mp4",
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_1s_1MB.mp4",

  "https://videos.pexels.com/video-files/855253/855253-sd_640_360_30fps.mp4", // 8s - Coffee

  "https://videos.pexels.com/video-files/855253/855253-sd_640_360_30fps.mp4",
  "https://videos.pexels.com/video-files/3303009/3303009-sd_640_360_25fps.mp4",
  "https://videos.pexels.com/video-files/3120337/3120337-sd_640_360_30fps.mp4",
  "https://videos.pexels.com/video-files/854967/854967-sd_640_360_30fps.mp4",
  "https://videos.pexels.com/video-files/854964/854964-sd_640_360_30fps.mp4",
];

function randomImages() {
  return faker.helpers.arrayElements(
    imageUrls,
    faker.number.int({ min: 1, max: Math.min(6, imageUrls.length) }),
  );
}

function randomVideos() {
  return faker.helpers.arrayElements(
    videoUrls,
    faker.number.int({ min: 1, max: Math.min(6, videoUrls.length) }),
  );
}

function money(min = 500, max = 5000) {
  return faker.number.float({ min, max, fractionDigits: 2 });
}
const DAY_MS = 24 * 60 * 60 * 1000;

function randomRange(range: CountRange) {
  return faker.number.int(range);
}

function randomSeedDate() {
  const rangeDays = randomRange(SEED_CONFIG.dateRangeDays);
  const offset = faker.number.int({
    min: -rangeDays * DAY_MS,
    max: rangeDays * DAY_MS,
  });
  return new Date(Date.now() + offset);
}

function addMilliseconds(date: Date, milliseconds: number) {
  return new Date(date.getTime() + milliseconds);
}

const round2 = (v: number) => Number(v.toFixed(2));

// Mirrors src/controllers/referralController.generateReferralCode:
// 5-letter name prefix + 6 hex chars. Used so seeded referralCodes look
// exactly like app-generated ones (not arbitrary SEED_ strings).
function seedReferralCode(name: string): string {
  const prefix =
    name.replace(/[^A-Za-z]/g, "").slice(0, 5).toUpperCase() || "PADDI";
  const suffix = faker.string
    .hexadecimal({ length: 6, casing: "upper" })
    .replace(/^0x/i, "");
  return `${prefix}${suffix}`;
}

// Canonical marketplace-availability rule, mirrored from
// src/services/vendorAvailability.service.ts:
// orderable = vendor.isLive AND !archived AND (untracked OR stock > 0).
// deliveryPreferences==null means accepting orders (Bulk seed leaves it null).
function isSeedProductOrderable(
  product: { archived: boolean; trackInventory: boolean | null; stock: number | null },
  vendorIsLive: boolean,
) {
  if (!vendorIsLive) return false;
  if (product.archived) return false;
  if (product.trackInventory) return (product.stock ?? 0) > 0;
  return true;
}

function pick<T>(values: T[]) {
  return values.length ? faker.helpers.arrayElement(values) : undefined;
}
function take<T>(values: T[], count: number) {
  if (!values.length || count === 0) return [];
  return faker.helpers.arrayElements(values, Math.min(count, values.length));
}
function chunks<T>(values: T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}
async function createMany<T>(
  create: (data: T[]) => Promise<unknown>,
  data: T[],
) {
  for (const chunk of chunks(data)) if (chunk.length) await create(chunk);
}

async function seedDatabase() {
  console.log("Starting database seed with configuration:", SEED_CONFIG);
  const setProgress = (current: number, message: string) => {
    seederState.current = current;
    seederState.message = message;
    console.log(`${current}% ${message}`);
  };

  const users: Prisma.UserCreateManyInput[] = [];
  const addUsers = (role: Role, count: number, prefix: string) => {
    for (let index = 0; index < count; index++) {
      const name = faker.person.fullName();
      users.push({
        name,
        email: `${prefix}${index}_${faker.string.alphanumeric(6).toLowerCase()}@foodpaddi.test`,
        username: `${prefix}_${index}_${faker.string.alphanumeric(5).toLowerCase()}`,
        password: faker.internet.password(),
        role,
        roles: [role],
        preferences: take(["JOLLOF", "SUYA", "OFADA", "AMALA", "BOLI", "EGUSI"], 2),
        authProviders: ["local"],
        bio: faker.lorem.sentence(),
        avatarUrl: faker.image.avatar(),
        brandName: role === Role.VENDOR ? `${name} Foods` : undefined,
        brandLogo: role === Role.VENDOR ? faker.image.url() : undefined,
        isEmailVerified: true,
        isLive: role === Role.VENDOR,
        kycStatus:
          role === Role.VENDOR || role === Role.DELIVERY
            ? "VERIFIED"
            : undefined,
      });
    }
  };
  addUsers(Role.VENDOR, SEED_CONFIG.vendors, "vendor");
  addUsers(Role.CUSTOMER, SEED_CONFIG.customers, "customer");
  addUsers(Role.DELIVERY, SEED_CONFIG.deliveryPeople, "delivery");
  await createMany((data) => prisma.user.createMany({ data }), users);
  setProgress(10, `Created ${users.length} users`);

  const vendors = await prisma.user.findMany({ where: { roles: { has: Role.VENDOR } } });
  const customers = await prisma.user.findMany({
    where: { roles: { has: Role.CUSTOMER } },
  });
  const deliveryUsers = await prisma.user.findMany({
    where: { roles: { has: Role.DELIVERY }, deliveryPerson: null },
  });

  // P1 — Vendor/KYC lifecycle coverage (small, controlled; volumes preserved).
  // Bulk vendors above are VERIFIED+live. Flip 5 to cover the other valid
  // states. nin/ninData intentionally left NULL: the app stores raw Dojah
  // responses there, so we do not invent fake verification payloads.
  if (vendors.length >= 5) {
    const kycShowcase: { kycStatus: "PENDING" | "VERIFIED" | "REJECTED"; isLive: boolean }[] = [
      { kycStatus: "PENDING", isLive: false },
      { kycStatus: "PENDING", isLive: false },
      { kycStatus: "VERIFIED", isLive: false },
      { kycStatus: "VERIFIED", isLive: false },
      { kycStatus: "REJECTED", isLive: false },
    ];
    for (let i = 0; i < kycShowcase.length; i++) {
      const v = vendors[i];
      await prisma.user.update({
        where: { id: v.id },
        data: { kycStatus: kycShowcase[i].kycStatus, isLive: false },
      });
      v.kycStatus = kycShowcase[i].kycStatus as unknown as typeof v.kycStatus;
      v.isLive = false;
    }
  }
  const deliveryProfiles: Prisma.DeliveryPersonCreateManyInput[] =
    deliveryUsers.map((user) => ({
      userId: user.id,
      vehicleType: pick(["Bike", "Car", "Van"]),
      licensePlate: faker.vehicle.vrm(),
      status: DeliveryPersonStatus.ACTIVE,
      rating: faker.number.float({ min: 3, max: 5, fractionDigits: 1 }),
      totalDeliveries: faker.number.int({ min: 0, max: 50 }),
      isOnline: true,
      latitude: faker.number.float({ min: 6.3, max: 6.7, fractionDigits: 6 }),
      longitude: faker.number.float({ min: 3.2, max: 3.6, fractionDigits: 6 }),
      walletBalance: money(0, 10000),
      lastSeenAt: new Date(),
    }));
  await createMany(
    (data) => prisma.deliveryPerson.createMany({ data }),
    deliveryProfiles,
  );

  const addresses: Prisma.AddressCreateManyInput[] = [];
  for (const user of [...vendors, ...customers, ...deliveryUsers]) {
    const addressCount = randomRange(SEED_CONFIG.addressesPerUser);
    for (let index = 0; index < addressCount; index++)
      addresses.push({
        userId: user.id,
        label: index === 0 ? "Home" : `Address ${index + 1}`,
        street: faker.location.streetAddress(),
        city: "Lagos",
        state: "Lagos",
        country: "Nigeria",
        zipCode: faker.location.zipCode(),
        latitude: 6.5,
        longitude: 3.35,
        isDefault: index === 0,
      });
  }
  await createMany((data) => prisma.address.createMany({ data }), addresses);
  setProgress(
    20,
    `Created ${deliveryProfiles.length} delivery profiles and ${addresses.length} addresses`,
  );

  const products: Prisma.ProductCreateManyInput[] = [];
  for (const vendor of vendors)
    for (
      let index = 0;
      index < randomRange(SEED_CONFIG.productsPerVendor);
      index++
    ) {
      const name = `${pick(foodNames) || "Meal"} ${index + 1}`;
      products.push({
        id: faker.string.uuid(),
        name,
        description: `${
          [
            "A delicious",
            "A freshly prepared",
            "A flavorful",
            "A hearty",
            "A savory",
            "A rich and satisfying",
            "A perfectly seasoned",
            "A fresh and flavorful",
            "A tender and delicious",
            "An aromatic and flavorful",
          ][Math.floor(Math.random() * 10)]
        } ${name.toLowerCase()} prepared with care by ${vendor.brandName || vendor.name}.`,
        price: money(),
        dishTypeId: classifyDishType(name),
        archived: false,
        vendorId: vendor.id,
        images: randomImages(),
        video: randomVideos(),
        totalViews: faker.number.int({ min: 0, max: 1000 }),
        isNew: true,
      });
    }
  await createMany((data) => prisma.product.createMany({ data }), products);
  const savedProducts = await prisma.product.findMany({
    where: {
      id: {
        in: products.flatMap((product) => (product.id ? [product.id] : [])),
      },
    },
  });

  // P1 — Product state coverage (small, controlled). Bulk products above are
  // non-archived / untracked / isNew=true. Flip a handful to cover the other
  // valid states. In-memory copies are patched too so later cart/order
  // selection sees the same values as the DB.
  if (savedProducts.length >= 15) {
    const archivedIds = [savedProducts[0].id, savedProducts[1].id];
    await prisma.product.updateMany({
      where: { id: { in: archivedIds } },
      data: { archived: true },
    });
    for (const p of savedProducts)
      if (archivedIds.includes(p.id)) p.archived = true;

    await prisma.product.update({
      where: { id: savedProducts[2].id },
      data: { trackInventory: true, stock: 25 },
    });
    savedProducts[2].trackInventory = true;
    savedProducts[2].stock = 25;

    await prisma.product.update({
      where: { id: savedProducts[3].id },
      data: { trackInventory: true, stock: 12 },
    });
    savedProducts[3].trackInventory = true;
    savedProducts[3].stock = 12;

    await prisma.product.update({
      where: { id: savedProducts[4].id },
      data: { trackInventory: true, stock: 0 },
    });
    savedProducts[4].trackInventory = true;
    savedProducts[4].stock = 0;

    const notNewIds = savedProducts.slice(5, 15).map((p) => p.id);
    await prisma.product.updateMany({
      where: { id: { in: notNewIds } },
      data: { isNew: false },
    });
    for (const p of savedProducts)
      if (notNewIds.includes(p.id)) p.isNew = false;
  }
  const options: Prisma.ProductOptionCreateManyInput[] = [];
  for (const product of savedProducts) {
    for (
      let index = 0;
      index < randomRange(SEED_CONFIG.optionsPerProduct);
      index++
    )
      options.push({
        productId: product.id,
        name: `Option ${index + 1}`,
        price: money(100, 1000),
      });
  }
  await createMany(
    (data) => prisma.productOption.createMany({ data }),
    options,
  );
  // P1 — a small number of disabled add-ons. Disabled options are rejected
  // at cart/checkout but preserved on historical orders via snapshots.
  const savedOptions = await prisma.productOption.findMany({
    where: { productId: { in: savedProducts.map((p) => p.id) } },
    select: { id: true },
  });
  const inactiveOptionIds = savedOptions
    .filter((_, i) => i % 25 === 0)
    .slice(0, 10)
    .map((o) => o.id);
  if (inactiveOptionIds.length) {
    await prisma.productOption.updateMany({
      where: { id: { in: inactiveOptionIds } },
      data: { isActive: false },
    });
  }
  setProgress(
    35,
    `Created ${savedProducts.length} products and ${options.length} options`,
  );

  // Canonical marketplace availability (see vendorAvailability.service.ts):
  // vendor.isLive AND !archived AND (untracked OR stock > 0).
  // NOTE on P0.4: the app intentionally supports MULTI-vendor carts —
  // cartSummary groups by vendor, checkout creates one order per vendor,
  // delivery fees are per-vendor (cartSummary.service.ts, cartController
  // checkoutCart, deliveryFee.service.ts). The stale `Cart` model comment
  // ("Ensure all items are from same vendor") is not enforced anywhere, so
  // carts below keep sampling across vendors, with totals derived from the
  // actual items (which is the real invariant).
  const vendorLiveById = new Map(vendors.map((v) => [v.id, v.isLive]));
  const orderableProducts = savedProducts.filter((product) =>
    isSeedProductOrderable(
      {
        archived: product.archived,
        trackInventory: product.trackInventory,
        stock: product.stock,
      },
      vendorLiveById.get(product.vendorId) ?? false,
    ),
  );
  const liveProducts = orderableProducts;

  // P0.5 — product reviews are seeded AFTER orders (see below) so that
  // verifiedPurchase=true is only set when the reviewer really bought the
  // product. Vendor reviews have no purchase requirement.
  const vendorReviews: Prisma.VendorReviewCreateManyInput[] = [];
  for (const vendor of vendors)
    for (
      let index = 0;
      index < randomRange(SEED_CONFIG.vendorReviewsPerVendor);
      index++
    ) {
      const customer = pick(customers);
      // P1 — realistic spread: include 1-2 star ratings, not just 3-5.
      if (customer)
        vendorReviews.push({
          vendorId: vendor.id,
          customerId: customer.id,
          rating: faker.number.int({ min: 1, max: 5 }),
          comment: faker.lorem.sentence(),
        });
    }
  await createMany(
    (data) => prisma.vendorReview.createMany({ data }),
    vendorReviews,
  );

  const carts: Prisma.CartCreateManyInput[] = [];
  for (let index = 0; index < randomRange(SEED_CONFIG.carts); index++) {
    const customer = pick(customers);
    if (customer)
      carts.push({ customerId: customer.id, basePrice: 0, totalPrice: 0 });
  }
  await createMany((data) => prisma.cart.createMany({ data }), carts);
  const savedCarts = await prisma.cart.findMany({
    orderBy: { createdAt: "desc" },
    take: carts.length,
  });
  for (const cart of savedCarts) {
    const cartProducts = take(
      liveProducts,
      randomRange(SEED_CONFIG.cartItemsPerCart),
    );
    let total = 0;
    const items: Prisma.CartItemCreateManyInput[] = cartProducts.map(
      (product) => {
        const quantity = faker.number.int({ min: 1, max: 3 });
        const subtotal = round2(product.price * quantity);
        total = round2(total + subtotal);
        return {
          cartId: cart.id,
          productId: product.id,
          quantity,
          unitPrice: product.price,
          subtotal,
          specialRequest: null,
        };
      },
    );
    await createMany((data) => prisma.cartItem.createMany({ data }), items);
    await prisma.cart.update({
      where: { id: cart.id },
      data: { basePrice: total, totalPrice: total },
    });
  }
  setProgress(50, `Created ${savedCarts.length} carts`);

  const customerAddresses = await prisma.address.findMany({
    where: { userId: { in: customers.map((customer) => customer.id) } },
  });
  // P0.1/P0.2/P0.3 — single-scenario order generation.
  // The SAME chosen products/quantities feed Order.basePrice/totalPrice,
  // OrderItems, and Payments; the SAME paymentStartedAt/paidAt feed
  // Order.paidAt and Payment.completedAt; OrderItem timestamps derive from
  // the order timeline (never wall-clock now() for historical orders).
  const liveVendors = vendors.filter((v) => v.isLive);
  const orderVendorPool = liveVendors.length ? liveVendors : vendors;
  type BulkScenario = {
    orderId: string;
    customerId: string;
    vendorId: string;
    addressId?: string;
    orderDate: Date;
    paymentStartedAt: Date;
    paidAt: Date | null;
    isFutureOrder: boolean;
    items: { productId: string; quantity: number; unitPrice: number; subtotal: number }[];
    basePrice: number;
    totalPrice: number;
  };
  const bulkScenarios: BulkScenario[] = [];
  const orderCount = randomRange(SEED_CONFIG.orders);
  for (let index = 0; index < orderCount; index++) {
    const customer = pick(customers);
    const vendor = pick(orderVendorPool);
    if (!customer || !vendor) break;
    const vendorProducts = orderableProducts.filter(
      (product) => product.vendorId === vendor.id,
    );
    if (!vendorProducts.length) continue;
    const chosen = take(
      vendorProducts,
      randomRange(SEED_CONFIG.orderItemsPerOrder),
    );
    if (!chosen.length) continue;
    const items = chosen.map((product) => {
      const quantity = faker.number.int({ min: 1, max: 3 });
      const unitPrice = product.price;
      return {
        productId: product.id,
        quantity,
        unitPrice,
        subtotal: round2(unitPrice * quantity),
      };
    });
    const basePrice = round2(items.reduce((sum, i) => sum + i.subtotal, 0));
    const orderDate = randomSeedDate();
    const orderId = faker.string.uuid();
    const paymentStartedAt = addMilliseconds(
      orderDate,
      faker.number.int({ min: 1_000, max: 30_000 }),
    );
    const isFutureOrder = orderDate.getTime() > Date.now();
    const paidAt = isFutureOrder
      ? null
      : addMilliseconds(
          paymentStartedAt,
          faker.number.int({ min: 1_000, max: 60_000 }),
        );
    const address = pick(
      customerAddresses.filter((item) => item.userId === customer.id),
    );
    bulkScenarios.push({
      orderId,
      customerId: customer.id,
      vendorId: vendor.id,
      addressId: address?.id,
      orderDate,
      paymentStartedAt,
      paidAt,
      isFutureOrder,
      items,
      basePrice,
      totalPrice: round2(basePrice + 250 + 500),
    });
  }
  const orders: Prisma.OrderCreateManyInput[] = bulkScenarios.map((s) => ({
    id: s.orderId,
    customerId: s.customerId,
    vendorId: s.vendorId,
    addressId: s.addressId,
    basePrice: s.basePrice,
    extraCharge: 250,
    deliveryFee: 500,
    totalPrice: s.totalPrice,
    customerApproval: true,
    status: s.isFutureOrder ? OrderStatus.PENDING : OrderStatus.COMPLETED,
    paymentStatus: s.isFutureOrder ? PaymentStatus.PENDING : PaymentStatus.SUCCESS,
    createdAt: s.orderDate,
    updatedAt: s.orderDate,
    paidAt: s.paidAt ?? undefined,
    paymentStartedAt: s.paymentStartedAt,
    protectedUntil: addMilliseconds(s.orderDate, 15 * 60000),
    paymentGraceMinutes: 15,
  }));
  await createMany((data) => prisma.order.createMany({ data }), orders);
  const savedOrders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: orders.length,
  });
  const scenarioByOrderId = new Map(bulkScenarios.map((s) => [s.orderId, s]));
  const orderItems: Prisma.OrderItemCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = [];
  for (const s of bulkScenarios) {
    for (const item of s.items)
      orderItems.push({
        orderId: s.orderId,
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
        createdAt: s.orderDate,
        updatedAt: s.orderDate,
      });
    payments.push({
      userId: s.customerId,
      orderId: s.orderId,
      amount: Math.round(s.totalPrice * 100),
      reference: `SEED-${faker.string.alphanumeric(16).toUpperCase()}`,
      status: s.isFutureOrder ? PaymentStatus.PENDING : PaymentStatus.SUCCESS,
      startedAt: s.paymentStartedAt,
      completedAt: s.paidAt,
      expiresAt: addMilliseconds(s.orderDate, DAY_MS),
      channel: "card",
      ipAddress: "127.0.0.1",
      userAgent: "seed-script",
      createdAt: s.paymentStartedAt,
      updatedAt: s.paidAt ?? s.paymentStartedAt,
    });
  }
  await createMany((data) => prisma.orderItem.createMany({ data }), orderItems);
  await createMany((data) => prisma.payment.createMany({ data }), payments);
  const orderDates = new Map(bulkScenarios.map((s) => [s.orderId, s.orderDate]));
  void scenarioByOrderId;
  setProgress(
    65,
    `Created ${savedOrders.length} orders, ${orderItems.length} order items and ${payments.length} payments`,
  );

  // P0.5 — verified reviews ONLY from real purchases.
  // Build customer->products and product->customers maps from the seeded
  // OrderItems (which are now guaranteed consistent with Order headers).
  const purchasedProductsByCustomer = new Map<string, Set<string>>();
  const purchasingCustomersByProduct = new Map<string, string[]>();
  {
    const orderCustomerById = new Map(savedOrders.map((o) => [o.id, o.customerId]));
    for (const item of orderItems) {
      const customerId = orderCustomerById.get(item.orderId);
      if (!customerId) continue;
      let set = purchasedProductsByCustomer.get(customerId);
      if (!set) {
        set = new Set();
        purchasedProductsByCustomer.set(customerId, set);
      }
      set.add(item.productId);
      const list = purchasingCustomersByProduct.get(item.productId) ?? [];
      if (!list.includes(customerId)) {
        list.push(customerId);
        purchasingCustomersByProduct.set(item.productId, list);
      }
    }
  }
  const productReviews: Prisma.ProductReviewCreateManyInput[] = [];
  for (const product of savedProducts) {
    const buyers = purchasingCustomersByProduct.get(product.id) ?? [];
    for (let index = 0; index < randomRange(SEED_CONFIG.productReviewsPerProduct); index++) {
      // ~70% of reviews come from real buyers (verified), the rest are
      // explicitly non-verified browse reviews. Ratings now span 1-5 (P1).
      const useVerified = buyers.length > 0 && faker.datatype.boolean({ probability: 0.7 });
      if (useVerified) {
        const customerId = faker.helpers.arrayElement(buyers);
        productReviews.push({
          productId: product.id,
          customerId,
          rating: faker.number.int({ min: 1, max: 5 }),
          comment: faker.lorem.sentence(),
          images: [],
          verifiedPurchase: true,
        });
      } else {
        const customer = pick(customers);
        if (!customer) continue;
        const actuallyBought = purchasedProductsByCustomer.get(customer.id)?.has(product.id) ?? false;
        productReviews.push({
          productId: product.id,
          customerId: customer.id,
          rating: faker.number.int({ min: 1, max: 5 }),
          comment: faker.lorem.sentence(),
          images: [],
          verifiedPurchase: actuallyBought,
        });
      }
    }
  }
  await createMany(
    (data) => prisma.productReview.createMany({ data }),
    productReviews,
  );

  // P0.7 — denormalized product aggregates, canonical logic mirrored from
  // src/jobs/workers jobs/updatePopularityScore.ts (Phase 1 + log-scaled
  // Phase 2). Review aggregates come from the just-seeded reviews,
  // order counts from the just-seeded order items.
  {
    const ratingSum = new Map<string, number>();
    const ratingCount = new Map<string, number>();
    for (const r of productReviews) {
      ratingSum.set(r.productId, (ratingSum.get(r.productId) ?? 0) + r.rating);
      ratingCount.set(r.productId, (ratingCount.get(r.productId) ?? 0) + 1);
    }
    const orderCountByProduct = new Map<string, number>();
    for (const item of orderItems)
      orderCountByProduct.set(item.productId, (orderCountByProduct.get(item.productId) ?? 0) + 1);
    const nowMs = Date.now();
    const scores = new Map<string, number>();
    let maxScore = 0;
    for (const p of savedProducts) {
      const count = ratingCount.get(p.id) ?? 0;
      const avg = count ? (ratingSum.get(p.id) ?? 0) / count : 0;
      const orderCount = orderCountByProduct.get(p.id) ?? 0;
      const totalViews = p.totalViews ?? 0;
      const createdMs = new Date(p.createdAt).getTime();
      const daysSinceCreation = Number.isFinite(createdMs) ? Math.max(0, (nowMs - createdMs) / DAY_MS) : 0;
      const score =
        totalViews * 0.1 + orderCount * 2 + avg * count * 5 + Math.max(0, 30 - daysSinceCreation);
      scores.set(p.id, score);
      if (score > maxScore) maxScore = score;
    }
    const denom = maxScore > 0 ? Math.log(maxScore + 1) : 0;
    for (const p of savedProducts) {
      const count = ratingCount.get(p.id) ?? 0;
      const avg = count ? (ratingSum.get(p.id) ?? 0) / count : 0;
      const score = scores.get(p.id) ?? 0;
      const percent =
        maxScore > 0 && denom > 0
          ? Math.min(99.9, Number(((Math.log(score + 1) / denom) * 100).toFixed(2)))
          : 0;
      await prisma.product.update({
        where: { id: p.id },
        data: {
          averageRating: round2(avg),
          reviewCount: count,
          popularityScore: round2(score),
          popularityPercent: percent,
          popularityUpdatedAt: new Date(),
        },
      });
      p.averageRating = round2(avg);
      p.reviewCount = count;
      p.popularityScore = round2(score);
      p.popularityPercent = percent;
    }
  }

  const deliveryProfilesSaved = await prisma.deliveryPerson.findMany();
  const assignments: Prisma.DeliveryAssignmentCreateManyInput[] = [];
  for (const order of take(
    savedOrders.filter((item) => item.status === OrderStatus.COMPLETED),
    randomRange(SEED_CONFIG.assignments),
  )) {
    const deliveryPerson = pick(deliveryProfilesSaved);
    if (deliveryPerson) {
      // Coherent timeline: assigned -> accepted -> started -> completed.
      const acceptedAt = addMilliseconds(order.createdAt, faker.number.int({ min: 30_000, max: 120_000 }));
      const startedAt = addMilliseconds(acceptedAt, faker.number.int({ min: 120_000, max: 300_000 }));
      const completedAt = addMilliseconds(startedAt, faker.number.int({ min: 600_000, max: 1_800_000 }));
      assignments.push({
        orderId: order.id,
        deliveryPersonId: deliveryPerson.id,
        status: DeliveryStatus.DELIVERED,
        assignedAt: order.createdAt,
        acceptedAt,
        startedAt,
        completedAt,
      });
    }
  }
  await createMany(
    (data) => prisma.deliveryAssignment.createMany({ data }),
    assignments,
  );

  // P1 — small coherent showcase for missing Order/Payment/Delivery states.
  // Each scenario reuses the single-scenario pattern (header/items/payment
  // share one timeline). Volumes stay small (~14 orders) vs bulk 5-200.
  const showcaseOrderIds: string[] = [];
  {
    type ShowcaseSpec = {
      key: string;
      orderStatus: OrderStatus;
      paymentStatus: PaymentStatus;
      paymentState: "pending" | "initiated" | "success" | "failed" | "expired" | "late" | "mismatch" | "refunded";
      cancellationReason?: string;
      assign?: { status: DeliveryStatus; extra?: "declined-history" | "cancelled-history" };
    };
    const specs: ShowcaseSpec[] = [
      { key: "waiting-vendor", orderStatus: OrderStatus.WAITING_VENDOR_CONFIRMATION, paymentStatus: PaymentStatus.PENDING, paymentState: "pending" },
      { key: "waiting-customer", orderStatus: OrderStatus.WAITING_CUSTOMER_APPROVAL, paymentStatus: PaymentStatus.PENDING, paymentState: "pending" },
      { key: "awaiting-payment", orderStatus: OrderStatus.AWAITING_PAYMENT, paymentStatus: PaymentStatus.INITIATED, paymentState: "initiated" },
      { key: "payment-confirmed", orderStatus: OrderStatus.PAYMENT_CONFIRMED, paymentStatus: PaymentStatus.SUCCESS, paymentState: "success", assign: { status: DeliveryStatus.PICKED_UP } },
      { key: "cooking", orderStatus: OrderStatus.COOKING, paymentStatus: PaymentStatus.SUCCESS, paymentState: "success", assign: { status: DeliveryStatus.ASSIGNED, extra: "cancelled-history" } },
      { key: "ready-pickup", orderStatus: OrderStatus.READY_FOR_PICKUP, paymentStatus: PaymentStatus.SUCCESS, paymentState: "success", assign: { status: DeliveryStatus.ACCEPTED } },
      { key: "out-delivery", orderStatus: OrderStatus.OUT_FOR_DELIVERY, paymentStatus: PaymentStatus.SUCCESS, paymentState: "success", assign: { status: DeliveryStatus.EN_ROUTE, extra: "declined-history" } },
      { key: "cancelled", orderStatus: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.FAILED, paymentState: "failed", cancellationReason: "USER_CANCELLED" },
      { key: "failed-delivery", orderStatus: OrderStatus.FAILED_DELIVERY, paymentStatus: PaymentStatus.SUCCESS, paymentState: "success", assign: { status: DeliveryStatus.FAILED } },
      { key: "payment-expired", orderStatus: OrderStatus.PAYMENT_EXPIRED, paymentStatus: PaymentStatus.EXPIRED, paymentState: "expired", cancellationReason: "PAYMENT_EXPIRED" },
      { key: "cancelled-unpaid", orderStatus: OrderStatus.CANCELLED_UNPAID, paymentStatus: PaymentStatus.EXPIRED, paymentState: "expired", cancellationReason: "USER_CANCELLED" },
      { key: "late-payment", orderStatus: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.LATE_PAYMENT, paymentState: "late" },
      { key: "amount-mismatch", orderStatus: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.AMOUNT_MISMATCH, paymentState: "mismatch" },
      { key: "refunded", orderStatus: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.REFUNDED, paymentState: "refunded", assign: { status: DeliveryStatus.RETURNED } },
    ];
    const showcaseOrders: Prisma.OrderCreateManyInput[] = [];
    const showcaseItems: Prisma.OrderItemCreateManyInput[] = [];
    const showcasePayments: Prisma.PaymentCreateManyInput[] = [];
    const showcaseAssignments: Prisma.DeliveryAssignmentCreateManyInput[] = [];
    for (const spec of specs) {
      const customer = pick(customers);
      const vendor = pick(orderVendorPool);
      if (!customer || !vendor) continue;
      const vendorProducts = orderableProducts.filter((p) => p.vendorId === vendor.id);
      if (!vendorProducts.length) continue;
      const chosen = take(vendorProducts, faker.number.int({ min: 1, max: 2 }));
      if (!chosen.length) continue;
      const items = chosen.map((product) => {
        const quantity = faker.number.int({ min: 1, max: 2 });
        return {
          productId: product.id,
          quantity,
          unitPrice: product.price,
          subtotal: round2(product.price * quantity),
        };
      });
      const basePrice = round2(items.reduce((s, i) => s + i.subtotal, 0));
      const totalPrice = round2(basePrice + 250 + 500);
      const orderDate = randomSeedDate();
      const paymentStartedAt = addMilliseconds(orderDate, faker.number.int({ min: 1_000, max: 30_000 }));
      const protectedUntil = addMilliseconds(orderDate, 15 * 60000);
      let completedAt: Date | null = null;
      let expiresAt = addMilliseconds(orderDate, DAY_MS);
      let amount = Math.round(totalPrice * 100);
      let refundedAmount = 0;
      if (spec.paymentState === "success" || spec.paymentState === "late" || spec.paymentState === "refunded") {
        completedAt =
          spec.paymentState === "late"
            ? addMilliseconds(protectedUntil, 5 * 60000 + faker.number.int({ min: 0, max: 300_000 }))
            : addMilliseconds(paymentStartedAt, faker.number.int({ min: 1_000, max: 60_000 }));
        if (spec.paymentState === "refunded") refundedAmount = amount;
      } else if (spec.paymentState === "mismatch") {
        completedAt = addMilliseconds(paymentStartedAt, faker.number.int({ min: 1_000, max: 60_000 }));
        amount = Math.round(totalPrice * 100) + 1000; // intentional +₦10 mismatch case
      } else if (spec.paymentState === "initiated") {
        expiresAt = addMilliseconds(paymentStartedAt, 30 * 60000);
      }
      const orderId = faker.string.uuid();
      const address = pick(customerAddresses.filter((a) => a.userId === customer.id));
      const needsCancelStamp =
        spec.orderStatus === OrderStatus.CANCELLED ||
        spec.orderStatus === OrderStatus.CANCELLED_UNPAID ||
        spec.orderStatus === OrderStatus.PAYMENT_EXPIRED;
      showcaseOrders.push({
        id: orderId,
        customerId: customer.id,
        vendorId: vendor.id,
        addressId: address?.id,
        basePrice,
        extraCharge: 250,
        deliveryFee: 500,
        totalPrice,
        customerApproval:
          spec.orderStatus === OrderStatus.WAITING_CUSTOMER_APPROVAL ? false : true,
        status: spec.orderStatus,
        paymentStatus: spec.paymentStatus,
        createdAt: orderDate,
        updatedAt: completedAt ?? orderDate,
        paidAt: completedAt ?? undefined,
        paymentStartedAt,
        protectedUntil,
        paymentGraceMinutes: 15,
        cancelledAt: needsCancelStamp ? (completedAt ?? addMilliseconds(orderDate, 20 * 60000)) : undefined,
        cancellationReason: spec.cancellationReason,
      });
      showcaseOrderIds.push(orderId);
      orderDates.set(orderId, orderDate);
      for (const item of items)
        showcaseItems.push({
          orderId,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          subtotal: item.subtotal,
          createdAt: orderDate,
          updatedAt: orderDate,
        });
      showcasePayments.push({
        userId: customer.id,
        orderId,
        amount,
        reference: `SEED-${spec.key.toUpperCase()}-${faker.string.alphanumeric(8).toUpperCase()}`,
        status: spec.paymentStatus,
        startedAt: paymentStartedAt,
        completedAt,
        expiresAt,
        channel: "card",
        ipAddress: "127.0.0.1",
        userAgent: "seed-script",
        refundedAmount,
        createdAt: paymentStartedAt,
        updatedAt: completedAt ?? paymentStartedAt,
      });
      const driver = pick(deliveryProfilesSaved);
      if (driver && spec.assign) {
        const assignedAt = addMilliseconds(orderDate, faker.number.int({ min: 60_000, max: 300_000 }));
        const buildTimeline = (status: DeliveryStatus) => {
          if (status === DeliveryStatus.ASSIGNED) return { assignedAt } as const;
          if (status === DeliveryStatus.ACCEPTED)
            return {
              assignedAt,
              acceptedAt: addMilliseconds(assignedAt, 60_000),
            } as const;
          if (status === DeliveryStatus.PICKED_UP)
            return {
              assignedAt,
              acceptedAt: addMilliseconds(assignedAt, 60_000),
              startedAt: addMilliseconds(assignedAt, 180_000),
            } as const;
          const acceptedAt = addMilliseconds(assignedAt, 60_000);
          const startedAt = addMilliseconds(acceptedAt, 180_000);
          const completedAt2 = addMilliseconds(startedAt, 900_000);
          if (status === DeliveryStatus.DECLINED)
            return {
              assignedAt,
              declinedAt: addMilliseconds(assignedAt, 45_000),
            } as const;
          if (status === DeliveryStatus.CANCELLED)
            return {
              assignedAt,
              declinedAt: addMilliseconds(assignedAt, 120_000),
            } as const;
          return { assignedAt, acceptedAt, startedAt, completedAt: completedAt2 } as const;
        };
        // History case: a first driver declined/cancelled, then reassigned.
        if (spec.assign.extra === "declined-history") {
          const first = pick(deliveryProfilesSaved) ?? driver;
          showcaseAssignments.push({
            orderId,
            deliveryPersonId: first.id,
            status: DeliveryStatus.DECLINED,
            ...buildTimeline(DeliveryStatus.DECLINED),
          });
        }
        if (spec.assign.extra === "cancelled-history") {
          const first = pick(deliveryProfilesSaved) ?? driver;
          showcaseAssignments.push({
            orderId,
            deliveryPersonId: first.id,
            status: DeliveryStatus.CANCELLED,
            ...buildTimeline(DeliveryStatus.CANCELLED),
          });
        }
        showcaseAssignments.push({
          orderId,
          deliveryPersonId: driver.id,
          status: spec.assign.status,
          ...buildTimeline(spec.assign.status),
        });
      }
    }
    await createMany((data) => prisma.order.createMany({ data }), showcaseOrders);
    await createMany((data) => prisma.orderItem.createMany({ data }), showcaseItems);
    await createMany((data) => prisma.payment.createMany({ data }), showcasePayments);
    await createMany(
      (data) => prisma.deliveryAssignment.createMany({ data }),
      showcaseAssignments,
    );
    // Make late/mismatch/refunded showcase payments discoverable for the
    // second audit without rescanning the whole table.
    console.log(
      `Showcase: ${showcaseOrders.length} orders, ${showcasePayments.length} payments, ${showcaseAssignments.length} assignments`,
    );
  }

  const notifications: Prisma.NotificationCreateManyInput[] = [];
  for (let index = 0; index < randomRange(SEED_CONFIG.notifications); index++) {
    const customer = pick(customers);
    if (customer)
      notifications.push({
        userId: customer.id,
        title: "Seed notification",
        message: faker.lorem.sentence(),
        type: "GENERAL",
        metadata: {},
      });
  }
  await createMany(
    (data) => prisma.notification.createMany({ data }),
    notifications,
  );
  const followers: Prisma.VendorFollowerCreateManyInput[] = [];
  for (let index = 0; index < randomRange(SEED_CONFIG.followers); index++) {
    const vendor = pick(vendors);
    const customer = pick(customers);
    if (vendor && customer)
      followers.push({ vendorId: vendor.id, customerId: customer.id });
  }
  await createMany(
    (data) => prisma.vendorFollower.createMany({ data, skipDuplicates: true }),
    followers,
  );

  const promotions: Prisma.PromotionCreateManyInput[] = [];
  for (const vendor of vendors) {
    const promotionCount = randomRange(SEED_CONFIG.promotions);
    for (let index = 0; index < promotionCount; index++)
      promotions.push({
        vendorId: vendor.id,
        code: `SEED_${vendor.id.slice(0, 6)}_${index + 1}_${faker.string.alphanumeric(5).toUpperCase()}`,
        name: `Seed promotion ${index + 1}`,
        description: "Promotion created by the development seeder",
        type: "PERCENTAGE",
        value: 10,
        maxUsesPerUser: 1,
      });
  }
  await createMany((data) => prisma.promotion.createMany({ data }), promotions);

  // P1 — representative promotion types/scopes + real usages.
  // Uses prisma.promotion.create (not createMany) where the M-N `products`
  // relation is needed. Usages reference real users/orders and bump
  // usedCount so counts stay truthful.
  const showcasePromoIds: string[] = [];
  {
    const promoVendor = pick(liveVendors);
    const scopedProduct = pick(orderableProducts);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const monthOut = new Date(now.getTime() + 30 * DAY_MS);
    const yesterday = new Date(now.getTime() - DAY_MS);
    if (promoVendor) {
      const fixed = await prisma.promotion.create({
        data: {
          vendorId: promoVendor.id,
          code: `SEED_FIXED_${faker.string.alphanumeric(5).toUpperCase()}`,
          name: "Seed fixed-amount promo",
          description: "₦500 off vendor-wide (seed showcase)",
          type: DiscountType.FIXED,
          value: 500,
          scope: PromotionScope.VENDOR_WIDE,
          isActive: true,
          startsAt: weekAgo,
          expiresAt: monthOut,
          usageLimit: 100,
          maxUsesPerUser: 2,
          minOrderAmount: 2000,
        },
      });
      showcasePromoIds.push(fixed.id);
      const auto = await prisma.promotion.create({
        data: {
          vendorId: promoVendor.id,
          code: null,
          name: "Seed automatic 15% off",
          description: "Automatic vendor discount, no code required",
          type: DiscountType.PERCENTAGE,
          value: 15,
          maxDiscount: 1500,
          scope: PromotionScope.VENDOR_WIDE,
          isActive: true,
          startsAt: weekAgo,
          expiresAt: monthOut,
          maxUsesPerUser: 1,
        },
      });
      showcasePromoIds.push(auto.id);
      if (scopedProduct) {
        // NOTE: schema.prisma declares the Promotion<->Product link as an
        // implicit M-N (client expects `_PromotionProducts`) but migration
        // 20260906000000_promotion_scope created an explicit
        // `PromotionProducts(promotionId, productId)` table. prisma schema /
        // migrations must NOT be changed in this pass, so the link is
        // inserted with raw SQL into the real table instead of
        // `products:{connect}` (which would require `_PromotionProducts`).
        const single = await prisma.promotion.create({
          data: {
            vendorId: scopedProduct.vendorId,
            code: `SEED_SINGLE_${faker.string.alphanumeric(5).toUpperCase()}`,
            name: "Seed single-product promo",
            description: "25% off one dish (seed showcase)",
            type: DiscountType.PERCENTAGE,
            value: 25,
            maxDiscount: 1000,
            scope: PromotionScope.SINGLE_PRODUCT,
            isActive: true,
            startsAt: weekAgo,
            expiresAt: monthOut,
            maxUsesPerUser: 1,
          },
        });
        await prisma.$executeRaw`
          INSERT INTO "PromotionProducts" ("promotionId", "productId")
          VALUES (${single.id}, ${scopedProduct.id})
          ON CONFLICT DO NOTHING
        `;
        showcasePromoIds.push(single.id);
      }
      // Expired-but-active-flag promo: getActivePromotions filters by
      // expiresAt, so this exercises the expired path without inventing a
      // new status.
      const expired = await prisma.promotion.create({
        data: {
          vendorId: null,
          code: `SEED_DLV_${faker.string.alphanumeric(5).toUpperCase()}`,
          name: "Seed expired delivery promo",
          description: "Platform delivery promo, now expired",
          type: DiscountType.DELIVERY,
          value: 100,
          scope: PromotionScope.VENDOR_WIDE,
          isActive: true,
          startsAt: weekAgo,
          expiresAt: yesterday,
          maxUsesPerUser: 1,
        },
      });
      showcasePromoIds.push(expired.id);

      // Usages tied to real COMPLETED bulk orders of the same vendor.
      const vendorCompletedOrders = savedOrders.filter(
        (o) => o.vendorId === promoVendor.id && o.status === OrderStatus.COMPLETED,
      );
      const usageTargets = vendorCompletedOrders.slice(0, 2);
      const fixedPromo = await prisma.promotion.findFirst({
        where: { id: { in: showcasePromoIds }, type: DiscountType.FIXED },
      });
      const singlePromo = await prisma.promotion.findFirst({
        where: { id: { in: showcasePromoIds }, scope: PromotionScope.SINGLE_PRODUCT },
      });
      const usageRows: Prisma.PromotionUsageCreateManyInput[] = [];
      if (fixedPromo && usageTargets[0])
        usageRows.push({
          promotionId: fixedPromo.id,
          userId: usageTargets[0].customerId,
          orderIds: [usageTargets[0].id],
          promoCode: fixedPromo.code!,
          discount: 500,
        });
      if (singlePromo && usageTargets[1])
        usageRows.push({
          promotionId: singlePromo.id,
          userId: usageTargets[1].customerId,
          orderIds: [usageTargets[1].id],
          promoCode: singlePromo.code!,
          discount: 250,
        });
      if (usageRows.length) {
        await createMany((data) => prisma.promotionUsage.createMany({ data }), usageRows);
        for (const row of usageRows)
          await prisma.promotion.update({
            where: { id: row.promotionId },
            data: { usedCount: { increment: 1 } },
          });
      }
    }
  }
  const supportTickets: Prisma.VendorSupportTicketCreateManyInput[] = [];
  for (const vendor of vendors)
    for (
      let index = 0;
      index < randomRange(SEED_CONFIG.supportTickets);
      index++
    )
      supportTickets.push({
        vendorId: vendor.id,
        category: "GENERAL",
        subject: "Seed support ticket",
        description: faker.lorem.sentence(),
        status: SupportTicketStatus.OPEN,
      });
  await createMany(
    (data) => prisma.vendorSupportTicket.createMany({ data }),
    supportTickets,
  );
  const customerTickets: Prisma.CustomerSupportTicketCreateManyInput[] = [];
  for (const customer of customers)
    for (
      let index = 0;
      index < randomRange(SEED_CONFIG.supportTickets);
      index++
    )
      customerTickets.push({
        customerId: customer.id,
        category: "GENERAL",
        subject: "Seed customer ticket",
        description: faker.lorem.sentence(),
        status: SupportTicketStatus.OPEN,
      });
  await createMany(
    (data) => prisma.customerSupportTicket.createMany({ data }),
    customerTickets,
  );

  const specialRequests: Prisma.SpecialOrderRequestCreateManyInput[] = [];
  for (
    let index = 0;
    index < randomRange(SEED_CONFIG.specialRequests);
    index++
  ) {
    const customer = pick(customers);
    const product = pick(savedProducts);
    if (customer && product)
      specialRequests.push({
        customerId: customer.id,
        vendorId: product.vendorId,
        productId: product.id,
        quantity: 1,
        message: "Please prepare this with extra care.",
        status: SpecialOrderRequestStatus.PENDING,
      });
  }
  await createMany(
    (data) => prisma.specialOrderRequest.createMany({ data }),
    specialRequests,
  );
  const savedRequests = await prisma.specialOrderRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: specialRequests.length,
  });
  const specialOffers: Prisma.SpecialOrderOfferCreateManyInput[] =
    savedRequests.map((request) => ({
      requestId: request.id,
      vendorId: request.vendorId!,
      price: money(),
      message: "We can prepare this for you.",
      status: SpecialOrderOfferStatus.PENDING,
    }));
  await createMany(
    (data) => prisma.specialOrderOffer.createMany({ data }),
    specialOffers,
  );

  // P1 — one coherent special-order journey: PENDING request -> ACCEPTED
  // offer (+ REJECTED sibling) -> real Order via specialOrderOfferId.
  // Mirrors orderController.acceptSpecialOrderOffer (AWAITING_PAYMENT order,
  // single line, basePrice=offer.price). Quantity is 1 so
  // subtotal (=offer.price) stays consistent with the app's own math.
  {
    const customer = pick(customers);
    const product = pick(orderableProducts);
    if (customer && product) {
      const address = pick(customerAddresses.filter((a) => a.userId === customer.id));
      const request = await prisma.specialOrderRequest.create({
        data: {
          customerId: customer.id,
          vendorId: product.vendorId,
          productId: product.id,
          quantity: 1,
          message: "Seed showcase: jollof for 20 guests, please quote.",
          status: SpecialOrderRequestStatus.ACCEPTED,
        },
      });
      const acceptedOffer = await prisma.specialOrderOffer.create({
        data: {
          requestId: request.id,
          vendorId: product.vendorId,
          price: round2(product.price * 18),
          message: "We can cater this for you.",
          status: SpecialOrderOfferStatus.ACCEPTED,
        },
      });
      await prisma.specialOrderOffer.create({
        data: {
          requestId: request.id,
          vendorId: product.vendorId,
          price: round2(product.price * 22),
          message: "Alternative quote.",
          status: SpecialOrderOfferStatus.REJECTED,
        },
      });
      await prisma.specialOrderRequest.update({
        where: { id: request.id },
        data: { status: SpecialOrderRequestStatus.ACCEPTED },
      });
      const orderDate = randomSeedDate();
      const offerOrderId = faker.string.uuid();
      await prisma.order.create({
        data: {
          id: offerOrderId,
          customerId: customer.id,
          vendorId: product.vendorId,
          addressId: address?.id,
          basePrice: acceptedOffer.price,
          extraCharge: 250,
          deliveryFee: 500,
          totalPrice: round2(acceptedOffer.price + 750),
          status: OrderStatus.AWAITING_PAYMENT,
          paymentStatus: PaymentStatus.PENDING,
          specialOrderOfferId: acceptedOffer.id,
          createdAt: orderDate,
          updatedAt: orderDate,
          paymentStartedAt: addMilliseconds(orderDate, 5_000),
          protectedUntil: addMilliseconds(orderDate, 15 * 60000),
          paymentGraceMinutes: 15,
          items: {
            create: [
              {
                productId: product.id,
                quantity: 1,
                unitPrice: acceptedOffer.price,
                subtotal: acceptedOffer.price,
                createdAt: orderDate,
                updatedAt: orderDate,
              },
            ],
          },
        },
      });
      orderDates.set(offerOrderId, orderDate);
    }
  }

  // P0.6+P1 — connected referrals mirroring referralController:
  // referralCode on referrer (app format), referredByUserId on invitee,
  // ReferralReward.referrerId/referredId matching that edge, orderId (when
  // set) = the referred user's own COMPLETED order (first one, per
  // creditReferralRewardIfEligible). Small lifecycle sample: PENDING + one
  // PAID + one CANCELLED (admin-settled states).
  {
    const rewardCount = randomRange(SEED_CONFIG.referralRewards);
    const pairCount = Math.min(rewardCount + 2, Math.floor(customers.length / 2));
    const usedReferralCodes = new Set<string>();
    const pairs: { referrerId: string; referredId: string; orderId: string | null }[] = [];
    const completedOrderByCustomer = new Map<string, string>();
    for (const o of savedOrders)
      if (o.status === OrderStatus.COMPLETED && !completedOrderByCustomer.has(o.customerId))
        completedOrderByCustomer.set(o.customerId, o.id);
    for (const showcaseId of showcaseOrderIds) {
      // showcaseOrderIds are bulk-external; their customers are already in
      // completedOrderByCustomer if COMPLETED, so nothing extra needed here.
      void showcaseId;
    }
    for (let i = 0; i < pairCount; i++) {
      const referrer = customers[i * 2];
      const referred = customers[i * 2 + 1];
      if (!referrer || !referred || referrer.id === referred.id) continue;
      // Referrer code (unique, app format).
      let code = seedReferralCode(referrer.name);
      let guard = 0;
      while (usedReferralCodes.has(code) && guard++ < 5)
        code = seedReferralCode(`${referrer.name}${guard}`);
      usedReferralCodes.add(code);
      try {
        await prisma.user.update({ where: { id: referrer.id }, data: { referralCode: code } });
      } catch {
        continue; // collision with pre-existing data: skip this pair
      }
      await prisma.user.update({
        where: { id: referred.id },
        data: { referredByUserId: referrer.id },
      });
      // Only the first `rewardCount` pairs earn a reward row (volumes
      // preserved); extra pairs just exercise the referral edge.
      if (pairs.length < rewardCount) {
        pairs.push({
          referrerId: referrer.id,
          referredId: referred.id,
          orderId: completedOrderByCustomer.get(referred.id) ?? null,
        });
      }
    }
    const referralRewards: Prisma.ReferralRewardCreateManyInput[] = pairs.map((p, idx) => ({
      referrerId: p.referrerId,
      referredId: p.referredId,
      orderId: p.orderId,
      amount: 500,
      status:
        idx === 0 && p.orderId
          ? ReferralRewardStatus.PAID
          : idx === 1
            ? ReferralRewardStatus.CANCELLED
            : ReferralRewardStatus.PENDING,
    }));
    await createMany(
      (data) => prisma.referralReward.createMany({ data, skipDuplicates: true }),
      referralRewards,
    );
  }

  const activities: Prisma.ActivityCreateManyInput[] = savedOrders
    .slice(0, 10)
    .map((order) => ({
      orderId: order.id,
      vendorId: order.vendorId,
      customerId: order.customerId,
      type: ActivityType.ORDER_CREATED,
      title: "Order created",
      message: "Seed order created for development data.",
      meta: {},
    }));
  await createMany((data) => prisma.activity.createMany({ data }), activities);
  setProgress(
    85,
    `Created ${assignments.length} assignments, ${notifications.length} notifications and supporting data`,
  );

  if (SEED_CONFIG.clearRedis)
    console.warn(
      "SEED_CLEAR_REDIS is enabled, but Redis clearing is left to the application cache job.",
    );
  setProgress(100, "Seed completed");
}

if (require.main === module) {
  seedDatabase()
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

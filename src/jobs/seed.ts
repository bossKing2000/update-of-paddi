import {
  Prisma,
  PrismaClient,
  Role,
  Category,
  OrderStatus,
  PaymentStatus,
  DeliveryPersonStatus,
  DeliveryStatus,
  ProductScheduleType,
  SupportTicketStatus,
  SpecialOrderRequestStatus,
  SpecialOrderOfferStatus,
  ActivityType,
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
  liveProductPercentage: envRange(
    "SEED_LIVE_PERCENTAGE_MIN",
    "SEED_LIVE_PERCENTAGE_MAX",
    10,
    40,
  ),
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
        preferences: take(Object.values(Category), 2),
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
        timezone: role === Role.VENDOR ? "Africa/Lagos" : undefined,
      });
    }
  };
  addUsers(Role.VENDOR, SEED_CONFIG.vendors, "vendor");
  addUsers(Role.CUSTOMER, SEED_CONFIG.customers, "customer");
  addUsers(Role.DELIVERY, SEED_CONFIG.deliveryPeople, "delivery");
  await createMany((data) => prisma.user.createMany({ data }), users);
  setProgress(10, `Created ${users.length} users`);

  const vendors = await prisma.user.findMany({ where: { role: Role.VENDOR } });
  const customers = await prisma.user.findMany({
    where: { role: Role.CUSTOMER },
  });
  const deliveryUsers = await prisma.user.findMany({
    where: { role: Role.DELIVERY, deliveryPerson: null },
  });
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
  const liveProductPercentage = Math.min(
    randomRange(SEED_CONFIG.liveProductPercentage),
    100,
  );
  for (const vendor of vendors)
    for (
      let index = 0;
      index < randomRange(SEED_CONFIG.productsPerVendor);
      index++
    ) {
      const name = `${pick(foodNames) || "Meal"} ${index + 1}`;
      const productIsLive =
        faker.number.int({ min: 1, max: 100 }) <= liveProductPercentage;
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
        category: pick(Object.values(Category)) || Category.LUNCH,
        archived: false,
        vendorId: vendor.id,
        images: randomImages(),
        video: randomVideos(),
        isLive: productIsLive,
        liveUntil: productIsLive ? new Date(Date.now() + 30 * DAY_MS) : null,
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
  const options: Prisma.ProductOptionCreateManyInput[] = [];
  const schedules: Prisma.ProductScheduleCreateManyInput[] = [];
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
    schedules.push({
      productId: product.id,
      type: ProductScheduleType.ONE_TIME,
      enabled: true,
      goLiveAt: new Date(Date.now() - DAY_MS),
      takeDownAt: product.isLive
        ? new Date(Date.now() + 30 * DAY_MS)
        : new Date(Date.now() - DAY_MS),
      isLive: product.isLive,
      graceMinutes: 15,
    });
  }
  await createMany(
    (data) => prisma.productOption.createMany({ data }),
    options,
  );
  await createMany(
    (data) => prisma.productSchedule.createMany({ data, skipDuplicates: true }),
    schedules,
  );
  setProgress(
    35,
    `Created ${savedProducts.length} products, ${options.length} options and schedules`,
  );

  const liveProducts = savedProducts.filter((product) => product.isLive);

  const productReviews: Prisma.ProductReviewCreateManyInput[] = [];
  for (const product of savedProducts)
    for (
      let index = 0;
      index < randomRange(SEED_CONFIG.productReviewsPerProduct);
      index++
    ) {
      const customer = pick(customers);
      if (customer)
        productReviews.push({
          productId: product.id,
          customerId: customer.id,
          rating: faker.number.int({ min: 3, max: 5 }),
          comment: faker.lorem.sentence(),
          images: [],
          verifiedPurchase: true,
        });
    }
  await createMany(
    (data) => prisma.productReview.createMany({ data }),
    productReviews,
  );
  const vendorReviews: Prisma.VendorReviewCreateManyInput[] = [];
  for (const vendor of vendors)
    for (
      let index = 0;
      index < randomRange(SEED_CONFIG.vendorReviewsPerVendor);
      index++
    ) {
      const customer = pick(customers);
      if (customer)
        vendorReviews.push({
          vendorId: vendor.id,
          customerId: customer.id,
          rating: faker.number.int({ min: 3, max: 5 }),
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
        const subtotal = product.price * quantity;
        total += subtotal;
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
  const orders: Prisma.OrderCreateManyInput[] = [];
  const orderDates = new Map<string, Date>();
  const orderCount = randomRange(SEED_CONFIG.orders);
  for (let index = 0; index < orderCount; index++) {
    const customer = pick(customers);
    const vendor = pick(vendors);
    if (!customer || !vendor) break;
    const vendorProducts = savedProducts.filter(
      (product) => product.vendorId === vendor.id,
    );
    if (!vendorProducts.length) continue;
    const chosen = take(
      vendorProducts,
      randomRange(SEED_CONFIG.orderItemsPerOrder),
    );
    const basePrice = chosen.reduce((sum, product) => sum + product.price, 0);
    const orderDate = randomSeedDate();
    const orderId = faker.string.uuid();
    const paymentStartedAt = addMilliseconds(
      orderDate,
      faker.number.int({ min: 1_000, max: 30_000 }),
    );
    const paidAt = addMilliseconds(
      paymentStartedAt,
      faker.number.int({ min: 1_000, max: 60_000 }),
    );
    const isFutureOrder = orderDate.getTime() > Date.now();
    const address = pick(
      customerAddresses.filter((item) => item.userId === customer.id),
    );
    orderDates.set(orderId, orderDate);
    orders.push({
      id: orderId,
      customerId: customer.id,
      vendorId: vendor.id,
      addressId: address?.id,
      basePrice,
      extraCharge: 250,
      deliveryFee: 500,
      totalPrice: basePrice + 750,
      customerApproval: true,
      status: isFutureOrder ? OrderStatus.PENDING : OrderStatus.COMPLETED,
      paymentStatus: isFutureOrder
        ? PaymentStatus.PENDING
        : PaymentStatus.SUCCESS,
      createdAt: orderDate,
      updatedAt: orderDate,
      paidAt: isFutureOrder ? undefined : paidAt,
      paymentStartedAt,
      protectedUntil: addMilliseconds(orderDate, 15 * 60000),
      paymentGraceMinutes: 15,
    });
  }
  await createMany((data) => prisma.order.createMany({ data }), orders);
  const savedOrders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: orders.length,
  });
  const orderItems: Prisma.OrderItemCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = [];
  for (const order of savedOrders) {
    const orderDate = orderDates.get(order.id) || order.createdAt;
    const paymentStartedAt = addMilliseconds(
      orderDate,
      faker.number.int({ min: 1_000, max: 30_000 }),
    );
    const paymentCompletedAt =
      order.status === OrderStatus.COMPLETED
        ? addMilliseconds(
            paymentStartedAt,
            faker.number.int({ min: 1_000, max: 60_000 }),
          )
        : null;
    const productsForOrder = take(
      savedProducts.filter((product) => product.vendorId === order.vendorId),
      randomRange(SEED_CONFIG.orderItemsPerOrder),
    );
    for (const product of productsForOrder)
      orderItems.push({
        orderId: order.id,
        productId: product.id,
        quantity: 1,
        unitPrice: product.price,
        subtotal: product.price,
      });
    payments.push({
      userId: order.customerId,
      orderId: order.id,
      amount: Math.round(order.totalPrice * 100),
      reference: `SEED-${faker.string.alphanumeric(16).toUpperCase()}`,
      status:
        order.status === OrderStatus.COMPLETED
          ? PaymentStatus.SUCCESS
          : PaymentStatus.PENDING,
      startedAt: paymentStartedAt,
      completedAt: paymentCompletedAt,
      expiresAt: addMilliseconds(orderDate, DAY_MS),
      channel: "card",
      ipAddress: "127.0.0.1",
      userAgent: "seed-script",
      createdAt: paymentStartedAt,
      updatedAt: paymentCompletedAt || paymentStartedAt,
    });
  }
  await createMany((data) => prisma.orderItem.createMany({ data }), orderItems);
  await createMany((data) => prisma.payment.createMany({ data }), payments);
  setProgress(
    65,
    `Created ${savedOrders.length} orders, ${orderItems.length} order items and ${payments.length} payments`,
  );

  const deliveryProfilesSaved = await prisma.deliveryPerson.findMany();
  const assignments: Prisma.DeliveryAssignmentCreateManyInput[] = [];
  for (const order of take(
    savedOrders.filter((item) => item.status === OrderStatus.COMPLETED),
    randomRange(SEED_CONFIG.assignments),
  )) {
    const deliveryPerson = pick(deliveryProfilesSaved);
    if (deliveryPerson)
      assignments.push({
        orderId: order.id,
        deliveryPersonId: deliveryPerson.id,
        status: DeliveryStatus.DELIVERED,
        assignedAt: order.createdAt,
        completedAt: order.createdAt,
      });
  }
  await createMany(
    (data) => prisma.deliveryAssignment.createMany({ data }),
    assignments,
  );

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

  const referralRewards: Prisma.ReferralRewardCreateManyInput[] = [];
  const referralRewardCount = randomRange(SEED_CONFIG.referralRewards);
  for (
    let index = 0;
    index < referralRewardCount && customers.length > 1;
    index++
  ) {
    const referrer = customers[index % customers.length];
    const referred = customers[(index + 1) % customers.length];
    if (referrer.id !== referred.id)
      referralRewards.push({
        referrerId: referrer.id,
        referredId: referred.id,
        amount: 500,
        status: "PENDING",
      });
  }
  await createMany(
    (data) => prisma.referralReward.createMany({ data, skipDuplicates: true }),
    referralRewards,
  );

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

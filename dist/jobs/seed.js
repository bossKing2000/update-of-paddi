"use strict";
// // npx ts-node src/jobs/seed.ts
// // npx prisma db push --force-reset
// // npx prisma db push  
// //  to make the html live run this : live-server
// npx prisma migrate resolve --applied "20251004214831_full_migration"
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRandomFoodName = getRandomFoodName;
exports.getRandomFoodDescription = getRandomFoodDescription;
// for locally
// npx prisma migrate reset
// npx prisma migrate dev --name init --create-only
// npx prisma migrate dev
const client_1 = require("@prisma/client");
const faker_1 = require("@faker-js/faker");
const redis_1 = require("../lib/redis");
const prisma = new client_1.PrismaClient();
const BATCH_SIZE = 500;
const MAX_PRODUCTS_PER_VENDOR = 10;
// ==============================
// Realistic Random Food Generators
// ==============================
function getRandomFoodName() {
    const foods = [
        // 🍔 Global foods you had
        "Cheeseburger", "Margherita Pizza", "California Roll", "Spaghetti Carbonara", "Caesar Salad",
        "Grilled Ribeye Steak", "Club Sandwich", "Beef Taco", "Tom Yum Soup", "Pork Dumplings",
        "Chocolate Ice Cream", "Blueberry Pancakes", "Chicken Curry", "Loaded Fries", "Red Velvet Cake",
        "Strawberry Smoothie", "Everything Bagel", "Chicken Burrito", "Belgian Waffle", "Glazed Donut",
        "Chili Hotdog", "Nacho Supreme", "Seafood Lasagna", "Tonkotsu Ramen", "Chicken Quesadilla",
        "Falafel Wrap", "Caprese Grilled Cheese", "Vegetable Samosa", "Beef Chow Mein", "Pho Bo",
        "Pad Thai with Shrimp", "Spinach Gnocchi", "Mac & Cheese with Bacon", "Cheese Omelette",
        "Beer-battered Fish & Chips", "Buffalo Chicken Wings", "Bruschetta with Tomato & Basil",
        "Beef Empanadas", "Seafood Paella", "Nutella Crepes", "Chicken Biryani", "Lamb Shawarma",
        "Ceviche with Lime", "Banana Muffin", "Greek Pita Sandwich", "Fruit Tart", "Chicken Fajitas",
        "Cobb Salad with Blue Cheese", "Vegetable Spring Rolls", "Miso Soup with Tofu",
        // 🇳🇬 Nigerian dishes (~90)
        "Jollof Rice", "Fried Rice", "Ofada Rice with Ayamase Sauce", "Banga Soup", "Egusi Soup",
        "Ogbono Soup", "Okra Soup", "Efo Riro", "Nsala (White Soup)", "Afang Soup",
        "Edikang Ikong", "Oha Soup", "Bitterleaf Soup", "Gbegiri Soup", "Ewedu Soup",
        "Amala with Gbegiri and Ewedu", "Pounded Yam with Egusi", "Semovita with Ogbono Soup",
        "Starch with Banga Soup", "Tuwo Shinkafa with Miyan Kuka", "Tuwo Masara with Miyan Taushe",
        "Waina (Masa)", "Moin Moin", "Akara (Bean Cakes)", "Suya (Spicy Grilled Meat)",
        "Kilishi (Beef Jerky)", "Nkwobi (Cow Foot Delicacy)", "Isi Ewu (Goat Head)", "Ukodo (Yam Pepper Soup)",
        "Goat Meat Pepper Soup", "Catfish Pepper Soup", "Chicken Pepper Soup", "Palm Nut Soup",
        "Yam Porridge (Asaro)", "Beans Porridge", "Plantain Porridge", "Ewa Agoyin with Agege Bread",
        "Ofada Rice and Designer Stew", "Ojojo (Water Yam Fritters)", "Ekpang Nkukwo",
        "Abacha (African Salad)", "Ugba with Fish", "Fisherman Soup", "Atama Soup",
        "Afang Okazi Soup", "Corn Pudding (Okpa)", "Agidi Jollof", "Agidi White with Pepper Soup",
        "Boli (Roasted Plantain) with Groundnut", "Roasted Corn with Coconut", "Yam and Egg Sauce",
        "Boiled Plantain with Garden Egg Sauce", "Beans and Plantain", "Beans and Pap",
        "Akamu (Pap/Ogi) with Akara", "Custard with Moi Moi", "Nigerian Meat Pie",
        "Chicken Pie", "Nigerian Fish Roll", "Scotch Egg (Nigerian style)", "Shawarma (Naija Style)",
        "Gala Sausage Roll", "Puff Puff", "Chin Chin", "Meat Kebab", "Asun (Spicy Goat Meat)",
        "Ponmo Alata (Peppered Cow Skin)", "Spaghetti Jollof", "Indomie Stir Fry with Egg",
        "Egg Roll (Nigerian Style)", "Beans Cake Sandwich", "Peppered Snail", "Grilled Croaker Fish",
        "Fried Titus Fish with Stew", "Dry Fish with Palm Oil Sauce", "Stockfish in Palm Oil Sauce",
        "Ofada Sauce (Ayamase)", "Goat Meat Stew", "Turkey Stew", "Chicken in Tomato Stew",
        "Ofe Akwu (Palm Nut Stew)", "Garden Egg Stew", "Okpa Enugu", "Nigerian Pancake",
        "Coconut Rice", "Jollof Spaghetti", "Boiled Yam with Palm Oil Sauce",
        "Wheat with Ogbono Soup", "Oatmeal Swallow with Efo Riro",
        // 🇮🇳 Indian dishes
        "Paneer Butter Masala", "Masala Dosa", "Chicken Tikka Masala", "Rogan Josh", "Dal Makhani",
        "Hyderabadi Biryani", "Kadai Paneer", "Pav Bhaji", "Chole Bhature", "Pani Puri",
        "Aloo Paratha", "Palak Paneer", "Vindaloo Curry", "Lamb Rogan Josh", "Butter Naan",
        "Malai Kofta", "Samosa Chaat", "Gulab Jamun", "Rasmalai", "Jalebi",
        // 🇲🇽 Mexican dishes
        "Beef Enchiladas", "Chicken Enchiladas Verde", "Churros with Chocolate", "Tamales Rojos",
        "Carnitas Tacos", "Huevos Rancheros", "Mole Poblano", "Pozole Rojo", "Chilaquiles Verdes",
        "Elote (Mexican Street Corn)", "Queso Fundido", "Sopes con Carne", "Tres Leches Cake",
        // 🇮🇹 Italian & Mediterranean
        "Fettuccine Alfredo", "Penne Arrabbiata", "Risotto alla Milanese", "Osso Buco",
        "Caprese Salad", "Prosciutto with Melon", "Arancini Rice Balls", "Tiramisu", "Panna Cotta",
        "Cannoli", "Cioppino Seafood Stew",
        // 🇹🇭 Thai & Southeast Asian
        "Green Curry Chicken", "Massaman Curry", "Som Tum Papaya Salad", "Pad Kra Pao Basil Chicken",
        "Mango Sticky Rice", "Khao Soi", "Satay Skewers", "Laksa Noodle Soup",
        // 🇯🇵 Japanese
        "Salmon Nigiri Sushi", "Tempura Udon", "Chicken Katsu Curry", "Okonomiyaki Pancake",
        "Takoyaki Octopus Balls", "Gyudon Beef Bowl", "Unagi Donburi", "Yakisoba Noodles",
        // 🇪🇹 Ethiopian & others
        "Injera with Doro Wat", "Misir Wot (Red Lentil Stew)", "Shiro Wat", "Kitfo (Spiced Beef Tartare)",
        "Tibs Stir Fry", "Baklava", "Shish Kebab", "Hummus with Pita", "Baba Ganoush",
        "French Onion Soup", "Coq au Vin", "Beef Bourguignon", "Ratatouille",
        "Croque Monsieur", "Quiche Lorraine", "Crème Brûlée"
    ];
    return faker_1.faker.helpers.arrayElement(foods);
}
/**
 * ✅ Generate dynamic Nigerian/global food descriptions
 */
function getRandomFoodDescription(name) {
    const adjectives = [
        // Original
        "delicious", "fresh", "tasty", "crispy", "spicy", "sweet", "savory", "juicy",
        "zesty", "mouth-watering", "flavorful", "aromatic", "hearty", "rich", "succulent",
        "tender", "cheesy", "buttery", "smoky", "golden", "fluffy", "creamy", "peppery", "local", "traditional",
        // Added ~150 more
        "silky", "velvety", "charred", "light", "airy", "toasty", "roasted", "wholesome",
        "crunchy", "crumbly", "nutty", "fiery", "herb-infused", "ginger-spiced", "garlicky", "lemony",
        "citrusy", "caramelized", "sticky", "sticky-sweet", "molten", "oozy", "jammy",
        "marbled", "butter-rich", "parmesan-crusted", "parboiled", "spongy", "syrupy", "candied",
        "peppermint-kissed", "fudgy", "gooey", "smouldering", "toffee-like", "toasted-coconut",
        "earthy", "umami-packed", "glazed", "fried-to-perfection", "slow-braised", "balsamic-drizzled",
        "honey-glazed", "maple-infused", "sticky-barbecue", "creamy-dreamy", "spiced-up", "hot-n-sweet",
        "sizzling", "tangy", "refreshing", "fruity", "exotic", "classic", "rustic", "fusion-style",
        "street-style", "festive", "gourmet", "homestyle", "comforting", "old-fashioned",
        "fiesta-style", "zesty-lime", "ginger-garlic", "cilantro-fresh", "minty", "coconutty",
        "butter-garlic", "spiced-honey", "wok-tossed", "sesame-sprinkled", "smoky-bbq", "charcoal-seared",
        "sticky-garlic", "herbed", "pesto-coated", "sundried-tomato", "chipotle-spiced",
        "jalapeño-peppery", "miso-flavored", "saffron-infused", "pineapple-glazed", "black-pepper",
        "five-spice", "teriyaki-brushed", "chili-lime", "wasabi-zinged", "spiced-butter",
        "creole-seasoned", "cajun-spiced", "harissa-rubbed", "peri-peri", "smoky-chipotle",
        "zucchini-fresh", "herbaceous", "fiery-red", "leek-flavored", "spring-onion-kissed",
        "whipped", "thick-cut", "crispy-skinned", "deeply-satisfying", "farm-fresh", "lively",
        "warming", "comfort-food-style", "lightly-spiced", "spicy-hot", "butter-soft", "velvet-rich",
        "luxurious", "golden-brown", "toasted-almond", "sesame-rich", "cinnamon-sugar",
        "decadent", "gluten-free", "sugar-free", "low-carb", "protein-packed", "fiber-rich",
        "indulgent", "crave-worthy", "zingy", "full-bodied", "grainy-textured", "juicy-bursting",
        "aroma-rich", "fusion-inspired", "soul-warming", "picnic-perfect", "garden-fresh", "farm-to-table",
        "keto-friendly", "classic-style", "meaty", "heavenly", "blissful", "chewy", "soft-centered",
        "double-layered", "ultra-thin", "crispy-edged"
    ];
    const cookingStyles = [
        // Original
        "grilled", "baked", "roasted", "pan-fried", "sautéed", "marinated", "slow-cooked",
        "peppered", "spiced", "smoked", "stir-fried", "stewed", "charcoal-grilled",
        // Added ~150 more
        "wood-fired", "oven-roasted", "coal-roasted", "rotisserie-cooked", "air-fried", "deep-fried",
        "pressure-cooked", "open-flame-seared", "pit-barbecued", "stone-baked", "tandoor-grilled",
        "skillet-seared", "flash-fried", "hand-tossed", "oven-broiled", "iron-skillet-baked",
        "wok-seared", "ginger-stirred", "garlic-sautéed", "lemon-butter-seared",
        "sous-vide", "steamed", "parboiled", "poached", "sun-dried", "herb-crusted",
        "cheese-stuffed", "chili-rubbed", "coconut-simmered", "ginger-braised", "braised-in-wine",
        "beer-battered", "tempura-fried", "miso-marinated", "honey-roasted", "balsamic-glazed",
        "maple-glazed", "hickory-smoked", "applewood-smoked", "mesquite-grilled", "cajun-blackened",
        "char-seared", "crispy-fried", "creamy-baked", "kettle-cooked", "oven-crisped",
        "pesto-drizzled", "garlic-butter-basted", "buttermilk-fried", "brine-cured",
        "hotpot-cooked", "broth-simmered", "korean-bbq-style", "yakitori-grilled", "teppanyaki-seared",
        "dim-sum-steamed", "oven-slow-roasted", "open-pit-grilled", "salt-crusted-baked",
        "foil-wrapped-baked", "banana-leaf-steamed", "citrus-marinated", "pineapple-roasted",
        "ginger-garlic-glazed", "honey-mustard-basted", "peri-peri-grilled", "jerk-style-grilled",
        "creole-blackened", "moroccan-spiced", "ethiopian-spiced", "thai-coconut-braised",
        "malaysian-satay-grilled", "filipino-adobo-style", "jamaican-jerk-roasted",
        "hawaiian-teriyaki-grilled", "mexican-street-grilled", "tangy-lime-marinated",
        "cilantro-chili-marinated", "chipotle-charred", "piri-piri-rubbed", "hot-oil-seared",
        "firecracker-fried", "butter-seared", "spice-roasted", "sugar-caramelized",
        "street-food-style", "café-style-baked", "market-style-grilled", "festival-style-fried",
        "grandma-style-braised", "homestyle-roasted", "bistro-style-pan-fried", "crispy-pan-seared",
        "butter-poached", "garlic-herb-baked", "coconut-grilled", "lemon-herb-grilled",
        "herbed-butter-broiled", "freshly-steamed", "campfire-grilled", "gluten-free-baked"
    ];
    const adjective = faker_1.faker.helpers.arrayElement(adjectives);
    const style = faker_1.faker.helpers.arrayElement(cookingStyles);
    return `A ${adjective}, ${style} ${name} served to satisfy your cravings.`;
}
const foodImageUrls = [
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
    "https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=400&h=300&fit=crop&auto=format&q=80"
];
const foodVideoUrls = [
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
function getRandomFoodImage(min = 1, max = 6) {
    const count = faker_1.faker.number.int({ min, max });
    return Array.from({ length: count }, () => faker_1.faker.helpers.arrayElement(foodImageUrls));
}
function getRandomFoodVideo(min = 1, max = 6) {
    const count = faker_1.faker.number.int({ min, max });
    return Array.from({ length: count }, () => faker_1.faker.helpers.arrayElement(foodVideoUrls));
}
// ==============================
// Helper: Chunk arrays into smaller batches
// ==============================
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}
// ==============================
// Clear Redis caches safely
// ==============================
async function clearRedisCaches() {
    console.log("🧹 Clearing Redis caches...");
    const clients = [redis_1.redisProducts, redis_1.redisSearch, redis_1.redisNotifications, redis_1.ShopCartRedis];
    for (const client of clients) {
        if (!client.isOpen)
            await client.connect();
        await client.flushAll();
        await client.quit();
    }
    console.log("✅ Redis caches cleared");
}
// ==============================
// Main Seed Function
// ==============================
async function main() {
    console.log("🌱 Starting database seeding...\n");
    // ==============================
    // CONFIGURABLE ENGAGEMENT PARAMETERS
    // ==============================
    const CUSTOMER_ENGAGEMENT = 0.7; // 60% of customers place orders
    const VENDOR_ENGAGEMENT = 0.5; // 70% of vendors have active products
    const MAX_ORDERS_PER_CUSTOMER = { min: 0, max: 5 };
    const ORDER_STATUS_PROBABILITIES = [
        { status: client_1.OrderStatus.COMPLETED, weight: 0.5 },
        { status: client_1.OrderStatus.CANCELLED, weight: 0.2 },
        { status: client_1.OrderStatus.PAYMENT_EXPIRED, weight: 0.15 },
        { status: client_1.OrderStatus.PENDING, weight: 0.15 },
    ];
    const PAYMENT_STATUS_PROBABILITIES = [
        { status: client_1.PaymentStatus.SUCCESS, weight: 0.5 },
        { status: client_1.PaymentStatus.PENDING, weight: 0.6 },
        { status: client_1.PaymentStatus.FAILED, weight: 0.3 },
        { status: client_1.PaymentStatus.EXPIRED, weight: 0.1 },
    ];
    function pickWeighted(arr) {
        const sum = arr.reduce((acc, e) => acc + e.weight, 0);
        let rand = Math.random() * sum;
        for (const e of arr) {
            if (rand < e.weight)
                return e.status;
            rand -= e.weight;
        }
        return arr[0].status;
    }
    // ==============================
    // 1️⃣ USERS (Vendors, Customers, Delivery)
    // ==============================
    const totalVendors = 200;
    const totalCustomers = 500;
    const totalDeliveryGuys = 20;
    const usersData = [];
    function generateSafeUserIdentifiers(role, index) {
        const cleanName = faker_1.faker.person.firstName().toLowerCase().replace(/[^a-z0-9]/g, '');
        const email = `${role.toLowerCase()}${index}_${cleanName}@foodpaddi.com`;
        const baseUsername = faker_1.faker.internet.username().toLowerCase().replace(/[^a-z0-9]/g, '');
        const username = `${baseUsername}${index}`;
        return { email, username };
    }
    // --------------------------
    // Delivery Users
    // --------------------------
    for (let i = 0; i < totalDeliveryGuys; i++) {
        const { email, username } = generateSafeUserIdentifiers('delivery', i);
        usersData.push({
            name: faker_1.faker.person.fullName(),
            email,
            username,
            password: faker_1.faker.internet.password(),
            role: client_1.Role.DELIVERY,
            bio: faker_1.faker.lorem.sentence(),
            avatarUrl: faker_1.faker.image.avatar(),
            isEmailVerified: true,
        });
    }
    // --------------------------
    // Vendors
    // --------------------------
    for (let i = 0; i < totalVendors; i++) {
        const { email, username } = generateSafeUserIdentifiers('vendor', i);
        usersData.push({
            name: faker_1.faker.person.fullName(),
            email,
            username,
            password: faker_1.faker.internet.password(),
            role: client_1.Role.VENDOR,
            bio: faker_1.faker.lorem.sentence(),
            avatarUrl: faker_1.faker.image.avatar(),
            brandName: faker_1.faker.company.name(),
            brandLogo: faker_1.faker.image.url(),
            preferences: faker_1.faker.helpers.arrayElements(["DESSERT", "DRINK", "DINNER", "BREAKFAST", "LUNCH"]),
            isEmailVerified: true,
        });
    }
    // --------------------------
    // Customers
    // --------------------------
    for (let i = 0; i < totalCustomers; i++) {
        const { email, username } = generateSafeUserIdentifiers('customer', i);
        usersData.push({
            name: faker_1.faker.person.fullName(),
            email,
            username,
            password: faker_1.faker.internet.password(),
            role: client_1.Role.CUSTOMER,
            bio: faker_1.faker.lorem.sentence(),
            avatarUrl: faker_1.faker.image.avatar(),
            preferences: faker_1.faker.helpers.arrayElements(["DESSERT", "DRINK", "DINNER", "BREAKFAST", "LUNCH"]),
            isEmailVerified: true,
        });
    }
    await prisma.user.createMany({ data: usersData, skipDuplicates: true });
    console.log(`✅ Created ${usersData.length} users (Vendors + Customers + Delivery)`);
    // ==============================
    // 2️⃣ Delivery Profiles
    // ==============================
    const deliveryUsers = await prisma.user.findMany({ where: { role: client_1.Role.DELIVERY } });
    const deliveryProfilesData = deliveryUsers.map((user) => ({
        userId: user.id,
        vehicleType: faker_1.faker.helpers.arrayElement(["Bike", "Car", "Van"]),
        licensePlate: faker_1.faker.vehicle.vrm(),
        status: faker_1.faker.helpers.arrayElement(["ACTIVE", "INACTIVE"]),
        rating: faker_1.faker.number.float({ min: 0, max: 5, fractionDigits: 1 }),
        totalDeliveries: faker_1.faker.number.int({ min: 0, max: 50 }),
        isOnline: faker_1.faker.datatype.boolean(),
        latitude: faker_1.faker.number.float({ min: 4.0, max: 10.0, fractionDigits: 6 }),
        longitude: faker_1.faker.number.float({ min: 3.0, max: 6.9, fractionDigits: 6 }),
        walletBalance: faker_1.faker.number.float({ min: 0, max: 1000, fractionDigits: 2 }),
        lastSeenAt: faker_1.faker.date.recent({ days: 3 }),
    }));
    if (deliveryProfilesData.length) {
        await prisma.deliveryPerson.createMany({ data: deliveryProfilesData, skipDuplicates: true });
        console.log(`🚴 Created ${deliveryProfilesData.length} delivery profiles`);
    }
    // ==============================
    // 3️⃣ Addresses
    // ==============================
    const allUsers = await prisma.user.findMany({ select: { id: true } });
    const addressesData = allUsers.map((user) => ({
        userId: user.id,
        label: "Home",
        street: faker_1.faker.location.streetAddress(),
        city: "Lagos",
        state: "Lagos",
        country: "Nigeria",
        zipCode: faker_1.faker.location.zipCode(),
        latitude: faker_1.faker.number.float({ min: 5.3, max: 10.7, fractionDigits: 6 }),
        longitude: faker_1.faker.number.float({ min: 3.2, max: 3.9, fractionDigits: 6 }),
        isDefault: true,
    }));
    await prisma.address.createMany({ data: addressesData, skipDuplicates: true });
    console.log(`✅ Created ${addressesData.length} addresses`);
    // ==============================
    // 4️⃣ Products + Options + Reviews
    // ==============================
    const allVendors = await prisma.user.findMany({ where: { role: client_1.Role.VENDOR } });
    const activeVendors = faker_1.faker.helpers.arrayElements(allVendors, Math.floor(allVendors.length * VENDOR_ENGAGEMENT));
    const allCustomers = await prisma.user.findMany({ where: { role: client_1.Role.CUSTOMER } });
    const customers = faker_1.faker.helpers.arrayElements(allCustomers, Math.floor(allCustomers.length * CUSTOMER_ENGAGEMENT));
    for (const vendor of activeVendors) {
        const totalProducts = faker_1.faker.number.int({ min: 5, max: MAX_PRODUCTS_PER_VENDOR });
        const totalBatches = Math.ceil(totalProducts / BATCH_SIZE);
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchCount = Math.min(BATCH_SIZE, totalProducts - batchIndex * BATCH_SIZE);
            const productsData = [];
            const optionData = [];
            const reviewData = [];
            const scheduleData = [];
            for (let i = 0; i < batchCount; i++) {
                const foodName = getRandomFoodName();
                const productId = faker_1.faker.string.uuid();
                productsData.push({
                    id: productId,
                    name: foodName,
                    description: getRandomFoodDescription(foodName),
                    price: parseFloat(faker_1.faker.commerce.price({ min: 200, max: 1500 })),
                    archived: false,
                    category: faker_1.faker.helpers.arrayElement(Object.values(client_1.Category)),
                    vendorId: vendor.id,
                    images: getRandomFoodImage(),
                    video: getRandomFoodVideo(),
                    totalViews: faker_1.faker.number.int({ min: 0, max: 1000 }),
                });
                // Options
                const optionCount = faker_1.faker.number.int({ min: 1, max: 3 });
                for (let j = 0; j < optionCount; j++) {
                    optionData.push({
                        productId,
                        name: faker_1.faker.commerce.productAdjective(),
                        price: parseFloat(faker_1.faker.commerce.price({ min: 100, max: 500 })),
                    });
                }
                // Reviews
                const reviewCount = faker_1.faker.number.int({ min: 2, max: 20 });
                for (let j = 0; j < reviewCount; j++) {
                    const customer = faker_1.faker.helpers.arrayElement(customers);
                    reviewData.push({
                        productId,
                        customerId: customer.id,
                        rating: faker_1.faker.number.int({ min: 0, max: 5 }),
                        comment: faker_1.faker.lorem.sentence(),
                        images: [],
                        verifiedPurchase: faker_1.faker.datatype.boolean(),
                    });
                }
                // ✅ Schedule — ONLY ONE PER PRODUCT
                // scheduleData.push({
                //   productId,
                //   goLiveAt: faker.date.soon({ days: 5 }),
                //   takeDownAt: faker.date.soon({ days: 10 }),
                //   isLive: faker.datatype.boolean(),
                //   graceMinutes: faker.number.int({ min: 0, max: 30 }),
                // });
                const goLiveAt = new Date();
                const takeDownAt = new Date(Date.now() + 90 * 60 * 1000);
                scheduleData.push({
                    productId,
                    goLiveAt,
                    takeDownAt,
                    isLive: true,
                    graceMinutes: faker_1.faker.number.int({ min: 0, max: 50 }),
                });
            }
            if (productsData.length)
                await prisma.product.createMany({ data: productsData });
            if (optionData.length)
                await prisma.productOption.createMany({ data: optionData });
            if (reviewData.length) {
                const reviewChunks = chunkArray(reviewData, BATCH_SIZE);
                for (const chunk of reviewChunks) {
                    await prisma.productReview.createMany({ data: chunk });
                    await new Promise((r) => setTimeout(r, 150));
                }
            }
            if (scheduleData.length)
                await prisma.productSchedule.createMany({ data: scheduleData });
            console.log(`✅ Vendor ${vendor.id} batch ${batchIndex + 1}/${totalBatches} seeded`);
            await new Promise((r) => setTimeout(r, 200));
        }
    }
    // --------------------------
    // 8️⃣ Customer Carts
    // --------------------------
    const cartCustomers = faker_1.faker.helpers.arrayElements(allCustomers, Math.floor(allCustomers.length * 0.3)); // 50% of customers
    const liveProducts = await prisma.product.findMany({ where: { archived: false, isLive: true } });
    for (const customer of cartCustomers) {
        // 1️⃣ Create cart
        const cart = await prisma.cart.create({
            data: {
                customerId: customer.id,
                basePrice: 0,
                totalPrice: 0,
            },
        });
        // 2️⃣ Pick some products for this cart
        const cartItemsCount = faker_1.faker.number.int({ min: 0, max: 5 });
        const cartProducts = faker_1.faker.helpers.arrayElements(liveProducts, cartItemsCount);
        let basePrice = 0;
        const cartData = cartProducts.map((product) => {
            const quantity = faker_1.faker.number.int({ min: 1, max: 5 });
            const unitPrice = product.price;
            const subtotal = quantity * unitPrice;
            basePrice += subtotal;
            return {
                cartId: cart.id,
                productId: product.id,
                quantity,
                unitPrice,
                subtotal,
                specialRequest: faker_1.faker.datatype.boolean() ? faker_1.faker.lorem.sentence() : null,
            };
        });
        // 3️⃣ Insert CartItems
        if (cartData.length) {
            await prisma.cartItem.createMany({ data: cartData });
        }
        // 4️⃣ Update cart totalPrice
        await prisma.cart.update({
            where: { id: cart.id },
            data: { basePrice, totalPrice: basePrice },
        });
    }
    console.log(`🛒 Created carts for ${cartCustomers.length} customers`);
    // ==============================
    // 5️⃣ Vendor Reviews
    // ==============================
    const vendorReviewsData = [];
    for (const vendor of activeVendors) {
        const reviewCount = faker_1.faker.number.int({ min: 0, max: 5000 });
        for (let i = 0; i < reviewCount; i++) {
            const customer = faker_1.faker.helpers.arrayElement(customers);
            vendorReviewsData.push({
                vendorId: vendor.id,
                customerId: customer.id,
                rating: faker_1.faker.number.int({ min: 0, max: 5 }),
                comment: faker_1.faker.lorem.sentence(),
            });
        }
    }
    if (vendorReviewsData.length) {
        const vendorChunks = chunkArray(vendorReviewsData, BATCH_SIZE);
        for (const chunk of vendorChunks) {
            await prisma.vendorReview.createMany({ data: chunk });
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    console.log("✅ Vendor reviews seeded");
    // ==============================
    // 7️⃣ Orders + Order Items + Payments
    // ==============================
    const engagedCustomers = faker_1.faker.helpers.arrayElements(allCustomers, Math.floor(allCustomers.length * CUSTOMER_ENGAGEMENT));
    const allProducts = await prisma.product.findMany();
    for (const customer of engagedCustomers) {
        const ordersCount = faker_1.faker.number.int(MAX_ORDERS_PER_CUSTOMER);
        for (let i = 0; i < ordersCount; i++) {
            const vendor = faker_1.faker.helpers.arrayElement(activeVendors);
            const vendorProducts = allProducts.filter((p) => p.vendorId === vendor.id);
            if (!vendorProducts.length)
                continue;
            const orderProducts = faker_1.faker.helpers.arrayElements(vendorProducts, faker_1.faker.number.int({ min: 1, max: Math.min(5, vendorProducts.length) }));
            let basePrice = 0;
            const orderItemsData = [];
            for (const product of orderProducts) {
                const quantity = faker_1.faker.number.int({ min: 1, max: 5 });
                const subtotal = quantity * product.price;
                basePrice += subtotal;
                orderItemsData.push({
                    orderId: "",
                    productId: product.id,
                    quantity,
                    unitPrice: product.price,
                    subtotal,
                    // specialRequest: faker.datatype.boolean() ? faker.lorem.sentence() : null,
                });
            }
            const extraCharge = faker_1.faker.number.float({ min: 10, max: 5500, fractionDigits: 2 });
            const totalPrice = basePrice + extraCharge;
            const orderStatus = pickWeighted(ORDER_STATUS_PROBABILITIES);
            const customerAddresses = await prisma.address.findMany({ where: { userId: customer.id } });
            const address = faker_1.faker.helpers.arrayElement(customerAddresses);
            const order = await prisma.order.create({
                data: {
                    customerId: customer.id,
                    vendorId: vendor.id,
                    addressId: address?.id,
                    basePrice,
                    extraCharge,
                    totalPrice,
                    status: orderStatus,
                    customerApproval: true,
                    paidAt: orderStatus === client_1.OrderStatus.COMPLETED ? faker_1.faker.date.recent({ days: 5 }) : null,
                },
            });
            const itemsToCreate = orderItemsData.map((item) => ({ ...item, orderId: order.id }));
            if (itemsToCreate.length)
                await prisma.orderItem.createMany({ data: itemsToCreate });
            const paymentStatus = pickWeighted(PAYMENT_STATUS_PROBABILITIES);
            await prisma.payment.create({
                data: {
                    userId: customer.id,
                    orderId: order.id,
                    amount: Math.round(totalPrice * 100),
                    reference: `SEED-${faker_1.faker.string.alphanumeric(10)}`,
                    status: paymentStatus,
                    startedAt: faker_1.faker.date.recent({ days: 3 }),
                    completedAt: paymentStatus === client_1.PaymentStatus.SUCCESS ? faker_1.faker.date.recent({ days: 2 }) : null,
                    expiresAt: faker_1.faker.date.soon({ days: 5 }),
                    channel: faker_1.faker.helpers.arrayElement(["card", "bank", "ussd"]),
                    ipAddress: faker_1.faker.internet.ip(),
                    userAgent: faker_1.faker.internet.userAgent(),
                },
            });
        }
    }
    console.log("💳 Orders, order items, and payments seeded successfully!");
    // ==============================
    // 6️⃣ Clear Redis Cache
    // ==============================
    try {
        await clearRedisCaches();
        console.log("🧹 Redis caches cleared\n");
    }
    catch (err) {
        console.warn("⚠️ Failed to clear Redis caches:", err);
    }
    console.log("🎉 Seeding completed successfully!\n");
}
main()
    .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});

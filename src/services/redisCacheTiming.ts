// ==========================
// 🔥 UNIVERSAL CACHE KEYS
// ==========================
export const CACHE_KEYS = {
  PRODUCTS_ALL: (page: number, limit: number) =>
    `products:all:page=${page}:limit=${limit}`,

  PRODUCT_DETAIL: (productId: string) =>
    `product:${productId}:detail`,

  SEARCH: (
    query: string,
    dishType?: string,
    sort?: string,
    page?: number,
    limit?: number
  ) =>
    `search:${query.toLowerCase()}:${dishType || "all"}:${sort || "newest"}:${page || 1}:${limit || 20}`,

  SUGGESTIONS: (query?: string) =>
    query ? `suggestions:${query.toLowerCase()}` : "suggestions:*",

  PRODUCTS_MOST_POPULAR: (page: number, limit: number) =>
    `products:mostPopular:page=${page}:limit=${limit}`,

  CATEGORIES_ALL: "categories:all",

  DISH_TYPES_ALL: "dishtypes:all",

  WHATS_IN_THE_POT: "home:pot",

  // Phase 3A — composed home feed. Scope distinguishes guest vs
  // authenticated (personalized) feeds; coordinates are rounded to ~1km
  // granularity so GPS jitter doesn't explode the key space.
  HOME_FEED: (
    scope: string,
    userId: string,
    lat: number | null,
    lng: number | null,
    dishType: string,
    limit: number
  ) =>
    `home:feed:${scope}:${userId}:lat=${lat ?? "-"}:lng=${lng ?? "-"}:dishtype=${dishType}:limit=${limit}`,
};

export const CACHE_TTLS = {
  PRODUCTS_ALL: 60 * 60 * 5,          
  PRODUCT_DETAIL: 60 * 60 * 5,        
  SEARCH: 60 * 60 * 3,                
  SUGGESTIONS: 60 * 30,               
  CATEGORIES_ALL: 60 * 60,
  DISH_TYPES_ALL: 60 * 60,

  // The pot changes as vendors sell out — keep it fresh (60s).
  WHATS_IN_THE_POT: 60,
  PRODUCTS_MOST_POPULAR: 60 * 5,      

  // Home feed contains live products / open vendors / active promos — keep
  // it fresh (90s) rather than long-cached.
  HOME_FEED: 90,
};

// Phase 3A — composed home feed. Short TTL on purpose: the feed mixes live
// products, open-now vendors and active promotions, all of which go stale
// fast. The namespace is isolated from the per-endpoint product caches so
// feed invalidation can never poison them.

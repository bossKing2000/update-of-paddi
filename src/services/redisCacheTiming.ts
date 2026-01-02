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
    category?: string,
    sort?: string,
    page?: number,
    limit?: number
  ) =>
    `search:${query.toLowerCase()}:${category || "all"}:${sort || "newest"}:${page || 1}:${limit || 20}`,

  SUGGESTIONS: (query?: string) =>
    query ? `suggestions:${query.toLowerCase()}` : "suggestions:*",

  PRODUCTS_MOST_POPULAR: (page: number, limit: number) =>
    `products:mostPopular:page=${page}:limit=${limit}`,

  CATEGORIES_ALL: "categories:all",
};

export const CACHE_TTLS = {
  PRODUCTS_ALL: 60 * 60 * 5,          
  PRODUCT_DETAIL: 60 * 60 * 5,        
  SEARCH: 60 * 60 * 3,                
  SUGGESTIONS: 60 * 30,               
  CATEGORIES_ALL: 60 * 60,            
  PRODUCTS_MOST_POPULAR: 60 * 5,      
};

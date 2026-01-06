"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CACHE_TTLS = exports.CACHE_KEYS = void 0;
// ==========================
// 🔥 UNIVERSAL CACHE KEYS
// ==========================
exports.CACHE_KEYS = {
    PRODUCTS_ALL: (page, limit) => `products:all:page=${page}:limit=${limit}`,
    PRODUCT_DETAIL: (productId) => `product:${productId}:detail`,
    SEARCH: (query, category, sort, page, limit) => `search:${query.toLowerCase()}:${category || "all"}:${sort || "newest"}:${page || 1}:${limit || 20}`,
    SUGGESTIONS: (query) => query ? `suggestions:${query.toLowerCase()}` : "suggestions:*",
    PRODUCTS_MOST_POPULAR: (page, limit) => `products:mostPopular:page=${page}:limit=${limit}`,
    CATEGORIES_ALL: "categories:all",
};
exports.CACHE_TTLS = {
    PRODUCTS_ALL: 60 * 60 * 5,
    PRODUCT_DETAIL: 60 * 60 * 5,
    SEARCH: 60 * 60 * 3,
    SUGGESTIONS: 60 * 30,
    CATEGORIES_ALL: 60 * 60,
    PRODUCTS_MOST_POPULAR: 60 * 5,
};

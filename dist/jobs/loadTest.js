"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/jobs/LoadTest.ts
const axios_1 = __importDefault(require("axios"));
const prisma_1 = __importDefault(require("../lib/prisma"));
/**
 * =========================
 * CONFIG
 * =========================
 */
const BASE_URL = "http://localhost:5000";
const CUSTOMER_USERS = 1200;
const VENDOR_USERS = 150;
const LOGIN_CONCURRENCY = 50;
const REQUEST_CONCURRENCY = 200;
const REQUESTS_PER_CUSTOMER = 20;
const REQUESTS_PER_VENDOR = 50;
const http = axios_1.default.create({
    timeout: 15000,
    headers: { "Content-Type": "application/json" },
});
/**
 * =========================
 * SEARCH TERMS
 * =========================
 */
const SEARCH_TERMS = [
    "rice", "jollof rice", "fried rice",
    "chicken", "fried chicken", "chicken stew",
    "beef", "beef suya", "beef stew",
    "fish", "catfish pepper soup",
    "yam", "fried yam",
    "beans", "ewa agoyin",
    "plantain", "dodo",
    "egusi", "ogbono",
    "shawarma", "burger",
    "pizza", "spaghetti",
];
/**
 * =========================
 * CONCURRENCY HELPER
 * =========================
 */
async function runWithConcurrency(tasks, limit) {
    const results = [];
    const executing = new Set();
    for (const task of tasks) {
        const p = task()
            .then((r) => {
            results.push(r); // push the actual result
        })
            .catch(() => { })
            .finally(() => executing.delete(p));
        executing.add(p);
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    await Promise.all(executing);
    return results;
}
/**
 * =========================
 * LOGIN USERS
 * =========================
 */
async function loginUsers(role) {
    const users = await prisma_1.default.user.findMany({
        where: role ? { role } : undefined,
        take: role ? VENDOR_USERS : CUSTOMER_USERS,
        select: { email: true },
    });
    console.log(`🔐 Logging in ${users.length} ${role ?? "customer"} users...`);
    const loginTasks = users.map((u) => async () => {
        try {
            const res = await http.post(`${BASE_URL}/api/auth/login`, {
                email: u.email,
                password: "password123",
            });
            // ✅ Adjust to your backend's response
            // Usually: { success: true, data: { accessToken: '...' } }
            const token = res.data?.data?.accessToken;
            if (!token) {
                console.warn(`⚠️ No token for ${u.email}`);
                return null;
            }
            return token;
        }
        catch (err) {
            console.warn(`❌ Failed login for ${u.email}`);
            return null;
        }
    });
    const tokens = await runWithConcurrency(loginTasks, LOGIN_CONCURRENCY);
    const validTokens = tokens.filter(Boolean);
    console.log(`✅ Logged in ${validTokens.length} ${role ?? "customer"} users`);
    return validTokens;
}
/**
 * =========================
 * FETCH PRODUCT IDS
 * =========================
 */
async function getProductIds() {
    const products = await prisma_1.default.product.findMany({
        take: 300,
        select: { id: true },
    });
    return products.map((p) => p.id);
}
/**
 * =========================
 * CUSTOMER REQUESTS
 * =========================
 */
function buildCustomerTasks(tokens, productIds) {
    return tokens.flatMap((token) => Array.from({ length: REQUESTS_PER_CUSTOMER }).map(() => async () => {
        const start = Date.now();
        let url;
        const r = Math.random();
        if (r < 0.4) {
            url = `${BASE_URL}/api/product`;
        }
        else if (r < 0.7) {
            const id = productIds[Math.floor(Math.random() * productIds.length)];
            url = `${BASE_URL}/api/product/${id}`;
        }
        else {
            const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
            url = `${BASE_URL}/api/product/p/search?q=${encodeURIComponent(term)}`;
        }
        try {
            const res = await http.get(url, { headers: { Authorization: `Bearer ${token}` } });
            return { status: res.status, time: Date.now() - start };
        }
        catch (err) {
            return { status: err.response?.status || "ERR", time: Date.now() - start };
        }
    }));
}
/**
 * =========================
 * VENDOR DASHBOARD REQUESTS
 * =========================
 */
function pickVendorEndpoint() {
    const r = Math.random();
    if (r < 0.4)
        return "/api/vendor-dashboard/dashboard";
    if (r < 0.6)
        return "/api/vendor-dashboard/analytics";
    if (r < 0.75)
        return "/api/vendor-dashboard/products/all";
    if (r < 0.85)
        return "/api/vendor-dashboard/recent-activity";
    if (r < 0.95)
        return "/api/vendor-dashboard/revenue-overview";
    return "/api/vendor-dashboard/product-performance";
}
function buildVendorTasks(tokens) {
    return tokens.flatMap((token) => Array.from({ length: REQUESTS_PER_VENDOR }).map(() => async () => {
        const start = Date.now();
        const url = `${BASE_URL}${pickVendorEndpoint()}`;
        try {
            const res = await http.get(url, { headers: { Authorization: `Bearer ${token}` } });
            return { status: res.status, time: Date.now() - start };
        }
        catch (err) {
            return { status: err.response?.status || "ERR", time: Date.now() - start };
        }
    }));
}
/**
 * =========================
 * RUN LOAD TEST
 * =========================
 */
async function runLoadTest() {
    console.log("🔥 STARTING LOAD TEST");
    const customerTokens = await loginUsers();
    const vendorTokens = await loginUsers("VENDOR");
    if (!customerTokens.length || !vendorTokens.length) {
        console.error("❌ Missing tokens. Aborting.");
        return;
    }
    const productIds = await getProductIds();
    if (!productIds.length) {
        console.error("❌ No products found. Aborting.");
        return;
    }
    const tasks = [
        ...buildCustomerTasks(customerTokens, productIds),
        ...buildVendorTasks(vendorTokens),
    ];
    console.log(`🚀 Executing ${tasks.length} requests @ concurrency ${REQUEST_CONCURRENCY}`);
    const results = await runWithConcurrency(tasks, REQUEST_CONCURRENCY);
    // =========================
    // METRICS
    // =========================
    const stats = {};
    const times = [];
    results.forEach((r) => {
        stats[r.status] = (stats[r.status] || 0) + 1;
        times.push(r.time);
    });
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    const min = Math.min(...times);
    console.log("📊 STATUS SUMMARY:", stats);
    console.log(`⏱️ Avg: ${avg.toFixed(2)}ms | Min: ${min}ms | Max: ${max}ms`);
}
/**
 * =========================
 * ENTRY
 * =========================
 */
runLoadTest()
    .then(() => {
    console.log("✅ Load test completed");
    process.exit(0);
})
    .catch((err) => {
    console.error("❌ Load test failed", err);
    process.exit(1);
});

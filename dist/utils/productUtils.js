"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeIsLive = computeIsLive;
const time_1 = require("../utils/time");
/**
 * 🕒 Computes whether a product is currently "live"
 * - Uses strict UTC comparison across all timestamps
 * - Respects goLiveAt, takeDownAt, and graceMinutes
 * - Returns false if product is archived or marked offline
 */
function computeIsLive(product) {
    // 🚫 Not live or archived
    if (!product.isLive || product.archived)
        return false;
    const now = (0, time_1.nowUtc)();
    // 🕓 Check schedule if both exist
    if (product.goLiveAt && product.takeDownAt) {
        const graceMinutes = product.graceMinutes ?? 0;
        const liveFromUtc = new Date(product.goLiveAt);
        const takeDownUtc = new Date(product.takeDownAt);
        const liveUntilUtc = (0, time_1.addMinutesUtc)(takeDownUtc, graceMinutes);
        // ✅ Compare UTC times
        return now >= liveFromUtc && now <= liveUntilUtc;
    }
    // 🧩 Fallback to product flag
    return product.isLive && !product.archived;
}

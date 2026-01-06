"use strict";
// import cron from "node-cron";
// import axios from "axios";
// import { DateTime } from "luxon";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startKeepAlive = startKeepAlive;
// const BASE_URL = "https://food-paddi-backend.onrender.com";
// const TIMEZONE = "Africa/Lagos";
// // Nigeria active hours → 7 AM to 1 AM next day
// const START_HOUR = 7;
// const STOP_HOUR = 1;
// /**
//  * 🔹 Ping the backend /healthz endpoint
//  * Only runs during active window (7:00 → 1:00)
//  */
// async function pingServer() {
//   const now = DateTime.now().setZone(TIMEZONE);
//   const hour = now.hour;
//   const inActiveWindow =
//     (hour >= START_HOUR && hour < 24) || (hour >= 0 && hour < STOP_HOUR);
//   if (!inActiveWindow) {
//     console.log(
//       `[KeepAlive] ⏸ Outside active window (${START_HOUR}:00 → ${STOP_HOUR}:00). Render can sleep.`
//     );
//     return;
//   }
//   try {
//     const res = await axios.get(`${BASE_URL}/healthz`);
//     console.log(`[KeepAlive] ✅ Ping successful at ${now.toISO()} — status: ${res.status}`);
//   } catch (err: any) {
//     console.warn(`[KeepAlive] ⚠️ Ping failed at ${now.toISO()}: ${err.message}`);
//   }
// }
// /**
//  * 🔁 Cron Job — runs every 10 minutes
//  */
// export function startKeepAliveJob() {
//   cron.schedule("*/10 * * * * ", async () => {
//     await pingServer();
//     console.log("[KeepAlive] 🕒 Next ping in 10 minutes.");
//   });
//   console.log("[KeepAlive] 🚀 Cron job started for keep-alive pings.");
// }
const axios_1 = __importDefault(require("axios"));
const luxon_1 = require("luxon");
const BASE_URL = "https://food-paddi-backend.onrender.com";
// Ping every 10 minutes (production safe)
const PING_INTERVAL_MS = 10 * 60 * 1000;
// Nigeria timezone
const TIMEZONE = "Africa/Lagos";
// Active window: 7:00 AM → 1:00 AM (next day)
const START_HOUR = 7; // 7 AM
const STOP_HOUR = 1; // 1 AM (next day)
let keepAliveTimer = null;
async function pingServer() {
    const now = luxon_1.DateTime.now().setZone(TIMEZONE);
    const hour = now.hour;
    // ✅ Active window logic:
    // from 7 AM → midnight (0–24)
    // and from 0 AM → 1 AM
    const inActiveWindow = (hour >= START_HOUR && hour < 24) || (hour >= 0 && hour < STOP_HOUR);
    if (!inActiveWindow) {
        // Outside allowed hours → stop loop if running
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
            console.log(`[KeepAlive] Outside active window (${START_HOUR}:00 → ${STOP_HOUR}:00). Stopping at ${now.toISO()}. Render can now auto-sleep.`);
        }
        return;
    }
    try {
        const res = await axios_1.default.get(`${BASE_URL}/healthz`);
        console.log(`[KeepAlive] Ping successful at ${now.toISO()} - status: ${res.status}`);
    }
    catch (err) {
        console.warn(`[KeepAlive] Ping failed at ${now.toISO()}:`, err instanceof Error ? err.message : err);
    }
}
function startKeepAlive() {
    console.log("[KeepAlive] Starting ping loop...");
    // Run immediately once
    pingServer();
    // Schedule future pings
    keepAliveTimer = setInterval(pingServer, PING_INTERVAL_MS);
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestAvailability = void 0;
// src/services/vendorAvailabilityService.ts
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const suggestAvailability = async (vendorId) => {
    // Example: analyze past orders to suggest Go-Live time
    const orders = await prismaClient_1.default.order.findMany({ where: { vendorId } });
    // Placeholder logic: suggest next 2 hours
    const now = new Date();
    const startTime = now;
    const endTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    return { startTime, endTime };
};
exports.suggestAvailability = suggestAvailability;

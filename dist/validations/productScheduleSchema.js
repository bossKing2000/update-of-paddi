"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extendGraceSchema = exports.goLiveSchema = void 0;
const zod_1 = require("zod");
// 🟢 Schema for scheduling Go Live + Take Down
exports.goLiveSchema = zod_1.z.object({
    goLiveAt: zod_1.z.string().datetime("Invalid goLiveAt date format."), // <── Missing field fixed
    takeDownAt: zod_1.z.string().datetime("Invalid takeDownAt date format."),
    graceMinutes: zod_1.z.number().min(0).max(300).optional(),
});
// ⏰ Schema for extending grace period
exports.extendGraceSchema = zod_1.z.object({
    extraMinutes: zod_1.z.number().min(1, "extraMinutes must be at least 1."),
});

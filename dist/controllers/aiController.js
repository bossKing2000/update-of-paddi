"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.vendorAvailability = exports.searchCorrect = exports.getRecommendations = void 0;
const recommendationService = __importStar(require("../AI/recommendationService")); // personalized recommendations
const vendorAvailabilityService = __importStar(require("../AI/vendorAvailabilityService"));
const localSearchCorrect_1 = require("../AI/localSearchCorrect");
// // 🌟 Search Auto-Correct
// export const searchCorrect = async (req: Request, res: Response) => {
//   const { query } = req.query;
//   if (!query || typeof query !== 'string') return res.status(400).json({ error: 'Missing query' });
//   const corrected = await searchService.correctSearchQuery(query); // ✅ correct now
//   res.json({ corrected });
// };
const getRecommendations = async (req, res) => {
    const { userId } = req.query;
    if (!userId || typeof userId !== 'string')
        return res.status(400).json({ error: 'Missing userId' });
    const recommendations = await recommendationService.getRecommendations(userId); // ✅ correct now
    res.json({ recommendations });
};
exports.getRecommendations = getRecommendations;
// src/controllers/aiController.ts
// 🌟 Search Auto-Correct (Offline)
const searchCorrect = async (req, res) => {
    const { query } = req.query;
    if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'Missing query' });
    }
    const corrected = (0, localSearchCorrect_1.correctQuery)(query); // Offline correction
    res.json({ corrected });
};
exports.searchCorrect = searchCorrect;
// You can leave other AI endpoints (recommendations, vendor availability) as they are
// 🌟 Vendor “Go Live / Take Down” AI Suggestions
const vendorAvailability = async (req, res) => {
    try {
        const { vendorId } = req.body;
        if (!vendorId || typeof vendorId !== 'string') {
            return res.status(400).json({ error: 'Missing vendorId' });
        }
        const suggestion = await vendorAvailabilityService.suggestAvailability(vendorId);
        res.status(200).json({ success: true, suggestion });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to suggest vendor availability' });
    }
};
exports.vendorAvailability = vendorAvailability;

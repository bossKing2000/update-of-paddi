"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.correctSearchQuery = void 0;
// src/services/searchService.ts
const openai_1 = __importDefault(require("openai"));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new openai_1.default({ apiKey: OPENAI_API_KEY });
const correctSearchQuery = async (query) => {
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: `You are an assistant that ONLY fixes typos and grammar in a search query.
          Respond ONLY with the corrected text, nothing else.`,
                },
                { role: 'user', content: query },
            ],
            temperature: 0,
        });
        const corrected = completion.choices[0].message?.content?.trim();
        return corrected || query;
    }
    catch (err) {
        console.error('Search correction failed:', err);
        return query; // fallback
    }
};
exports.correctSearchQuery = correctSearchQuery;

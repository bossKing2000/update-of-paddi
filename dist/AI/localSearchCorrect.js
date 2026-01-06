"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.correctQuery = exports.correctWord = void 0;
// src/AI/localSearchCorrect.ts
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const nspell_1 = __importDefault(require("nspell"));
const dictionary_en_us_1 = __importDefault(require("dictionary-en-us"));
let spell;
// 1️⃣ Load English dictionary
(0, dictionary_en_us_1.default)((err, dict) => {
    if (err) {
        console.error('Failed to load English dictionary:', err);
        return;
    }
    spell = (0, nspell_1.default)(dict);
    // 2️⃣ Load custom food dictionary (your own words)
    const foodDictPath = path_1.default.join(__dirname, 'custom-food-dict.txt');
    if (fs_1.default.existsSync(foodDictPath)) {
        const foodWords = fs_1.default.readFileSync(foodDictPath, 'utf-8')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        foodWords.forEach(word => spell?.add(word));
        console.log(`✅ Loaded ${foodWords.length} custom food words`);
    }
    else {
        console.warn('⚠️ custom-food-dict.txt not found, only English dictionary is used');
    }
    console.log('✅ Local search correction dictionary loaded');
});
// 3️⃣ Correct a single word
const correctWord = (word) => {
    if (!spell)
        return word; // fallback if dictionary not loaded
    if (spell.correct(word))
        return word; // already correct
    const suggestions = spell.suggest(word);
    return suggestions.length > 0 ? suggestions[0] : word;
};
exports.correctWord = correctWord;
// 4️⃣ Correct a full query (split by spaces)
const correctQuery = (query) => {
    return query
        .split(/\s+/)
        .map(exports.correctWord)
        .join(' ');
};
exports.correctQuery = correctQuery;

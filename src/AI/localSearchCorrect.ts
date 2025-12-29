// src/AI/localSearchCorrect.ts
import fs from 'fs';
import path from 'path';
import nspell from 'nspell';
import enUS from 'dictionary-en-us';

let spell: ReturnType<typeof nspell> | undefined;

// 1️⃣ Load English dictionary
enUS((err: Error | null, dict: any) => {
  if (err) {
    console.error('Failed to load English dictionary:', err);
    return;
  }

  spell = nspell(dict);

  // 2️⃣ Load custom food dictionary (your own words)
  const foodDictPath = path.join(__dirname, 'custom-food-dict.txt');
  if (fs.existsSync(foodDictPath)) {
    const foodWords = fs.readFileSync(foodDictPath, 'utf-8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    foodWords.forEach(word => spell?.add(word));
    console.log(`✅ Loaded ${foodWords.length} custom food words`);
  } else {
    console.warn('⚠️ custom-food-dict.txt not found, only English dictionary is used');
  }

  console.log('✅ Local search correction dictionary loaded');
});

// 3️⃣ Correct a single word
export const correctWord = (word: string): string => {
  if (!spell) return word; // fallback if dictionary not loaded
  if (spell.correct(word)) return word; // already correct
  const suggestions = spell.suggest(word);
  return suggestions.length > 0 ? suggestions[0] : word;
};

// 4️⃣ Correct a full query (split by spaces)
export const correctQuery = (query: string): string => {
  return query
    .split(/\s+/)
    .map(correctWord)
    .join(' ');
};

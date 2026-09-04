// src/AI/localSearchCorrect.ts
import fs from 'fs';
import path from 'path';
import nspell from 'nspell';
import enUS from 'dictionary-en-us';

let spell: ReturnType<typeof nspell> | undefined;

// Lower-cased custom food words, in file order. Used to prefer food
// corrections ("jolof" → "jollof") over generic English suggestions
// ("jolof" → "aloof").
const foodWordList: string[] = [];

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let corner = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, corner + (a[i - 1] === b[j - 1] ? 0 : 1));
      corner = temp;
    }
  }
  return prev[b.length];
}

/** Closest food word within maxDist edits, or null. */
function closestFoodWord(word: string, maxDist = 2): string | null {
  let best: string | null = null;
  let bestDist = maxDist + 1;
  for (const food of foodWordList) {
    if (Math.abs(food.length - word.length) > maxDist) continue;
    const d = editDistance(word, food);
    if (d < bestDist) {
      bestDist = d;
      best = food;
      if (d <= 1) break;
    }
  }
  return bestDist <= maxDist ? best : null;
}

// 1️⃣ Load English dictionary
enUS((err: Error | null, dict: any) => {
  if (err) {
    console.error('Failed to load English dictionary:', err);
    return;
  }

  spell = nspell(dict);

  // 2️⃣ Load custom food dictionary (dish names like jollof/suya/ofada).
  // Resolved against several roots so it works from src (ts-node/dev),
  // dist (compiled build — see the `cp` step in package.json build), and
  // any other working directory layout.
  const candidates = [
    path.join(__dirname, 'custom-food-dict.txt'),
    path.join(process.cwd(), 'src', 'AI', 'custom-food-dict.txt'),
    path.join(process.cwd(), 'dist', 'AI', 'custom-food-dict.txt'),
  ];
  const foodDictPath = candidates.find((p) => fs.existsSync(p));
  const foodWords: string[] = [];
  if (foodDictPath) {
    for (const line of fs.readFileSync(foodDictPath, 'utf-8').split(/\r?\n/)) {
      const word = line.trim().toLowerCase();
      if (word) {
        foodWords.push(word);
        spell?.add(word);
      }
    }
    console.log(`✅ Loaded ${foodWords.length} custom food words from ${foodDictPath}`);
  } else {
    console.warn('⚠️ custom-food-dict.txt not found, only English dictionary is used');
  }
  foodWordList.push(...foodWords);

  console.log('✅ Local search correction dictionary loaded');
});

// 3️⃣ Correct a single word
export const correctWord = (word: string): string => {
  if (!spell) return word; // fallback if dictionary not loaded
  if (spell.correct(word)) return word; // already correct
  // Food-first: a close dish name beats a generic English suggestion.
  const food = closestFoodWord(word.toLowerCase());
  if (food) return food;
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

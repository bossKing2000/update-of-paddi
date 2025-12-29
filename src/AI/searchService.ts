// src/services/searchService.ts
import OpenAI from 'openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

export const correctSearchQuery = async (query: string): Promise<string> => {
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
  } catch (err) {
    console.error('Search correction failed:', err);
    return query; // fallback
  }
};

// src/controllers/aiController.ts
import { Request, Response } from 'express';
import * as searchService from '../AI/searchService';           // search auto-correct
import * as recommendationService from '../AI/recommendationService'; // personalized recommendations
import * as vendorAvailabilityService from '../AI/vendorAvailabilityService';
import { correctQuery } from '../AI/localSearchCorrect';

// // 🌟 Search Auto-Correct
// export const searchCorrect = async (req: Request, res: Response) => {
//   const { query } = req.query;
//   if (!query || typeof query !== 'string') return res.status(400).json({ error: 'Missing query' });

//   const corrected = await searchService.correctSearchQuery(query); // ✅ correct now
//   res.json({ corrected });
// };

export const getRecommendations = async (req: Request, res: Response) => {
  const { userId } = req.query;
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Missing userId' });

  const recommendations = await recommendationService.getRecommendations(userId); // ✅ correct now
  res.json({ recommendations });
};

// src/controllers/aiController.ts

// 🌟 Search Auto-Correct (Offline)
export const searchCorrect = async (req: Request, res: Response) => {
  const { query } = req.query;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing query' });
  }

  const corrected = correctQuery(query); // Offline correction
  res.json({ corrected });
};

// You can leave other AI endpoints (recommendations, vendor availability) as they are


// 🌟 Vendor “Go Live / Take Down” AI Suggestions
export const vendorAvailability = async (req: Request, res: Response) => {
  try {
    const { vendorId } = req.body;
    if (!vendorId || typeof vendorId !== 'string') {
      return res.status(400).json({ error: 'Missing vendorId' });
    }

    const suggestion = await vendorAvailabilityService.suggestAvailability(vendorId);
    res.status(200).json({ success: true, suggestion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to suggest vendor availability' });
  }
};

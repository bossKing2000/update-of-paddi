import { Router } from 'express';
import * as aiController from '../controllers/aiController';
import { aiRateLimiter } from '../middlewares/rateLimiter.middleware';

const router = Router();

// search-correct is fully offline (local dictionary) — safe unauthenticated.
// recommendations fans out to paid embedding calls per request and accepts
// an arbitrary userId, so it is rate-limited (no client currently calls it;
// auth was deliberately not added to avoid changing the product surface).
router.get('/search-correct', aiController.searchCorrect);
router.get('/recommendations', aiRateLimiter, aiController.getRecommendations);
router.post('/vendor-availability', aiRateLimiter, aiController.vendorAvailability);

export default router;

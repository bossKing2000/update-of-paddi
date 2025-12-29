import { Router } from 'express';
import * as aiController from '../controllers/aiController';

const router = Router();

router.get('/search-correct', aiController.searchCorrect);
router.get('/recommendations', aiController.getRecommendations);
router.post('/vendor-availability', aiController.vendorAvailability);

export default router;

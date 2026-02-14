import { Router } from 'express';
import { startSeeder, requestStopSeeder, seederProgress } from '../controllers/seederController';

const router = Router();

router.get('/run-seeder', startSeeder);
router.get('/stop-seeder', requestStopSeeder);
router.get('/seeder-progress', seederProgress);

export default router;

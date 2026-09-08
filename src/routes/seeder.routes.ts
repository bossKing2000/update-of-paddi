import { Router } from 'express';
import { startSeeder, requestStopSeeder, seederProgress } from '../controllers/seederController';
import { authenticate, authorizeAdmin } from '../middlewares/auth.middleware';

const router = Router();

// Seeder generates/destroys bulk fake data — ADMIN-only even in
// development, and the router itself is only mounted outside production
// (see server.ts). Never publicly callable.
router.use(authenticate, authorizeAdmin);

router.get('/run-seeder', startSeeder);
router.get('/stop-seeder', requestStopSeeder);
router.get('/seeder-progress', seederProgress);

export default router;

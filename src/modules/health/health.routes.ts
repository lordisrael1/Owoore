import { Router } from 'express';
import { healthController } from './health.controller';

/**
 * health.routes.ts
 * GET /health — public, no auth
 * Nomba build-week checklist: "Health-check endpoint your judges can hit to see green status"
 */
const router = Router();

router.get('/', healthController.check);

export default router;
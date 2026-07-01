import { Router } from 'express';
import { generalRateLimiter } from '../../middleware/rateLimiter';
import { anonymousController } from './anonymous.controller';

/**
 * anonymous.routes.ts
 *
 * GET /give/:orgSlug — fully public, no JWT required.
 *
 * Returns org-level shared VA numbers per fund type.
 * Displayed on the church's public giving page and on
 * the Sunday service projector.
 *
 * Rate limited to prevent VA creation abuse (each request
 * may trigger Nomba API calls to create missing VAs).
 */
const router = Router();

router.get('/:orgSlug', generalRateLimiter, anonymousController.getGivingPage);

export default router;
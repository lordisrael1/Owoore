import { Router } from 'express';
import { authenticateMember } from '../../middleware/authenticate';
import { generalRateLimiter } from '../../middleware/rateLimiter';
import { vaController } from './va.controller';

/**
 * va.routes.ts
 *
 * POST /me/funds/:fundId/account → lazy VA creation (member auth)
 * GET  /me/accounts              → all member VAs (member auth)
 *
 * All routes require member JWT.
 * Rate limited to prevent VA creation abuse.
 */
const router = Router();

router.post('/me/funds/:fundId/account', authenticateMember, generalRateLimiter, vaController.getOrCreate);
router.get('/me/accounts',               authenticateMember, generalRateLimiter, vaController.getAllMemberVAs);

export default router;
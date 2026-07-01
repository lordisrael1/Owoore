import { Router } from 'express';
import { approvalController } from './approval.controller';
import { approvalRateLimiter } from '../../../middleware/rateLimiter';

/**
 * approval.routes.ts
 *
 * No JWT middleware — token in URL is the credential.
 * Rate limited to prevent token scanning (5 req/min).
 */
const router = Router();

router.get( '/:token',         approvalRateLimiter, approvalController.getDetails);
router.post('/:token',         approvalRateLimiter, approvalController.approve);
router.post('/:token/decline', approvalRateLimiter, approvalController.decline);

export default router;
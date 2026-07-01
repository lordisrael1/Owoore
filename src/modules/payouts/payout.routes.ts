import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorise';
import { validateBody } from '../../middleware/validateRequest';
import { generalRateLimiter } from '../../middleware/ratelimiter';
import { initPayoutSchema } from './payout.validator';
import { payoutController } from './payout.controller';
 
const router = Router();
 
// All payout routes require admin authentication
router.use(authenticateAdmin, generalRateLimiter);
 
router.post(
  '/',
  requireRole(['ADMIN', 'TREASURER']),
  validateBody(initPayoutSchema),
  payoutController.initiate,
);
 
router.get('/',     payoutController.list);
router.get('/:id',  payoutController.getById);
router.delete('/:id', requireRole(['ADMIN', 'TREASURER']), payoutController.cancel);
 
export default router;
 
import { Router } from 'express';
import { authenticateMember, authenticateAdmin } from '../../middleware/authenticate';
import { validateQuery } from '../../middleware/validateRequest';
import { givingHistoryQuerySchema } from './member.validator';
import { memberController } from './member.controller';

/**
 * member.routes.ts
 *
 * Member-facing routes (require member JWT):
 *   GET /me                 → profile + fund summaries
 *   GET /me/giving-history  → transaction history
 *
 * Admin-facing routes (require admin JWT):
 *   GET /members            → paginated member list for dashboard
 */
const router = Router();

// Member portal routes
router.get('/me',
  authenticateMember,
  memberController.getMe,
);

router.get('/me/funds',
  authenticateMember,
  memberController.listFunds,
);

router.get('/me/giving-history',
  authenticateMember,
  validateQuery(givingHistoryQuerySchema),
  memberController.getGivingHistory,
);

// Admin dashboard — member management
router.get('/members',
  authenticateAdmin,
  memberController.listForAdmin,
);

export default router;
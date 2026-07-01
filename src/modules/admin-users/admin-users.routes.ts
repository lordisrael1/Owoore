import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorise';
import { validateBody, validateParams } from '../../middleware/validateRequest';
import { generalRateLimiter } from '../../middleware/rateLimiter';
import {
  inviteSchema, acceptInviteSchema, setPasswordSchema, inviteTokenParamSchema,
} from './admin-users.validator';
import { adminUserController } from './admin-users.controller';

const router = Router();

// Admin sends invite email to a treasurer
router.post(
  '/invite',
  authenticateAdmin,
  requireRole(['ADMIN']),
  validateBody(inviteSchema),
  adminUserController.invite,
);

// Treasurer clicks email link — frontend fetches invite details
router.get(
  '/invite/:token',
  generalRateLimiter,
  validateParams(inviteTokenParamSchema),
  adminUserController.getInviteDetails,
);

// Treasurer sets password — account activates (token in URL)
router.post(
  '/invite/:token',
  generalRateLimiter,
  validateParams(inviteTokenParamSchema),
  validateBody(setPasswordSchema),
  adminUserController.acceptInviteByToken,
);

// Legacy: accept invite with token in body
router.post(
  '/accept-invite',
  generalRateLimiter,
  validateBody(acceptInviteSchema),
  adminUserController.acceptInvite,
);

export default router;

import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorise';
import { validateBody, validateParams } from '../../middleware/validateRequest';
import { generalRateLimiter } from '../../middleware/ratelimiter';
import {
  inviteSchema, acceptInviteSchema, setPasswordSchema, inviteTokenParamSchema,
  adminUserIdParamSchema, updateAdminUserSchema,
} from './admin-users.validator';
import { adminUserController } from './admin-users.controller';

const router = Router();

// Team roster — any staff member can see who has access
router.get(
  '/',
  authenticateAdmin,
  adminUserController.list,
);

// Revoke / restore a team member's access (ADMIN only)
router.patch(
  '/:id',
  authenticateAdmin,
  requireRole(['ADMIN']),
  validateParams(adminUserIdParamSchema),
  validateBody(updateAdminUserSchema),
  adminUserController.setActive,
);

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

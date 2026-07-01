import { Router } from 'express';
import { validateBody, validateParams } from '../../middleware/validateRequest';
import { authenticateAdmin } from '../../middleware/authenticate';
import { scopeToOrg } from '../../middleware/authorise';
import { generalRateLimiter } from '../../middleware/rateLimiter';
import { uploadLogo } from '../../middleware/upload';
import {
  createOrgSchema,
  updateOrgSchema,
  orgSlugParamSchema,
  orgIdParamSchema,
} from './org.validator';
import { orgController } from './org.controller';

const router = Router();

// Public routes
router.post(
  '/',
  generalRateLimiter,
  uploadLogo,
  validateBody(createOrgSchema),
  orgController.create,
);

router.get(
  '/:slug',
  validateParams(orgSlugParamSchema),
  orgController.getBySlug,
);

// Admin-only routes
router.patch(
  '/:id',
  authenticateAdmin,
  validateParams(orgIdParamSchema),
  scopeToOrg,
  uploadLogo,
  validateBody(updateOrgSchema),
  orgController.update,
);

export default router;
import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorise';
import { validateBody, validateParams } from '../../middleware/validateRequest';
import { createFundSchema, updateFundSchema, fundParamsSchema } from './fund.validator';
import { fundController } from './fund.controller';

/**
 * fund.routes.ts
 *
 * GET    /orgs/:orgId/funds    → list all funds for org
 * POST   /orgs/:orgId/funds    → create new fund type (ADMIN only)
 * GET    /funds/:id            → get single fund
 * PATCH  /funds/:id            → update fund (ADMIN only)
 * DELETE /funds/:id            → deactivate fund (ADMIN only)
 *
 * All routes require admin authentication + org scoping.
 */

// Router mounted at /api/v1 — handles both /orgs/:orgId/funds and /funds/:id
const router = Router({ mergeParams: true });

router.use(authenticateAdmin);

// Org-scoped fund routes (mounted under /orgs/:orgId/funds in app.ts)
router.get( '/',  fundController.list);
router.post('/',  requireRole(['ADMIN']), validateBody(createFundSchema), fundController.create);

// Fund-level routes (mounted under /funds in app.ts)
router.get( '/:id', validateParams(fundParamsSchema), fundController.getById);
router.patch('/:id', requireRole(['ADMIN']), validateParams(fundParamsSchema),
  validateBody(updateFundSchema), fundController.update);
router.delete('/:id', requireRole(['ADMIN']), validateParams(fundParamsSchema),
  fundController.deactivate);

export default router;
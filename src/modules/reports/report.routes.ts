import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { reportController } from './report.controller';

/**
 * report.routes.ts
 *
 * GET /orgs/:orgId/reports/giving      → fund giving report (JSON or CSV)
 * GET /members/:id/statement           → member giving statement (JSON or CSV)
 * GET /reports/arrears                 → members with outstanding balances
 *
 * Append ?format=csv to get downloadable CSV files.
 * All routes require admin authentication.
 */
const router = Router();

router.get('/orgs/:orgId/reports/giving',  authenticateAdmin, reportController.getOrgGiving);
router.get('/members/:id/statement',       authenticateAdmin, reportController.getMemberStatement);
router.get('/reports/arrears',             authenticateAdmin, reportController.getArrears);

export default router;
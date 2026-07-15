import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { requireRole, scopeToOrg } from '../../middleware/authorise';
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

// Reports expose org-wide financials and member PII — gate to
// ADMIN/TREASURER (authenticateAdmin alone also admits SIGNATORY).
// scopeToOrg only where the route carries :orgId; the member-statement
// route's :id is a MEMBER id, which the controller org-scopes internally.
const reportRole = requireRole(['ADMIN', 'TREASURER']);

router.get('/orgs/:orgId/reports/giving',  authenticateAdmin, reportRole, scopeToOrg, reportController.getOrgGiving);
router.get('/members/:id/statement',       authenticateAdmin, reportRole, reportController.getMemberStatement);
router.get('/reports/arrears',             authenticateAdmin, reportRole, reportController.getArrears);

export default router;
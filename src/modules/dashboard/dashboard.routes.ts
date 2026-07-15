import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorise';
import { dashboardController } from './dashboard.controller';

/**
 * dashboard.routes.ts
 *
 * GET /dashboard/summary         → top-level collection metrics
 * GET /dashboard/fund-breakdown  → per-fund balance + totals
 * GET /dashboard/member-status   → who paid, who owes, deficits
 * GET /dashboard/payout-history  → recent payout requests
 * GET /dashboard/transactions    → org-wide giving ledger (paginated)
 */
const router = Router();

// authenticateAdmin lets SIGNATORY tokens through as well — signatories
// approve individual payouts via email links and should NOT see org-wide
// financials. Explicit role gate on top of the auth check.
router.use(authenticateAdmin, requireRole(['ADMIN', 'TREASURER']));

router.get('/summary',        dashboardController.getSummary);
router.get('/fund-breakdown', dashboardController.getFundBreakdown);
router.get('/member-status',  dashboardController.getMemberStatus);
router.get('/payout-history', dashboardController.getPayoutHistory);
router.get('/transactions',   dashboardController.getTransactions);
router.get('/activity',       dashboardController.getActivity);

export default router;
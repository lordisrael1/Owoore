import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { dashboardController } from './dashboard.controller';

/**
 * dashboard.routes.ts
 *
 * GET /dashboard/summary         → top-level collection metrics
 * GET /dashboard/fund-breakdown  → per-fund balance + totals
 * GET /dashboard/member-status   → who paid, who owes, deficits
 * GET /dashboard/payout-history  → recent payout requests
 */
const router = Router();

router.use(authenticateAdmin);

router.get('/summary',        dashboardController.getSummary);
router.get('/fund-breakdown', dashboardController.getFundBreakdown);
router.get('/member-status',  dashboardController.getMemberStatus);
router.get('/payout-history', dashboardController.getPayoutHistory);
router.get('/activity',       dashboardController.getActivity);

export default router;
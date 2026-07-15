import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { Errors } from '../../utils/AppError';
import { dashboardService } from './dashboard.service';

const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_RE = /^\d{4}-\d{2}$/;

export const dashboardController = {
  getSummary: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const data = await dashboardService.getSummary(user.orgId);
    res.json({ success: true, data });
  }),

  getFundBreakdown: catchAsync(async (req: Request, res: Response) => {
    const user   = (req as any).user;
    const period = req.query.period as string | undefined;
    const data   = await dashboardService.getFundBreakdown(user.orgId, period);
    res.json({ success: true, data });
  }),

  getMemberStatus: catchAsync(async (req: Request, res: Response) => {
    const user   = (req as any).user;
    const period = req.query.period as string | undefined;
    const data   = await dashboardService.getMemberStatus(user.orgId, period);
    res.json({ success: true, data });
  }),

  getPayoutHistory: catchAsync(async (req: Request, res: Response) => {
    const user  = (req as any).user;
    const limit = Number(req.query.limit ?? 20);
    const data  = await dashboardService.getPayoutHistory(user.orgId, limit);
    res.json({ success: true, data });
  }),

  getTransactions: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { fund_type_id, period } = req.query as Record<string, string | undefined>;

    // Validate before the ::uuid / ::char(7) casts hit Postgres — a bad
    // value would otherwise surface as a 500 instead of a 400.
    if (fund_type_id && !UUID_RE.test(fund_type_id)) {
      throw Errors.badRequest('fund_type_id must be a valid UUID.');
    }
    if (period && !PERIOD_RE.test(period)) {
      throw Errors.badRequest('period must be in YYYY-MM format.');
    }

    const limit  = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 100);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

    const data = await dashboardService.getTransactions(user.orgId, {
      fundTypeId: fund_type_id,
      period,
      limit,
      offset,
    });
    res.json({ success: true, data });
  }),

  getActivity: catchAsync(async (req: Request, res: Response) => {
    const user  = (req as any).user;
    const limit = Math.min(Number(req.query.limit ?? 15), 50);
    const data  = await dashboardService.getActivity(user.orgId, limit);
    res.json({ success: true, data });
  }),
};
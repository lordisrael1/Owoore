import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { dashboardService } from './dashboard.service';

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
};
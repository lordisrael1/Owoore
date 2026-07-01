import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { reportService } from './report.service';
import { csvService } from './csv.service';

export const reportController = {
  // GET /orgs/:orgId/reports/giving?year=2026&period=2026-06&fund_type_id=xxx
  getOrgGiving: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { period, fund_type_id, year, format } = req.query as Record<string, string>;

    if (format === 'csv') {
      const csv = await csvService.generateGivingStatement(user.orgId, {
        period, fund_type_id,
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition',
        `attachment; filename="owoore-giving-${period ?? 'all'}.csv"`);
      res.send(csv);
      return;
    }

    const data = await reportService.getOrgGivingReport(user.orgId, {
      period, fund_type_id, year: year ? Number(year) : undefined,
    });
    res.json({ success: true, data });
  }),

  // GET /members/:id/statement?year=2026&format=csv
  getMemberStatement: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { year, format } = req.query as Record<string, string>;
    const memberId = req.params.id as string;

    if (format === 'csv') {
      const csv = await csvService.generateMemberStatement(memberId, user.orgId);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition',
        `attachment; filename="owoore-statement-${year ?? new Date().getFullYear()}.csv"`);
      res.send(csv);
      return;
    }

    const data = await reportService.getMemberStatement(
      memberId, user.orgId, year ? Number(year) : undefined,
    );
    res.json({ success: true, data });
  }),

  // GET /reports/arrears — members with outstanding balances
  getArrears: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const data = await reportService.computeArrears(user.orgId);
    res.json({ success: true, data });
  }),
};
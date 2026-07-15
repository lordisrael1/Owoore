import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { reportService } from './report.service';
import { csvService } from './csv.service';

export const reportController = {
  // GET /orgs/:orgId/reports/giving?year=2026&period=2026-06&fund_type_id=xxx&format=csv&view=summary
  //
  // Two CSV shapes for two different questions a church asks:
  //   view=detailed (default) → one row per member payment  (reconciliation)
  //   view=summary            → one row per fund per month   (board report)
  getOrgGiving: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { period, fund_type_id, year, format, view } = req.query as Record<string, string>;

    if (format === 'csv') {
      const scope = period ?? (year ?? 'all');

      if (view === 'summary') {
        const csv = await csvService.generateFundSummary(user.orgId, {
          period,
          year: year ? Number(year) : undefined,
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition',
          `attachment; filename="owoore-fund-summary-${scope}.csv"`);
        res.send(csv);
        return;
      }

      const csv = await csvService.generateGivingStatement(user.orgId, {
        period, fund_type_id,
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition',
        `attachment; filename="owoore-giving-${scope}.csv"`);
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
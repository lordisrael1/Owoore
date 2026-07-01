import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { memberService } from './member.service';

export const memberController = {
  // GET /me — member profile + fund summaries
  getMe: catchAsync(async (req: Request, res: Response) => {
    const user   = (req as any).user;
    const result = await memberService.getProfile(user.sub, user.orgId);
    res.json({ success: true, data: result });
  }),

  // GET /me/giving-history
  getGivingHistory: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { fund_type_id, period, limit, offset } = req.query as Record<string, string>;

    const history = await memberService.getGivingHistory(user.sub, {
      fund_type_id,
      period,
      limit:  Number(limit ?? 20),
      offset: Number(offset ?? 0),
    });

    res.json({ success: true, data: history });
  }),

  // GET /me/funds — member: list active funds with VA for shared funds
  listFunds: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { queryMany } = await import('../../db');
    const funds = await queryMany(
      `SELECT
         ft.id, ft.name, ft.kind, ft.description,
         ft.expected_amt_kobo, ft.expires_at, ft.sort_order, ft.is_shared_va,
         -- For shared-VA funds, include the VA number directly (same for all members)
         -- NULL if the VA hasn't been created yet (first member to tap will trigger creation)
         ofa.nomba_va_number AS shared_va_number,
         ofa.bank_name       AS shared_va_bank
       FROM fund_types ft
       LEFT JOIN org_shared_fund_accounts ofa
         ON ofa.fund_type_id = ft.id AND ofa.org_id = ft.org_id
       WHERE ft.org_id = $1
         AND ft.is_active = TRUE
         AND ft.is_anonymous_only = FALSE
       ORDER BY ft.sort_order ASC`,
      [user.orgId],
    );
    res.json({ success: true, data: funds });
  }),

  // GET /members — admin: list all members (admin dashboard)
  listForAdmin: catchAsync(async (req: Request, res: Response) => {
    const user   = (req as any).user;
    const { limit = '50', offset = '0' } = req.query as Record<string, string>;

    const result = await memberService.listForAdmin(
      user.orgId, Number(limit), Number(offset),
    );

    res.json({ success: true, data: result });
  }),
};
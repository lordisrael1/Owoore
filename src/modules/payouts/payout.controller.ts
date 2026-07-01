import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { payoutService } from './payout.service';
import { payoutRepository } from './payout.repository';
import { Errors } from '../../utils/AppError';

export const payoutController = {
  // POST /payouts — initiate a new payout request
  initiate: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { fund_type_id, bank_code, account_number, amount, purpose } = req.body;

    const result = await payoutService.initiate({
      orgId:         user.orgId,
      fundTypeId:    fund_type_id,
      bankCode:      bank_code,
      accountNumber: account_number,
      initiatedBy:   user.sub,
      amountNaira:   amount,
      purpose,
    });

    res.status(202).json({ success: true, data: result });
  }),

  // GET /payouts — list payout requests for this org
  list: catchAsync(async (req: Request, res: Response) => {
    const user    = (req as any).user;
    const { status, limit = '20', offset = '0' } = req.query as Record<string, string>;

    const payouts = await payoutRepository.list(user.orgId, {
      status: status as any,
      limit:  Number(limit),
      offset: Number(offset),
    });

    res.json({ success: true, data: payouts });
  }),

  // GET /payouts/:id — get single payout with approval records
  getById: catchAsync(async (req: Request, res: Response) => {
    const user   = (req as any).user;
    const payout = await payoutRepository.findById(req.params.id as string, user.orgId);

    if (!payout) throw Errors.notFound('Payout request');
    res.json({ success: true, data: payout });
  }),

  // DELETE /payouts/:id — cancel a PENDING payout
  cancel: catchAsync(async (req: Request, res: Response) => {
    const user   = (req as any).user;
    const result = await payoutService.cancel(req.params.id as string, user.orgId, user.sub);
    res.json({ success: true, data: result });
  }),
};
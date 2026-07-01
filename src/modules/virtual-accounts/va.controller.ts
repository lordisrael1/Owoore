import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { vaService } from './va.service';
import { Errors } from '../../utils/AppError';

export const vaController = {
  /**
   * getOrCreate — POST /me/funds/:fundId/account
   *
   * Lazy VA creation — the member taps "Pay [Fund]" and this runs.
   * Returns the same account number on every subsequent tap.
   * Authentication: member JWT required.
   */
  getOrCreate: catchAsync(async (req: Request, res: Response) => {
    const user       = (req as any).user;
    const fundTypeId = req.params.fundId as string;

    if (!fundTypeId) throw Errors.badRequest('fundId parameter is required');

    const result = await vaService.getOrCreate(user.sub, fundTypeId, user.orgId);

    res.status(result.isNew ? 201 : 200).json({
      success: true,
      data: {
        va_number:         result.vaNumber,
        bank_name:         result.bankName,
        account_reference: result.accountReference,
        is_new:            result.isNew,
        instructions:      `Transfer to ${result.vaNumber} (${result.bankName}) from any Nigerian bank.`,
      },
    });
  }),

  /**
   * getAllMemberVAs — GET /me/accounts
   * Returns all VAs the member has across all funds.
   * Useful for the member portal "My Accounts" view.
   */
  getAllMemberVAs: catchAsync(async (req: Request, res: Response) => {
    const user     = (req as any).user;
    const accounts = await vaService.getMemberVAs(user.sub);
    res.json({ success: true, data: accounts });
  }),
};
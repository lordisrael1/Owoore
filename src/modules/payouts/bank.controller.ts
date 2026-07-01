import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { getAllBanks, lookupBankAccount } from './bank-lookup.service';

export const bankController = {
  listBanks: catchAsync(async (_req: Request, res: Response) => {
    const banks = await getAllBanks();
    res.json({ success: true, data: banks });
  }),

  lookupAccount: catchAsync(async (req: Request, res: Response) => {
    const { accountNumber, bankCode } = req.body;
    const result = await lookupBankAccount(bankCode, accountNumber);
    res.json({ success: true, data: result });
  }),
};

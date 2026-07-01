import { Request, Response } from 'express';
import { catchAsync } from '../../../utils/catchAsync';
import { approvalPayoutService } from './approval.service';

/**
 * approval.controller.ts
 *
 * No JWT authentication on these routes.
 * The approval token IS the credential.
 * Phone last-4 provides identity confirmation.
 */
export const approvalController = {
  // GET /approve/:token — return payout details for the approval page
  getDetails: catchAsync(async (req: Request, res: Response) => {
    const { token } = req.params;
    const details   = await approvalPayoutService.getDetails(token as string);
    res.json({ success: true, data: details });
  }),

  // POST /approve/:token — record approval
  approve: catchAsync(async (req: Request, res: Response) => {
    const { token }     = req.params;
    const { phone_last4 } = req.body;

    const result = await approvalPayoutService.processAction({
      rawToken:   token as string,
      action:     'APPROVED',
      phoneLast4: phone_last4 ?? '',
      ipAddress:  req.ip,
    });

    res.json({ success: true, data: result });
  }),

  // POST /decline/:token — record decline
  decline: catchAsync(async (req: Request, res: Response) => {
    const { token }     = req.params;
    const { phone_last4 } = req.body;

    const result = await approvalPayoutService.processAction({
      rawToken:   token as string,
      action:     'DECLINED',
      phoneLast4: phone_last4 ?? '',
      ipAddress:  req.ip,
    });

    res.json({ success: true, data: result });
  }),
};
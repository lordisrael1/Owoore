import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { signatoryService } from './signatories.service';

export const signatoryController = {
  list: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const data = await signatoryService.list(user.orgId);
    res.json({ success: true, data });
  }),

  create: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { name, email, phone, role, can_initiate, can_approve } = req.body;
    const data = await signatoryService.create(user.orgId, {
      name, email, phone, role, can_initiate, can_approve,
    });
    res.status(201).json({ success: true, data });
  }),

  update: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { name, phone, role, can_initiate, can_approve } = req.body;
    const data = await signatoryService.update(req.params.id as string, user.orgId, {
      name, phone, role, can_initiate, can_approve,
    });
    res.json({ success: true, data });
  }),

  deactivate: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const data = await signatoryService.deactivate(req.params.id as string, user.orgId);
    res.json({ success: true, data });
  }),

  getPolicy: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const data = await signatoryService.getPolicy(user.orgId);
    res.json({ success: true, data });
  }),

  updatePolicy: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { min_approvers, threshold_kobo, token_expiry_hours, auto_decline_hours } = req.body;
    const data = await signatoryService.updatePolicy(user.orgId, {
      min_approvers, threshold_kobo, token_expiry_hours, auto_decline_hours,
    });
    res.json({ success: true, data });
  }),
};
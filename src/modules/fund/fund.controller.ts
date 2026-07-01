import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { fundService } from './fund.service';

export const fundController = {
  // GET /orgs/:orgId/funds
  list: catchAsync(async (req: Request, res: Response) => {
    const user            = (req as any).user;
    const includeInactive = req.query.includeInactive === 'true';
    const funds = await fundService.list(user.orgId, includeInactive);
    res.json({ success: true, data: funds });
  }),

  // POST /orgs/:orgId/funds
  create: catchAsync(async (req: Request, res: Response) => {
    const user  = (req as any).user;
    const { name, kind, description, expected_amt, expires_at } = req.body;

    const fund = await fundService.create(user.orgId, {
      name, kind, description, expected_amt, expires_at,
    });

    res.status(201).json({ success: true, data: fund });
  }),

  // GET /funds/:id
  getById: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const fund = await fundService.getById(req.params.id as string, user.orgId);
    res.json({ success: true, data: fund });
  }),

  // PATCH /funds/:id
  update: catchAsync(async (req: Request, res: Response) => {
    const user    = (req as any).user;
    const updated = await fundService.update(req.params.id as string, user.orgId, req.body);
    res.json({ success: true, data: updated });
  }),

  // DELETE /funds/:id
  deactivate: catchAsync(async (req: Request, res: Response) => {
    const user   = (req as any).user;
    const result = await fundService.deactivate(req.params.id as string, user.orgId);
    res.json({ success: true, data: result });
  }),
};
import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { adminUserService } from './admin-users.service';

export const adminUserController = {
  list: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const data = await adminUserService.listTeam(user.orgId);
    res.json({ success: true, data });
  }),

  setActive: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { id } = req.params;
    const { is_active } = req.body;

    const data = await adminUserService.setActive({
      orgId:      user.orgId,
      actorId:    user.sub,
      actorEmail: user.email,
      targetId:   id as string,
      isActive:   is_active,
    });

    res.json({ success: true, data });
  }),

  invite: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { email, name, role } = req.body;

    const result = await adminUserService.invite({
      orgId:     user.orgId,
      email,
      name,
      role,
      invitedBy: user.sub,
    });

    res.status(201).json({
      success: true,
      data: {
        message: `Invite sent to ${result.email}`,
        adminUserId: result.adminUserId,
      },
    });
  }),

  getInviteDetails: catchAsync(async (req: Request, res: Response) => {
    const { token } = req.params;
    const result = await adminUserService.getInviteDetails(token as string);
    res.json({ success: true, data: result });
  }),

  acceptInviteByToken: catchAsync(async (req: Request, res: Response) => {
    const { token } = req.params;
    const { password } = req.body;

    const result = await adminUserService.acceptInvite(token as string, password);

    res.json({
      success: true,
      data: {
        message: 'Account activated successfully',
        token:   result.token,
        admin:   result.admin,
        org:     result.org,
      },
    });
  }),

  acceptInvite: catchAsync(async (req: Request, res: Response) => {
    const { token, password } = req.body;

    const result = await adminUserService.acceptInvite(token, password);

    res.json({
      success: true,
      data: {
        message: 'Account activated successfully',
        token:   result.token,
        admin:   result.admin,
        org:     result.org,
      },
    });
  }),
};

import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { adminUserService } from './admin-users.service';

export const adminUserController = {
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

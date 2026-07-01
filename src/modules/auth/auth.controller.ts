import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { authService } from './auth.service';
import { adminAuthService } from './admin-auth.service';

export const authController = {
  // POST /auth/send-otp
  sendOtp: catchAsync(async (req: Request, res: Response) => {
    const { email, org_slug } = req.body;
    const result = await authService.sendOtp(email, org_slug);
    res.json({ success: true, data: result });
  }),

  // POST /auth/verify-otp
  verifyOtp: catchAsync(async (req: Request, res: Response) => {
    const { email, code, org_slug, name } = req.body;
    const result = await authService.verifyOtp(email, code, org_slug, name);
    res.json({ success: true, data: result });
  }),

  // POST /auth/admin/login
  adminLogin: catchAsync(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const result = await adminAuthService.login(email, password);
    res.json({ success: true, data: result });
  }),

  // POST /auth/refresh
  refresh: catchAsync(async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: { message: 'No token provided' } });
      return;
    }
    const token  = authHeader.slice(7);
    const result = await authService.refresh(token);
    res.json({ success: true, data: result });
  }),
};

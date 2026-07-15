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

  // POST /auth/admin/verify-email
  verifyAdminEmail: catchAsync(async (req: Request, res: Response) => {
    const { email, code, org_slug } = req.body;
    const result = await adminAuthService.verifyEmail(email, code, org_slug);
    res.json({ success: true, data: result });
  }),

  // POST /auth/admin/forgot-password — emails a reset code (never reveals account existence)
  adminForgotPassword: catchAsync(async (req: Request, res: Response) => {
    const { email } = req.body;
    const result = await adminAuthService.requestPasswordReset(email);
    res.json({ success: true, data: result });
  }),

  // POST /auth/admin/reset-password — verifies the code, sets the new password
  adminResetPassword: catchAsync(async (req: Request, res: Response) => {
    const { email, code, new_password } = req.body;
    const result = await adminAuthService.resetPassword(email, code, new_password);
    res.json({ success: true, data: result });
  }),

  // POST /auth/refresh — exchanges a refresh token for a new access token
  refresh: catchAsync(async (req: Request, res: Response) => {
    const { token } = req.body;
    const result = await authService.refresh(token);
    res.json({ success: true, data: result });
  }),

  // POST /auth/admin/logout — invalidates every session for the caller
  adminLogout: catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    await adminAuthService.logout(user.sub);
    res.json({ success: true, data: { message: 'Logged out. All sessions have been invalidated.' } });
  }),
};

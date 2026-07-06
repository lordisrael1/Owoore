import { Router } from 'express';
import { validateBody } from '../../middleware/validateRequest';
import { otpRateLimiter, adminLoginRateLimiter, generalRateLimiter } from '../../middleware/ratelimiter';
import {
  sendOtpSchema,
  verifyOtpSchema,
  adminLoginSchema,
  verifyAdminEmailSchema,
  adminForgotPasswordSchema,
  adminResetPasswordSchema,
  refreshTokenSchema,
} from './auth.validator';
import { authController } from './auth.controller';

/**
 * auth.routes.ts
 *
 * POST /auth/send-otp          → member requests OTP (rate limited: 3/15min)
 *   Also reused to (re)send the admin email-verification code — it only
 *   needs an org_slug + email, nothing member-specific.
 * POST /auth/verify-otp        → member verifies OTP, gets JWT + refresh token
 * POST /auth/admin/login       → admin email+password login (rate limited: 10/15min)
 * POST /auth/admin/verify-email → confirms a self-registered admin's OTP and
 *   logs them in. Invited admins skip this — accepting the invite link
 *   already proves email ownership.
 * POST /auth/refresh     → exchange a refresh token for a new access token.
 *   Deliberately NOT gated behind the `authenticate` middleware — the whole
 *   point is that this works even after the access token has expired. The
 *   refresh token itself (member_refresh_tokens) is the credential here.
 */
const router = Router();

router.post('/send-otp',
  otpRateLimiter,
  validateBody(sendOtpSchema),
  authController.sendOtp,
);

router.post('/verify-otp',
  validateBody(verifyOtpSchema),
  authController.verifyOtp,
);

router.post('/admin/login',
  adminLoginRateLimiter,
  validateBody(adminLoginSchema),
  authController.adminLogin,
);

router.post('/admin/verify-email',
  validateBody(verifyAdminEmailSchema),
  authController.verifyAdminEmail,
);

// Forgot/reset password for admin + treasurer accounts (both live in
// admin_users). OTP rate limiter on the send; login limiter on the attempt.
router.post('/admin/forgot-password',
  otpRateLimiter,
  validateBody(adminForgotPasswordSchema),
  authController.adminForgotPassword,
);

router.post('/admin/reset-password',
  adminLoginRateLimiter,
  validateBody(adminResetPasswordSchema),
  authController.adminResetPassword,
);

router.post('/refresh',
  generalRateLimiter,
  validateBody(refreshTokenSchema),
  authController.refresh,
);

export default router;
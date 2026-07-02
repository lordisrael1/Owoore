import { Router } from 'express';
import { validateBody } from '../../middleware/validateRequest';
import { otpRateLimiter, adminLoginRateLimiter, generalRateLimiter } from '../../middleware/ratelimiter';
import {
  sendOtpSchema,
  verifyOtpSchema,
  adminLoginSchema,
  refreshTokenSchema,
} from './auth.validator';
import { authController } from './auth.controller';

/**
 * auth.routes.ts
 *
 * POST /auth/send-otp    → member requests OTP (rate limited: 3/15min)
 * POST /auth/verify-otp  → member verifies OTP, gets JWT + refresh token
 * POST /auth/admin/login → admin email+password login (rate limited: 10/15min)
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

router.post('/refresh',
  generalRateLimiter,
  validateBody(refreshTokenSchema),
  authController.refresh,
);

export default router;
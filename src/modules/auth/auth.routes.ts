import { Router } from 'express';
import { validateBody } from '../../middleware/validateRequest';
import { otpRateLimiter, adminLoginRateLimiter } from '../../middleware/ratelimiter';
import { authenticate } from '../../middleware/authenticate';
import {
  sendOtpSchema,
  verifyOtpSchema,
  adminLoginSchema,
} from './auth.validator';
import { authController } from './auth.controller';

/**
 * auth.routes.ts
 *
 * POST /auth/send-otp    → member requests OTP (rate limited: 3/15min)
 * POST /auth/verify-otp  → member verifies OTP, gets JWT
 * POST /auth/admin/login → admin email+password login (rate limited: 10/15min)
 * POST /auth/refresh     → refresh a member JWT (requires valid Bearer token)
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
  authenticate,
  authController.refresh,
);

export default router;
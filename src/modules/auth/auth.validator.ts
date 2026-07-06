import { z } from 'zod';
import { safeText } from '../../utils/sanitize';

export const sendOtpSchema = z.object({
  email:    z.string().email('Enter a valid email address'),
  org_slug: z.string().min(1, 'org_slug is required — use the church join link slug'),
});

export const verifyOtpSchema = z.object({
  email:    z.string().email('Enter a valid email address'),
  code:     z.string().length(6, 'OTP must be 6 digits').regex(/^\d{6}$/, 'OTP must be numeric'),
  org_slug: z.string().min(1, 'org_slug is required'),
  name:     safeText(z.string().min(2, 'Name must be at least 2 characters').max(100)).optional(),
});

export const adminLoginSchema = z.object({
  email:    z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const verifyAdminEmailSchema = z.object({
  email:    z.string().email('Enter a valid email address'),
  code:     z.string().length(6, 'OTP must be 6 digits').regex(/^\d{6}$/, 'OTP must be numeric'),
  org_slug: z.string().min(1, 'org_slug is required'),
});

export const adminForgotPasswordSchema = z.object({
  email: z.string().email('Enter a valid email address'),
});

export const adminResetPasswordSchema = z.object({
  email:        z.string().email('Enter a valid email address'),
  code:         z.string().length(6, 'Code must be 6 digits').regex(/^\d{6}$/, 'Code must be numeric'),
  new_password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export const refreshTokenSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

export type SendOtpInput    = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput  = z.infer<typeof verifyOtpSchema>;
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

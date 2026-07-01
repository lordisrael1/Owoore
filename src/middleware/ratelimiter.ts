import rateLimit from 'express-rate-limit';
import { AppError } from '../utils/AppError';

/**
 * rateLimiter.ts — per-endpoint rate limiting.
 *
 * Three tiers as defined in the folder structure:
 *   OTP endpoints:      3 requests / 15 minutes (brute-force protection)
 *   Approval endpoints: 5 requests / 1 minute   (prevent token scanning)
 *   General API:        100 requests / 1 minute  (general abuse protection)
 *
 * Uses in-memory store by default.
 * For multi-instance Railway deployments, swap to redis store:
 *   npm install rate-limit-redis
 *   import { RedisStore } from 'rate-limit-redis';
 */

const rateLimitErrorHandler = (msg: string) => (_req: any, _res: any, next: any) =>
  next(new AppError(msg, 429, true, 'TOO_MANY_REQUESTS'));

// ── OTP rate limiter ──────────────────────────────────────────────────────
// 3 OTP requests per 15 minutes per IP
// Prevents brute-force OTP enumeration
export const otpRateLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,  // 15 minutes
  max:              3,
  standardHeaders:  true,
  legacyHeaders:    false,
  skipSuccessfulRequests: false,
  handler: rateLimitErrorHandler(
    'Too many OTP requests from this IP. Please wait 15 minutes before trying again.',
  ),
});

// ── Approval link rate limiter ────────────────────────────────────────────
// 5 requests per minute per IP on approval endpoints
// Prevents scanning for valid approval tokens
export const approvalRateLimiter = rateLimit({
  windowMs:         60 * 1000,        // 1 minute
  max:              5,
  standardHeaders:  true,
  legacyHeaders:    false,
  handler: rateLimitErrorHandler(
    'Too many approval requests. Please wait a moment.',
  ),
});

// ── General API rate limiter ──────────────────────────────────────────────
// 100 requests per minute per IP — broad protection
export const generalRateLimiter = rateLimit({
  windowMs:         60 * 1000,        // 1 minute
  max:              100,
  standardHeaders:  true,
  legacyHeaders:    false,
  handler: rateLimitErrorHandler(
    'Too many requests. Please slow down.',
  ),
});

// ── Admin login rate limiter ──────────────────────────────────────────────
// 10 attempts per 15 minutes — prevent credential stuffing
export const adminLoginRateLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  handler: rateLimitErrorHandler(
    'Too many login attempts. Please wait 15 minutes.',
  ),
});
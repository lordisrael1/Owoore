import { logger } from '../../utils/logger';
import { authRepository } from './auth.repository';
import { Errors } from '../../utils/AppError';
import { getRedisClient as getRedis } from '../../config/redis';

const OTP_TTL_SECONDS   = 10 * 60;
const MAX_ATTEMPTS       = 5;
const RATE_LIMIT_MAX     = 3;

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export const otpService = {
  async send(email: string): Promise<string> {
    const recent = await authRepository.countRecentOtps(email);
    if (recent >= RATE_LIMIT_MAX) {
      throw Errors.tooManyRequests(
        'Too many OTP requests. Please wait 15 minutes before requesting another code.',
      );
    }

    const code      = generateCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

    try {
      const redis    = await getRedis();
      const redisKey = `otp:${email}`;
      await redis.setEx(redisKey, OTP_TTL_SECONDS, code);
    } catch (err: any) {
      logger.warn({ err: err.message },
        '[OTP] Redis store failed — falling back to DB only');
    }

    await authRepository.saveOtp(email, code, expiresAt);

    logger.info({ email }, '[OTP] Code generated and stored');

    return code;
  },

  /**
   * checkValid — confirms the code is correct WITHOUT consuming it.
   * Throws if invalid/expired/too many attempts.
   *
   * Safe to call more than once for the same code (e.g. a first request
   * that turns out to need more info — like a new member's display name —
   * before the OTP should actually be spent). The caller is responsible
   * for calling consume() once the full flow has succeeded.
   */
  async checkValid(email: string, code: string): Promise<void> {
    try {
      const redis    = await getRedis();
      const redisKey = `otp:${email}`;
      const stored   = await redis.get(redisKey);

      if (stored !== null && stored === code) {
        return; // valid — caller decides when to consume
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, '[OTP] Redis verify failed — falling back to DB');
    }

    const dbOtp = await authRepository.getActiveOtp(email);

    if (!dbOtp) {
      throw Errors.badRequest('OTP expired or not found. Please request a new code.');
    }

    if (dbOtp.code !== code) {
      const attempts = await authRepository.incrementAttempts(dbOtp.id);

      if (attempts > MAX_ATTEMPTS) {
        await authRepository.markUsed(dbOtp.id);
        throw Errors.tooManyRequests(
          'Too many incorrect attempts. Please request a new OTP.',
        );
      }

      const remaining = MAX_ATTEMPTS - attempts;
      throw Errors.badRequest(
        `Incorrect OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      );
    }
    // valid in DB — caller decides when to consume
  },

  /**
   * consume — marks the OTP as spent. Call ONLY after the full verify
   * flow has succeeded (member resolved, about to issue the JWT).
   */
  async consume(email: string): Promise<void> {
    try {
      const redis = await getRedis();
      await redis.del(`otp:${email}`);
    } catch (err: any) {
      logger.warn({ err: err.message }, '[OTP] Redis consume failed');
    }

    const dbOtp = await authRepository.getActiveOtp(email);
    if (dbOtp) await authRepository.markUsed(dbOtp.id);
  },
};

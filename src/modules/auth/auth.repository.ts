import { query, queryOne } from '../../db';

export const authRepository = {
  async saveOtp(email: string, code: string, expiresAt: Date): Promise<void> {
    await query(
      `UPDATE otp_tokens SET used_at = NOW()
       WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [email],
    );

    await query(
      `INSERT INTO otp_tokens (email, code, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [email, code, expiresAt],
    );
  },

  async getActiveOtp(email: string): Promise<{
    id: string; code: string; attempts: number; expires_at: Date;
  } | null> {
    return queryOne(
      `SELECT id, code, attempts, expires_at FROM otp_tokens
       WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
  },

  async incrementAttempts(otpId: string): Promise<number> {
    const row = await queryOne<{ attempts: number }>(
      `UPDATE otp_tokens SET attempts = attempts + 1
       WHERE id = $1 RETURNING attempts`,
      [otpId],
    );
    return row?.attempts ?? 0;
  },

  async markUsed(otpId: string): Promise<void> {
    await query(
      `UPDATE otp_tokens SET used_at = NOW() WHERE id = $1`,
      [otpId],
    );
  },

  async countRecentOtps(email: string): Promise<number> {
    const row = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM otp_tokens
       WHERE email = $1 AND created_at > NOW() - INTERVAL '15 minutes'`,
      [email],
    );
    return Number(row?.count ?? 0);
  },
};

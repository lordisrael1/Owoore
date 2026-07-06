import { z } from 'zod';

// Optional vars copied from .env.example arrive as EMPTY STRINGS
// (`KEY=`), which would fail .email()/.length() checks and block boot.
// Treat empty as unset so a verbatim copy of the example still starts.
const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v);

const envSchema = z.object({
  // ── Server ────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('4000').transform(Number),

  // ── Database ──────────────────────────────────────────────
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid postgres connection string' }),

  // ── Redis ─────────────────────────────────────────────────
  REDIS_URL: z.string().url({ message: 'REDIS_URL must be a valid redis connection string' }),

  // ── Nomba ─────────────────────────────────────────────────
  NOMBA_BASE_URL: z.string().url().default('https://sandbox.api.nomba.com/v1'),
  NOMBA_ACCOUNT_ID: z.string().min(1, 'NOMBA_ACCOUNT_ID is required'),
  NOMBA_SUB_ACCOUNT_ID: z.string().min(1, 'NOMBA_SUB_ACCOUNT_ID is required'),
  NOMBA_CLIENT_ID: z.string().min(1, 'NOMBA_CLIENT_ID is required'),
  NOMBA_CLIENT_SECRET: z.string().min(1, 'NOMBA_CLIENT_SECRET is required'),
  NOMBA_WEBHOOK_SECRET: z.string().min(1, 'NOMBA_WEBHOOK_SECRET is required'),
  // Fee headroom reserved when checking balances before an outbound transfer.
  // The ACTUAL fee is always taken from the payout_success webhook — this
  // buffer only prevents "insufficient funds" when paying out a full balance.
  NOMBA_TRANSFER_FEE_KOBO: z.string().default('2000').transform(Number),

  // ── JWT ───────────────────────────────────────────────────
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_MEMBER_EXPIRES_IN: z.string().default('1h'),
  JWT_ADMIN_EXPIRES_IN: z.string().default('1d'),
  JWT_MEMBER_REFRESH_EXPIRES_DAYS: z.string().default('30').transform(Number),

  // ── Resend (email) ────────────────────────────────────────
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY is required'),
  RESEND_FROM_ADDRESS: z.string().email().default('noreply@owoore.ng'),
  RESEND_FROM_NAME: z.string().default('Owoore'),
  // Ops inbox for operational alerts (e.g. a webhook event that exhausted
  // all retries and landed in the dead-letter queue). Optional: when unset
  // the alert is still logged at ERROR level, just not emailed.
  OPS_ALERT_EMAIL: z.preprocess(emptyAsUndefined, z.string().email().optional()),

  // ── Cloudinary ────────────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: z.string().min(1, 'CLOUDINARY_CLOUD_NAME is required'),
  CLOUDINARY_API_KEY:    z.string().min(1, 'CLOUDINARY_API_KEY is required'),
  CLOUDINARY_API_SECRET: z.string().min(1, 'CLOUDINARY_API_SECRET is required'),

  // ── App ───────────────────────────────────────────────────
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  APPROVAL_LINK_BASE_URL: z.string().url().default('http://localhost:3000/approve'),

  // ── Demo / judging credentials ────────────────────────────
  // When BOTH are set, DEMO_MEMBER_EMAIL logs in with the fixed
  // DEMO_OTP_CODE — no OTP is generated, stored, or emailed. Lets
  // judges use published test credentials without inbox access.
  // Leave unset (the default) and the shortcut does not exist.
  DEMO_MEMBER_EMAIL: z.preprocess(emptyAsUndefined, z.string().email().optional()),
  DEMO_OTP_CODE:     z.preprocess(emptyAsUndefined,
                       z.string().length(6).regex(/^\d{6}$/).optional()),
});

// Parse and validate — throws with a clear message if any var is missing
const _parsed = envSchema.safeParse(process.env);

if (!_parsed.success) {
  const errors = _parsed.error.issues
    .map((e) => `  x ${e.path.join('.')}: ${e.message}`)
    .join('\n');

  console.error('\n[Owoore] Missing or invalid environment variables:\n');
  console.error(errors);
  console.error('\nCheck your .env file against .env.example and restart.\n');
  process.exit(1);
}

export const env = _parsed.data;
export type Env = typeof env;
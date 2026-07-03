/**
 * AppError — custom error class for all operational errors.
 *
 * isOperational = true  → known, expected error (400, 401, 403, 404, 409)
 *                         logged as WARN, response sent to client
 * isOperational = false → programming bug or unexpected failure
 *                         logged as ERROR, generic 500 sent to client
 *
 * Usage:
 *   throw new AppError('Phone number already registered', 409);
 *   throw new AppError('Invalid OTP', 400);
 *   throw new AppError('Payout request not found', 404);
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    this.details = details;

    // Maintains proper stack trace in V8
    Error.captureStackTrace(this, this.constructor);

    // Required for instanceof checks to work with transpiled TS
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// ── Common error factories ────────────────────────────────────────────────
// Import and use these instead of building AppError manually each time

export const Errors = {
  notFound: (resource: string) =>
    new AppError(`${resource} not found`, 404, true, 'NOT_FOUND'),

  unauthorized: (msg = 'Authentication required') =>
    new AppError(msg, 401, true, 'UNAUTHORIZED'),

  forbidden: (msg = 'You do not have permission to perform this action') =>
    new AppError(msg, 403, true, 'FORBIDDEN'),

  badRequest: (msg: string) =>
    new AppError(msg, 400, true, 'BAD_REQUEST'),

  conflict: (msg: string) =>
    new AppError(msg, 409, true, 'CONFLICT'),

  unprocessable: (msg: string) =>
    new AppError(msg, 422, true, 'UNPROCESSABLE'),

  tooManyRequests: (msg = 'Too many requests. Please try again later.') =>
    new AppError(msg, 429, true, 'TOO_MANY_REQUESTS'),

  internal: (msg = 'An unexpected error occurred') =>
    new AppError(msg, 500, false, 'INTERNAL_ERROR'),

  nombaError: (msg: string) =>
    new AppError(`Nomba API error: ${msg}`, 502, true, 'NOMBA_ERROR'),

  payoutNotActionable: (status: string) =>
    new AppError(
      `Payout request cannot be actioned in status: ${status}`,
      409,
      true,
      'PAYOUT_NOT_ACTIONABLE',
    ),

  tokenExpired: () =>
    new AppError('This approval link has expired. Contact your treasurer.', 410, true, 'TOKEN_EXPIRED'),

  tokenUsed: () =>
    new AppError('This approval link has already been used.', 410, true, 'TOKEN_USED'),

  emailNotVerified: (orgSlug?: string) =>
    new AppError(
      'Please verify your email before logging in.',
      403,
      true,
      'EMAIL_NOT_VERIFIED',
      orgSlug ? { orgSlug } : undefined,
    ),
} as const;
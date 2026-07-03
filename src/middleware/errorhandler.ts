import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { env } from '../config/env';

/**
 * errorHandler — global Express error middleware.
 *
 * Must be registered LAST in app.ts after all routes.
 * Catches everything forwarded via next(err) or catchAsync.
 *
 * Two error types:
 *   AppError (isOperational=true)  → known error, structured JSON response
 *   AppError (isOperational=false) → programming bug, generic 500
 *   Unknown Error                  → programming bug, generic 500
 *
 * Stack traces are ONLY included in development responses.
 */
export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // ── AppError (operational) ──────────────────────────────────────────────
  if (err instanceof AppError && err.isOperational) {
    logger.warn({
      err_code:   err.code,
      err_msg:    err.message,
      status:     err.statusCode,
      method:     req.method,
      path:       req.path,
      org_id:     (req as any).orgId,
    }, 'Operational error');

    res.status(err.statusCode).json({
      success: false,
      error: {
        code:    err.code ?? 'ERROR',
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    });
    return;
  }

  // ── Unknown / programming error ──────────────────────────────────────────
  logger.error({
    err_name:   err.name,
    err_msg:    err.message,
    stack:      err.stack,
    method:     req.method,
    path:       req.path,
  }, 'Unhandled server error');

  res.status(500).json({
    success: false,
    error: {
      code:    'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please try again.',
      ...(env.NODE_ENV === 'development' && {
        debug: err.message,
        stack: err.stack,
      }),
    },
  });
}
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * Credentials must never reach the log stream. CSV downloads carry the
 * JWT as a ?token= query param (window.open can't set headers), and
 * originalUrl would otherwise write that bearer token into persistent
 * logs — replayable by anyone with log access until it expires.
 */
const SENSITIVE_QUERY_PARAMS = /([?&](?:token|code|access_token|refresh_token|authorization)=)[^&#]*/gi;

export function redactUrl(url: string): string {
  return url.replace(SENSITIVE_QUERY_PARAMS, '$1[REDACTED]');
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    logger.info({
      method:     req.method,
      path:       redactUrl(req.originalUrl),
      status:     res.statusCode,
      duration_ms: Date.now() - start,
      ip:         req.ip,
      user_agent: req.get('user-agent'),
    }, 'HTTP request');
  });

  next();
}

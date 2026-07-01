import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    logger.info({
      method:     req.method,
      path:       req.originalUrl,
      status:     res.statusCode,
      duration_ms: Date.now() - start,
      ip:         req.ip,
      user_agent: req.get('user-agent'),
    }, 'HTTP request');
  });

  next();
}

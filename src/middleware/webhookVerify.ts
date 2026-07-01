import { Request, Response, NextFunction } from 'express';
import { verifyNombaSignature } from '../utils/crypto';
import { logger } from '../utils/logger';
import { Errors } from '../utils/AppError';

/**
 * webhookVerify — Nomba HMAC-SHA256 signature verification.
 *
 * MUST run before ANY processing of the webhook payload.
 * If the signature check fails, we return 401 immediately —
 * no payload is parsed, no DB queries run.
 *
 * CRITICAL: this middleware requires the RAW request body as a Buffer.
 * In app.ts, the webhook route must use express.raw() NOT express.json():
 *
 *   app.use('/api/v1/webhooks/nomba', express.raw({ type: 'application/json' }));
 *   app.use('/api/v1/webhooks/nomba', webhookVerify);
 *
 * After this middleware, req.body is the raw Buffer.
 * The webhook controller parses it with JSON.parse(req.body.toString()).
 *
 * From Nomba docs:
 *   "Verify the nomba-signature HMAC before doing anything else."
 */
export function webhookVerify(req: Request, _res: Response, next: NextFunction): void {
  const signature = req.headers['nomba-signature']  as string | undefined;
  const timestamp = req.headers['nomba-timestamp']   as string | undefined;

  if (!signature) {
    logger.warn({ path: req.path, ip: req.ip },
      'Webhook received without nomba-signature header — rejected');
    return next(Errors.unauthorized('Missing nomba-signature header'));
  }

  if (!timestamp) {
    logger.warn({ path: req.path, ip: req.ip },
      'Webhook received without nomba-timestamp header — rejected');
    return next(Errors.unauthorized('Missing nomba-timestamp header'));
  }

  const rawBody = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody)) {
    logger.error({ path: req.path, body_type: typeof rawBody },
      'Webhook body is not a Buffer — express.raw() middleware missing on this route');
    return next(Errors.internal('Webhook body parsing misconfiguration'));
  }

  const isValid = verifyNombaSignature(rawBody, signature, timestamp);

  if (!isValid) {
    logger.warn({
      path:      req.path,
      ip:        req.ip,
      signature: signature.slice(0, 16) + '...', // log prefix only
    }, 'Invalid Nomba webhook signature — rejected');

    return next(Errors.unauthorized('Invalid webhook signature'));
  }

  logger.debug({ path: req.path }, 'Nomba webhook signature verified');
  next();
}
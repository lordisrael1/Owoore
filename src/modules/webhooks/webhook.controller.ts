import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { webhookProcessor } from './webhook.processor';

/**
 * webhook.controller.ts
 *
 * The single job of this controller: ACK 200 to Nomba IMMEDIATELY,
 * then hand off to the processor asynchronously.
 *
 * Why this matters:
 *   Nomba retries webhook delivery if it doesn't receive a 2xx within
 *   a few seconds. If we do DB writes, ledger updates, and SMS sends
 *   synchronously before responding, a slow DB query causes a retry —
 *   and now we're processing the same event twice.
 *
 * Pattern: receive → ACK → process async → idempotency guard in processor.
 *
 * The processor handles duplicate events via the idempotency service —
 * even if Nomba retries, the second event is a no-op.
 */
export const webhookController = {
  handle(req: Request, res: Response): void {
    // ACK immediately — Nomba needs this within ~5 seconds
    res.sendStatus(200);

    // Parse the raw Buffer body (set by express.raw() in app.ts)
    let event: Record<string, unknown>;
    try {
      event = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch (err) {
      logger.error({ err }, '[Webhook] Failed to parse webhook body as JSON');
      return; // Already ACKed — just log and drop
    }

    const requestId = event.requestId as string | undefined;
    const eventType = (event.event_type ?? event.event) as string | undefined;

    logger.info({
      nomba_request_id: requestId,
      event_type:       eventType,
    }, '[Webhook] Received — processing async');

    // Fire and forget — processor handles idempotency and errors internally
    webhookProcessor.process(event).catch((err) => {
      logger.error({
        nomba_request_id: requestId,
        event_type:       eventType,
        err:              err.message,
      }, '[Webhook] Async processing failed');
    });
  },
};
import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { catchAsync } from '../../utils/catchAsync';
import { enqueueNombaEvent } from '../../queue/webhook.queue';

/**
 * webhook.controller.ts
 *
 * The 200 we return to Nomba is a durability contract: once Nomba sees
 * it, the event is NEVER resent. So the order here is everything:
 *
 *   1. HMAC signature verified (webhookVerify middleware, raw body)
 *   2. Parse — reject garbage with 400 BEFORE acking
 *   3. ONE durable write: enqueue to pg-boss (a Postgres row, ~ms)
 *   4. Only then ACK 200 — the event now survives crash/redeploy
 *
 * If the enqueue throws (DB down, timeout), catchAsync surfaces a 500 —
 * a non-2xx is exactly right: Nomba retries on its schedule, and the
 * retry lands when the database is back. Failing to ACK when we cannot
 * durably store is honest; ACKing from memory is lying.
 *
 * Processing happens in the pg-boss worker (see queue/webhook.queue.ts)
 * with retries + backoff. Idempotency lives where it always did — the
 * UNIQUE constraint on webhook_log.nomba_request_id in the processor.
 */
export const webhookController = {
  handle: catchAsync(async (req: Request, res: Response): Promise<void> => {
    // Parse the raw Buffer body (set by express.raw() in app.ts).
    // Signature verification already passed, so garbage here is a
    // malformed-but-authentic payload — 400 tells Nomba, pre-ACK.
    let event: Record<string, unknown>;
    try {
      event = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      logger.error('[Webhook] Signed payload is not valid JSON — rejected with 400');
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PAYLOAD', message: 'Body is not valid JSON' },
      });
      return;
    }

    const requestId = event.requestId as string | undefined;
    const eventType = (event.event_type ?? event.event) as string | undefined;

    // No requestId → nothing to dedupe or process. ACK and drop:
    // retrying an unprocessable event forever helps nobody.
    if (!requestId) {
      logger.warn({ event_type: eventType },
        '[Webhook] Event missing requestId — acknowledged and dropped');
      res.sendStatus(200);
      return;
    }

    // The one durable write. Throws → 500 → Nomba retries.
    const jobId = await enqueueNombaEvent(event, requestId);

    logger.info({
      nomba_request_id: requestId,
      event_type:       eventType,
      job_id:           jobId ?? 'duplicate-suppressed',
    }, '[Webhook] Event durably enqueued — ACK');

    res.sendStatus(200);
  }),
};

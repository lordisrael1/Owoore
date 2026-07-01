import { logger } from '../../utils/logger';
import { idempotencyService } from './idempotency.service';
import { webhookRepository } from './webhook.repository';
import { inflowHandlerService } from './inflow-handler.service';
import { nombaTransferService } from '../payouts/nomba-transfer.service';

/**
 * webhook.processor.ts
 *
 * Routes each Nomba event to the correct handler after idempotency check.
 *
 * Supported events:
 *   payment_success  → inflowHandlerService   (member payment in)
 *   payout_success   → nombaTransferService   (payout settled)
 *   payout_failed    → nombaTransferService   (payout reversed)
 *
 * No dynamic imports — all handlers are real modules imported at the top.
 * No circular dependency: webhooks → payouts is one direction only.
 * payouts never imports from webhooks.
 */

export interface NombaWebhookEvent {
  requestId: string;
  event:     string;
  data:      Record<string, unknown>;
  [key: string]: unknown;
}

export const webhookProcessor = {
  async process(raw: Record<string, unknown>): Promise<void> {
    const event = raw as NombaWebhookEvent;
    const requestId = event.requestId;
    const eventType = (event.event_type ?? event.event) as string;
    const data      = event.data as Record<string, unknown>;

    if (!requestId) {
      logger.warn('[WebhookProcessor] Event missing requestId — cannot process safely');
      return;
    }

    // ── Step 1: Idempotency check ───────────────────────────────────────
    const alreadyProcessed = await idempotencyService.isProcessed(requestId);
    if (alreadyProcessed) {
      logger.info({ nomba_request_id: requestId, event_type: eventType },
        '[WebhookProcessor] Duplicate event — skipping');
      return;
    }

    // ── Step 2: Log raw event ───────────────────────────────────────────
    const logId = await webhookRepository.logEvent({
      nomba_request_id: requestId,
      event_type:       eventType,
      raw_payload:      event,
    });

    // ── Step 3: Route to handler ────────────────────────────────────────
    try {
      switch (eventType) {
        case 'payment_success':
          await inflowHandlerService.handle(data, requestId);
          break;

        case 'payout_success':
          // Payout settled — update status TRANSFERRING→TRANSFERRED, debit ledger
          await nombaTransferService.handleTransferSuccess(data, requestId);
          break;

        case 'payout_failed':
        case 'payout_refund':    // refunded = failed + funds returned
        case 'payment_reversal': // payment reversed back to sender
          // All three mean the payout didn't settle — release soft lock, mark FAILED
          await nombaTransferService.handleTransferFailed(data, requestId);
          break;

        case 'payment_failed':
          // Inbound payment attempt failed — nothing to credit, just log
          logger.info({ requestId, eventType }, '[WebhookProcessor] payment_failed — no action required');
          break;

        default:
          logger.info({ eventType, requestId },
            '[WebhookProcessor] Unrecognised event type — logged, no action');
          break;
      }

      // ── Step 4: Mark processed ─────────────────────────────────────────
      await idempotencyService.markProcessed(requestId);
      await webhookRepository.markProcessed(logId);

      logger.info({ nomba_request_id: requestId, event_type: eventType },
        '[WebhookProcessor] Event processed successfully');

    } catch (err: any) {
      await webhookRepository.markFailed(logId, err.message);

      logger.error({
        nomba_request_id: requestId,
        event_type:       eventType,
        err:              err.message,
      }, '[WebhookProcessor] Handler failed — event marked for replay');

      throw err;
    }
  },
};
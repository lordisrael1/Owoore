import { query, queryOne } from '../../db';
import { logger } from '../../utils/logger';

/**
 * webhook.repository.ts
 *
 * Writes to the webhook_log table — every Nomba event is persisted
 * before processing begins. Provides full audit trail and enables
 * manual replay of failed events.
 */

interface LogEventInput {
  nomba_request_id: string;
  event_type:       string;
  raw_payload:      Record<string, unknown>;
  org_id?:          string;
}

export const webhookRepository = {
  /**
   * logEvent — inserts the raw event into webhook_log.
   *
   * Returns the internal UUID of the log row so we can update
   * it later (markProcessed / markFailed).
   *
   * If the nomba_request_id already exists (duplicate delivery
   * that slipped past the idempotency check), the INSERT is
   * silently ignored via ON CONFLICT DO NOTHING.
   */
  async logEvent(input: LogEventInput): Promise<string> {
    const { nomba_request_id, event_type, raw_payload, org_id } = input;

    try {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO webhook_log
           (nomba_request_id, event_type, raw_payload, org_id, processed, received_at)
         VALUES ($1, $2, $3, $4, FALSE, NOW())
         ON CONFLICT (nomba_request_id) DO NOTHING
         RETURNING id`,
        [nomba_request_id, event_type, JSON.stringify(raw_payload), org_id ?? null],
      );

      if (!row) {
        // ON CONFLICT hit — duplicate, return a sentinel
        logger.debug({ nomba_request_id }, '[WebhookRepo] Duplicate insert skipped');
        return 'duplicate';
      }

      return row.id;
    } catch (err: any) {
      logger.error({ nomba_request_id, err: err.message },
        '[WebhookRepo] Failed to log event — continuing with processing');
      // Non-fatal: processing continues even if logging fails
      return 'log-failed';
    }
  },

  /**
   * markProcessed — updates the log row after successful processing.
   */
  async markProcessed(logId: string): Promise<void> {
    if (logId === 'duplicate' || logId === 'log-failed') return;

    await query(
      `UPDATE webhook_log
       SET processed = TRUE, processed_at = NOW()
       WHERE id = $1`,
      [logId],
    );
  },

  /**
   * markFailed — records the error message when processing fails.
   * These rows are queryable for manual replay or monitoring.
   */
  async markFailed(logId: string, errorMessage: string): Promise<void> {
    if (logId === 'duplicate' || logId === 'log-failed') return;

    await query(
      `UPDATE webhook_log
       SET processed = FALSE, processing_error = $1
       WHERE id = $2`,
      [errorMessage, logId],
    ).catch((err) => {
      logger.error({ logId, err: err.message }, '[WebhookRepo] Failed to mark event as failed');
    });
  },

  /**
   * getUnprocessed — returns failed/unprocessed events for replay.
   * Used by a manual admin endpoint or monitoring script.
   */
  async getUnprocessed(limit = 50): Promise<Array<{ id: string; nomba_request_id: string; event_type: string; raw_payload: Record<string, unknown>; received_at: Date }>> {
    const result = await query<{
      id: string;
      nomba_request_id: string;
      event_type: string;
      raw_payload: Record<string, unknown>;
      received_at: Date;
    }>(
      `SELECT id, nomba_request_id, event_type, raw_payload, received_at
       FROM webhook_log
       WHERE processed = FALSE
       ORDER BY received_at ASC
       LIMIT $1`,
      [limit],
    );

    return result.rows;
  },
};
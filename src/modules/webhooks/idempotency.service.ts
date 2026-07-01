import { queryOne } from '../../db';
import { logger } from '../../utils/logger';

/**
 * idempotency.service.ts
 *
 * Prevents duplicate event processing using a two-layer guard:
 *
 * Layer 1 — Database (webhook_log table):
 *   The nomba_request_id has a UNIQUE constraint in webhook_log.
 *   Any attempt to insert a duplicate will fail at the DB level.
 *   This is the durable, persistent guard.
 *
 * Layer 2 — In-memory Set (fast path):
 *   For the duration of the process lifetime, processed IDs are
 *   cached in memory to short-circuit before hitting the DB.
 *   Cleared on restart — the DB guard picks it up on the next call.
 *
 * From Nomba docs:
 *   "Webhooks may fire twice. Store event.requestId in a unique
 *    index and reject duplicates — never apply a balance change twice."
 */

// In-memory fast-path cache (process lifetime only)
const processedIds = new Set<string>();

export const idempotencyService = {
  /**
   * isProcessed — checks if this requestId has already been handled.
   *
   * Checks memory first (O(1)), then DB (single indexed query).
   * Returns true if the event should be skipped.
   */
  async isProcessed(requestId: string): Promise<boolean> {
    // Fast path: check in-memory set
    if (processedIds.has(requestId)) {
      return true;
    }

    // Durable path: check DB
    try {
      const row = await queryOne<{ id: string }>(
        `SELECT id FROM webhook_log
         WHERE nomba_request_id = $1
           AND processed = TRUE
         LIMIT 1`,
        [requestId],
      );

      if (row) {
        // Warm the in-memory cache
        processedIds.add(requestId);
        return true;
      }

      return false;
    } catch (err: any) {
      logger.error({ requestId, err: err.message },
        '[Idempotency] DB check failed — allowing processing to continue');
      // On DB error, allow processing — the UNIQUE constraint is the hard stop
      return false;
    }
  },


//   TODO: const row = await queryOne<{ exists: number }>(
//   `SELECT 1 AS exists
//    FROM webhook_log
//    WHERE nomba_request_id = $1
//      AND processed = TRUE
//    LIMIT 1`,
//   [requestId],
// );

  /**
   * markProcessed — records that this requestId has been successfully handled.
   *
   * Adds to in-memory cache AND the DB is updated by webhookRepository.markProcessed.
   * This method only handles the in-memory side.
   */
  async markProcessed(requestId: string): Promise<void> {
    processedIds.add(requestId);

    // Cap memory cache size to prevent unbounded growth on long-running processes
    if (processedIds.size > 10_000) {
      const oldest = processedIds.values().next().value;
      if (oldest) processedIds.delete(oldest);
    }
  },

  /**
   * clearCache — for testing only. Resets the in-memory set.
   */
  clearCache(): void {
    processedIds.clear();
  },
};
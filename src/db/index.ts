import { QueryResult, QueryResultRow } from 'pg';
import { pool } from '../config/database';
import { env } from '../config/env';

/**
 * query<T> — the single DB access point for the entire application.
 *
 * Every module imports this function — nothing imports pool directly.
 * This gives us one place to add:
 *   - structured logging (nomba_ref tagged)
 *   - read-replica routing in future
 *   - query timeout injection
 *   - test transaction wrapping
 *
 * @param text   - parameterised SQL string
 * @param params - values array for $1, $2 … placeholders
 */
export async function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now();

  try {
    const result = await pool.query<T>(text, params);

    if (env.NODE_ENV === 'development') {
      const duration = Date.now() - start;
      console.log('[DB]', {
        query: text.replace(/\s+/g, ' ').trim().slice(0, 100),
        rows: result.rowCount,
        duration: `${duration}ms`,
      });
    }

    return result;
  } catch (err: unknown) {
    const duration = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);

    console.error('[DB] Query error', {
      query: text.replace(/\s+/g, ' ').trim().slice(0, 100),
      duration: `${duration}ms`,
      error: message,
    });

    throw err;
  }
}

/**
 * withTransaction<T> — wraps multiple queries in a single ACID transaction.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     await client.query('INSERT INTO ...', [...]);
 *     await client.query('UPDATE ...', [...]);
 *     return someValue;
 *   });
 *
 * Commits on success, rolls back automatically on any throw.
 * Used by: ledger updates, payout state transitions, webhook processing.
 */
export async function withTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Transaction rolled back:', err instanceof Error ? err.message : err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * queryOne<T> — returns the first row or null. Convenience wrapper
 * used throughout repositories to avoid repetitive result.rows[0] checks.
 */
export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

/**
 * queryMany<T> — returns all rows. Explicit alias for clarity
 * when the caller expects a list rather than a single record.
 */
export async function queryMany<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

/**
 * exists — returns true if at least one row matches the query.
 * Useful for uniqueness checks without fetching the full record.
 *
 * Example:
 *   const taken = await exists('SELECT 1 FROM members WHERE phone = $1', [phone]);
 */
export async function exists(text: string, params?: unknown[]): Promise<boolean> {
  const result = await query(text, params);
  return (result.rowCount ?? 0) > 0;
}
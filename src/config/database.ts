import { Pool, PoolConfig, QueryResultRow } from 'pg';
import { env } from './env';

const poolConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,
  // Tests run against the remote DB — keep their pools small so a test
  // run never crowds out the deployed app's connections
  max: env.NODE_ENV === 'test' ? 5 : 20,
  idleTimeoutMillis: 30000, // close idle connections after 30s
  // Cross-provider connects (Render app → Railway Postgres proxy) can take
  // several seconds cold — 5s caused spurious "connection timeout" failures
  connectionTimeoutMillis: 15000,
  ssl: env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false } // Railway postgres requires SSL
    : false,
};

export const pool = new Pool(poolConfig);

// Graceful shutdown — drain pool on SIGINT / SIGTERM
process.on('SIGINT', async () => {
  await pool.end();
});
process.on('SIGTERM', async () => {
  await pool.end();
});

/**
 * testConnection — called at startup to verify DB is reachable.
 * Exits the process immediately if it cannot connect so Railway
 * knows the deploy failed rather than serving a broken app.
 */
export async function testConnection(): Promise<void> {
  let client;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    console.log('[DB] PostgreSQL connection established');
  } catch (err) {
    console.error('[DB] Failed to connect to PostgreSQL:', err);
    process.exit(1);
  } finally {
    client?.release();
  }
}

/**
 * query — thin wrapper around pool.query with structured error logging.
 * All modules import this instead of the pool directly so we have
 * one place to add query logging, tracing, or read-replica routing later.
 */
export async function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<import('pg').QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;

    if (env.NODE_ENV === 'development') {
      console.log('[DB] query', { text: text.slice(0, 120), duration, rows: result.rowCount });
    }

    return result;
  } catch (err) {
    console.error('[DB] query error', { text: text.slice(0, 120), err });
    throw err;
  }
}
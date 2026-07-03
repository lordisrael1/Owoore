import { createClient } from 'redis';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * redis.ts — single shared Redis client, lazily connected.
 *
 * node-redis (the `redis` package, v4+) requires an explicit async
 * connect() before use — unlike `pg.Pool`, which connects lazily per
 * query. getRedisClient() memoises the connected client so every caller
 * (OTP storage, cache-aside helpers, etc.) reuses one connection.
 */
let client: ReturnType<typeof createClient> | null = null;

export async function getRedisClient() {
  if (client?.isOpen) return client;

  client = createClient({ url: env.REDIS_URL });
  client.on('error', (err) =>
    logger.error({ err: err.message }, '[Redis] Connection error'),
  );
  await client.connect();
  return client;
}

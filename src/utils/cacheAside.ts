import { getRedisClient } from '../config/redis';
import { logger } from './logger';

/**
 * cacheAside.ts — cache-aside read-through with stampede protection.
 *
 * Problem this solves: when a cached value expires, many concurrent callers
 * for the SAME key would otherwise all miss at once and hit the DB
 * simultaneously (thundering herd). Only one of them should rebuild the
 * cache; the rest should wait briefly for it, or fall back to a direct
 * fetch if the rebuild is taking too long.
 *
 * Only worth reaching for when a key is genuinely shared across many
 * concurrent callers (e.g. org-wide data hit by every member of a church).
 * A per-user key doesn't stampede — each caller only ever contends with
 * their own past requests — so it isn't a fit for data whose freshness
 * matters more than shaving a cheap, already-indexed query.
 *
 * Redis failures (connection down, command error) degrade to calling
 * fetch() directly — caching is a performance optimisation, never a hard
 * dependency for the request to succeed. This is deliberately NOT the same
 * try/catch as fetch() itself: a real error from fetch() (e.g. a genuine DB
 * failure) must propagate to the caller untouched, never be mistaken for a
 * Redis hiccup and silently retried.
 */

export interface CacheAsideOptions<T> {
  key:             string;
  ttlSeconds:      number;
  fetch:           () => Promise<T>;
  lockTtlSeconds?: number; // how long the rebuild lock lives — auto-expires so a crashed worker can't wedge it. Default 10s.
  maxWaitMs?:      number; // how long a waiter polls before giving up and fetching directly. Default 2000ms.
  pollIntervalMs?: number; // Default 100ms.
}

export async function getOrSetWithLock<T>(options: CacheAsideOptions<T>): Promise<T> {
  const {
    key, ttlSeconds, fetch,
    lockTtlSeconds = 10,
    maxWaitMs      = 2000,
    pollIntervalMs = 100,
  } = options;

  const lockKey = `${key}:lock`;

  let redis: Awaited<ReturnType<typeof getRedisClient>>;
  try {
    redis = await getRedisClient();
  } catch (err: any) {
    logger.warn({ key, err: err.message }, '[CacheAside] Redis unavailable — skipping cache');
    return fetch();
  }

  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      const parsed = safeParse<T>(cached);
      if (parsed !== undefined) return parsed;
      // Corrupted/unparsable entry — fall through and treat as a miss.
    }
  } catch (err: any) {
    logger.warn({ key, err: err.message }, '[CacheAside] Redis GET failed — skipping cache');
    return fetch();
  }

  let gotLock = false;
  try {
    gotLock = (await redis.set(lockKey, '1', { NX: true, EX: lockTtlSeconds })) !== null;
  } catch (err: any) {
    logger.warn({ key, err: err.message }, '[CacheAside] Redis lock acquisition failed — fetching directly');
    return fetch();
  }

  if (gotLock) {
    try {
      // Deliberately outside any Redis try/catch — a real fetch() failure
      // must reach the caller as-is, not be swallowed as "Redis is down".
      const data = await fetch();

      try {
        await redis.set(key, JSON.stringify(data), { EX: ttlSeconds });
      } catch (err: any) {
        logger.warn({ key, err: err.message }, '[CacheAside] Failed to write cache — value still returned fresh');
      }

      return data;
    } finally {
      redis.del(lockKey).catch((err: any) =>
        logger.warn({ key, err: err.message }, '[CacheAside] Failed to release lock')); // auto-expires via EX regardless
    }
  }

  // Someone else is rebuilding — poll briefly for their result.
  const attempts = Math.ceil(maxWaitMs / pollIntervalMs);
  for (let i = 0; i < attempts; i++) {
    await sleep(pollIntervalMs);

    try {
      const retry = await redis.get(key);
      if (retry !== null) {
        const parsed = safeParse<T>(retry);
        if (parsed !== undefined) return parsed;
      }
    } catch (err: any) {
      logger.warn({ key, err: err.message }, '[CacheAside] Redis GET failed while waiting — fetching directly');
      return fetch();
    }
  }

  // Waited long enough — rebuild is stuck or slow. Don't make this request hang.
  return fetch();
}

function safeParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

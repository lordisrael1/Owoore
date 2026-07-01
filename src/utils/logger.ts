import pino, { Logger } from 'pino';
import { env } from '../config/env';

/**
 * logger — structured pino logger.
 *
 * Production:  JSON output — ingested by Railway log drain or Datadog
 * Development: pretty-printed with colours via pino-pretty
 *
 * Standard fields on every log:
 *   level, time, pid, hostname, msg
 *
 * Add nomba_ref to any log to tag it for Nomba reconciliation tracing:
 *   logger.info({ nomba_ref: tx.merchantTxRef }, 'Transfer initiated')
 */

const isDev = env.NODE_ENV === 'development';

export const logger: Logger = pino({
  level: isDev ? 'debug' : 'info',

  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),

  // Base fields on every log line
  base: {
    pid: process.pid,
    app: 'owoore-backend',
    env: env.NODE_ENV,
  },

  // Redact sensitive fields — never log these
  redact: {
    paths: [
      'req.headers.authorization',
      'req.body.password',
      'req.body.bcrypt_hash',
      'req.body.client_secret',
      'req.body.code',            // OTP codes
      '*.nomba_client_secret',
      '*.webhook_secret',
    ],
    censor: '[REDACTED]',
  },

  // Consistent timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * childLogger — creates a child logger with extra bound fields.
 * Use for per-request logging to carry context across function calls.
 *
 * Usage:
 *   const log = childLogger({ org_id: org.id, member_id: member.id });
 *   log.info('VA created');
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

/**
 * logNombaCall — structured log for every Nomba API call.
 * Tagged with nomba_ref for reconciliation tracing.
 */
export function logNombaCall(
  method: string,
  endpoint: string,
  nombaRef: string,
  durationMs: number,
  status: number,
): void {
  logger.info({
    nomba_ref: nombaRef,
    nomba_method: method,
    nomba_endpoint: endpoint,
    nomba_status: status,
    duration_ms: durationMs,
  }, 'Nomba API call');
}
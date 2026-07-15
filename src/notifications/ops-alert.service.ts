import { env } from '../config/env';
import { logger } from '../utils/logger';
import { formatNaira } from '../utils/formatMoney';
import { emailService } from './email/email.service';

/**
 * ops-alert.service.ts — internal operator alerting.
 *
 * For a money product, "the server is up" is not enough: the operator
 * must hear about it when money-processing breaks. This is the single
 * helper every such site calls (payout failures, dead-lettered webhooks,
 * reconciliation drift).
 *
 * Behaviour:
 *   - ALWAYS logs at ERROR — the durable, queryable signal even when
 *     email is down or OPS_ALERT_EMAIL is unset.
 *   - Emails OPS_ALERT_EMAIL when configured. Best-effort: an alert
 *     failure must never fail the flow that raised it.
 */
export async function sendOpsAlert(params: {
  event:    string;                    // machine tag, e.g. 'PAYOUT_TRANSFER_FAILED'
  summary:  string;                    // one human sentence
  context?: Record<string, unknown>;   // ids, amounts — rendered in the email
}): Promise<void> {
  const { event, summary, context = {} } = params;

  logger.error({ ops_event: event, ...context }, `[OpsAlert] ${summary}`);

  if (!env.OPS_ALERT_EMAIL) return;

  const rows = Object.entries(context)
    .map(([k, v]) => `<li><strong>${k}:</strong> ${String(v)}</li>`)
    .join('');

  await emailService
    .send({
      to:      env.OPS_ALERT_EMAIL,
      subject: `[Owoore] ${event} — ${summary.slice(0, 80)}`,
      html:    `<p>${summary}</p><ul>${rows}</ul>
                <p>Check /health (pipeline section) and the logs for detail.</p>`,
    })
    .catch((err) =>
      logger.warn({ err: err.message, ops_event: event },
        '[OpsAlert] Alert email failed — ERROR log above is the signal'));
}

/** Convenience wrapper for the recurring payout-failure shape. */
export async function alertPayoutFailure(params: {
  payoutId:   string;
  orgId:      string;
  amountKobo: number;
  reason:     string;
  path:       'MANUAL' | 'MULTI_APPROVER' | 'SWEEP' | 'WEBHOOK';
}): Promise<void> {
  await sendOpsAlert({
    event:   'PAYOUT_TRANSFER_FAILED',
    summary: `Payout transfer failed (${params.path}) — ${formatNaira(params.amountKobo)}`,
    context: {
      payout_id:   params.payoutId,
      org_id:      params.orgId,
      amount:      formatNaira(params.amountKobo),
      path:        params.path,
      reason:      params.reason,
    },
  });
}

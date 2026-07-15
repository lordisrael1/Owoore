import * as dotenv from 'dotenv';
dotenv.config();

/**
 * reconcile-replay.ts — operator tool for healing orphaned Nomba
 * transactions found by the nightly reconciliation job.
 *
 * Background: reconciliation.job.ts diffs Nomba's own transaction list
 * against our local tables every night. An "orphan" means Nomba shows a
 * payment that our webhook pipeline never recorded — the money landed in
 * the Nomba wallet correctly, but nothing credited the member's ledger,
 * because the ONLY code path that does that is the webhook handler, and
 * it never ran for this transaction (Nomba never delivered the webhook,
 * or delivery failed before we could act on it).
 *
 * This tool does NOT hand-roll a second money-writing path. It resolves
 * the destination account from the orphan's raw Nomba record, builds the
 * same event shape a webhook would have delivered, and replays it through
 * the real webhookProcessor — the exact code that runs reconciliation
 * math, ledger credits, and notifications for every live payment. Safe to
 * run twice on the same orphan: webhook_log's UNIQUE(nomba_request_id)
 * makes it a no-op the second time.
 *
 * Deliberately NOT an HTTP endpoint or in-app button: an orphan hasn't
 * been attributed to any church yet (Nomba's transaction feed is shared
 * across every org on one sub-account), so acting on one needs to sit
 * ABOVE the church-admin permission boundary. There is no "platform
 * operator" role in this system yet — until there is, this is a CLI run
 * by whoever has server/DB access, with an audit_log row on every replay.
 *
 * Usage:
 *   npm run reconcile:replay          — list outstanding orphans, replay interactively
 *   npm run reconcile:replay -- --list-only   — just list, no prompts
 */

interface RawNombaTx {
  merchantTxRef?: string;
  amount?:        number; // kobo, per reconciliation.job.ts's direct comparison against amount_kobo
  status?:        string;
  type?:          string;
  fee?:           number; // kobo, same basis as amount — unconfirmed field name, best-effort only
  [key: string]:  unknown;
}

interface OrphanRecord {
  auditLogId: string;
  createdAt:  Date;
  nombaTxRef: string;
  amountKobo: number;
  period:     string;
  raw:        RawNombaTx;
}

/**
 * findAccountReference — scans the raw Nomba record for anything shaped
 * like an account/VA reference, without assuming a specific field name we
 * haven't independently verified against Nomba's poll-endpoint response.
 * Returns every candidate string found so the caller can validate each
 * against real account_reference rows rather than trusting the field name.
 */
function findReferenceCandidates(raw: RawNombaTx): string[] {
  const candidates = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value.length < 5) continue;
    const k = key.toLowerCase();
    if (k.includes('reference') || k.includes('alias')) {
      candidates.add(value);
    }
  }
  return [...candidates];
}

async function main(): Promise<void> {
  const { queryMany, queryOne } = await import('../db');
  const { webhookProcessor } = await import('../modules/webhooks/webhook.processor');
  const { auditService } = await import('../modules/audit/audit.service');

  const listOnly = process.argv.includes('--list-only');

  console.log('Scanning audit_log for outstanding RECONCILIATION_ORPHAN entries...\n');

  const rows = await queryMany<{ id: string; created_at: Date; metadata: RawNombaTx & { nomba_tx_ref: string; nomba_amount: number; period: string; nomba_raw?: RawNombaTx } }>(
    `SELECT id, created_at, metadata FROM audit_log
     WHERE action = 'RECONCILIATION_ORPHAN'
     ORDER BY created_at DESC
     LIMIT 200`,
  );

  const outstanding: OrphanRecord[] = [];
  for (const row of rows) {
    const txRef = row.metadata.nomba_tx_ref;
    if (!txRef) continue;

    // Already resolved (by a prior replay, or a late webhook eventually
    // landing) if a real transaction row now exists for this ref — the
    // ledger tables are the source of truth, not a separate "resolved"
    // flag that could drift from reality.
    const alreadyResolved = await queryOne(
      `SELECT 1 FROM transactions WHERE nomba_tx_ref = $1
       UNION ALL
       SELECT 1 FROM anonymous_transactions WHERE nomba_tx_ref = $1
       LIMIT 1`,
      [txRef],
    );
    if (alreadyResolved) continue;

    outstanding.push({
      auditLogId: row.id,
      createdAt:  row.created_at,
      nombaTxRef: txRef,
      amountKobo: row.metadata.nomba_amount,
      period:     row.metadata.period,
      raw:        row.metadata.nomba_raw ?? {},
    });
  }

  if (outstanding.length === 0) {
    console.log('No outstanding orphans. Everything reconciliation has flagged is already accounted for.');
    process.exit(0);
  }

  console.log(`${outstanding.length} outstanding orphan(s):\n`);
  outstanding.forEach((o, i) => {
    console.log(`  [${i + 1}] ${o.nombaTxRef} — ₦${(o.amountKobo / 100).toLocaleString()} — period ${o.period} — flagged ${o.createdAt.toISOString()}`);
  });
  console.log();

  if (listOnly) {
    process.exit(0);
  }

  const { createInterface } = await import('readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  for (const orphan of outstanding) {
    console.log('─'.repeat(70));
    console.log(`Reviewing ${orphan.nombaTxRef} — ₦${(orphan.amountKobo / 100).toLocaleString()}`);
    console.log('Raw Nomba record:', JSON.stringify(orphan.raw, null, 2));

    const candidates = findReferenceCandidates(orphan.raw);
    let resolvedRef: string | null = null;
    let resolvedOrgId: string | null = null;
    let resolvedLabel = '';

    for (const candidate of candidates) {
      const memberAccount = await queryOne<{ org_id: string; member_name: string; fund_name: string; org_name: string }>(
        `SELECT o.id AS org_id, m.display_name AS member_name, ft.name AS fund_name, o.name AS org_name
         FROM member_fund_accounts mfa
         JOIN members m ON m.id = mfa.member_id
         JOIN fund_types ft ON ft.id = mfa.fund_type_id
         JOIN organisations o ON o.id = mfa.org_id
         WHERE mfa.account_reference = $1`,
        [candidate],
      );
      if (memberAccount) {
        resolvedRef   = candidate;
        resolvedOrgId = memberAccount.org_id;
        resolvedLabel = `member "${memberAccount.member_name}" · fund "${memberAccount.fund_name}" · church "${memberAccount.org_name}"`;
        break;
      }

      const sharedAccount = await queryOne<{ org_id: string; fund_name: string; org_name: string }>(
        `SELECT o.id AS org_id, ft.name AS fund_name, o.name AS org_name
         FROM org_shared_fund_accounts osfa
         JOIN fund_types ft ON ft.id = osfa.fund_type_id
         JOIN organisations o ON o.id = osfa.org_id
         WHERE osfa.account_reference = $1`,
        [candidate],
      );
      if (sharedAccount) {
        resolvedRef   = candidate;
        resolvedOrgId = sharedAccount.org_id;
        resolvedLabel = `shared fund "${sharedAccount.fund_name}" · church "${sharedAccount.org_name}"`;
        break;
      }
    }

    if (!resolvedRef) {
      console.log('\nCould not confidently resolve an account reference from the raw record.');
      console.log('Skipping — investigate manually (check the Nomba dashboard for this transaction ID) and attribute by hand.\n');
      continue;
    }

    console.log(`\nResolved to: ${resolvedLabel}`);
    console.log(`This will replay as a real payment_success event and credit the ledger.`);
    const answer = await rl.question('Replay this transaction? [y/N] ');

    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Skipped.\n');
      continue;
    }

    // Kobo → naira: inflowHandlerService always expects transactionAmount
    // in NAIRA (it multiplies by 100 itself, matching the real webhook
    // payload) — feeding it kobo directly here would overcredit 100x.
    const amountNaira = orphan.amountKobo / 100;
    const feeNaira     = typeof orphan.raw.fee === 'number' ? orphan.raw.fee / 100 : 0;

    const requestId = `reconcile_replay_${orphan.nombaTxRef}`;
    const event = {
      requestId,
      event_type: 'payment_success',
      data: {
        transaction: {
          aliasAccountReference: resolvedRef,
          aliasAccountNumber:    '',
          transactionAmount:     amountNaira,
          fee:                   feeNaira,
          transactionId:         orphan.nombaTxRef,
          narration:             'Reconciliation replay — orphaned Nomba transaction',
        },
      },
    };

    try {
      await webhookProcessor.process(event);
      console.log('Replayed successfully — ledger credited.');

      await auditService.record({
        org_id:      resolvedOrgId,
        actor_type:  'SYSTEM',
        action:      'RECONCILIATION_ORPHAN_REPLAYED',
        entity_type: 'transaction',
        metadata: {
          nomba_tx_ref: orphan.nombaTxRef,
          amount_kobo:  orphan.amountKobo,
          resolved_ref: resolvedRef,
          audit_log_id: orphan.auditLogId,
        },
      });
    } catch (err: any) {
      console.error('Replay FAILED:', err.message);
      console.error('Nothing was credited for this one — investigate before retrying.');
    }

    console.log();
  }

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('reconcile-replay failed:', err.message ?? err);
  process.exit(1);
});

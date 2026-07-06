# Owoore — Architecture & Security Note

> Submission document for the DevCareer × Nomba Hackathon.
> Covers system architecture, authentication, webhook handling, and data handling.

Owoore is a multi-tenant digital giving platform for churches. Every member gets a
dedicated **Nomba virtual account (NUBAN) per fund** — they give by plain bank
transfer from any Nigerian bank app, and every kobo is automatically reconciled to
the exact member and fund. Outbound payouts are governed by **M-of-N signatory
approval** before money can leave the church's wallet.

**Stack:** TypeScript · Express 5 · PostgreSQL · Redis · pg-boss · Nomba (VAs,
transfers, webhooks) · Resend (email) · Cloudinary (logos) · Render (hosting)

---

## 1. System architecture

```
                         ┌─────────────────────────────────────────────┐
  Member's bank app      │                Owoore API                   │
  ──transfer──► NUBAN    │  Express 5 (modular monolith, src/modules)  │
  (Nomba virtual acct)   │                                             │
        │                │  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
        ▼                │  │  Auth   │  │ Payouts  │  │ Dashboard │  │
   Nomba sub-account ────┼─►│ JWT/OTP │  │ M-of-N   │  │ Reports   │  │
        │                │  └─────────┘  └──────────┘  └───────────┘  │
        │ webhook        └───────┬──────────────┬──────────────────────┘
        ▼                        │              │
  POST /webhooks/nomba           ▼              ▼
  ── HMAC verify ──► pg-boss queue ──► webhook processor ──► ledger
  (fail = 401,       (Postgres row,     (idempotent,          (transactions,
   nothing runs)      ACK only after    UNIQUE constraint)     fund_ledger,
                      durable write)                           audit_log)
                            │
                            └─ retries ×5 (exp. backoff)
                               └─ dead-letter queue + ops email alert
```

- **One Postgres database is the source of truth** — business data, the job queue
  (pg-boss schema), and the audit log live together, so a queued webhook job and
  the ledger row it produces are in the same backup and the same transaction
  boundary. No dual-write gap between "queued" and "recorded".
- **Workers:** the queue consumer runs embedded in the API process by default and
  can also run as a dedicated worker service (`npm run worker`). Both at once is
  safe — pg-boss fetches jobs with `SELECT … FOR UPDATE SKIP LOCKED`.
- **Scheduled jobs** (node-cron): auto-sweep, reconciliation against Nomba,
  campaign-expiry, and payment reminders.
- **Multi-tenancy** is enforced at the query layer: every tenant-scoped table
  carries `org_id`, every repository query filters on it, and cross-org access
  returns 403. Tenant identity comes from the JWT, never from request input.

### Money in (give → reconcile)

1. Member authenticates and picks a fund → Owoore calls Nomba
   `POST /accounts/virtual/{subAccountId}` with `accountRef = member_{id}_fund_{id}`.
2. Member transfers from any bank app to that NUBAN. Funds settle into the
   church-scoped **sub-account**, never the parent merchant account.
3. Nomba fires `virtual_account.funded` → signature verified → event durably
   queued → processor resolves `accountRef` to member + fund in one lookup,
   writes the transaction, updates the fund ledger, classifies the payment
   (EXACT / OVERPAYMENT / UNDERPAYMENT vs. pledge), and emails the member.

### Money out (payout governance)

1. Treasurer initiates a payout → recipient account is verified via Nomba
   `POST /transfers/bank/lookup` (name shown before anything moves).
2. The amount is **soft-locked** in the ledger; each signatory gets a
   single-use, expiring approval link by email. The payout state machine
   (`PENDING → PARTIAL → APPROVED → TRANSFERRING → TRANSFERRED/FAILED`)
   rejects any illegal transition.
3. On quorum, Owoore calls Nomba `POST /v2/transfers/bank/{subAccountId}` with
   `merchantTxRef = payout_{id}` — the same ref on every retry, so Nomba
   deduplicates and a retry can never double-send.
4. The `transfer.success` / `transfer.failed` webhook drives final state:
   success debits the ledger with the **actual fee from the webhook payload**;
   failure releases the soft lock so funds are available again. A requery
   endpoint covers delayed webhooks.

---

## 2. Authentication & authorisation

| Actor | Mechanism |
|---|---|
| Church admin / treasurer | Email + password (bcrypt-hashed), email verification required before first login |
| Member | Passwordless — 6-digit email OTP scoped to the church's join slug |
| Payout signatory | No account needed — single-use tokenised email link + last-4-digits phone challenge |
| Nomba (webhooks) | HMAC-SHA256 signature — see §3 |

- **JWTs** are signed with a ≥32-char secret (enforced at boot by the zod env
  schema). Member tokens expire in 1h, admin tokens in 1d; members get rotating
  refresh tokens (30-day). The payload carries `role` and `orgId`; middleware
  (`authenticate`, `authenticateMember`, `authenticateAdmin`, `authorise`)
  enforces role and tenant on every protected route.
- **Approval links** are UUID tokens with configurable expiry
  (`token_expiry_hours` in the org's payout policy). A used token returns
  `410 TOKEN_USED`; an expired one `410 TOKEN_EXPIRED`. Before approving, the
  signatory must supply the last 4 digits of their registered phone number —
  a leaked email alone is not enough to approve a transfer.
- **Rate limiting** (express-rate-limit) protects OTP issuance and the public
  approval endpoints against brute force; `helmet` and CORS are applied
  app-wide.

---

## 3. Webhook handling

Nomba's webhooks are the system's financial backbone, so they get the strictest
treatment in the codebase:

1. **Raw-body HMAC verification first.** The webhook route uses `express.raw()`
   — the HMAC-SHA256 signature (`nomba-signature` + `nomba-timestamp` headers,
   keyed with `NOMBA_WEBHOOK_SECRET`) is verified against the untouched byte
   buffer *before any parsing or DB access*. Missing or invalid signature →
   401, nothing else runs.
2. **Durable before ACK.** The 200 we return is a contract — Nomba never
   resends after it. So the event is written to a Postgres-backed queue
   (pg-boss) *before* we ACK. A crash or redeploy mid-processing loses
   nothing: the job is a row. The enqueue is wrapped in a 5s hard timeout —
   if Postgres hangs we return 500 and Nomba retries on its schedule.
3. **Idempotency at two layers.** A `singletonKey` on the queue suppresses
   duplicate deliveries while the first is in flight; the real guarantee is a
   `UNIQUE` constraint on `nomba_request_id` in `webhook_log` — a replayed
   event can never double-credit a member or double-debit the ledger.
4. **Retries + dead-letter queue.** A processor failure is retried 5× with
   exponential backoff. Exhausted jobs are re-enqueued onto a dead-letter
   queue (`nomba-events-dead`) with full event data intact — never silently
   purged — and a worker alerts ops (ERROR log + email to `OPS_ALERT_EMAIL`).
   Replay is a deliberate manual action after fixing the root cause.

---

## 4. Data handling

**Money.** All amounts are stored and computed as **integer kobo** — floats
never touch arithmetic. An `assertKobo` guard runs before every Nomba call
(the v2 transfer endpoint takes naira, so conversion happens in exactly one
audited place). Nomba's transfer fees are captured from webhook payloads and
tracked per payout so the internal ledger reconciles to the real wallet
balance, and a scheduled reconciliation job cross-checks the two.

**SQL.** Every query is parameterised (`$1, $2, …`) — including the dynamic
UPDATE/filter builders, which interpolate only hardcoded column fragments
while all values travel in the parameter array. There is no string-concatenated
SQL anywhere in the codebase.

**Input sanitisation.** Human-authored free text (names, fund descriptions,
payout purpose) is stripped of all HTML via DOMPurify (`ALLOWED_TAGS: []`) at
the validation layer before it reaches the database — stored-XSS defence for
the HTML emails and dashboards that later render it. Structured values
(emails, UUIDs, bank codes, account numbers) are instead pinned by strict zod
format validators that reject rather than mask bad input.

**Secrets & config.** All secrets live in environment variables validated by a
zod schema at boot — the process refuses to start with a missing or malformed
secret (e.g. JWT secret under 32 chars). No secret is ever committed;
`.env.example` documents the required set.

**Logging.** Structured pino logs with an explicit redaction list:
authorization headers, passwords, OTP codes, client secrets, and webhook
secrets are censored; bank account numbers are masked to their last 4 digits
and member emails are partially masked before logging.

**Auditability.** Every sensitive action (payout initiated/approved/declined/
transferred, signatory changes, sweeps) writes an `audit_log` row with actor
type, entity, and metadata — the business history is reconstructable
independently of application logs.

---

## 5. Failure & resilience design

| Failure | Behaviour |
|---|---|
| Nomba API timing out | Circuit breaker trips after 5 consecutive systemic failures → requests fail fast with 503 "try again shortly" instead of hanging 30s each. Half-open probes detect recovery and resume traffic automatically; cooldown doubles (30s → 5min cap) while Nomba stays down. |
| Webhook lost / delayed | Requery endpoint polls transfer status; reconciliation job cross-checks ledger vs. Nomba. |
| Processor bug / bad payload | 5 retries with backoff → dead-letter queue → ops alert. Event data preserved for manual replay. |
| Crash mid-webhook | Event already durable in Postgres before ACK; job re-fetched on restart. |
| Transfer fails after approval | `transfer.failed` webhook releases the soft lock; retry reuses the same `merchantTxRef` so Nomba deduplicates. |
| Bank-list fetch fails | 24h in-memory cache served stale rather than failing the payout flow. |
| Duplicate webhook delivery | Queue `singletonKey` fast-path + `UNIQUE(nomba_request_id)` hard guarantee. |

---

## 6. Testing

170+ automated tests across 17 vitest suites cover auth flows, webhook
signature rejection, payout state transitions and quorum rules, multi-tenant
isolation (cross-org 403s), reconciliation classification, the circuit
breaker state machine, and security cases (missing/forged signatures,
expired/reused approval tokens, rate limits).

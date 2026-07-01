-- 016_create_webhook_log.sql
-- Every Nomba webhook event stored before processing begins.
-- This is the idempotency store — if nomba_request_id already exists, skip processing.
-- processed = FALSE means the event was received but processing failed — re-queue these.
-- Raw payload stored for debugging and manual replay.

CREATE TABLE webhook_log (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nomba_request_id  VARCHAR(255)  NOT NULL UNIQUE,  -- event.requestId from Nomba payload
  event_type        VARCHAR(100)  NOT NULL,          -- 'virtual_account.funded' | 'transfer.success' etc.
  org_id            UUID          REFERENCES organisations(id),
  raw_payload       JSONB         NOT NULL,          -- full webhook body
  processed         BOOLEAN       NOT NULL DEFAULT FALSE,
  processing_error  TEXT,                            -- error message if processing failed
  processed_at      TIMESTAMPTZ,
  received_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_webhook_log_nomba_request_id ON webhook_log(nomba_request_id);
CREATE INDEX idx_webhook_log_unprocessed
  ON webhook_log(received_at)
  WHERE processed = FALSE;

COMMENT ON TABLE webhook_log IS 'Every Nomba event stored on receipt — idempotency key prevents double-processing.';
COMMENT ON COLUMN webhook_log.nomba_request_id IS 'Nomba event.requestId — unique constraint is the idempotency guard.';
COMMENT ON COLUMN webhook_log.processed IS 'FALSE = failed or not yet processed — picked up by retry mechanism.';
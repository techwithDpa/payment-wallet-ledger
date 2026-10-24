-- migrate:up
-- Milestone 4: reconciliation. One run = one full check of the ledger.

CREATE TABLE recon_runs (
  recon_run_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED')),
  trigger           TEXT NOT NULL CHECK (trigger IN ('MANUAL', 'SCHEDULED')),
  requested_by      BIGINT REFERENCES users (user_id),
  transfers_checked BIGINT,
  accounts_checked  BIGINT,
  total_debits      BIGINT,   -- across the whole ledger; must equal total_credits
  total_credits     BIGINT,
  issue_count       INT,
  error             TEXT,     -- why a run FAILED or was SKIPPED
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

-- One row per ROOT problem (not per symptom):
--   TRANSFER_LEDGER_MISMATCH  a transfer's ledger lines don't match the transfer
--   ACCOUNT_BALANCE_MISMATCH  a stored balance matches neither its ledger lines nor its transfers
CREATE TABLE recon_issues (
  recon_issue_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recon_run_id   BIGINT NOT NULL REFERENCES recon_runs (recon_run_id),
  kind           TEXT NOT NULL CHECK (kind IN ('TRANSFER_LEDGER_MISMATCH', 'ACCOUNT_BALANCE_MISMATCH')),
  transfer_id    BIGINT REFERENCES transfers (transfer_id),
  account_id     BIGINT REFERENCES accounts (account_id),
  expected       BIGINT,      -- paise
  actual         BIGINT,      -- paise
  detail         TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recon_issues_points_somewhere CHECK (transfer_id IS NOT NULL OR account_id IS NOT NULL)
);
CREATE INDEX recon_issues_run_idx ON recon_issues (recon_run_id);

-- migrate:down
DROP TABLE recon_issues;
DROP TABLE recon_runs;

-- migrate:up
-- Milestone 5: fraud rules. Thresholds live in the table so ops can tune them without a deploy.

CREATE TABLE risk_rules (
  risk_rule_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE CHECK (code IN ('VELOCITY', 'AMOUNT_SPIKE', 'NEW_PAYEE_LARGE')),
  action         TEXT NOT NULL CHECK (action IN ('HOLD', 'FLAG')),  -- HOLD: wait for an admin; FLAG: allow, but record
  threshold      BIGINT NOT NULL CHECK (threshold > 0),               -- a count, a multiplier or paise, depending on the rule
  window_minutes INT CHECK (window_minutes > 0),
  enabled        BOOLEAN NOT NULL DEFAULT true,
  description    TEXT NOT NULL
);

INSERT INTO risk_rules (code, action, threshold, window_minutes, description) VALUES
  ('VELOCITY',        'HOLD', 5,       10,    'More than 5 outgoing transfers in 10 minutes'),
  ('AMOUNT_SPIKE',    'HOLD', 5,       43200, 'Amount above 5x the wallet''s 30-day average (skipped without history)'),
  ('NEW_PAYEE_LARGE', 'FLAG', 1000000, NULL,  'First transfer to this payee above Rs 10,000');

-- One row per rule a transfer tripped.
CREATE TABLE risk_flags (
  risk_flag_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  BIGINT NOT NULL REFERENCES transfers (transfer_id),
  rule_code    TEXT NOT NULL REFERENCES risk_rules (code),
  action       TEXT NOT NULL CHECK (action IN ('HOLD', 'FLAG')),
  detail       TEXT NOT NULL,
  resolution   TEXT CHECK (resolution IN ('RELEASED', 'REJECTED')),  -- set when an admin decides a HELD transfer
  resolved_by  BIGINT REFERENCES users (user_id),
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_flags_transfer_idx ON risk_flags (transfer_id);

-- The rules look up a wallet's recent outgoing transfers and its past payees.
CREATE INDEX transfers_from_created_idx ON transfers (from_account_id, created_at);
CREATE INDEX transfers_from_to_idx ON transfers (from_account_id, to_account_id);
-- The admin queue lists HELD transfers.
CREATE INDEX transfers_held_idx ON transfers (created_at) WHERE status = 'HELD';

-- migrate:down
DROP INDEX transfers_held_idx;
DROP INDEX transfers_from_to_idx;
DROP INDEX transfers_from_created_idx;
DROP TABLE risk_flags;
DROP TABLE risk_rules;

-- migrate:up
-- Milestone 1: the core of the ledger.
-- Money is always whole paise in BIGINT. Never NUMERIC/FLOAT: no rounding, ever.

CREATE TABLE users (
  user_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  kyc_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (kyc_status IN ('PENDING', 'VERIFIED', 'REJECTED')), -- stored, not enforced
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One table for user wallets AND the bank's own system accounts.
-- A transfer is always "from one account to another", so a top-up is
-- cash_in -> wallet and a withdrawal is wallet -> cash_out.
CREATE TABLE accounts (
  account_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT REFERENCES users (user_id),
  kind        TEXT NOT NULL CHECK (kind IN ('USER_WALLET', 'SYSTEM')),
  system_code TEXT UNIQUE,                       -- 'cash_in', 'cash_out', 'fee_revenue'; NULL for wallets
  currency    CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  balance     BIGINT NOT NULL DEFAULT 0,         -- paise; provable from ledger_entries
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a wallet belongs to a user; a system account belongs to nobody
  CONSTRAINT accounts_owner_matches_kind CHECK ((kind = 'USER_WALLET') = (user_id IS NOT NULL)),
  CONSTRAINT accounts_code_matches_kind  CHECK ((kind = 'SYSTEM') = (system_code IS NOT NULL)),
  -- the last line of defence: the database itself refuses a negative wallet
  CONSTRAINT accounts_wallet_not_negative CHECK (kind = 'SYSTEM' OR balance >= 0)
);
CREATE INDEX accounts_user_id_idx ON accounts (user_id);

INSERT INTO accounts (kind, system_code) VALUES ('SYSTEM', 'cash_in'), ('SYSTEM', 'cash_out'), ('SYSTEM', 'fee_revenue');

-- One row per money movement (the "why"). ledger_entries are the "how much, where".
CREATE TABLE transfers (
  transfer_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type                 TEXT NOT NULL CHECK (type IN ('TOPUP', 'PEER', 'WITHDRAWAL', 'FEE', 'REVERSAL')),
  status               TEXT NOT NULL CHECK (status IN ('COMPLETED', 'HELD', 'REJECTED', 'REVERSED')),
  from_account_id      BIGINT NOT NULL REFERENCES accounts (account_id),
  to_account_id        BIGINT NOT NULL REFERENCES accounts (account_id),
  amount               BIGINT NOT NULL CHECK (amount > 0),
  reverses_transfer_id BIGINT UNIQUE REFERENCES transfers (transfer_id), -- UNIQUE: a transfer can be reversed at most once
  note                 TEXT,
  created_by           BIGINT REFERENCES users (user_id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transfers_two_different_accounts CHECK (from_account_id <> to_account_id),
  CONSTRAINT transfers_reversal_has_target CHECK ((type = 'REVERSAL') = (reverses_transfer_id IS NOT NULL))
);

-- Double entry: every COMPLETED transfer writes exactly one D line and one C line
-- for the same amount. Debit subtracts from balance, credit adds.
CREATE TABLE ledger_entries (
  entry_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES transfers (transfer_id),
  account_id  BIGINT NOT NULL REFERENCES accounts (account_id),
  direction   CHAR(1) NOT NULL CHECK (direction IN ('D', 'C')),
  amount      BIGINT NOT NULL CHECK (amount > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_statement_idx ON ledger_entries (account_id, created_at DESC, entry_id DESC);
CREATE INDEX ledger_entries_transfer_idx ON ledger_entries (transfer_id);

-- Append-only: history is never rewritten. A mistake is fixed with a REVERSAL transfer.
CREATE FUNCTION forbid_ledger_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER ledger_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_change();

-- Every status a transfer has ever had (COMPLETED -> REVERSED, HELD -> COMPLETED, ...).
CREATE TABLE transfer_status_audit (
  audit_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES transfers (transfer_id),
  old_status  TEXT,                     -- NULL for the first row (transfer created)
  new_status  TEXT NOT NULL,
  changed_by  BIGINT REFERENCES users (user_id),
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transfer_status_audit_transfer_idx ON transfer_status_audit (transfer_id);

-- Remembers every POST by (caller, Idempotency-Key) so a retry replays the
-- first answer instead of moving money twice.
-- user_id is just the caller scope (NULL for anonymous POST /users), so no FK.
-- NULLS NOT DISTINCT: two anonymous requests with the same key still collide.
CREATE TABLE idempotency_keys (
  idempotency_key_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            BIGINT,
  key                UUID NOT NULL,
  request_hash       CHAR(64) NOT NULL,  -- sha256 of method + path + body
  status             TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_code      INT,
  response_body      JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_user_key UNIQUE NULLS NOT DISTINCT (user_id, key)
);

-- migrate:down
DROP TABLE idempotency_keys;
DROP TABLE transfer_status_audit;
DROP TABLE ledger_entries;
DROP FUNCTION forbid_ledger_change();
DROP TABLE transfers;
DROP TABLE accounts;
DROP TABLE users;

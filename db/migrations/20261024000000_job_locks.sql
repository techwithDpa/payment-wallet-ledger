-- migrate:up
-- First real table of the schema (used in Milestone 4).
-- One row per background job; a run locks its row with FOR UPDATE NOWAIT
-- so two reconciliation runs can never overlap.
CREATE TABLE job_locks (
  job_lock_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name    TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO job_locks (job_name) VALUES ('reconciliation');

-- migrate:down
DROP TABLE job_locks;

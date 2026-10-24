# Progress log

Newest first. At the end of every working session, add: what was done, what's next, anything surprising.

## 2026-10-24 15:15 — Step 2 done (safe transfers + stampede)
- Done: `moveMoney()` in `src/services/transfers.ts` (lock both rows `FOR UPDATE` in ascending id order → re-check balance under lock → transfer + D/C lines + `balance = balance ± $amount` + audit row). Routes `POST /transfers/topup`, `POST /transfers`. `AppError`, zod `amountSchema` (whole paise only, int or digit string), bigint-safe JSON (amounts and ids sent as strings).
- Verified: stampede (₹500 wallet, 100 parallel ₹10) gives exactly 50×201 + 50×422, balance 0, stored == ledger balance, all 20 rounds; debits = credits for every transfer.
- Surprising: the Step 1 append-only test had left a one-sided ledger line, which broke "debits = credits". Fixed by running it in a rolled-back transaction, and reset the local tables (rollback + up).
- Next: Step 3, idempotency.

## 2026-10-24 15:15 — Step 1 done (schema)
- Done: migration `20261024010000_ledger_core.sql` with users, accounts (+ seeded `cash_in`, `cash_out`, `fee_revenue`), transfers, ledger_entries (append-only trigger), transfer_status_audit, idempotency_keys. `docs/schema.md` with Mermaid ER. 8 schema tests prove the DB itself refuses negative wallets, ledger edits, zero amounts, duplicate idempotency keys.
- Decision: risk_* and recon_* tables are NOT in this migration; they get their own migration in Steps 5/6 when their columns are decided.
- Decision: `idempotency_keys.user_id` has no FK and uses `UNIQUE NULLS NOT DISTINCT`, so anonymous `POST /users` can be idempotent too.
- Next: Step 2, safe transfers + stampede test.

## 2026-10-24 02:10 — Step 0 done
- Done: repo skeleton, Docker Compose (db, migrate, api, worker), first migration (`job_locks`), `GET /health`, `withTransaction()` helper, error shape, 4 passing tests, CI workflow.
- Verified: migration + tests + API + worker against Postgres 16. `docker compose up` itself still to be verified on the laptop.
- Next: push to GitHub and confirm CI is green, then **Step 1: schema migrations** (see docs/PLAN.md "Schema decisions") + `docs/schema.md`.

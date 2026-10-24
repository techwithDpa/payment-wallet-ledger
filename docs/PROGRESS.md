# Progress log

Newest first. At the end of every working session, add: what was done, what's next, anything surprising.

## 2026-10-24 16:12 — Step 5 done (reconciliation)
- Done: migration `20261024020000_reconciliation.sql` (recon_runs, recon_issues). `src/services/reconciliation.ts`: one `REPEATABLE READ` snapshot, `job_locks` row `FOR UPDATE NOWAIT` (second run → SKIPPED), two checks written as `INSERT ... SELECT` into recon_issues, totals of debits/credits on the run. `POST /admin/reconciliation/run` (202, idempotent, runs in background after commit), `GET /admin/reconciliation/runs/{id}`. Worker: nightly at 02:30 (heartbeat removed).
- Root-cause rule: transfer whose lines don't match it → TRANSFER_LEDGER_MISMATCH. Account reported only if stored balance ≠ ledger view AND ≠ transfers view (otherwise it's a symptom of a broken transfer).
- Verified: 10k transfers + corrupt amount + delete credit + change balance → exactly 3 issues; repaired → 0; overlapping run → SKIPPED; 41/41 tests twice; Docker API + worker smoke test.
- Test changes: `vitest.config.ts` `fileParallelism: false` (the recon test briefly corrupts the shared DB; other files' "debits = credits" checks must not see that). The recon test uses `session_replication_role = replica` (superuser) to get past the append-only trigger, then deletes all its data. The seed test now checks exact balances only on a fresh DB (I had used the demo users by hand).
- Surprising: PR #2 was merged into `feature/steps-1-4`, not `main` (stacked PRs only retarget when the base branch is deleted). Opened PR #3 to bring Step 8 into `main`; this branch is based on it.
- Next: merge PR #3, then this PR. Then `docs/isolation.md`, then Step 6 fraud rules (HELD/202, risk_rules, risk_flags, `/admin/risk/*`).

## 2026-10-24 15:58 — Step 8 done (README, seed, demo script); video still to record
- Done: `src/seed.ts` (`npm run seed`, or `docker compose run --rm api node dist/seed.js`): Asha, Ravi, Meera with top-ups, peer transfers, a withdrawal and a reversed mistake, all through `moveMoney()`/`reverseTransfer()`; skips if already seeded. Test: expected balances, stored == ledger, safe to run twice.
- Done: README rewritten: run, tests, API table, curl examples, design (data model, locking, idempotency, reversals), trade-offs, assumptions, Done / Not done / Next.
- Done: `docs/demo.md`, a ~5 min video script; every command checked against the running Docker API.
- Surprising: the append-only demo `UPDATE ... WHERE entry_id = 1` printed `UPDATE 0` (no such row → a row trigger never fires). The script now targets `min(entry_id)`.
- Verified: 37/37 tests; seed works locally and inside Docker.
- Next: record the video (you), merge PR #1 then the Step 8 PR, then Step 5 reconciliation, then `docs/isolation.md`.

## 2026-10-24 15:30 — Money path: what is implemented (reference)
Everything that moves money, in one place. All of it runs inside ONE transaction on ONE `PoolClient` (`withTransaction('READ COMMITTED', ...)` via `idempotent()`).

**Request flow for every money POST** (`/transfers/topup`, `/transfers`, `/transfers/withdraw`, `/transfers/{id}/reverse`):
1. `requireUser()` / `requireAdmin()`: `X-User-Id` header, else 401 (reverse: `X-Admin: true`, else 403).
2. `parse()` with zod: `amount` must be whole paise (positive int or digit string, max 18 digits) → `bigint`. Floats, `"10.50"`, `"1e5"`, 0, negatives → 400 `VALIDATION_ERROR`. No `parseFloat` anywhere.
3. `idempotent()` (`src/services/idempotency.ts`): `Idempotency-Key` must be a UUID (else 400). Opens the transaction and claims the key with `INSERT ... 'IN_PROGRESS' ON CONFLICT DO NOTHING`.
4. `SAVEPOINT money`, then the route's handler: ownership check (`requireOwnWallet`, 404 if not yours) → `moveMoney()` or `reverseTransfer()`.
5. Business error (`AppError`, e.g. 422 INSUFFICIENT_FUNDS) → `ROLLBACK TO SAVEPOINT money` (money work undone, key row kept) and the error response is saved. Unexpected crash → whole transaction rolls back, key included, so the client can retry.
6. Response saved as JSONB, key → COMPLETED, COMMIT. The reply is the stored JSONB, so replays are byte-identical.
7. Seen key: different request hash → 422 `IDEMPOTENCY_KEY_REUSED`; still IN_PROGRESS → 409; COMPLETED → replay with header `idempotent-replayed: true`.

**`moveMoney()`** (`src/services/transfers.ts`):
1. Same account on both sides → 422 `SAME_ACCOUNT`.
2. `SELECT ... WHERE account_id = ANY($1) ORDER BY account_id FOR UPDATE`: locks both rows, lowest id first (no deadlocks).
3. Missing account → 404. Re-check balance UNDER the lock: user wallet with `balance < amount` → 422 `INSUFFICIENT_FUNDS`. System accounts may go negative (`cash_in` goes negative as money enters).
4. INSERT transfer (status `COMPLETED`) → INSERT one `D` line (from) + one `C` line (to), same amount.
5. `UPDATE accounts SET balance = balance - $1` / `+ $1`: Postgres does the arithmetic on the locked row.
6. INSERT `transfer_status_audit` row (NULL → COMPLETED).

**Transfer types wired to routes:** TOPUP = `cash_in` → wallet; PEER = wallet → another user's wallet; WITHDRAWAL = wallet → `cash_out`; REVERSAL = see below. `FEE` exists in the schema but nothing charges fees yet.

**`reverseTransfer()`**: locks the original transfer row `FOR UPDATE` → not found 404; is a REVERSAL → 409 `NOT_REVERSIBLE`; already REVERSED → 409 `ALREADY_REVERSED`; not COMPLETED → 409 → `moveMoney(type REVERSAL, to → from)` (422 if the receiver already spent it) → original status `REVERSED` + audit row. Ledger lines are never edited; `reverses_transfer_id UNIQUE` is a second guard against double reversal.

**Database guards (last line of defence):** wallet `balance >= 0` CHECK, `amount > 0` CHECKs, ledger append-only trigger (UPDATE/DELETE/TRUNCATE raise), `UNIQUE NULLS NOT DISTINCT (user_id, key)` on idempotency keys, BIGINT paise everywhere and `bigint` in TS (type parser for OID 20). JSON responses send amounts and ids as strings.

**Proven by tests:** stampede ×20 (exactly 50/100 succeed, balance 0, stored == ledger balance), debits = credits for every transfer, same request ×5 / same key ×10 parallel → 1 transfer, key reuse with a different amount → 422 with no money moved, failed transfer replays the same 422, 5 parallel reversals → exactly one 201.

**Not in the money path yet:** HELD transfers / 202 (Step 6 fraud rules: HELD writes no ledger lines until released), fees, reconciliation job (Step 5).

## 2026-10-24 15:22 — Step 4 done (rest of the API)
- Done: `POST /users` (409 EMAIL_TAKEN), `POST /users/{id}/wallets`, `GET /wallets/{id}/balance`, `GET /wallets/{id}/statement?limit&offset` (newest first, `created_at DESC, entry_id DESC`), `POST /transfers/withdraw`, `POST /transfers/{id}/reverse`, `GET /transfers/{id}` (+ entries + status_history). Every POST goes through `idempotent()`.
- Decisions (for the README assumptions): reverse is admin-only (`X-Admin: true`); a reversal is refused with 422 if the receiver already spent the money (wallet never goes negative); a reversal can't be reversed; "not yours" and "doesn't exist" both return 404 so ids can't be probed; `POST /users` needs no `X-User-Id` and its idempotency scope is `user_id NULL`.
- Verified: 36/36 tests (full money flow + 5 parallel reversals → exactly one 201); rebuilt the Docker api and smoke-tested over HTTP with curl.
- Next: open a PR for `feature/steps-1-4` and check CI is green, then Step 8 (README design answers, seed, video), then Step 5 reconciliation. The `202 HELD` path of `POST /transfers` arrives with fraud rules (Step 6).

## 2026-10-24 15:16 — Step 3 done (idempotency)
- Done: `idempotent()` in `src/services/idempotency.ts`. Claim key with `INSERT ... ON CONFLICT DO NOTHING` + run the transfer in the SAME transaction; business errors roll back to `SAVEPOINT money` and the error response is still saved. Seen key: different hash → 422 `IDEMPOTENCY_KEY_REUSED`, IN_PROGRESS → 409, COMPLETED → replay (header `idempotent-replayed: true`). Missing/invalid header → 400. Both transfer routes use it.
- Detail: the reply is always the JSONB read back with `RETURNING`, so the first response and replays are byte-identical (JSONB reorders keys, so sending the JS object first would differ).
- Verified: same request ×5 → 1 transfer + 5 identical bodies; same key ×10 parallel → 1 transfer; same key different amount → 422, no money moved; 30/30 tests.
- Next: Step 4, rest of the API.

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
